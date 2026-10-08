import { EventEmitter } from 'node:events'
import type { Operator } from '../shared/types'
import { hiddenConsoleEnv } from './hideshim'
import { isFixedLine } from './nudge'
import { defaultShell, type PathEnv, type ShellSpec } from './paths'

// The subset of node-pty that sessions use, so tests can pass a fake.
export interface Pty {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  onData(cb: (data: string) => void): unknown
  onExit(cb: (e: { exitCode: number }) => void): unknown
}

export type PtyFactory = (
  file: string,
  args: string[],
  opts: { cwd: string; cols: number; rows: number; env: Record<string, string> },
) => Pty

export interface LaunchSpec {
  // The operator the session belongs to; scratch terminals have none and pass a key instead.
  operator?: Pick<Operator, 'id'>
  address?: string
  cwd: string
  // Session key; defaults to the operator id. Scratch terminals use `scratch:<id>`.
  key?: SessionKey
  // Extra environment entries (the CLI socket and token), merged over the defaults.
  env?: Record<string, string>
  // The launch line typed into the shell (from launch.ts), and an optional fixed line typed after it.
  command?: string | null
  firstInput?: string | null
  // Hold `firstInput` until the launched TUI has painted and gone quiet (OpenCode drops text typed while it loads).
  firstInputWhenReady?: boolean
}

export type SessionKey = number | string

// The one extra line Operant types after a Codex launch (ruling R10): a pointer to a role file it wrote.
// eslint-disable-next-line no-control-regex
const ROLE_POINTER_RE = /^Read [^\0-\x1f\x7f]+ and follow it as your role\.$/
export const isRolePointer = (line: string): boolean => ROLE_POINTER_RE.test(line)

// What a session inherits from Operant's own environment: never an outer instance's token, socket or
// operator (Operant started from inside an operator), nor the flag that makes Electron act as Node.
export function inheritedEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(source)) {
    const name = k.toUpperCase()
    if (v === undefined || name.startsWith('OPERANT_') || name === 'ELECTRON_RUN_AS_NODE') continue
    out[k] = v
  }
  return out
}

// Output kept per operator so a newly opened terminal can replay recent history.
const BUFFER_LIMIT = 256 * 1024

interface Session {
  pty: Pty
  buffer: string
  lastOutputAt: number
  // The owner's own keystrokes (write(), the renderer path), never Operant's typed lines.
  lastOwnerInputAt: number | null
  // The owner typed text since their last Enter (or Ctrl+C / Ctrl+U / Esc), so a typed line would land in their draft.
  ownerDraft: boolean
}

// Delay between a fixed line's text and its Enter: ConPTY and the TUIs' paste detection would otherwise read the CR
// that arrives in the same chunk as part of a paste.
export const ENTER_DELAY_MS = 30
const READY_QUIET_MS = 1500
const READY_MIN_CHARS = 1000
const READY_POLL_MS = 250
const READY_GIVE_UP_MS = 30_000
// Ctrl+U: clears the input line in Claude Code and OpenCode (checked on ConPTY) before a retyped line.
export const CLEAR_INPUT_KEY = '\x15'

