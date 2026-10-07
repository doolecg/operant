// The console layer: output of the background processes Operant starts, shown inside the app instead of a console window.

export const CONSOLE_SOURCES = ['hindsight', 'opencode', 'claude-run', 'mcp', 'codegraph', 'git', 'providers', 'media', 'discord'] as const
export type ConsoleSource = (typeof CONSOLE_SOURCES)[number]

export type ConsoleStream = 'stdout' | 'stderr' | 'info'

export interface ConsoleLine {
  id: number
  at: number
  source: ConsoleSource
  stream: ConsoleStream
  text: string
  pid?: number
  // A failure: a non-zero exit, a spawn error, or stderr text that says so.
  error: boolean
}

// A background process Operant started and that has not exited yet.
export interface ConsoleProcess {
  pid: number
  source: ConsoleSource
  command: string
  startedAt: number
}
