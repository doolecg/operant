import { Plus } from 'lucide-react'
import type { Operator } from '@shared/types'
import { StatusDot } from '@/components/dashboard/StatusDot'
import { SquadHeader } from '@/components/operators/GroupMenus'
import { OperatorMenu, useOperatorActions, type OperatorActionRunner } from '@/components/operators/OperatorActions'
import { CapBadge, ContextBar, EffortSelect, ModelSelect, PresetBadge, UnreadBadge, hitText } from '@/components/operators/OperatorControls'
import { useOperatorData, type OperatorExtras } from '@/components/operators/useOperatorData'
import { Button } from '@/components/ui/button'
import { statusLabel, usd } from '@/lib/format'
import type { ViewProps } from '@/registry'
import type { Preset } from '@shared/types'

// Narrow panes drop Preset, Hit and Unread so the rest fits without a horizontal scrollbar.
const COLUMNS =
  'grid-cols-[minmax(104px,1.1fr)_minmax(140px,1fr)_minmax(112px,0.8fr)_minmax(60px,0.8fr)_72px_52px_64px_28px] @4xl:grid-cols-[minmax(150px,1.2fr)_minmax(110px,0.8fr)_170px_120px_minmax(130px,1.4fr)_110px_72px_72px_52px_40px_32px]'
const WIDE_ONLY = 'hidden @4xl:block'

const HEADS = ['Operator', 'Preset', 'Model', 'Effort', 'Current job', 'Context', 'Spend', 'Cap', 'Hit', 'Unread', '']
const WIDE_HEADS = new Set(['Preset', 'Hit', 'Unread'])

export function ListView({ crewId, crew, onOpenOperator, onAddOperator, onAddSquad }: ViewProps) {
  const data = useOperatorData(crewId)
  const { run, dialogs } = useOperatorActions(crew, onOpenOperator)

  return (
    <div className="@container h-full overflow-auto">
      <div className="space-y-5 px-4 pt-3 pb-6">
        {crew.squads.length === 0 ? (
          <div className="grid place-items-center rounded-lg border border-dashed p-10 text-center">
            <div className="space-y-3">
              <p className="font-medium">No squads yet</p>
              <Button onClick={onAddSquad}>
                <Plus /> Add squad
              </Button>
            </div>
          </div>
        ) : (
          crew.squads.map((squad) => (
            <section key={squad.id}>
              <SquadHeader squad={squad} onAddOperator={() => onAddOperator(squad.id)} />
              <div role="table" aria-label={`Operators in ${squad.name}`} className="rounded-lg border">
                <div role="row" className={`text-muted-foreground bg-muted/30 grid ${COLUMNS} items-center gap-2 px-3 py-1.5 text-[11px] @4xl:gap-3`}>
                  {HEADS.map((h, i) => (
                    <div key={i} role="columnheader" className={WIDE_HEADS.has(h) ? WIDE_ONLY : undefined}>
                      {h}
                    </div>
                  ))}
                </div>
                {squad.operators.map((operator) => (
                  <Row
                    key={operator.id}
                    operator={operator}
                    address={`${operator.role}@${crew.name}`}
                    extras={data.extras(operator)}
                    presets={data.presets}
                    capWarnPct={data.capWarnPct}
                    run={run}
                  />
                ))}
                {squad.operators.length === 0 && <div className="text-muted-foreground px-3 py-4 text-center text-xs">No operators in this squad.</div>}
              </div>
            </section>
          ))
        )}
      </div>
      {dialogs}
    </div>
  )
}

function Row({
  operator,
  address,
  extras,
  presets,
  capWarnPct,
  run,
}: {
  operator: Operator
  address: string
  extras: OperatorExtras
  presets: Preset[]
  capWarnPct: number
  run: OperatorActionRunner
}) {
  const spend = extras.cap?.spentUsd ?? extras.usage?.costUsd
  return (
    <div role="row" className={`grid ${COLUMNS} items-center gap-2 border-t px-3 py-2 text-xs @4xl:gap-3`}>
      <div role="cell" className="flex min-w-0 items-center gap-2">
        <StatusDot status={operator.status} />
        <div className="min-w-0">
          <div className="truncate font-mono text-[11px]" title={address}>
            {address}
          </div>
          <div className="text-muted-foreground text-[11px]">{statusLabel[operator.status]}</div>
        </div>
      </div>
      <div role="cell" className="hidden flex-wrap items-center gap-1 @4xl:flex">
        <PresetBadge operator={operator} preset={extras.preset} run={run} />
      </div>
      <div role="cell">{operator.agent === 'shell' ? <span className="text-muted-foreground">shell</span> : <ModelSelect operator={operator} presets={presets} />}</div>
      <div role="cell">
        <EffortSelect operator={operator} />
      </div>
      <div role="cell" className="text-muted-foreground truncate" title={extras.job?.title}>
        {extras.job ? extras.job.title : 'None'}
      </div>
      <div role="cell">
        <ContextBar context={extras.context} cap={operator.contextCap} />
      </div>
      <div role="cell" className="tabular-nums" title="Spend today">
        {spend == null ? '-' : usd(spend)}
      </div>
      <div role="cell">
        <CapBadge cap={extras.cap} warnPct={capWarnPct} />
      </div>
      <div role="cell" className={`text-muted-foreground tabular-nums ${WIDE_ONLY}`} title="Cache hit ratio, last 24 hours">
        {hitText(extras.usage?.hitRatio)}
      </div>
      <div role="cell" className={WIDE_ONLY}>
        <UnreadBadge count={extras.unread} label={operator.role} />
      </div>
      <div role="cell">
        <OperatorMenu operator={operator} run={run} />
      </div>
    </div>
  )
}
