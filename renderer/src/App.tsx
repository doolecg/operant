import { useEffect, useState } from 'react'
import { Activity, AlertTriangle, ChevronDown, Code2, Loader2, MoreHorizontal, Network, Plus, Settings, SquareTerminal, Terminal } from 'lucide-react'
import { ConsoleDrawer } from '@/components/console/ConsoleDrawer'
import { useConsole } from '@/components/console/useConsole'
import { DeleteCrewDialog, EditCrewDialog, NewCrewDialog } from '@/components/dashboard/Dialogs'
import { GitChangesDialog } from '@/components/dashboard/GitChangesDialog'
import { projectActions } from '@/components/dashboard/projectActions'
import { TerminalDrawer } from '@/components/terminal/TerminalDrawer'
import { useTerminals } from '@/components/terminal/useTerminals'
import { Toaster } from '@/components/ui/toaster'
import { SeatEditor } from '@/components/seats/SeatEditor'
import { NewTaskDialog } from '@/components/jobs/NewTaskDialog'
import { Sidebar } from '@/components/dashboard/Sidebar'
import { Workspace } from '@/components/dashboard/Workspace'
import { LearningBadge } from '@/components/memory/LearningBadge'
import { MemoryPage } from '@/components/memory/MemoryPage'
import { ProviderLimitBadge } from '@/components/cost/ProviderBadge'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { StatusPill } from '@/components/topbar/StatusPill'
import { ClockPill } from '@/components/topbar/ClockPill'
import { MediaBar } from '@/components/topbar/MediaBar'
import { iconBtn } from '@/components/topbar/pill'
import { useBarTier } from '@/components/topbar/useBarTier'
import { mediaCommand } from '@/components/topbar/useMedia'
import { matches } from '@/lib/keys'
import { effectiveScale, stepScale, useUiScale } from '@/lib/uiScale'
import { useAction, useCrews, useIndexStatus, useLiveUpdates, useMcpHealth, useMoveToGroup, useSaveSettings, useSettings } from '@/lib/queries'
import type { Crew } from '@shared/types'
import { cn } from '@/lib/utils'

const LAST_CREW = 'operant.lastCrew'
const MODE = 'operant.mode'

type Mode = 'workspace' | 'seats' | 'memory'
const MODES: Mode[] = ['workspace', 'seats', 'memory']
const MODE_LABEL: Record<Mode, string> = { workspace: 'Workspace', seats: 'Seats', memory: 'Memory' }

function readMode(): Mode {
  try {
    const v = localStorage.getItem(MODE)
    return v === 'seats' || v === 'memory' ? v : 'workspace'
  } catch {
    return 'workspace'
  }
}

function readLastCrew(): number | null {
  try {
    const v = localStorage.getItem(LAST_CREW)
    return v ? Number(v) : null
  } catch {
    return null
  }
}

