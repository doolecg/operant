// Windows media session (the Spotify/browser "now playing" the volume flyout shows) and the top-bar clock and counts.
// The helper script reports state; the bar's buttons go back as the commands below.

export interface MediaTimeline {
  // Seconds into the track and its length, and when the player last reported the position (ms since 1970).
  pos: number
  dur: number
  at: number
}

export interface MediaState {
  active: boolean
  app?: string
  appName?: string
  title?: string
  artist?: string
  album?: string
  playing?: boolean
  shuffle?: boolean
  canShuffle?: boolean
  canPrev?: boolean
  canNext?: boolean
  canPlayPause?: boolean
  // 0..1, the player's own volume when appVolume is true, else the system volume; -1 when unknown.
  volume?: number
  appVolume?: boolean
  art?: string | null
  timeline?: MediaTimeline | null
}

// The only lines the helper accepts: toggle | next | prev | shuffle | focus | vol <0..1>.
export const MEDIA_COMMAND_RE = /^(toggle|next|prev|shuffle|focus|vol (0|1|0?\.\d+))$/
export const isMediaCommand = (v: unknown): v is string => typeof v === 'string' && MEDIA_COMMAND_RE.test(v)

export type MediaSize = 'compact' | 'full'
export type ClockFormat = 'auto' | '24' | '12'

export interface TopBarSettings {
  mediaControls: boolean
  mediaSize: MediaSize
  clockFormat: ClockFormat
  clockSeconds: boolean
  clockDate: boolean
  agentPill: boolean
}

export function clockText(d: Date, o: { format: ClockFormat; seconds: boolean }, locale?: string): string {
  const hourCycle = o.format === '24' ? 'h23' : o.format === '12' ? 'h12' : undefined
  return d.toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
    ...(o.seconds ? { second: '2-digit' as const } : {}),
    ...(hourCycle ? { hourCycle } : {}),
  })
}

// "Tue 7 Oct".
export const dateText = (d: Date, locale?: string): string =>
  d.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' })

// What a click copies: "Tuesday 7 October 2026, 14:05:09".
export function fullDateTime(d: Date, o: { format: ClockFormat }, locale?: string): string {
  const date = d.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  return `${date}, ${clockText(d, { format: o.format, seconds: true }, locale)}`
}

// ISO 8601 week number.
export function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1)
  return Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7)
}

export interface CalendarWeek {
  week: number
  // Day of month, or null for the padding before the 1st and after the last day.
  days: Array<number | null>
}

// A Monday-first month grid with the ISO week number of each row.
export function monthGrid(d: Date): CalendarWeek[] {
  const y = d.getFullYear()
  const m = d.getMonth()
  const last = new Date(y, m + 1, 0).getDate()
  const lead = (new Date(y, m, 1).getDay() + 6) % 7
  const cells: Array<number | null> = [...Array<null>(lead).fill(null), ...Array.from({ length: last }, (_, i) => i + 1)]
  while (cells.length % 7) cells.push(null)
  const weeks: CalendarWeek[] = []
  for (let i = 0; i < cells.length; i += 7) {
    const days = cells.slice(i, i + 7)
    const first = days.find((x) => x != null) ?? 1
    weeks.push({ week: isoWeek(new Date(y, m, first)), days })
  }
  return weeks
}

export interface AgentCounts {
  running: number
  idle: number
  done: number
  waiting: number
}

// Running = jobs working, idle = queued, waiting = needs you (a question, a permission, a stopped Master or a review), done = finished since `sinceMs`.
export function agentCounts(
  runs: Array<{ status: string; finishedAt?: number | null }>,
  sinceMs: number,
): AgentCounts {
  const c: AgentCounts = { running: 0, idle: 0, done: 0, waiting: 0 }
  for (const r of runs) {
    if (r.status === 'working') c.running++
    else if (r.status === 'queued') c.idle++
    else if (r.status === 'needs-you' || r.status === 'review') c.waiting++
    else if (r.status === 'done' && (r.finishedAt ?? 0) >= sinceMs) c.done++
  }
  return c
}
