import { useEffect, useRef, useState } from 'react'
import { Play, Square } from 'lucide-react'
import { decodeIpcError } from '@shared/ipc'
import { RunGrid } from '@/components/jobs/RunGrid'
import { RunPanel } from '@/components/jobs/RunPanel'
import { ActivityPanel } from '@/components/panels/ActivityPanel'
import { UsagePage } from '@/components/cost/UsagePage'
import { onUsageRequest, takeUsageRequest } from '@/components/cost/openUsage'
import { JobsPanel, useJobsBadge } from '@/components/panels/JobsPanel'
import { MessagesPanel, useMessagesBadge } from '@/components/panels/MessagesPanel'
import { Button } from '@/components/ui/button'
import { ResizeHandle } from '@/components/ui/resize-handle'
import { usePanelWidth } from '@/lib/layout'
import { cn } from '@/lib/utils'
import { useMaster, useRuns, useStartMaster, useStopMaster } from '@/lib/queries'
import { OperatorTerminal } from './OperatorTerminal'

type Tab = 'runs' | 'board' | 'messages' | 'activity' | 'usage'

function TabButton({ id, label, active, badge, onSelect }: { id: Tab; label: string; active: boolean; badge?: number; onSelect: (t: Tab) => void }) {
  return (
    <button
      type="button"
      role="tab"
      id={`workspace-tab-${id}`}
      aria-selected={active}
      aria-controls="workspace-tabpanel"
      onClick={() => onSelect(id)}
      className={cn(
        'flex h-full items-center gap-1.5 border-b-2 px-2.5 text-xs font-medium',
        active ? 'border-primary text-foreground' : 'text-muted-foreground hover:text-foreground border-transparent',
      )}
    >
      {label}
      {badge != null && badge > 0 && <span className="bg-muted rounded-full px-1.5 text-[10px] tabular-nums">{badge}</span>}
    </button>
  )
}

// The project workspace: Master Terminal in the centre, a tabbed column on the right (job cards by default), the job panel over them.
export function Workspace({ crewId }: { crewId: number }) {
  const master = useMaster(crewId).data
  const runs = useRuns(crewId).data ?? []
  const start = useStartMaster()
  const stop = useStopMaster()
  const [error, setError] = useState<string | null>(null)
  const [openRun, setOpenRun] = useState<number | null>(null)
  const [tab, setTab] = useState<Tab>(() => (takeUsageRequest() ? 'usage' : 'runs'))
  const [usageJob, setUsageJob] = useState<number | null>(null)
  const [wide, setWide] = useState(false)
  const boardBadge = useJobsBadge(crewId)
  const unread = useMessagesBadge(crewId)
  const panel = usePanelWidth('rightWidth')
  const column = useRef<HTMLElement>(null)
  const running = master != null && master.status !== 'stopped' && master.status !== 'error'

  useEffect(() => {
    setError(null)
    setOpenRun(null)
    setUsageJob(null)
  }, [crewId])

  // The header's limit badge opens the Usage tab.
  useEffect(() => onUsageRequest(() => takeUsageRequest() && setTab('usage')), [])

  const toggle = () => {
    setError(null)
    const opts = { onError: (e: unknown) => setError(decodeIpcError(e).message) }
    if (running) stop.mutate([crewId], opts)
    else start.mutate([crewId], opts)
  }

  return (
    <div className="relative flex h-full min-h-0">
      <section aria-label="Master Terminal" className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-3 border-b px-4">
          <span aria-hidden className={running ? 'size-2 rounded-full bg-emerald-400' : 'bg-muted-foreground size-2 rounded-full'} />
          <h2 className="text-sm font-medium">Master Terminal</h2>
          <Button variant="ghost" size="sm" disabled={start.isPending || stop.isPending} onClick={toggle}>
            {running ? <Square /> : <Play />} {running ? 'Stop' : 'Start'}
          </Button>
        </div>
        <div className="min-h-0 flex-1">
          {running && master ? (
            <OperatorTerminal operatorId={master.id} autoFocus={false} />
          ) : (
            <div className="text-muted-foreground grid h-full place-items-center p-4 text-center text-sm">
              <div className="space-y-3">
                <p>The Master Terminal is not running. Starting a task starts it.</p>
                {error && (
                  <p role="alert" className="text-destructive text-xs">
                    {error}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </section>

      <section
        ref={column}
        aria-label="Workspace panels"
        style={{ minWidth: 'min(22rem, 45%)', maxWidth: '70%', ...(panel.width ? { width: panel.width } : {}) }}
        className={cn('relative flex shrink-0 flex-col border-l', !panel.width && (tab === 'usage' && wide ? 'w-[min(56rem,70%)]' : 'w-[clamp(min(22rem,45%),30%,56rem)]'))}
      >
        <ResizeHandle
          target={column}
          axis="x"
          grow={-1}
          min={() => Math.min(22 * 16, (column.current?.parentElement?.clientWidth ?? window.innerWidth) * 0.45)}
          max={() => (column.current?.parentElement?.clientWidth ?? window.innerWidth) * 0.7}
          label="Resize workspace panels"
          className="-left-1"
          {...panel.handle}
        />
        <div role="tablist" aria-label="Workspace panels" className="flex h-11 shrink-0 items-stretch gap-0.5 border-b px-2">
          <TabButton id="runs" label="Runs" active={tab === 'runs'} badge={runs.length} onSelect={setTab} />
          <TabButton id="board" label="Board" active={tab === 'board'} badge={boardBadge} onSelect={setTab} />
          <TabButton id="messages" label="Messages" active={tab === 'messages'} badge={unread} onSelect={setTab} />
          <TabButton id="activity" label="Activity" active={tab === 'activity'} onSelect={setTab} />
          <TabButton id="usage" label="Usage" active={tab === 'usage'} onSelect={setTab} />
        </div>
        <div role="tabpanel" id="workspace-tabpanel" aria-labelledby={`workspace-tab-${tab}`} className="flex min-h-0 flex-1 flex-col">
          {tab === 'runs' && <RunGrid runs={runs} selectedId={openRun} onOpen={(r) => setOpenRun(r.id)} onDeleted={(id) => setOpenRun((cur) => (cur === id ? null : cur))} />}
          {tab === 'board' && <JobsPanel crewId={crewId} />}
          {tab === 'messages' && <MessagesPanel crewId={crewId} />}
          {tab === 'activity' && <ActivityPanel crewId={crewId} />}
          {tab === 'usage' && <UsagePage crewId={crewId} jobId={usageJob} onJobChange={setUsageJob} wide={wide} onToggleWide={() => setWide((w) => !w)} />}
        </div>
      </section>

      {openRun != null && <RunPanel
          runId={openRun}
          onClose={() => setOpenRun(null)}
          onOpenUsage={(id) => {
            setUsageJob(id)
            setTab('usage')
            setOpenRun(null)
          }}
        />}
    </div>
  )
}