export function App() {
  useLiveUpdates()
  const crews = useCrews()
  const [crewId, setCrewId] = useState<number | null>(readLastCrew)
  const [newCrew, setNewCrew] = useState(false)
  const [crewDialog, setCrewDialog] = useState<'edit' | 'delete' | null>(null)
  const [mode, setModeState] = useState<Mode>(readMode)
  const [page, setPage] = useState<'dashboard' | 'settings'>('dashboard')
  const [settingsSection, setSettingsSection] = useState<string | undefined>()
  const mcpDown = useMcpHealth().data ?? []
  const [consoleOpen, setConsoleOpen] = useState(false)
  const bgConsole = useConsole(consoleOpen)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  // The project a new project is added to (from a group's "+"), the project a delete or changes dialog is about.
  const [newCrewGroup, setNewCrewGroup] = useState<number | undefined>()
  const [deleteTarget, setDeleteTarget] = useState<Crew | null>(null)
  const [changesTarget, setChangesTarget] = useState<Crew | null>(null)
  const moveToGroup = useMoveToGroup()
  const [barRef, tier] = useBarTier()
  const [statusOpen, setStatusOpen] = useState(false)
  const [taskOpen, setTaskOpen] = useState(false)

  const setMode = (m: Mode) => {
    setModeState(m)
    try {
      localStorage.setItem(MODE, m)
    } catch {
      /* storage unavailable */
    }
  }

  // Fall back to the first crew when the remembered one is gone.
  useEffect(() => {
    const list = crews.data
    if (!list) return
    if (crewId == null || !list.some((r) => r.id === crewId)) setCrewId(list[0]?.id ?? null)
  }, [crews.data, crewId])

  useEffect(() => {
    try {
      if (crewId != null) localStorage.setItem(LAST_CREW, String(crewId))
    } catch {
      /* storage unavailable */
    }
  }, [crewId])

  const index = useIndexStatus(crewId)
  const runIndex = useAction('index:run')
  const settings = useSettings()
  const saveSettings = useSaveSettings()
  useUiScale(settings.data?.uiScale)
  const terminals = useTerminals(crews.data, settings.data?.defaultModels.claude ?? 'sonnet')

  const crew = crews.data?.find((c) => c.id === crewId)
  const tb = settings.data?.topBar

  // The status pill and alerts sit in the bar, or in one menu once the bar is too narrow for them.
  const pills = (inMenu: boolean) => (
    <>
      <StatusPill crewId={crewId} jobs={!!tb?.agentPill} labels={inMenu || tier < 2} />
      <ProviderLimitBadge onOpen={() => setPage('dashboard')} />
      <LearningBadge onOpen={() => setMode('memory')} />
      {mcpDown.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive gap-1 px-2"
              aria-label={`MCP servers down: ${mcpDown.map((d) => d.server).join(', ')}`}
              onClick={() => (setSettingsSection('mcp'), setPage('settings'))}
            >
              <AlertTriangle className="size-4" />
              <span className="text-xs">{mcpDown.length}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {mcpDown.map((d) => `${d.server} (${d.state === 'missing' ? 'not configured' : d.state}) for ${d.seats.join(', ')}`).join('; ')}
          </TooltipContent>
        </Tooltip>
      )}
    </>
  )

  const openSettingsAt = (section?: string) => (setSettingsSection(section), setPage('settings'))
  const projectMenu = {
    newAgent: (c: Crew) => void terminals.openTab(c, 'agent'),
    newShell: (c: Crew) => void terminals.openTab(c, 'shell'),
    openIde: (c: Crew) => void projectActions.openIde(c),
    openFolder: (c: Crew) => void projectActions.openFolder(c),
    index: (c: Crew) => void projectActions.index(c),
    changes: (c: Crew) => setChangesTarget(c),
    copyPath: (c: Crew) => void projectActions.copyPath(c),
    trackerNow: (c: Crew) => void projectActions.trackerNow(c),
    defaults: () => openSettingsAt('projects'),
    remove: (c: Crew) => setDeleteTarget(c),
    openMaster: (c: Crew) => (setCrewId(c.id), setPage('dashboard'), setMode('workspace')),
  }

  // Rebindable shortcuts from Settings; dialogs and the key recorder take keys first.
  useEffect(() => {
    const binds = settings.data?.keybinds
    const uiScale = settings.data?.uiScale ?? 0
    if (!binds) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const dash = () => setPage('dashboard')
      const actions: Array<[string, () => void]> = [
        [binds.newCrew, () => (dash(), setNewCrew(true))],
        [binds.indexCrew, () => crewId != null && runIndex.mutate([crewId])],
        [binds.openSettings, () => setPage((v) => (v === 'settings' ? 'dashboard' : 'settings'))],
        [binds.toggleConsole, () => setConsoleOpen((v) => !v)],
        [binds.newShell, () => crew && (dash(), void terminals.openTab(crew, 'shell'))],
        [binds.toggleSidebar, () => setSidebarOpen((v) => !v)],
        [binds.openInIde, () => crew && void projectActions.openIde(crew)],
        [binds.mediaPlayPause, () => mediaCommand('toggle')],
        [binds.mediaNext, () => mediaCommand('next')],
        [binds.mediaPrev, () => mediaCommand('prev')],
        [binds.mediaShuffle, () => mediaCommand('shuffle')],
        [binds.zoomIn, () => saveSettings.mutate({ uiScale: stepScale(effectiveScale(uiScale), 1) })],
        [binds.zoomOut, () => saveSettings.mutate({ uiScale: stepScale(effectiveScale(uiScale), -1) })],
        [binds.zoomReset, () => saveSettings.mutate({ uiScale: 0 })],
      ]
      const hit = actions.find(([accel]) => matches(e, accel))
      if (!hit) return
      e.preventDefault()
      hit[1]()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settings.data?.keybinds, settings.data?.uiScale, saveSettings, crewId, runIndex, crew, terminals.openTab])

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col">
      <header
        ref={barRef}
        className={cn('bg-background/80 flex h-[42px] shrink-0 items-center border-b px-3.5 text-xs backdrop-blur', tier >= 6 ? 'gap-2' : 'gap-3')}
      >
        <div className="flex min-w-0 flex-1 basis-0 items-center gap-3">
          <div className="group/proj flex min-w-0 shrink items-center gap-2.5">
            <span aria-hidden className="text-[26px] leading-none text-[#d97757]">
              ◈
            </span>
            <div className="min-w-0 leading-tight">
              <div className="text-[12.5px] font-semibold">Operant 3</div>
              <div className="flex min-w-0 items-baseline gap-1.5 text-[11px]">
                {crew ? <h1 className="max-w-[60%] min-w-[4ch] shrink-0 truncate text-[11px] font-medium">{crew.name}</h1> : <span>&nbsp;</span>}
                <span className="text-muted-foreground min-w-0 truncate font-mono text-[10px]" title={crew?.folder}>
                  {crew?.folder}
                </span>
              </div>
            </div>
            {crew && (
              <div className="flex shrink-0 items-center max-w-0 overflow-hidden opacity-0 transition-[max-width,opacity] duration-200 group-hover/proj:max-w-[140px] group-hover/proj:opacity-100 group-focus-within/proj:max-w-[140px] group-focus-within/proj:opacity-100">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className={iconBtn}
                      onClick={() => crewId != null && runIndex.mutate([crewId])}
                      disabled={index.data?.indexing || runIndex.isPending}
                      aria-label={index.data?.initialized ? 'Update index' : 'Index with CodeGraph'}
                    >
                      {index.data?.indexing || runIndex.isPending ? <Loader2 className="animate-spin" /> : <Network />}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{index.data?.initialized ? 'Update index' : 'Index with CodeGraph'}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button type="button" className={iconBtn} aria-label={`Open ${crew.name} in IDE`} onClick={() => projectMenu.openIde(crew)}>
                      <Code2 />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Open in IDE</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button type="button" className={iconBtn} aria-label={`New shell in ${crew.name}`} onClick={() => projectMenu.newShell(crew)}>
                      <SquareTerminal />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>New shell here</TooltipContent>
                </Tooltip>
                <DropdownMenu>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DropdownMenuTrigger asChild>
                        <button type="button" className={iconBtn} aria-label={`Actions for crew ${crew.name}`}>
                          <MoreHorizontal />
                        </button>
                      </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <TooltipContent>Project actions</TooltipContent>
                  </Tooltip>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem onSelect={() => setCrewDialog('edit')}>Edit crew</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => setCrewDialog('delete')}>
                      Delete crew
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}
          </div>
          <div role="group" aria-label="Dashboard mode" className="bg-foreground/5 flex shrink-0 gap-1 rounded-full p-[3px]">
            {tier >= 6 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" className="flex h-[22px] items-center gap-0.5 rounded-full bg-[#d97757]/20 pl-2.5 pr-1.5 text-xs font-medium text-[#d97757]">
                    {MODE_LABEL[mode]}
                    <ChevronDown className="size-3" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {MODES.map((m) => (
                    <DropdownMenuItem key={m} onSelect={() => setMode(m)}>
                      {MODE_LABEL[m]}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              MODES.map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={m === mode}
                  onClick={() => setMode(m)}
                  className={cn(
                    'h-[22px] rounded-full text-xs transition-[padding,background-color,color] duration-[350ms] ease-[cubic-bezier(.05,.9,.1,1.05)]',
                    m === mode ? 'bg-[#d97757]/20 px-3.5 font-medium text-[#d97757]' : 'text-muted-foreground hover:text-foreground px-2.5',
                  )}
                >
                  {MODE_LABEL[m]}
                </button>
              ))
            )}
          </div>
          {tb?.mediaControls && tier < 4 && <MediaBar enabled size={tb.mediaSize} tier={tier} />}
        </div>
        <div className="flex shrink-0 justify-center">{tb && tier < 5 && <ClockPill format={tb.clockFormat} seconds={tb.clockSeconds} date={tb.clockDate && tier < 2} />}</div>
        <div className={cn('flex items-center justify-end gap-1', tier < 3 ? 'min-w-0 flex-1 basis-0' : 'shrink-0')}>
          {tier < 3 ? (
            pills(false)
          ) : (
            <DropdownMenu open={statusOpen} onOpenChange={setStatusOpen}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <button type="button" className={iconBtn} aria-label={mcpDown.length > 0 ? `Status and alerts, ${mcpDown.length} MCP servers down` : 'Status and alerts'}>
                      <Activity />
                      {mcpDown.length > 0 && <span aria-hidden className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-red-500" />}
                    </button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent>Status and alerts</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" aria-label="Status and alerts" className="w-auto p-2">
                <div className="flex flex-col items-start gap-1.5" onClick={() => setStatusOpen(false)}>
                  {pills(true)}
                </div>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={iconBtn}
                aria-label="Start new task"
                disabled={crewId == null}
                onClick={() => (setPage('dashboard'), setTaskOpen(true))}
              >
                <Plus />
              </button>
            </TooltipTrigger>
            <TooltipContent>Start new task</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className={iconBtn} aria-label="Settings" onClick={() => (setSettingsSection(undefined), setPage('settings'))}>
                <Settings />
              </button>
            </TooltipTrigger>
            <TooltipContent>Settings</TooltipContent>
          </Tooltip>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        {sidebarOpen && (
          <Sidebar
            crews={crews.data ?? []}
            selected={page === 'dashboard' ? crewId : null}
            settingsOpen={page === 'settings'}
            onSelect={(id) => (setCrewId(id), setPage('dashboard'))}
            onNewCrew={(groupId) => (setNewCrewGroup(groupId), setNewCrew(true))}
            onOpenSettings={() => (setSettingsSection(undefined), setPage('settings'))}
            actions={projectMenu}
            footer={
              <>
                {terminals.tabs.length > 0 && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon" aria-label="Terminals" aria-pressed={terminals.open} onClick={() => terminals.setOpen(!terminals.open)}>
                        <SquareTerminal />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Terminals</TooltipContent>
                  </Tooltip>
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="relative"
                      aria-label={bgConsole.errors > 0 ? `Console, ${bgConsole.errors} new errors` : 'Console'}
                      aria-pressed={consoleOpen}
                      onClick={() => setConsoleOpen((v) => !v)}
                    >
                      <Terminal />
                      {bgConsole.errors > 0 && (
                        <span className="absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full bg-red-500 px-1 text-[10px] leading-4 text-white">
                          {bgConsole.errors > 99 ? '99+' : bgConsole.errors}
                        </span>
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Console</TooltipContent>
                </Tooltip>
              </>
            }
          />
        )}

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {page === 'settings' ? (
            <SettingsPage initialSection={settingsSection} onClose={() => setPage('dashboard')} />
          ) : crews.data && crews.data.length === 0 ? (
            <Welcome onNewCrew={() => setNewCrew(true)} />
          ) : (
            <>
              {mode === 'workspace' ? (
                <div className="min-h-0 flex-1">{crewId != null && <Workspace crewId={crewId} />}</div>
              ) : mode === 'memory' ? (
                <div className="min-h-0 flex-1">
                  <MemoryPage crewId={crewId} />
                </div>
              ) : (
                <div className="min-h-0 flex-1">
                  <SeatEditor />
                </div>
              )}
            </>
          )}
          {terminals.open && terminals.tabs.length > 0 && (
            <TerminalDrawer
              tabs={terminals.tabs}
              active={terminals.active}
              onSelect={terminals.setActive}
              onClose={terminals.closeTab}
              onNewShell={() => crew && void terminals.openTab(crew, 'shell')}
              onHide={() => terminals.setOpen(false)}
            />
          )}
          {consoleOpen && (
            <ConsoleDrawer
              lines={bgConsole.lines}
              processes={bgConsole.processes}
              onClear={bgConsole.clear}
              onStop={bgConsole.stop}
              onClose={() => setConsoleOpen(false)}
            />
          )}
        </main>
      </div>
      </div>

      {crewId != null && <NewTaskDialog crewId={crewId} open={taskOpen} onOpenChange={setTaskOpen} />}
      <NewCrewDialog
        open={newCrew}
        onOpenChange={(o) => (setNewCrew(o), !o && setNewCrewGroup(undefined))}
        onCreated={(id) => {
          setCrewId(id)
          setPage('dashboard')
          if (newCrewGroup != null) moveToGroup.mutate([id, newCrewGroup])
        }}
      />
      {crew && crewDialog === 'edit' && <EditCrewDialog crew={crew} open onOpenChange={(o) => !o && setCrewDialog(null)} />}
      {crew && crewDialog === 'delete' && (
        <DeleteCrewDialog
          crewId={crew.id}
          crewName={crew.name}
          open
          onOpenChange={(o) => !o && setCrewDialog(null)}
          onDeleted={() => terminals.dropCrew(crew.id)}
        />
      )}
      {deleteTarget && (
        <DeleteCrewDialog
          crewId={deleteTarget.id}
          crewName={deleteTarget.name}
          open
          onOpenChange={(o) => !o && setDeleteTarget(null)}
          onDeleted={() => terminals.dropCrew(deleteTarget.id)}
        />
      )}
      {changesTarget && <GitChangesDialog crew={changesTarget} onClose={() => setChangesTarget(null)} />}
      <Toaster />
    </TooltipProvider>
  )
}

function Welcome({ onNewCrew }: { onNewCrew: () => void }) {
  return (
    <div className="grid flex-1 place-items-center p-10">
      <div className="max-w-md space-y-4 text-center">
        <div aria-hidden className="text-[#d97757] text-5xl leading-none">
          ◈
        </div>
        <h1 className="text-2xl font-semibold">Welcome to Operant 3</h1>
        <p className="text-muted-foreground text-sm">
          Create a crew for a project folder, hand it jobs, and let a Master Terminal run your seats and teams of coding agents
          while you watch from here.
        </p>
        <Button onClick={onNewCrew}>
          <Plus /> Create your first crew
        </Button>
      </div>
    </div>
  )
}
