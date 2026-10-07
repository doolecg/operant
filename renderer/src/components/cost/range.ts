export type RangeId = 'today' | '7d' | '30d' | 'all' | 'custom'

export const RANGES: Array<{ id: RangeId; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: 'all', label: 'All time' },
  { id: 'custom', label: 'Custom' },
]

const DAY = 86_400_000
const startOfDay = (t: number) => {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
// 'YYYY-MM-DD' (an <input type="date"> value) as local midnight, or undefined when it is empty or invalid.
const dateValue = (v: string) => {
  const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(v)
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : undefined
}

// `from` is inclusive and `to` exclusive local milliseconds; an open end is left out so the query key stays stable.
export function rangeBounds(id: RangeId, customFrom: string, customTo: string, now = Date.now()): { from?: number; to?: number } {
  const today = startOfDay(now)
  if (id === 'today') return { from: today }
  if (id === '7d') return { from: today - 6 * DAY }
  if (id === '30d') return { from: today - 29 * DAY }
  if (id === 'all') return {}
  const to = dateValue(customTo)
  return { from: dateValue(customFrom), to: to == null ? undefined : to + DAY }
}

export const rangeIsHourly = (b: { from?: number; to?: number }) => b.from != null && (b.to ?? Date.now()) - b.from <= 2 * DAY
