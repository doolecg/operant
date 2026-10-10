import type { UsageRowOut, UsageTotals, UsageTrend } from '@shared/types'
import { compact, usd } from '@/lib/format'
import { KIND_COLORS } from './palette'

const num = (n: number) => n.toLocaleString()

// The five totals every view starts with; each is the sum of the rows below.
export function TotalsCards({ totals, trend }: { totals: UsageTotals; trend?: UsageTrend | null }) {
  const cards: Array<{ label: string; value: string; title: string; color?: string }> = [
    { label: 'Input', value: compact(totals.inputTokens), title: num(totals.inputTokens), color: KIND_COLORS.input },
    { label: 'Output', value: compact(totals.outputTokens), title: num(totals.outputTokens), color: KIND_COLORS.output },
    { label: 'Cache read', value: compact(totals.cacheRead), title: num(totals.cacheRead), color: KIND_COLORS.cacheRead },
    { label: 'Cache write', value: compact(totals.cacheWrite), title: num(totals.cacheWrite), color: KIND_COLORS.cacheWrite },
    { label: 'Cost', value: usd(totals.costUsd), title: `${usd(totals.costUsd)} over ${totals.turns} turns` },
  ]
  return (
    <section aria-label="Usage totals" className="space-y-1.5">
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
        {cards.map((c) => (
          <div key={c.label} className="bg-card rounded-lg border px-3 py-2" title={c.title}>
            <dt className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
              {c.color && <span className="size-2 rounded-sm" style={{ backgroundColor: c.color }} aria-hidden />}
              {c.label}
            </dt>
            <dd className="text-base font-semibold tabular-nums">{c.value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-muted-foreground px-1 text-[11px]">
        {totals.turns} turn{totals.turns === 1 ? '' : 's'}
        {totals.legacyTurns > 0 && `, ${totals.legacyTurns} imported from Operant 2.8.2 without token kinds (cost only)`}
        {trend && (
          <>
            {'. '}
            {trend.deltaPct == null
              ? `Previous period: ${usd(trend.previous.costUsd)}`
              : `${trend.deltaUsd >= 0 ? '+' : '-'}${usd(Math.abs(trend.deltaUsd))} (${trend.deltaPct >= 0 ? '+' : ''}${Math.round(trend.deltaPct)}%) against the previous period of the same length`}
          </>
        )}
      </p>
    </section>
  )
}

const th = 'px-2 py-1.5 text-right font-medium'
const td = 'px-2 py-1.5 text-right tabular-nums'

export function UsageTable({
  rows,
  totals,
  firstHeading,
  caption,
}: {
  rows: UsageRowOut[]
  totals: UsageTotals
  firstHeading: string
  caption: string
}) {
  if (rows.length === 0) return <p className="text-muted-foreground px-1 text-xs">No usage matches these filters.</p>
  return (
    <div className="bg-card overflow-x-auto rounded-lg border">
      <table className="w-full text-[11px]">
        <caption className="sr-only">{caption}</caption>
        <thead className="text-muted-foreground border-b">
          <tr>
            <th scope="col" className="px-2 py-1.5 text-left font-medium">
              {firstHeading}
            </th>
            <th scope="col" className={th}>Input</th>
            <th scope="col" className={th}>Output</th>
            <th scope="col" className={th}>Cache read</th>
            <th scope="col" className={th}>Cache write</th>
            <th scope="col" className={th}>Cost</th>
            <th scope="col" className={th}>Turns</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((r) => (
            <tr key={r.keys.join('\u0000')}>
              <th scope="row" className="max-w-40 truncate px-2 py-1.5 text-left font-normal" title={r.labels.join(' / ')}>
                {r.labels.join(' / ') || r.keys.join(' / ') || 'Unknown'}
              </th>
              <td className={td} title={num(r.inputTokens)}>{compact(r.inputTokens)}</td>
              <td className={td} title={num(r.outputTokens)}>{compact(r.outputTokens)}</td>
              <td className={td} title={num(r.cacheRead)}>{compact(r.cacheRead)}</td>
              <td className={td} title={num(r.cacheWrite)}>{compact(r.cacheWrite)}</td>
              <td className={`${td} font-medium`}>{usd(r.costUsd)}</td>
              <td className={td}>{r.turns}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t font-medium">
          <tr>
            <th scope="row" className="px-2 py-1.5 text-left">Total</th>
            <td className={td}>{compact(totals.inputTokens)}</td>
            <td className={td}>{compact(totals.outputTokens)}</td>
            <td className={td}>{compact(totals.cacheRead)}</td>
            <td className={td}>{compact(totals.cacheWrite)}</td>
            <td className={td}>{usd(totals.costUsd)}</td>
            <td className={td}>{totals.turns}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
