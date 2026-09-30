import type { Operator, OperatorSpend } from '@shared/types'
import { usd } from '@/lib/format'

function Sparkline({ values, max }: { values: number[]; max: number }) {
  const w = 120
  const h = 28
  const step = values.length > 1 ? w / (values.length - 1) : w
  const y = (v: number) => h - 2 - (max > 0 ? (v / max) * (h - 4) : 0)
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-7 w-[120px] shrink-0 overflow-visible" aria-hidden>
      <polygon points={`0,${h} ${points} ${w},${h}`} className="fill-emerald-400/10" />
      <polyline points={points} fill="none" strokeWidth={1.5} strokeLinejoin="round" className="stroke-emerald-400" />
    </svg>
  )
}

export function CostPanel({ series, operators }: { series: OperatorSpend[]; operators: Operator[] }) {
  const rows = operators
    .map((operator) => ({ operator, spend: series.find((s) => s.operatorId === operator.id) }))
    .filter((r) => r.operator.agent === 'claude' || r.spend)
    .sort((a, b) => (b.spend?.total ?? 0) - (a.spend?.total ?? 0))
  const total = series.reduce((a, s) => a + s.total, 0)
  // One scale for every sparkline so operators compare at a glance.
  const max = Math.max(0, ...series.flatMap((s) => s.buckets))

  return (
    <div className="space-y-4 p-3">
      <div className="bg-card rounded-lg border px-3.5 py-3">
        <div className="text-muted-foreground text-xs">Last 24 hours, this crew</div>
        <div className="text-2xl font-semibold tabular-nums">{usd(total)}</div>
        <div className="text-muted-foreground text-[11px]">Estimated from operator transcripts at list prices</div>
      </div>

      {rows.length === 0 && (
        <p className="text-muted-foreground px-1 text-xs">Spend appears here once a Claude Code operator has run.</p>
      )}
      <div className="space-y-1">
        {rows.map(({ operator, spend }) => (
          <div key={operator.id} className="flex items-center gap-3 rounded-md px-2 py-1.5">
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium">{operator.role}</div>
              <div className="text-muted-foreground font-mono text-[10px]">{operator.model}</div>
            </div>
            <Sparkline values={spend?.buckets ?? Array<number>(24).fill(0)} max={max} />
            <div className="w-16 text-right text-xs tabular-nums">{usd(spend?.total ?? 0)}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
