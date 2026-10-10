import type { ClaudeSessionStatus } from '../shared/claude-mods'
import type { ClaudeModsSettings } from '../shared/settings'

// The Claude Code hooks and status line Operant adds to the tiles it launches (passed with --settings, layered over the
// user's own settings). scripts/op-event.mjs writes what they receive into the events folder.

export interface ModsPaths {
  // The binary that runs the script as Node: the app binary (ELECTRON_RUN_AS_NODE=1) or node.
  node: string
  script: string
  eventsDir: string
}

export interface ClaudeEvent {
  ts: number
  // The tile that launched the session (OPERANT_TILE_ID), null when the event came from another run.
  tile: number | null
  sessionId: string
  name: string
  payload: Record<string, unknown>
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/
// Characters that would break the quoted command line the hook shell runs.
const UNSAFE_PATH = /["$`\n\r\0]/

export const isSafeSessionId = (id: unknown): id is string => typeof id === 'string' && SAFE_ID.test(id)

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

// The command a hook or status line runs. Forward slashes keep it valid in the bash that Claude Code uses on Windows.
export function modsCommand(paths: ModsPaths, mode: 'hook' | 'status'): string | null {
  const parts = [paths.node, paths.script, paths.eventsDir]
  if (parts.some((p) => UNSAFE_PATH.test(p) || p === '')) return null
  const [node, script, dir] = parts.map((p) => `"${p.replace(/\\/g, '/')}"`)
  return `ELECTRON_RUN_AS_NODE=1 ${node} ${script} ${mode} ${dir}`
}

// The hooks Operant's sub-agent panel reads: the session phase events and the sub-agent events. Registered only while
// the subagents mod is on. The status line is set while Claude mods are on (the info bar and context card read it).
// Null when Claude mods are off or a path cannot be quoted safely: the tile then starts without them.
export function claudeModsConfig(paths: ModsPaths, settings: ClaudeModsSettings): { hooks: Record<string, unknown[]>; statusLine: { type: 'command'; command: string } } | null {
  if (!settings.enabled) return null
  const hook = modsCommand(paths, 'hook')
  const status = modsCommand(paths, 'status')
  if (!hook || !status) return null
  const entry = (matcher?: string) => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: hook }] })
  const hooks: Record<string, unknown[]> = {}
  if (settings.mods.subagents) {
    for (const event of ['SessionStart', 'UserPromptSubmit', 'Notification', 'Stop', 'SessionEnd', 'SubagentStart', 'SubagentStop']) hooks[event] = [entry()]
    hooks.PreToolUse = [entry('Agent')]
    hooks.PostToolUse = [entry('Agent')]
  }
  return { hooks, statusLine: { type: 'command', command: status } }
}

// One events-file line; null when it is not a hook event Operant can use.
export function parseEventLine(line: string): ClaudeEvent | null {
  let o: unknown
  try {
    o = JSON.parse(line)
  } catch {
    return null
  }
  const payload = obj(o)
  const name = str(payload.hook_event_name)
  if (!name || !isSafeSessionId(payload.session_id)) return null
  const tile = str(payload.tile)
  const tileId = tile !== undefined && /^\d+$/.test(tile) ? Number(tile) : (num(payload.tile) ?? null)
  return { ts: num(payload.ts) ?? 0, tile: tileId, sessionId: payload.session_id, name, payload }
}

// The status file the status line writes, reduced to the fields Operant shows. Fields the payload lacks stay out.
export function parseStatusFile(text: string): ClaudeSessionStatus | null {
  let o: unknown
  try {
    o = JSON.parse(text)
  } catch {
    return null
  }
  const p = obj(o)
  const out: ClaudeSessionStatus = { updatedAt: num(p.ts) ?? 0 }
  const model = str(obj(p.model).display_name) ?? str(obj(p.model).id)
  if (model) out.model = model
  const ctx = obj(p.context_window)
  const size = num(ctx.context_window_size)
  if (size !== undefined) out.contextWindowSize = size
  const used = num(ctx.used_percentage)
  if (used !== undefined) out.usedPercentage = used
  const usage = obj(ctx.current_usage)
  const current: NonNullable<ClaudeSessionStatus['currentUsage']> = {}
  const pairs: Array<[keyof NonNullable<ClaudeSessionStatus['currentUsage']>, string]> = [
    ['inputTokens', 'input_tokens'],
    ['outputTokens', 'output_tokens'],
    ['cacheCreationTokens', 'cache_creation_input_tokens'],
    ['cacheReadTokens', 'cache_read_input_tokens'],
  ]
  for (const [key, from] of pairs) {
    const v = num(usage[from])
    if (v !== undefined) current[key] = v
  }
  if (Object.keys(current).length) out.currentUsage = current
  const cost = obj(p.cost)
  const usd = num(cost.total_cost_usd)
  if (usd !== undefined) out.costUsd = usd
  const dur = num(cost.total_duration_ms)
  if (dur !== undefined) out.durationMs = dur
  const b = obj(p.breakdown)
  if (Array.isArray(b.rows) && num(b.maxTokens) !== undefined) out.breakdown = p.breakdown as ClaudeSessionStatus['breakdown']
  return out
}
