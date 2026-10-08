import { useEffect, useRef, useState } from 'react'
import { Play, Square } from 'lucide-react'
import { decodeIpcError } from '@shared/ipc'
import { ActivityPanel } from '@/components/panels/ActivityPanel'
import { UsagePage } from '@/components/cost/UsagePage'
import { onUsageRequest, takeUsageJob, takeUsageRequest } from '@/components/cost/openUsage'
import { GitPage } from '@/components/git/GitPage'
import { onGitRequest, takeGitRequest } from '@/components/git/openGit'
import { JobsPanel, useJobsBadge } from '@/components/panels/JobsPanel'
import { MessagesPanel, useMessagesBadge } from '@/components/panels/MessagesPanel'
import { Button } from '@/components/ui/button'
import { ResizeHandle } from '@/components/ui/resize-handle'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { MASTER_PHASE_HINT, MASTER_PHASE_LABEL } from '@/components/jobs/runUi'
import { OperatorTerminal } from '@/components/dashboard/OperatorTerminal'
import { usePanelWidth } from '@/lib/layout'
import { useMaster, useMasterState, useSettings, useStartMaster, useStopMaster } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { SubagentTile } from './SubagentTile'
import { TileSurface } from './TileSurface'
import { useProjectTiles, type TileInfo } from './useProjectTiles'
import type { TerminalTab } from './useTerminals'

type Tab = 'board' | 'messages' | 'activity' | 'usage' | 'git'

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

interface Props {
  crewId: number
  // The project's shell and agent terminals (from the drawer's list); they open as tiles here.
  scratch: TerminalTab[]
  onCloseScratch: (scratchId: number) => void
}

