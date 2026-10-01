import { useState } from 'react'
import type { UsagePeriod } from '@shared/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { DailyCap } from '@/components/cost/DailyCap'
import { OperatorTable } from '@/components/cost/OperatorTable'
import { PurgeLine } from '@/components/cost/Purge'
import { KindModelTable, PERIODS, Summary, periodLabel } from '@/components/cost/Summary'
import { WasteSignals } from '@/components/cost/Waste'
import { usd } from '@/lib/format'
import { useSpendSeries, useUsageBreakdown } from '@/lib/queries'
import type { TabProps } from '@/registry'

export function CostPanel({ crewId, operators }: TabProps) {
  const [period, setPeriod] = useState<UsagePeriod>('24h')
  const breakdown = useUsageBreakdown(crewId, period)
  const spend = useSpendSeries(crewId)
  const data = breakdown.data
  const series = spend.data ?? []
  const last24h = series.reduce((a, s) => a + s.total, 0)

  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 p-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h2 className="text-sm font-semibold">Cost</h2>
          <span className="text-muted-foreground min-w-0 basis-full text-[11px]">Estimated from operator transcripts at list prices</span>
          <div role="group" aria-label="Period" className="ml-auto flex gap-1">
            {PERIODS.map((p) => (
              <Button key={p} size="xs" variant={p === period ? 'secondary' : 'ghost'} aria-pressed={p === period} onClick={() => setPeriod(p)}>
                {periodLabel(p)}
              </Button>
            ))}
          </div>
        </div>

        {!data ? (
          <p className="text-muted-foreground px-1 text-xs">{breakdown.error ? 'The cost breakdown could not be loaded.' : 'Loading...'}</p>
        ) : (
          <>
            <Summary data={data} last24h={last24h} period={period} />
            <DailyCap />
            <WasteSignals waste={data.waste} operators={data.operators} />
            <OperatorTable operators={operators} usage={data.operators} total={data.totalUsd} />
            <section aria-label="Scratch spend" className="bg-card flex items-center gap-3 rounded-lg border px-3.5 py-2.5 text-xs">
              <span className="font-medium">Scratch terminals</span>
              <Badge variant="outline">not an operator</Badge>
              <span className="text-muted-foreground">
                {data.scratch.turns} turns, counted toward the daily budget but not toward any operator.
              </span>
              <span className="ml-auto text-sm font-semibold tabular-nums">{usd(data.scratch.costUsd)}</span>
            </section>
            <KindModelTable rows={data.rows} />
          </>
        )}
        <PurgeLine />
      </div>
    </ScrollArea>
  )
}
