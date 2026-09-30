import { Play, Plus, Square, SquareTerminal } from 'lucide-react'
import type { SquadWithOperators, Operator, OperatorContext, Task } from '@shared/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { agentLabel, compact, contextWindow, statusLabel } from '@/lib/format'
import { useAction } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { StatusDot } from './StatusDot'

interface Props {
  crewName: string
  squads: SquadWithOperators[]
  tasks: Task[]
  contexts: Record<number, OperatorContext>
  onOpenOperator: (operator: Operator) => void
  onAddOperator: (squadId: number) => void
  onAddSquad: () => void
}

export function Topology({ crewName, squads, tasks, contexts, onOpenOperator, onAddOperator, onAddSquad }: Props) {
  if (squads.length === 0) {
    return (
      <div className="grid h-full place-items-center rounded-lg border border-dashed p-10 text-center">
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
    )
  }

  return (
    <div className="space-y-6">
      {squads.map((squad) => (
        <section key={squad.id}>
          <div className="mb-2.5 flex items-center gap-2">
            <h3 className="text-sm font-medium">{squad.name}</h3>
            <span className="text-muted-foreground text-xs tabular-nums">
              {squad.operators.filter((s) => s.status === 'running').length}/{squad.operators.length} running
            </span>
            <div className="bg-border ml-2 h-px flex-1" />
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => onAddOperator(squad.id)}>
              <Plus className="size-3.5" /> Operator
            </Button>
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3">
            {squad.operators.map((operator) => (
              <OperatorCard
                key={operator.id}
                operator={operator}
                address={`${operator.role}@${crewName}`}
                task={tasks.find((t) => t.operatorId === operator.id && t.state === 'doing')}
                context={contexts[operator.id]}
                onOpen={() => onOpenOperator(operator)}
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
  )
}

function ContextPill({ context }: { context: OperatorContext }) {
  const pct = Math.min(1, context.contextTokens / contextWindow(context.model))
  return (
    <div className="ml-auto flex items-center gap-1.5" title={`${context.contextTokens.toLocaleString()} tokens in context`}>
      <div className="bg-muted h-1.5 w-12 overflow-hidden rounded-full">
        <div
          className={cn('h-full rounded-full', pct > 0.8 ? 'bg-red-400' : pct > 0.5 ? 'bg-amber-400' : 'bg-emerald-400')}
          style={{ width: `${Math.max(4, pct * 100)}%` }}
        />
      </div>
      <span className="text-muted-foreground text-[11px] tabular-nums">{compact(context.contextTokens)}</span>
    </div>
  )
}

function OperatorCard({
  operator,
  address,
  task,
  context,
  onOpen,
}: {
  operator: Operator
  address: string
  task?: Task
  context?: OperatorContext
  onOpen: () => void
}) {
  const start = useAction('operators:start')
  const stop = useAction('operators:stop')
  const running = operator.status === 'running'

  return (
    <div
      className={cn(
        'bg-card group flex flex-col gap-3 rounded-lg border p-3.5 transition-colors',
        running && 'border-emerald-500/30',
        operator.status === 'error' && 'border-red-500/40',
      )}
    >
      <div className="flex items-start gap-2.5">
        <StatusDot status={operator.status} className="mt-1.5" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{operator.role}</div>
          <div className="text-muted-foreground truncate font-mono text-[11px]">{address}</div>
        </div>
        <span className="text-muted-foreground text-[11px]">{statusLabel[operator.status]}</span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="secondary" className="font-normal">
          {agentLabel[operator.agent]}
        </Badge>
        {operator.agent !== 'shell' && (
          <Badge variant="outline" className="font-mono font-normal">
            {operator.model}
          </Badge>
        )}
        {context && <ContextPill context={context} />}
      </div>

      <div className="text-muted-foreground min-h-4 truncate text-xs">
        {task ? (
          <>
            <span className="text-foreground">Working on:</span> {task.title}
          </>
        ) : (
          'No task in progress'
        )}
      </div>

      <div className="flex gap-2">
        {running ? (
          <Button size="sm" variant="secondary" className="h-7 flex-1" onClick={() => stop.mutate([operator.id])}>
            <Square className="size-3" /> Stop
          </Button>
        ) : (
          <Button size="sm" className="h-7 flex-1" onClick={() => start.mutate([operator.id])} disabled={start.isPending}>
            <Play className="size-3" /> Start
          </Button>
        )}
        <Button size="sm" variant="outline" className="h-7 flex-1" onClick={onOpen} disabled={!running}>
          <SquareTerminal className="size-3" /> Terminal
        </Button>
      </div>
    </div>
  )
}
