import { Play, Square, SquareTerminal } from 'lucide-react'
import type { Operator, Preset } from '@shared/types'
import { StatusDot } from '@/components/dashboard/StatusDot'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { agentLabel, statusLabel } from '@/lib/format'
import { cn } from '@/lib/utils'
import { CapBadge, ContextBar, EffortSelect, ModelSelect, PausedActions, PresetBadge, UnreadBadge, hitText } from './OperatorControls'
import { OperatorMenu, type OperatorActionRunner } from './OperatorActions'
import type { OperatorExtras } from './useOperatorData'

export function OperatorCard({
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
  const running = operator.status !== 'stopped'
  const paused = extras.cap?.paused === true
  return (
    <div
      className={cn(
        'bg-card flex flex-col gap-3 rounded-lg border p-3.5 transition-colors',
        operator.status === 'running' && 'border-emerald-500/30',
        operator.status === 'error' && 'border-red-500/40',
        paused && 'border-red-500/40',
      )}
    >
      <div className="flex items-start gap-2.5">
        <StatusDot status={operator.status} className="mt-1.5" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{operator.role}</div>
          <div className="text-muted-foreground truncate font-mono text-[11px]">{address}</div>
        </div>
        <UnreadBadge count={extras.unread} label={operator.role} />
        <span className="text-muted-foreground text-[11px]">{statusLabel[operator.status]}</span>
        <OperatorMenu operator={operator} run={run} className="-mt-1 -mr-1.5 size-7" />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {operator.agent !== 'claude' && (
          <Badge variant="outline" className="font-normal">
            {agentLabel[operator.agent]}
          </Badge>
        )}
        <PresetBadge operator={operator} preset={extras.preset} run={run} />
        <CapBadge cap={extras.cap} warnPct={capWarnPct} />
      </div>

      {operator.agent !== 'shell' && (
        <div className="grid grid-cols-2 gap-2">
          <ModelSelect operator={operator} presets={presets} className={operator.agent === 'claude' && !operator.model.includes('haiku') ? '' : 'col-span-2'} />
          <EffortSelect operator={operator} />
        </div>
      )}

      <div className="text-muted-foreground min-h-4 truncate text-xs" title={extras.job?.title}>
        {extras.job ? (
          <>
            <span className="text-foreground">Working on:</span> {extras.job.title}
          </>
        ) : (
          'No job in progress'
        )}
      </div>

      {(extras.context || extras.usage) && (
        <div className="flex items-center justify-between gap-2">
          <ContextBar context={extras.context} cap={operator.contextCap} />
          {extras.usage && (
            <span className="text-muted-foreground text-[11px] tabular-nums" title="Cache hit ratio, last 24 hours">
              hit {hitText(extras.usage.hitRatio)}
            </span>
          )}
        </div>
      )}

      {paused ? (
        <PausedActions operator={operator} run={run} />
      ) : (
        <div className="flex gap-2">
          {running ? (
            <Button size="sm" variant="secondary" className="h-7 flex-1" onClick={() => run('stop', operator)}>
              <Square className="size-3" /> Stop
            </Button>
          ) : (
            <Button size="sm" className="h-7 flex-1" onClick={() => run('start', operator)}>
              <Play className="size-3" /> Start
            </Button>
          )}
          <Button size="sm" variant="outline" className="h-7 flex-1" onClick={() => run('terminal', operator)} disabled={!running}>
            <SquareTerminal className="size-3" /> Terminal
          </Button>
        </div>
      )}
    </div>
  )
}

// The Master Terminal: one pinned card per crew. It can be started, stopped, opened, messaged and its launch
// command (model, effort, mode) edited; it runs the user's own Claude Code and is not deleted.
export function MasterCard({
  master,
  address,
  unread,
  run,
}: {
  master: Operator
  address: string
  unread: number
  run: OperatorActionRunner
}) {
  const running = master.status !== 'stopped'
  return (
    <div className={cn('bg-card flex items-center gap-3 rounded-lg border border-dashed p-3.5', master.status === 'running' && 'border-emerald-500/40')}>
      <StatusDot status={master.status} />
      <div className="min-w-0 flex-1">
        <div className="font-medium">Master Terminal</div>
        <div className="text-muted-foreground truncate font-mono text-[11px]">{address}: your own Claude Code in this crew</div>
      </div>
      <UnreadBadge count={unread} label="the Master Terminal" />
      <span className="text-muted-foreground text-[11px]">{statusLabel[master.status]}</span>
      {running ? (
        <Button size="sm" variant="secondary" className="h-7" onClick={() => run('stop', master)}>
          <Square className="size-3" /> Stop
        </Button>
      ) : (
        <Button size="sm" className="h-7" onClick={() => run('start', master)}>
          <Play className="size-3" /> Start
        </Button>
      )}
      <Button size="sm" variant="outline" className="h-7" onClick={() => run('terminal', master)} disabled={!running}>
        <SquareTerminal className="size-3" /> Terminal
      </Button>
      <OperatorMenu operator={master} run={run} />
    </div>
  )
}
