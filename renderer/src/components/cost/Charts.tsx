import type { KindCost } from '@shared/types'
import { usd } from '@/lib/format'
import { KIND_COLORS, KIND_KEYS, KIND_LABELS, MODEL_COLOR } from './palette'

export function KindBar({ byKind }: { byKind: KindCost }) {
  const total = KIND_KEYS.reduce((a, k) => a + byKind[k], 0)
  const label = `Cost by token kind: ${KIND_KEYS.map((k) => `${KIND_LABELS[k]} ${usd(byKind[k])}`).join(', ')}`
  let x = 0
  return (
    <div className="space-y-2">
      <svg viewBox="0 0 400 16" role="img" aria-label={label} className="h-4 w-full overflow-hidden rounded">
        <rect width={400} height={16} className="fill-muted" />
        {total > 0 &&
          KIND_KEYS.map((k) => {
            const w = (byKind[k] / total) * 400
            const rect = <rect key={k} x={x} width={w} height={16} fill={KIND_COLORS[k]} />
            x += w
            return rect
          })}
      </svg>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs" aria-label="Legend">
        {KIND_KEYS.map((k) => (
          <li key={k} className="flex items-center gap-1.5">
            <span className="size-2.5 shrink-0 rounded-sm" style={{ backgroundColor: KIND_COLORS[k] }} aria-hidden />
            <span className="text-muted-foreground truncate">{KIND_LABELS[k]}</span>
            <span className="ml-auto tabular-nums">{usd(byKind[k])}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function ModelBars({ byModel }: { byModel: Array<{ model: string; costUsd: number }> }) {
  const rows = [...byModel].sort((a, b) => b.costUsd - a.costUsd)
  const max = Math.max(0, ...rows.map((r) => r.costUsd))
  if (rows.length === 0) return <p className="text-muted-foreground text-xs">No spend in this period.</p>
  const rowH = 22
  return (
    <svg
      viewBox={`0 0 400 ${rows.length * rowH}`}
      role="img"
      aria-label={`Cost by model: ${rows.map((r) => `${r.model} ${usd(r.costUsd)}`).join(', ')}`}
      className="w-full"
      style={{ maxHeight: rows.length * rowH * 1.4 }}
    >
      {rows.map((r, i) => {
        const w = max > 0 ? (r.costUsd / max) * 130 : 0
        return (
          <g key={r.model} transform={`translate(0 ${i * rowH})`}>
            <text x={0} y={14} fontSize={11} className="fill-muted-foreground font-mono">
              {r.model.length > 26 ? `${r.model.slice(0, 25)}...` : r.model}
            </text>
            <rect x={200} y={4} width={Math.max(w, r.costUsd > 0 ? 2 : 0)} height={12} rx={2} fill={MODEL_COLOR} />
            <text x={200 + w + 6} y={14} fontSize={11} className="fill-foreground">
              {usd(r.costUsd)}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
