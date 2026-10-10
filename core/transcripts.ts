import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { claudeProjectsDir, type PathEnv } from './paths'
import { costUsd, isPriced, type TokenUsage } from './pricing'

// Claude Code stores a session at projects/<cwd with every non-alphanumeric char as "-">/<session id>.jsonl.
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

// Claude Code encodes its real working directory, so resolve 8.3 short names (C:\Users\ABCDEF~1)
// and symlinks first or the folder name won't match.
export function transcriptProjectDir(cwd: string, env?: PathEnv): string {
  let real = cwd
  try {
    real = realpathSync.native(cwd)
  } catch {
    /* folder missing: fall back to the path as given */
  }
  return join(claudeProjectsDir(env), encodeProjectDir(real))
}

export function transcriptPath(cwd: string, sessionId: string, env?: PathEnv): string {
  return join(transcriptProjectDir(cwd, env), `${sessionId}.jsonl`)
}

export interface MessageUsage extends TokenUsage {
  messageId: string
  model: string
  at: number
  costUsd: number
  // No price row for the model: the cost is the conservative fallback.
  unpriced: boolean
  // Tokens the model saw on this turn: roughly how full the context window is.
  contextTokens: number
  // True when this line's content block is a tool call. Each block of one message is its own line, so
  // callers OR the flag across lines that share a messageId.
  toolUse: boolean
}

interface RawUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
}

// One API message is written as several lines (one per content block) that repeat the same usage,
// so callers key on messageId.
export function parseLine(line: string): MessageUsage | null {
  let o: {
    type?: string
    timestamp?: string
    message?: { id?: string; model?: string; usage?: RawUsage; content?: unknown }
  }
  try {
    o = JSON.parse(line)
  } catch {
    return null
  }
  const m = o.message
  if (o.type !== 'assistant' || !m?.id || !m.usage || !m.model || m.model === '<synthetic>') return null
  const u = m.usage
  const write = u.cache_creation_input_tokens ?? 0
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0
  const w5m = u.cache_creation ? (u.cache_creation.ephemeral_5m_input_tokens ?? 0) : write
  const tokens: TokenUsage = {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWrite5mTokens: w5m,
    cacheWrite1hTokens: w1h,
  }
  return {
    ...tokens,
    messageId: m.id,
    model: m.model,
    at: o.timestamp ? Date.parse(o.timestamp) : Date.now(),
    costUsd: costUsd(m.model, tokens),
    unpriced: !isPriced(m.model),
    contextTokens: tokens.inputTokens + tokens.cacheReadTokens + write,
    toolUse: Array.isArray(m.content) && m.content.some((c: { type?: string } | null) => c?.type === 'tool_use'),
  }
}

// Reads a growing JSONL file incrementally, returning only complete new lines.
export class JsonlTail {
  private offset = 0
  private partial = ''

  constructor(readonly file: string) {}

  read(): string[] {
    if (!existsSync(this.file)) return []
    const size = statSync(this.file).size
    if (size < this.offset) {
      this.offset = 0
      this.partial = ''
    }
    if (size === this.offset) return []
    const fd = openSync(this.file, 'r')
    try {
      const buf = Buffer.alloc(size - this.offset)
      readSync(fd, buf, 0, buf.length, this.offset)
      this.offset = size
      const text = this.partial + buf.toString('utf8')
      const lines = text.split('\n')
      this.partial = lines.pop() ?? ''
      return lines.filter((l) => l.trim())
    } finally {
      closeSync(fd)
    }
  }
}
