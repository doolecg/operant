import { useMemo, useState } from 'react'
import { Play, Plus, Square } from 'lucide-react'
import { BOARD_COLUMNS, columnOf, type BoardColumn as Column } from '@shared/board'
import { decodeIpcError } from '@shared/ipc'
import type { Run } from '@shared/types'
import { MASTER_PHASE_HINT, MASTER_PHASE_LABEL } from '@/components/jobs/runUi'
import { requestOpenRun } from '@/components/jobs/openRuns'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useMaster, useMasterState, useRuns, useSettings, useStartMaster, useStopMaster } from '@/lib/queries'
import { BoardColumn } from './BoardColumn'
import { Inbox } from './Inbox'
import { useInbox, useInboxSeen } from './useInboxSeen'

// Newest first, except Queued which runs oldest first (the order the Master takes them) and Done by finish time.
function inColumn(runs: Run[], column: Column): Run[] {
  const list = runs.filter((r) => columnOf(r) === column)
  if (column === 'queued') return list.sort((a, b) => a.id - b.id)
  if (column === 'done') return list.sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt) || b.id - a.id)
  return list.sort((a, b) => b.id - a.id)
}

// The Workspace view: the project's jobs in five status columns with the owner's inbox beside them. A card opens the task modal.
export function WorkspaceBoard({ crewId, onNewTask }: { crewId: number; onNewTask?: () => void }) {
  const runs = useRuns(crewId).data ?? []
  const master = useMaster(crewId).data
  const masterState = useMasterState(crewId).data
  const start = useStartMaster()
  const stop = useStopMaster()
  const hidden = useSettings().data?.layout.inboxHidden ?? false
  const { items } = useInbox(crewId)
  const { markSeen } = useInboxSeen()
  const [error, setError] = useState<string | null>(null)
  const running = master != null && master.status !== 'stopped' && master.status !== 'error'
  const columns = useMemo(() => BOARD_COLUMNS.map((c) => [c, inColumn(runs, c)] as const), [runs])
  const phase = running ? (masterState?.phase ?? 'unknown') : 'exited'

  const open = (runId: number) => {
    if (runs.find((r) => r.id === runId)?.status === 'failed') markSeen(runId)
    requestOpenRun(runId)
  }
  const toggle = () => {
    setError(null)
    const opts = { onError: (e: unknown) => setError(decodeIpcError(e).message) }
    if (running) stop.mutate([crewId], opts)
    else start.mutate([crewId], opts)
  }

  return (
    <div className="flex h-full min-h-0" data-workspace-board>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-3 border-b px-5">
          <span aria-hidden className={running ? 'size-2 rounded-full bg-emerald-400' : 'bg-muted-foreground size-2 rounded-full'} />
          <h2 className="text-sm font-medium">Master Terminal</h2>
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} data-master-phase={phase} className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs outline-none">
                {MASTER_PHASE_LABEL[phase]}
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">{MASTER_PHASE_HINT[phase]}</TooltipContent>
          </Tooltip>
          <Button variant="ghost" size="sm" disabled={start.isPending || stop.isPending} onClick={toggle}>
            {running ? <Square /> : <Play />} {running ? 'Stop' : 'Start'}
          </Button>
          {error && (
            <p role="alert" className="text-destructive text-xs">
              {error}
            </p>
          )}
          {onNewTask && (
            <Button size="sm" className="ml-auto" onClick={onNewTask}>
              <Plus /> New task
            </Button>
          )}
        </div>
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4" role="group" aria-label="Job board">
          {columns.map(([c, list]) => (
            <BoardColumn key={c} column={c} runs={list} onOpen={(r) => open(r.id)} onDeleted={() => undefined} />
          ))}
        </div>
      </div>
      {!hidden && <Inbox items={items} runs={runs} onOpen={open} onDismiss={markSeen} />}
    </div>
  )
}
