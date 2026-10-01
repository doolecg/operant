import { Play, Plus } from 'lucide-react'
import { StatStrip } from '@/components/dashboard/StatStrip'
import { StatusDot } from '@/components/dashboard/StatusDot'
import { SquadHeader } from '@/components/operators/GroupMenus'
import { useOperatorActions } from '@/components/operators/OperatorActions'
import { MasterCard, OperatorCard } from '@/components/operators/OperatorCard'
import { useOperatorData } from '@/components/operators/useOperatorData'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { errorText } from '@/components/dashboard/Dialogs'
import { useIndexStatus, useMaster, useStartMaster, useSummary } from '@/lib/queries'
import type { ViewProps } from '@/registry'

export function CardsView({ crewId, crew, onOpenOperator, onAddOperator, onAddSquad }: ViewProps) {
  const summary = useSummary()
  const index = useIndexStatus(crewId)
  const master = useMaster(crewId)
  const startMaster = useStartMaster()
  const data = useOperatorData(crewId)
  const { run, dialogs } = useOperatorActions(crew, onOpenOperator)
  const address = (role: string) => `${role}@${crew.name}`

  return (
    <ScrollArea className="h-full">
      <div className="space-y-6 p-6">
        <StatStrip summary={summary.data} index={index.data} />

        {master.data ? (
          <MasterCard master={master.data} address={address('master')} unread={data.unreadMaster} run={run} />
        ) : (
          <div className="bg-card flex items-center gap-3 rounded-lg border border-dashed p-3.5">
            <StatusDot status="stopped" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">Master Terminal</div>
              <div className="text-muted-foreground text-[11px]">Your own Claude Code in this crew, with elevated rights on the job board.</div>
              {startMaster.error != null && <p className="text-destructive text-xs">{errorText(startMaster.error)}</p>}
            </div>
            <Button size="sm" className="h-7" disabled={startMaster.isPending} onClick={() => startMaster.mutate([crewId])}>
              <Play className="size-3" /> Start
            </Button>
          </div>
        )}

        {crew.squads.length === 0 ? (
          <div className="grid place-items-center rounded-lg border border-dashed p-10 text-center">
            <div className="space-y-3">
              <p className="font-medium">No squads yet</p>
              <p className="text-muted-foreground max-w-sm text-sm">
                A squad groups operators that work together, such as <code>dev</code> or <code>review</code>. Add one, then add
                operators to it.
              </p>
              <Button onClick={onAddSquad}>
                <Plus /> Add squad
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {crew.squads.map((squad) => (
              <section key={squad.id}>
                <SquadHeader squad={squad} onAddOperator={() => onAddOperator(squad.id)} />
                <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
                  {squad.operators.map((operator) => (
                    <OperatorCard
                      key={operator.id}
                      operator={operator}
                      address={address(operator.role)}
                      extras={data.extras(operator)}
                      presets={data.presets}
                      capWarnPct={data.capWarnPct}
                      run={run}
                    />
                  ))}
                  {squad.operators.length === 0 && (
                    <button
                      onClick={() => onAddOperator(squad.id)}
                      className="text-muted-foreground hover:text-foreground hover:border-foreground/30 grid min-h-32 place-items-center rounded-lg border border-dashed text-sm transition-colors"
                    >
                      Add the first operator
                    </button>
                  )}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
      {dialogs}
    </ScrollArea>
  )
}