// The project's Terminal view: tiles (the Master as the fixed main tile, subagents as read-only tiles, shell and agent
// terminals) and a hideable side panel with Board, Messages, Activity, Usage and Git.
export function TerminalView({ crewId, scratch, onCloseScratch }: Props) {
  const master = useMaster(crewId).data
  const masterState = useMasterState(crewId).data
  const settings = useSettings().data
  const start = useStartMaster()
  const stop = useStopMaster()
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>(() => (takeUsageRequest() ? 'usage' : takeGitRequest() ? 'git' : 'board'))
  const [usageJob, setUsageJob] = useState<number | null>(takeUsageJob)
  const [wide, setWide] = useState(false)
  const [gitWide, setGitWide] = useState(false)
  const boardBadge = useJobsBadge(crewId)
  const unread = useMessagesBadge(crewId)
  const panel = usePanelWidth('rightWidth')
  const column = useRef<HTMLElement>(null)
  const project = useProjectTiles(crewId, scratch)
  const running = master != null && master.status !== 'stopped' && master.status !== 'error'
  const hidden = settings?.layout.panelHidden ?? false

  const shownCrew = useRef(crewId)
  useEffect(() => {
    if (shownCrew.current === crewId) return
    shownCrew.current = crewId
    setError(null)
    setUsageJob(null)
  }, [crewId])
  useEffect(
    () =>
      onUsageRequest(() => {
        if (!takeUsageRequest()) return
        setUsageJob(takeUsageJob())
        setTab('usage')
      }),
    [],
  )
  useEffect(() => onGitRequest(() => takeGitRequest() && setTab('git')), [])

  const gitFull = tab === 'git' && gitWide && !hidden
  const toggle = () => {
    setError(null)
    const opts = { onError: (e: unknown) => setError(decodeIpcError(e).message) }
    if (running) stop.mutate([crewId], opts)
    else start.mutate([crewId], opts)
  }

  const close = (t: TileInfo) => {
    if (t.kind === 'scratch' && t.scratch) onCloseScratch(t.scratch.scratchId)
    else if (t.kind === 'subagent') project.dismiss(t.id)
  }

  const badge = (t: TileInfo) => {
    if (t.kind === 'subagent') return <span className="text-muted-foreground bg-muted rounded-full px-2 py-0.5 text-[10px]">read-only</span>
    if (t.kind !== 'master') return null
    const phase = running && masterState ? masterState.phase : 'exited'
    return (
      <>
        <span aria-hidden className={running ? 'size-2 rounded-full bg-emerald-400' : 'bg-muted-foreground size-2 rounded-full'} />
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={start.isPending || stop.isPending} onClick={toggle}>
          {running ? <Square /> : <Play />} {running ? 'Stop' : 'Start'}
        </Button>
        {masterState && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} data-master-phase={phase} className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs outline-none">
                {MASTER_PHASE_LABEL[phase]}
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">{MASTER_PHASE_HINT[phase]}</TooltipContent>
          </Tooltip>
        )}
      </>
    )
  }

  const body = (t: TileInfo) => {
    if (t.kind === 'subagent' && t.agent) return <SubagentTile agent={t.agent} />
    if (t.kind === 'scratch' && t.scratch)
      return <OperatorTerminal sessionKey={`scratch:${t.scratch.scratchId}`} autoFocus={false} crewId={crewId} cli={t.scratch.kind === 'agent' ? 'claude' : 'shell'} />
    return running && master ? (
      <OperatorTerminal operatorId={master.id} autoFocus={false} crewId={crewId} cli={master.agent} />
    ) : (
      <div className="text-muted-foreground grid h-full place-items-center p-4 text-center text-sm">
        <div className="space-y-3">
          <p>The Master Terminal starts when you send it a task</p>
          <Button size="sm" disabled={start.isPending} onClick={toggle}>
            <Play /> Start
          </Button>
          {error && (
            <p role="alert" className="text-destructive text-xs">
              {error}
            </p>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex h-full min-h-0">
      <section aria-label="Terminal tiles" className="flex min-w-0 flex-1 flex-col p-1.5">
        <TileSurface crewId={crewId} tiles={project.list} pinned={project.pinned} onClose={close} onPin={project.togglePin} badge={badge} body={body} />
      </section>

      {!hidden && (
        <section
          ref={column}
          aria-label="Workspace panels"
          style={gitFull ? undefined : { minWidth: 'min(22rem, 45%)', maxWidth: '70%', ...(panel.width ? { width: panel.width } : {}) }}
          className={cn('relative flex shrink-0 flex-col border-l', gitFull && 'bg-background absolute inset-0 z-20 border-l-0', !gitFull && !panel.width && (tab === 'usage' && wide ? 'w-[min(56rem,70%)]' : 'w-[clamp(min(22rem,45%),30%,56rem)]'))}
        >
          {!gitFull && (
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
          )}
          <div role="tablist" aria-label="Workspace panels" className="flex h-11 shrink-0 items-stretch gap-0.5 border-b px-2">
            <TabButton id="board" label="Board" active={tab === 'board'} badge={boardBadge} onSelect={setTab} />
            <TabButton id="messages" label="Messages" active={tab === 'messages'} badge={unread} onSelect={setTab} />
            <TabButton id="activity" label="Activity" active={tab === 'activity'} onSelect={setTab} />
            <TabButton id="usage" label="Usage" active={tab === 'usage'} onSelect={setTab} />
            <TabButton id="git" label="Git" active={tab === 'git'} onSelect={setTab} />
          </div>
          <div role="tabpanel" id="workspace-tabpanel" aria-labelledby={`workspace-tab-${tab}`} className="flex min-h-0 flex-1 flex-col">
            {tab === 'board' && <JobsPanel crewId={crewId} />}
            {tab === 'messages' && <MessagesPanel crewId={crewId} />}
            {tab === 'activity' && <ActivityPanel crewId={crewId} />}
            {tab === 'git' && <GitPage crewId={crewId} wide={gitWide} onToggleWide={() => setGitWide((w) => !w)} />}
            {tab === 'usage' && <UsagePage crewId={crewId} jobId={usageJob} onJobChange={setUsageJob} wide={wide} onToggleWide={() => setWide((w) => !w)} />}
          </div>
        </section>
      )}
    </div>
  )
}
