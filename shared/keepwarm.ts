// Keep-warm for a Chat tile: the owner turns it on with /keepwarm; while the tile is idle Operant sends one tiny message
// shortly before Claude's prompt cache would expire, so the next real message still reads the cache. Everything here is
// pure (the command parser, the scheduler decision, the status text) so the process layer and the renderer share it.

export const PING_PROMPT = 'Reply with the single word: warm'
export const DEFAULT_WINDOW_MS = 6 * 3_600_000
export const MAX_WINDOW_MS = 24 * 3_600_000
export const MIN_WINDOW_MS = 60_000

// What the renderer shows (ChatState.keepWarm); null when keep-warm was never turned on for the tile.
export interface KeepWarmView {
  active: boolean
  // No end: runs until /keepwarm off, a closed tile, errors or the budget.
  always: boolean
  endsAt: number | null
  ttlMs: number
  lastActivityAt: number | null
  nextPingAt: number | null
  pings: number
  lastPing: { at: number; cacheRead: number; usd: number | null; ok: boolean } | null
  // Why it is not running (shown instead of the status line badge): "Stopped by restart".
  stopped: string | null
}

export type KeepWarmCommand = { kind: 'start'; ms: number | null } | { kind: 'off' } | { kind: 'status' } | { kind: 'invalid'; error: string }

// "6h", "90m", "1h30m", "2d" as milliseconds; null when it is not a duration.
export function parseWindow(raw: string): number | null {
  const m = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/i.exec(raw.trim())
  if (!m || (!m[1] && !m[2] && !m[3])) return null
  return (Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 3_600_000 + Number(m[3] ?? 0) * 60_000
}

// null when the text is not a /keepwarm command. The command is Operant's own: it is never sent to Claude.
export function parseKeepWarm(text: string): KeepWarmCommand | null {
  const m = /^\/keepwarm(?:\s+(.*))?$/i.exec(text.trim())
  if (!m) return null
  const arg = (m[1] ?? '').trim().toLowerCase()
  if (arg === '') return { kind: 'start', ms: DEFAULT_WINDOW_MS }
  if (arg === 'off' || arg === 'stop') return { kind: 'off' }
  if (arg === 'status') return { kind: 'status' }
  if (arg === 'always') return { kind: 'start', ms: null }
  const ms = parseWindow(arg)
  if (ms === null) return { kind: 'invalid', error: `Not a keep-warm window: "${arg}". Use /keepwarm, /keepwarm 90m, /keepwarm always, /keepwarm off or /keepwarm status.` }
  if (ms < MIN_WINDOW_MS) return { kind: 'invalid', error: 'The shortest keep-warm window is 1m.' }
  if (ms > MAX_WINDOW_MS) return { kind: 'invalid', error: 'The longest keep-warm window is 24h. Use /keepwarm always for longer.' }
  return { kind: 'start', ms }
}

// ---- the scheduler

// Ping this long before the cache expires: 55m for the 1 hour cache, 4m30s for the 5 minute one.
export function pingLeadMs(ttlMs: number): number {
  return ttlMs >= 3_600_000 ? 5 * 60_000 : 30_000
}

export interface PingInput {
  now: number
  // The end of the newest API call; null when nothing was sent yet (no cache to keep).
  lastActivity: number | null
  lastPingAt: number | null
  ttlMs: number
  // A turn runs or a prompt waits.
  busy: boolean
  endsAt: number | null
}

export type PingDecision =
  | { action: 'send' }
  | { action: 'stop'; reason: 'window' }
  // `at`: when to look again (null: on the next event, e.g. the end of a turn).
  | { action: 'wait'; at: number | null; reason: 'not-due' | 'busy' | 'cold' | 'no-activity' }

export function decidePing(i: PingInput): PingDecision {
  if (i.endsAt !== null && i.now >= i.endsAt) return { action: 'stop', reason: 'window' }
  if (i.lastActivity === null) return { action: 'wait', at: i.endsAt, reason: 'no-activity' }
  const lead = pingLeadMs(i.ttlMs)
  const interval = i.ttlMs - lead
  const due = Math.max(i.lastActivity + interval, i.lastPingAt === null ? 0 : i.lastPingAt + interval)
  const cap = (t: number): number => (i.endsAt !== null ? Math.min(t, i.endsAt) : t)
  // A cold cache is not worth a ping: the next real message writes it again.
  if (i.now >= i.lastActivity + i.ttlMs) return { action: 'wait', at: i.endsAt, reason: 'cold' }
  if (i.now < due) return { action: 'wait', at: cap(due), reason: 'not-due' }
  if (i.busy) return { action: 'wait', at: null, reason: 'busy' }
  return { action: 'send' }
}

export type WarmBadge = 'warm' | 'cooling' | 'cold'

export function warmBadge(now: number, lastActivity: number | null, ttlMs: number): WarmBadge | null {
  if (lastActivity === null) return null
  const age = now - lastActivity
  if (age >= ttlMs) return 'cold'
  return age > ttlMs * 0.8 ? 'cooling' : 'warm'
}

// ---- text

// "5h10m", "50m", "4m30s", "40s".
export function formatSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 10) return s % 60 ? `${m}m${s % 60}s` : `${m}m`
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h}h${m % 60}m` : `${h}h`
}

export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(Math.round(n))
}

export const formatCost = (usd: number): string => (usd > 0 && usd < 0.005 ? '<$0.01' : `$${usd.toFixed(2)}`)

export interface KeepWarmLine {
  badge: WarmBadge | 'off'
  // Everything after the badge, parts that are unknown left out: "keepwarm 5h10m left", "ping in 50m", "last ping read 61k $0.03".
  parts: string[]
}

export function keepWarmLine(v: KeepWarmView, now: number): KeepWarmLine {
  if (!v.active) return { badge: 'off', parts: [v.stopped ?? 'stopped'] }
  const parts: string[] = []
  if (v.always) parts.push('keepwarm always')
  else if (v.endsAt !== null) parts.push(`keepwarm ${formatSpan(v.endsAt - now)} left`)
  if (v.nextPingAt !== null) parts.push(v.nextPingAt > now ? `ping in ${formatSpan(v.nextPingAt - now)}` : 'pinging now')
  if (v.lastPing) parts.push(v.lastPing.ok ? `last ping read ${formatCount(v.lastPing.cacheRead)}${v.lastPing.usd !== null ? ` ${formatCost(v.lastPing.usd)}` : ''}` : 'last ping failed')
  return { badge: warmBadge(now, v.lastActivityAt, v.ttlMs) ?? 'cold', parts }
}

// The reply to /keepwarm status and the confirmations.
export function keepWarmSummary(v: KeepWarmView | null, now: number): string {
  if (!v || !v.active) return v?.stopped ? `Keep-warm is off (${v.stopped.toLowerCase()}).` : 'Keep-warm is off.'
  const l = keepWarmLine(v, now)
  return `Keep-warm is on (${l.badge}): ${l.parts.join(' · ')}. ${v.pings} ping${v.pings === 1 ? '' : 's'} sent.`
}
