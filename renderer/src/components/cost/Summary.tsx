import type { UsageBreakdownResult, UsageCell, UsagePeriod } from '@shared/types'
import { Badge } from '@/components/ui/badge'
import { compact, usd } from '@/lib/format'
import { KindBar, ModelBars } from './Charts'

export const PERIODS: UsagePeriod[] = ['24h', '7d', '30d']
const PERIOD_LABEL: Record<UsagePeriod, string> = { '24h': 'Last 24 hours', '7d': 'Last 7 days', '30d': 'Last 30 days' }
export const periodLabel = (p: UsagePeriod) => PERIOD_LABEL[p]

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-card min-w-0 rounded-lg border px-3.5 py-3">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="text-muted-foreground text-[11px]">{hint}</div>}
    </div>
  )
}

function Box({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="bg-card min-w-0 space-y-2 rounded-lg border px-3.5 py-3">
      <h3 className="text-sm font-medium">{title}</h3>
      {children}
    </section>
  )
}

export function Summary({
  data,
  last24h,
  period,
}: {
  data: UsageBreakdownResult
  last24h: number
  period: UsagePeriod
}) {
  const turns = data.rows.reduce((a, r) => a + r.turns, 0)
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Today" value={usd(data.today)} hint="Since midnight, this crew" />
        <Stat label="Last 24 hours" value={usd(last24h)} hint="This crew, list prices" />
        <Stat label={periodLabel(period)} value={usd(data.totalUsd)} hint={`${compact(turns)} turns`} />
      </div>
      <div className="grid grid-cols-1 gap-3">
        <Box title="By token kind">
          <KindBar byKind={data.byKind} />
        </Box>
        <Box title="By model">
          <ModelBars byModel={data.byModel} />
        </Box>
      </div>
    </div>
  )
}

export function KindModelTable({ rows }: { rows: UsageCell[] }) {
  if (rows.length === 0) return null
  return (
    <section aria-label="Tokens by kind and model" className="space-y-1.5">
      <h3 className="text-sm font-medium">Tokens and cost by model</h3>
      <div className="bg-card relative overflow-x-auto rounded-lg border">
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr className="border-b text-right [&>th]:px-3 [&>th]:py-1.5 [&>th]:font-normal">
              <th className="!text-left">Model</th>
              <th>Uncached in</th>
              <th>Output</th>
              <th>Cache read</th>
              <th>5m write</th>
              <th>1h write</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {rows.map((r) => (
              <tr key={`${r.group}:${r.model}`} className="border-b text-right last:border-0 [&>td]:px-3 [&>td]:py-1.5">
                <td className="!text-left font-mono">
                  {r.model}
                  {r.group === 'scratch' && (
                    <Badge variant="outline" className="ml-2">
                      scratch
                    </Badge>
                  )}
                </td>
                <td>{compact(r.inputTokens)}</td>
                <td>{compact(r.outputTokens)}</td>
                <td>{compact(r.cacheRead)}</td>
                <td>{compact(r.cacheW5m)}</td>
                <td>{compact(r.cacheW1h)}</td>
                <td>{usd(r.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
