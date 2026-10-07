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
}

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

  start({ operator, address, cwd, key = operator?.id, env: extraEnv, command, firstInput }: LaunchSpec, cols = 120, rows = 32): void {
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
    const session: Session = { pty, buffer: '', lastOutputAt: this.now() }
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
      if (firstInput) pty.write(`${firstInput}\r`)
    }
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

  // Types one of Operant's fixed lines (nudge, /clear, /exit) plus Enter. Anything else is refused.
  typeFixed(key: SessionKey, line: string): boolean {
    if (!isFixedLine(line)) throw new Error('not a fixed Operant line')
    const s = this.sessions.get(key)
    if (!s) return false
    s.pty.write(`${line}\r`)
    return true
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

  write(operatorId: SessionKey, data: string): void {
    this.sessions.get(operatorId)?.pty.write(data)
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
