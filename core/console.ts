import { CONSOLE_SOURCES, type ConsoleLine, type ConsoleProcess, type ConsoleSource, type ConsoleStream } from '../shared/console'

export const CONSOLE_MAX_LINES = 2000
export const CONSOLE_MAX_BYTES = 1_000_000
export const CONSOLE_MAX_LINE = 2000

// Token-shaped text removed before a line is kept. Never the only guard: callers don't log env values or headers.
const BUILTIN: Array<[RegExp, string]> = [
  [/[\w-]{23,28}\.[\w-]{6,7}\.[\w-]{27,}/g, '[secret]'],
  [/\b(sk|pk|ghp|gho|github_pat|xox[abp])[-_][A-Za-z0-9_-]{16,}/g, '[secret]'],
  [/\bAKIA[A-Z0-9]{12,}/g, '[secret]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [secret]'],
  [/\b(authorization|x-api-key|api-key|cookie)\s*[:=]\s*\S.*$/gi, '$1: [secret]'],
  [/((?:api[_-]?key|token|secret|passw(?:or)?d|credential|auth)\w*["']?\s*[:=]\s*["']?)[^\s"',}]{4,}/gi, '$1[secret]'],
  [/(\/\/[^/@\s:]*:)[^@\s/]+@/g, '$1[secret]@'],
]

export type Scrubber = (text: string) => string

export function scrubConsoleText(text: string): string {
  let out = text
  for (const [re, to] of BUILTIN) out = out.replace(re, to)
  return out
}

const ERROR_TEXT = /\b(error|failed|fatal|exception|panic|traceback)\b/i

// Splits a stream's chunks into whole lines, keeping the unfinished tail for the next chunk.
export class LineBuffer {
  private tail = ''
  push(chunk: string): string[] {
    const parts = (this.tail + chunk).split(/\r?\n/)
    this.tail = parts.pop() ?? ''
    return parts
  }
  flush(): string[] {
    const t = this.tail
    this.tail = ''
    return t ? [t] : []
  }
}

export interface ConsoleLogOptions {
  maxLines?: number
  maxBytes?: number
  maxLine?: number
  now?: () => number
}

// Ring buffer of console lines, capped by count and by size, with secrets scrubbed on the way in.
export class ConsoleLog {
  private lines: ConsoleLine[] = []
  private bytes = 0
  private nextId = 1
  private readonly listeners = new Set<(line: ConsoleLine) => void>()
  private readonly running = new Map<number, ConsoleProcess>()
  private extraScrub: Scrubber | null = null
  private readonly maxLines: number
  private readonly maxBytes: number
  private readonly maxLine: number
  private readonly now: () => number

  constructor(o: ConsoleLogOptions = {}) {
    this.maxLines = o.maxLines ?? CONSOLE_MAX_LINES
    this.maxBytes = o.maxBytes ?? CONSOLE_MAX_BYTES
    this.maxLine = o.maxLine ?? CONSOLE_MAX_LINE
    this.now = o.now ?? Date.now
  }

  // An extra scrubber (the app's own log scrubber) applied after the built-in one.
  setScrubber(fn: Scrubber | null): void {
    this.extraScrub = fn
  }

  add(source: ConsoleSource, stream: ConsoleStream, text: string, opts: { pid?: number; error?: boolean } = {}): ConsoleLine[] {
    const added: ConsoleLine[] = []
    for (const raw of text.split(/\r?\n/)) {
      if (!raw.trim()) continue
      let t = scrubConsoleText(raw)
      if (this.extraScrub) t = this.extraScrub(t)
      if (t.length > this.maxLine) t = `${t.slice(0, this.maxLine)}...`
      const line: ConsoleLine = {
        id: this.nextId++,
        at: this.now(),
        source,
        stream,
        text: t,
        error: opts.error ?? (stream === 'stderr' && ERROR_TEXT.test(t)),
        ...(opts.pid !== undefined ? { pid: opts.pid } : {}),
      }
      this.lines.push(line)
      this.bytes += t.length + 24
      added.push(line)
      for (const l of this.listeners) {
        try {
          l(line)
        } catch {
          // a broken listener must not stop logging
        }
      }
    }
    while (this.lines.length > this.maxLines || (this.bytes > this.maxBytes && this.lines.length > 1)) {
      const old = this.lines.shift()!
      this.bytes -= old.text.length + 24
    }
    return added
  }

  list(filter: { source?: ConsoleSource; afterId?: number } = {}): ConsoleLine[] {
    return this.lines.filter((l) => (!filter.source || l.source === filter.source) && (filter.afterId === undefined || l.id > filter.afterId))
  }

  clear(source?: ConsoleSource): void {
    this.lines = source ? this.lines.filter((l) => l.source !== source) : []
    this.bytes = this.lines.reduce((n, l) => n + l.text.length + 24, 0)
  }

  onLine(fn: (line: ConsoleLine) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  processStarted(p: ConsoleProcess): void {
    this.running.set(p.pid, p)
  }
  processEnded(pid: number): void {
    this.running.delete(pid)
  }
  processes(): ConsoleProcess[] {
    return [...this.running.values()]
  }
  isOwnProcess(pid: number): boolean {
    return this.running.has(pid)
  }
}

export const consoleLog = new ConsoleLog()

export const isConsoleSource = (v: unknown): v is ConsoleSource => typeof v === 'string' && (CONSOLE_SOURCES as readonly string[]).includes(v)
