import { EventEmitter } from 'node:events'
import type { AgentKind, Operator } from '../shared/types'
import { defaultShell, type PathEnv, type ShellSpec } from './paths'

// The subset of node-pty that sessions use, so tests can pass a fake.
export interface Pty {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(cb: (data: string) => void): unknown
  onExit(cb: (e: { exitCode: number }) => void): unknown
}

export type PtyFactory = (
  file: string,
  args: string[],
  opts: { cwd: string; cols: number; rows: number; env: Record<string, string> },
) => Pty

export interface LaunchSpec {
  operator: Operator
  address: string
  cwd: string
  pluginDir: string
  // Claude operators get a known session id so Operant can find the operator's transcript.
  sessionId?: string
}

// Output kept per operator so a newly opened terminal can replay recent history.
const BUFFER_LIMIT = 256 * 1024

const quote = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s)

// The line typed into the operator's shell. The shell stays open after the agent exits.
export function agentCommand(agent: AgentKind, model: string, pluginDir: string, sessionId?: string): string | null {
  switch (agent) {
    case 'claude':
      return ['claude', '--model', model, '--plugin-dir', quote(pluginDir), ...(sessionId ? ['--session-id', sessionId] : [])].join(' ')
    case 'codex':
      return ['codex', '-m', model].join(' ')
    case 'shell':
      return null
  }
}

interface Session {
  pty: Pty
  buffer: string
}

export interface SessionEvents {
  data: [operatorId: number, data: string]
  exit: [operatorId: number, exitCode: number]
}

export class SessionManager extends EventEmitter<SessionEvents> {
  private readonly sessions = new Map<number, Session>()
  private shellOverride: ShellSpec | null = null

  constructor(
    private readonly spawn: PtyFactory,
    private readonly pathEnv?: PathEnv,
  ) {
    super()
  }

  // Applies to operators started from now on; null goes back to the system default shell.
  setShell(spec: ShellSpec | null): void {
    this.shellOverride = spec
  }

  isRunning(operatorId: number): boolean {
    return this.sessions.has(operatorId)
  }

  start({ operator, address, cwd, pluginDir, sessionId }: LaunchSpec, cols = 120, rows = 32): void {
    if (this.sessions.has(operator.id)) return
    const sh = this.shellOverride ?? defaultShell(this.pathEnv)
    const env = {
      ...(process.env as Record<string, string>),
      OPERANT_OPERATOR: address,
      OPERANT_OPERATOR_ID: String(operator.id),
    }
    const pty = this.spawn(sh.file, sh.args, { cwd, cols, rows, env })
    const session: Session = { pty, buffer: '' }
    this.sessions.set(operator.id, session)

    pty.onData((data) => {
      session.buffer = (session.buffer + data).slice(-BUFFER_LIMIT)
      this.emit('data', operator.id, data)
    })
    pty.onExit(({ exitCode }) => {
      this.sessions.delete(operator.id)
      this.emit('exit', operator.id, exitCode)
    })

    const cmd = agentCommand(operator.agent, operator.model, pluginDir, sessionId)
    if (cmd) pty.write(`${cmd}\r`)
  }

  stop(operatorId: number): void {
    this.sessions.get(operatorId)?.pty.kill()
  }

  write(operatorId: number, data: string): void {
    this.sessions.get(operatorId)?.pty.write(data)
  }

  resize(operatorId: number, cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.sessions.get(operatorId)?.pty.resize(cols, rows)
  }

  buffer(operatorId: number): string {
    return this.sessions.get(operatorId)?.buffer ?? ''
  }

  stopAll(): void {
    for (const s of this.sessions.values()) s.pty.kill()
  }
}
