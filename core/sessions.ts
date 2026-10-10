import { EventEmitter } from 'node:events'
import { killTree } from './proc'
import { hiddenConsoleEnv } from './hideshim'
import { defaultShell, type PathEnv, type ShellSpec } from './paths'

// The subset of node-pty that sessions use, so tests can pass a fake.
export interface Pty {
  pid?: number
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
  key: SessionKey
  cwd: string
  // Extra environment entries (the CLI socket and token), merged over the defaults.
  env?: Record<string, string>
  // The launch line typed into the shell (from launch.ts).
  command?: string | null
}

export type SessionKey = string

// Markers an outer Claude Code session leaves in the environment of what it launches. A Claude started inside a tile
// that inherits them takes itself for a child session and turns transcript saving off.
const OUTER_CLAUDE_SESSION = new Set([
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_PID',
])

// What a session inherits from Operant's own environment: never an outer instance's token or socket, nor the
// flag that makes Electron act as Node, nor the markers of an outer Claude Code session Operant was started from.
export function inheritedEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(source)) {
    const name = k.toUpperCase()
    if (v === undefined || name.startsWith('OPERANT_') || name === 'ELECTRON_RUN_AS_NODE' || OUTER_CLAUDE_SESSION.has(name)) continue
    out[k] = v
  }
  return out
}

// Output kept per session so a newly opened terminal can replay recent history.
const BUFFER_LIMIT = 256 * 1024

interface Session {
  pty: Pty
  buffer: string
}

export interface SessionEvents {
  data: [key: SessionKey, data: string]
  exit: [key: SessionKey, exitCode: number]
}

export class SessionManager extends EventEmitter<SessionEvents> {
  private readonly sessions = new Map<SessionKey, Session>()
  private shellOverride: ShellSpec | null = null

  constructor(
    private readonly spawn: PtyFactory,
    private readonly pathEnv?: PathEnv,
  ) {
    super()
  }

  // Applies to sessions started from now on; null goes back to the system default shell.
  setShell(spec: ShellSpec | null): void {
    this.shellOverride = spec
  }

  isRunning(key: SessionKey): boolean {
    return this.sessions.has(key)
  }

  start({ key, cwd, env: extraEnv, command }: LaunchSpec, cols = 120, rows = 32): void {
    if (this.sessions.has(key)) return
    const sh = this.shellOverride ?? defaultShell(this.pathEnv)
    const env = hiddenConsoleEnv({ ...inheritedEnv(), ...extraEnv }) as Record<string, string>
    const pty = this.spawn(sh.file, sh.args, { cwd, cols, rows, env })
    const session: Session = { pty, buffer: '' }
    this.sessions.set(key, session)

    pty.onData((data) => {
      session.buffer = (session.buffer + data).slice(-BUFFER_LIMIT)
      this.emit('data', key, data)
    })
    pty.onExit(({ exitCode }) => {
      // A session already dropped by forceStop has reported its exit.
      if (this.sessions.get(key) !== session) return
      this.sessions.delete(key)
      this.emit('exit', key, exitCode)
    })

    if (command) pty.write(`${command}\r`)
  }

  stop(key: SessionKey): void {
    this.sessions.get(key)?.pty.kill()
  }

  // For a pty that ignored stop(): kills it harder, then drops the session and reports its exit, so a
  // late real exit changes nothing. Returns false when the session was not running.
  forceStop(key: SessionKey): boolean {
    const session = this.sessions.get(key)
    if (!session) return false
    // The shell's children (a Claude that /exit did not end) go with it.
    if (session.pty.pid) killTree({ pid: session.pty.pid, kill: () => {} })
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
      this.emit('exit', key, 1)
    }
    return true
  }

  write(key: SessionKey, data: string): void {
    this.sessions.get(key)?.pty.write(data)
  }

  resize(key: SessionKey, cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.sessions.get(key)?.pty.resize(cols, rows)
  }

  buffer(key: SessionKey): string {
    return this.sessions.get(key)?.buffer ?? ''
  }

  stopAll(): void {
    for (const s of this.sessions.values()) s.pty.kill()
  }
}