// Terminal replies and key sequences (focus reports, cursor reports, arrows, bracketed paste markers).
// eslint-disable-next-line no-control-regex
const SEQUENCE_RE = /\x1b\[[0-9;?<>]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bO./g

export interface SessionEvents {
  // Operator sessions only (numeric keys), kept for existing listeners.
  data: [operatorId: number, data: string]
  exit: [operatorId: number, exitCode: number]
  // Every session, scratch terminals included.
  sessionData: [key: SessionKey, data: string]
  sessionExit: [key: SessionKey, exitCode: number]
}

export class SessionManager extends EventEmitter<SessionEvents> {
  private readonly sessions = new Map<SessionKey, Session>()
  private shellOverride: ShellSpec | null = null

  constructor(
    private readonly spawn: PtyFactory,
    private readonly pathEnv?: PathEnv,
    private readonly now: () => number = Date.now,
    private readonly later: (fn: () => void, ms: number) => void = (fn, ms) => void setTimeout(fn, ms),
  ) {
    super()
  }

  // Applies to operators started from now on; null goes back to the system default shell.
  setShell(spec: ShellSpec | null): void {
    this.shellOverride = spec
  }

  isRunning(operatorId: SessionKey): boolean {
    return this.sessions.has(operatorId)
  }

  start({ operator, address, cwd, key = operator?.id, env: extraEnv, command, firstInput, firstInputWhenReady }: LaunchSpec, cols = 120, rows = 32): void {
    if (key === undefined) throw new Error('A session needs an operator or a key')
    if (this.sessions.has(key)) return
    if (firstInput && !isRolePointer(firstInput)) throw new Error('not a fixed Operant line')
    const sh = this.shellOverride ?? defaultShell(this.pathEnv)
    const env = hiddenConsoleEnv({
      ...inheritedEnv(),
      ...(operator ? { OPERANT_OPERATOR: address ?? '', OPERANT_OPERATOR_ID: String(operator.id) } : {}),
      ...extraEnv,
    }) as Record<string, string>
    const pty = this.spawn(sh.file, sh.args, { cwd, cols, rows, env })
    const session: Session = { pty, buffer: '', lastOutputAt: this.now(), lastOwnerInputAt: null, ownerDraft: false }
    this.sessions.set(key, session)

    pty.onData((data) => {
      session.buffer = (session.buffer + data).slice(-BUFFER_LIMIT)
      session.lastOutputAt = this.now()
      this.emit('sessionData', key, data)
      if (typeof key === 'number') this.emit('data', key, data)
    })
    pty.onExit(({ exitCode }) => {
      // A session already dropped by forceStop has reported its exit.
      if (this.sessions.get(key) !== session) return
      this.sessions.delete(key)
      this.emit('sessionExit', key, exitCode)
      if (typeof key === 'number') this.emit('exit', key, exitCode)
    })

    if (command) {
      pty.write(`${command}\r`)
      if (firstInput && firstInputWhenReady) this.typeWhenReady(key, session, firstInput)
      else if (firstInput) pty.write(`${firstInput}\r`)
    }
  }

  // Types the line once the TUI has drawn a screen (more than the shell's echo) and been quiet READY_QUIET_MS;
  // after READY_GIVE_UP_MS it is typed anyway.
  private typeWhenReady(key: SessionKey, session: Session, line: string): void {
    const began = this.now()
    const check = (): void => {
      if (this.sessions.get(key) !== session) return
      const drawn = session.buffer.length >= READY_MIN_CHARS && this.now() - session.lastOutputAt >= READY_QUIET_MS
      if (!drawn && this.now() - began < READY_GIVE_UP_MS) return void this.later(check, READY_POLL_MS)
      session.pty.write(line)
      this.later(() => {
        if (this.sessions.get(key) === session) session.pty.write('\r')
      }, ENTER_DELAY_MS)
    }
    this.later(check, READY_POLL_MS)
  }

  // Milliseconds since the session last produced output; null when it is not running.
  idleMs(key: SessionKey): number | null {
    const s = this.sessions.get(key)
    return s ? this.now() - s.lastOutputAt : null
  }

  isIdle(key: SessionKey, idleSeconds: number): boolean {
    const ms = this.idleMs(key)
    return ms !== null && ms >= idleSeconds * 1000
  }

  // Types one of Operant's fixed lines (nudge, /clear, /exit, the Master pointer lines), then Enter as a separate write
  // ENTER_DELAY_MS later (checked on ConPTY with Claude Code and OpenCode). `clearFirst` sends Ctrl+U before the text
  // (a retyped pointer line, in case the first one is still in the input box). Anything else is refused.
  typeFixed(key: SessionKey, line: string, opts: { clearFirst?: boolean } = {}): boolean {
    if (!isFixedLine(line)) throw new Error('not a fixed Operant line')
    const s = this.sessions.get(key)
    if (!s) return false
    if (opts.clearFirst) s.pty.write(CLEAR_INPUT_KEY)
    s.pty.write(line)
    this.later(() => {
      if (this.sessions.get(key) === s) s.pty.write('\r')
    }, ENTER_DELAY_MS)
    return true
  }

  // Milliseconds since the owner last typed into the session; null when they never did or it is not running.
  ownerIdleMs(key: SessionKey): number | null {
    const s = this.sessions.get(key)
    return s && s.lastOwnerInputAt !== null ? this.now() - s.lastOwnerInputAt : null
  }

  // True while the owner has text in the input line that they have not sent.
  ownerDraft(key: SessionKey): boolean {
    return this.sessions.get(key)?.ownerDraft ?? false
  }

  stop(operatorId: SessionKey): void {
    this.sessions.get(operatorId)?.pty.kill()
  }

  // For a pty that ignored stop(): kills it harder, then drops the session and reports its exit, so a
  // late real exit changes nothing. Returns false when the session was not running.
  forceStop(key: SessionKey): boolean {
    const session = this.sessions.get(key)
    if (!session) return false
    try {
      session.pty.kill('SIGKILL')
    } catch {
      try {
        session.pty.kill()
      } catch {
        // already gone
      }
    }
    if (this.sessions.get(key) === session) {
      this.sessions.delete(key)
      this.emit('sessionExit', key, 1)
      if (typeof key === 'number') this.emit('exit', key, 1)
    }
    return true
  }

  // The owner's keystrokes (the renderer's operators:write and scratch:write). Terminal replies (focus and cursor
  // reports) are not typing; Enter, Ctrl+C, Ctrl+U and Esc end a draft.
  write(operatorId: SessionKey, data: string): void {
    const s = this.sessions.get(operatorId)
    if (!s) return
    const keys = data.replace(SEQUENCE_RE, '')
    if (keys || data === '\x1b') {
      s.lastOwnerInputAt = this.now()
      for (const ch of keys) {
        if (ch === '\r' || ch === '\n' || ch === '\x03' || ch === '\x15' || ch === '\x1b') s.ownerDraft = false
        else if (ch >= ' ' && ch !== '\x7f') s.ownerDraft = true
      }
    }
    s.pty.write(data)
  }

  resize(operatorId: SessionKey, cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.sessions.get(operatorId)?.pty.resize(cols, rows)
  }

  buffer(operatorId: SessionKey): string {
    return this.sessions.get(operatorId)?.buffer ?? ''
  }

  stopAll(): void {
    for (const s of this.sessions.values()) s.pty.kill()
  }
}
