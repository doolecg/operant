import type { CapProgress, ColdCause, OperatorUsage } from '@shared/types'
import type { Operator } from '@shared/types'
import { Badge } from '@/components/ui/badge'
import { compact, contextWindow, usd } from '@/lib/format'
import { decodeIpcError } from '@shared/ipc'
import { useCapStatus, useResetCaps, useSettings, useUpdateOperator } from '@/lib/queries'
import { CapEditor } from './Caps'

const pct = (n: number) => `${Math.round(n * 100)}%`

const COLD_CAUSE: Record<ColdCause, string> = {
  idle: 'idle past the cache lifetime',
  model: 'model changed',
  prompt: 'prompt changed',
}

function HitRatio({ ratio, warnBelow }: { ratio: number | null; warnBelow: number }) {
  if (ratio == null) return <span className="text-muted-foreground">n/a</span>
  const tone = ratio >= 0.7 ? 'text-emerald-400' : ratio >= warnBelow ? 'text-amber-400' : 'text-red-400'
  const word = ratio >= 0.7 ? 'healthy' : ratio >= warnBelow ? 'low' : 'poor'
  return (
    <span className={tone}>
      {pct(ratio)}
      <span className="sr-only"> ({word})</span>
    </span>
  )
}

function Row({
  usage,
  operator,
  total,
  cap,
  warnPct,
  warnBelow,
  defaultCap,
}: {
  usage: OperatorUsage
  operator: Operator | undefined
  total: number
  cap: CapProgress | undefined
  warnPct: number
  warnBelow: number
  defaultCap: number
}) {
  const update = useUpdateOperator()
  const reset = useResetCaps()
  const err = update.error ?? reset.error
  const contextCap = operator?.contextCap || contextWindow(usage.model)
  const ctxPct = contextCap > 0 ? usage.medianContext / contextCap : 0
  return (
    <tr className="border-b align-top last:border-0 [&>td]:px-3 [&>td]:py-2">
      <td className="min-w-0">
        <div className="max-w-40 truncate font-medium">{usage.address}</div>
        <div className="text-muted-foreground flex items-center gap-1 font-mono text-[10px]">
          {usage.model}
          {usage.unpriced && (
            <Badge variant="outline" className="text-amber-400" title="No list price known: the most expensive known rate is used">
              unpriced
            </Badge>
          )}
        </div>
      </td>
      <td className="text-right tabular-nums">
        {usd(usage.costUsd)}
        <div className="text-muted-foreground text-[10px]">{total > 0 ? pct(usage.costUsd / total) : '0%'} of crew</div>
      </td>
      <td className="text-right tabular-nums">
        <HitRatio ratio={usage.hitRatio} warnBelow={warnBelow} />
      </td>
      <td className="text-right tabular-nums">
        {compact(usage.medianContext)}
        <div className={`text-[10px] ${ctxPct > 0.8 ? 'text-amber-400' : 'text-muted-foreground'}`}>
          {pct(ctxPct)} of {compact(contextCap)}
        </div>
      </td>
      <td className={`text-right tabular-nums ${usage.coldCount >= 3 ? 'text-amber-400' : ''}`}>
        {usage.coldCount}
        {usage.lastColdCause && <div className="text-muted-foreground text-[10px]">last: {COLD_CAUSE[usage.lastColdCause]}</div>}
      </td>
      <td className="text-right tabular-nums">{pct(usage.outputShare)}</td>
      <td className="text-right tabular-nums">{usage.avgCostPerJobUsd == null ? 'n/a' : usd(usage.avgCostPerJobUsd)}</td>
      <td className="w-56">
        {operator ? (
          <CapEditor
            name={usage.address}
            cap={cap ?? usage.cap}
            value={operator.dailyCapUsd == null ? '' : String(operator.dailyCapUsd)}
            placeholder={defaultCap > 0 ? `${defaultCap} (default)` : 'off'}
            warnPct={warnPct}
            busy={update.isPending || reset.isPending}
            error={err ? decodeIpcError(err).message : null}
            onSetCap={(v) => update.mutate([operator.id, { dailyCapUsd: v }])}
            onRaise={(v) => update.mutate([operator.id, { dailyCapUsd: v }])}
            onReset={() => reset.mutate([operator.id])}
          />
        ) : (
          <span className="text-muted-foreground text-[11px]">Deleted operator</span>
        )}
      </td>
    </tr>
  )
}

export function OperatorTable({ operators, usage, total }: { operators: Operator[]; usage: OperatorUsage[]; total: number }) {
  const settings = useSettings()
  const caps = useCapStatus()
  const tokens = settings.data?.tokens
  const warnPct = tokens?.capWarnPct ?? 80
  const warnBelow = (tokens?.coldThresholdPct ?? 50) / 100
  const rows = [...usage].sort((a, b) => b.costUsd - a.costUsd)
  return (
    <section aria-label="Spend per operator" className="space-y-1.5">
      <h3 className="text-sm font-medium">Per operator</h3>
      {rows.length === 0 ? (
        <p className="text-muted-foreground px-1 text-xs">Spend appears here once a Claude Code operator has run.</p>
      ) : (
        <div className="bg-card relative overflow-x-auto rounded-lg border">
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr className="border-b text-right [&>th]:px-3 [&>th]:py-1.5 [&>th]:font-normal">
                <th className="!text-left">Operator</th>
                <th>Spend</th>
                <th>Cache hit</th>
                <th>Median context</th>
                <th title="Turns that rebuilt the whole prompt cache, and why the latest one did.">Cold restarts</th>
                <th>Output share</th>
                <th>Per job</th>
                <th className="!text-left">Daily cap</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <Row
                  key={u.operatorId}
                  usage={u}
                  operator={operators.find((o) => o.id === u.operatorId)}
                  total={total}
                  cap={caps.data?.operators[u.operatorId]}
                  warnPct={warnPct}
                  warnBelow={warnBelow}
                  defaultCap={tokens?.operatorDailyCapUsd ?? 0}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
