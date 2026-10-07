import type { UsageSeriesPoint } from '@shared/types'
import { usd } from '@/lib/format'

// Colours for the split series; the legend and every bar's title also print the values, so colour is not the only cue.
const SERIES_COLORS = ['#60a5fa', '#fbbf24', '#34d399', '#c084fc', '#f472b6', '#fb923c']
const OTHER_COLOR = '#94a3b8'
const MAX_SERIES = SERIES_COLORS.length
const DAY_RE = /^\d{4}-\d\d-\d\d$/

// Every day between the first and last bucket, so a quiet day shows as a gap and not as a missing bar.
function filledBuckets(buckets: string[]): string[] {
  if (buckets.length === 0 || !buckets.every((b) => DAY_RE.test(b))) return buckets
  const out: string[] = []
  const end = Date.parse(`${buckets.at(-1)}T00:00:00Z`)
  for (let t = Date.parse(`${buckets[0]}T00:00:00Z`); t <= end && out.length < 400; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10))
  return out
}

const niceMax = (v: number) => {
  if (v <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  const n = v / p
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p
}

export function TrendChart({ points, split }: { points: UsageSeriesPoint[]; split: boolean }) {
  if (points.length === 0) return <p className="text-muted-foreground text-xs">No spend in this range.</p>
  const totals = new Map<string, { label: string; cost: number }>()
  for (const p of points) {
    const t = totals.get(p.split) ?? { label: p.splitLabel || p.split || 'All', cost: 0 }
    t.cost += p.costUsd
    totals.set(p.split, t)
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1].cost - a[1].cost)
  const shown = ranked.slice(0, MAX_SERIES).map(([k]) => k)
  const colorOf = (k: string) => (shown.includes(k) ? SERIES_COLORS[shown.indexOf(k)]! : OTHER_COLOR)
  const hasOther = ranked.length > MAX_SERIES

  const buckets = filledBuckets([...new Set(points.map((p) => p.bucket))])
  const byBucket = new Map<string, UsageSeriesPoint[]>()
  for (const p of points) byBucket.set(p.bucket, [...(byBucket.get(p.bucket) ?? []), p])
  const sumOf = (b: string) => (byBucket.get(b) ?? []).reduce((a, p) => a + p.costUsd, 0)
  const max = niceMax(Math.max(...buckets.map(sumOf)))

  const W = 420
  const H = 130
  const left = 44
  const bottom = 18
  const plotH = H - bottom - 6
  const slot = (W - left - 4) / buckets.length
  const barW = Math.max(1, Math.min(28, slot * 0.7))
  const label = `Cost per ${buckets[0]?.includes(' ') ? 'hour' : 'day'}:${buckets.map((b) => `${b} ${usd(sumOf(b))}`).join(', ')}`

  return (
    <div className="space-y-2">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="w-full">
        {[0, 0.5, 1].map((f) => {
          const y = 6 + plotH - f * plotH
          return (
            <g key={f}>
              <line x1={left} x2={W - 4} y1={y} y2={y} className="stroke-border" strokeWidth={1} />
              <text x={left - 4} y={y + 3} textAnchor="end" fontSize={9} className="fill-muted-foreground tabular-nums">
                {usd(max * f)}
              </text>
            </g>
          )
        })}
        {buckets.map((b, i) => {
          const x = left + i * slot + (slot - barW) / 2
          let y = 6 + plotH
          const parts = new Map<string, number>()
          for (const p of byBucket.get(b) ?? []) {
            const k = shown.includes(p.split) ? p.split : '\u0000other'
            parts.set(k, (parts.get(k) ?? 0) + p.costUsd)
          }
          return (
            <g key={b}>
              <title>{`${b}: ${usd(sumOf(b))}`}</title>
              {[...parts.entries()].map(([k, cost]) => {
                const h = (cost / max) * plotH
                y -= h
                return <rect key={k} x={x} y={y} width={barW} height={Math.max(h, cost > 0 ? 1 : 0)} fill={k === '\u0000other' ? OTHER_COLOR : colorOf(k)} />
              })}
            </g>
          )
        })}
        <text x={left} y={H - 4} fontSize={9} className="fill-muted-foreground">
          {buckets[0]}
        </text>
        {buckets.length > 1 && (
          <text x={W - 4} y={H - 4} textAnchor="end" fontSize={9} className="fill-muted-foreground">
            {buckets.at(-1)}
          </text>
        )}
      </svg>
      {split && (
        <ul aria-label="Legend" className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
          {shown.map((k) => (
            <li key={k} className="flex items-center gap-1.5">
              <span className="size-2.5 shrink-0 rounded-sm" style={{ backgroundColor: colorOf(k) }} aria-hidden />
              <span className="text-muted-foreground max-w-40 truncate">{totals.get(k)!.label}</span>
              <span className="tabular-nums">{usd(totals.get(k)!.cost)}</span>
            </li>
          ))}
          {hasOther && (
            <li className="flex items-center gap-1.5">
              <span className="size-2.5 shrink-0 rounded-sm" style={{ backgroundColor: OTHER_COLOR }} aria-hidden />
              <span className="text-muted-foreground">Other</span>
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
