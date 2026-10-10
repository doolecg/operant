import { homedir } from 'node:os'
import { join } from 'node:path'

// What Operant needs from an OpenCode message: a finished assistant turn and its token counts.
export interface OpenCodeTurn {
  id: string
  at: number
  model: string
  provider: string
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheWrite: number
  costUsd: number
}

export const openCodeDbPath = (home = homedir()): string => join(home, '.local', 'share', 'opencode', 'opencode.db')

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

// One OpenCode message row (its `data` column is JSON). Reasoning tokens count as output, as they are billed.
export function parseOpenCodeMessage(id: string, createdAt: number, data: string): OpenCodeTurn | null {
  let o: Record<string, any>
  try {
    o = JSON.parse(data)
  } catch {
    return null
  }
  if (!o || o.role !== 'assistant' || !o.tokens || typeof o.modelID !== 'string') return null
  const t = o.tokens
  const turn: OpenCodeTurn = {
    id,
    at: num(o.time?.created) || createdAt,
    model: o.modelID,
    provider: typeof o.providerID === 'string' ? o.providerID : '',
    inputTokens: num(t.input),
    outputTokens: num(t.output) + num(t.reasoning),
    cacheRead: num(t.cache?.read),
    cacheWrite: num(t.cache?.write),
    costUsd: num(o.cost),
  }
  if (!turn.inputTokens && !turn.outputTokens && !turn.cacheRead && !turn.cacheWrite) return null
  return turn
}
