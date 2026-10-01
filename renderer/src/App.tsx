import { useEffect, useState } from 'react'
import { FolderOpen, Loader2, MoreHorizontal, Network, Plus } from 'lucide-react'
import type { Operator } from '@shared/types'
import { AddSquadDialog, AddOperatorDialog, DeleteCrewDialog, EditCrewDialog, NewCrewDialog } from '@/components/dashboard/Dialogs'
import { OperatorDrawer } from '@/components/dashboard/OperatorDrawer'
import { Sidebar } from '@/components/dashboard/Sidebar'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { TooltipProvider } from '@/components/ui/tooltip'
import { closeDialog, useOpenDialog } from '@/lib/dialogs'
import { matches } from '@/lib/keys'
import { useAction, useCrews, useIndexStatus, useLiveUpdates, useMaster, useSetCrewView, useSettings, useTopology } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { CREW_VIEWS, DEFAULT_VIEW, DIALOGS, PANEL_TABS, type PanelTab } from '@/registry'

const LAST_CREW = 'operant.lastCrew'

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
  const [addSquad, setAddSquad] = useState(false)
  const [crewDialog, setCrewDialog] = useState<'edit' | 'delete' | null>(null)
  const [operatorSquad, setOperatorSquad] = useState<number | null>(null)
  const [openOperatorId, setOpenOperatorId] = useState<number | null>(null)
  const [page, setPage] = useState<'dashboard' | 'settings'>('dashboard')
  const [tab, setTab] = useState(PANEL_TABS[0]!.id)

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

  const topology = useTopology(crewId)
  const index = useIndexStatus(crewId)
  const runIndex = useAction('index:run')
  const setView = useSetCrewView()
  const settings = useSettings()
  const master = useMaster(crewId)

  const crew = topology.data
  const viewId = crew?.view ?? DEFAULT_VIEW
  const view = CREW_VIEWS.find((v) => v.id === viewId) ?? CREW_VIEWS[0]!
  const View = view.component

  // Rebindable shortcuts from Settings; dialogs and the key recorder take keys first.
  useEffect(() => {
    const binds = settings.data?.keybinds
    if (!binds) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const dash = () => setPage('dashboard')
      const actions: Array<[string, () => void]> = [
        [binds.newCrew, () => (dash(), setNewCrew(true))],
        [binds.addSquad, () => crewId != null && (dash(), setAddSquad(true))],
        [binds.indexCrew, () => crewId != null && runIndex.mutate([crewId])],
        [binds.openSettings, () => setPage((v) => (v === 'settings' ? 'dashboard' : 'settings'))],
        ...PANEL_TABS.map((t): [string, () => void] => [binds[t.keybind], () => (dash(), setTab(t.id))]),
        ...CREW_VIEWS.map((v): [string, () => void] => [
          binds[v.keybind],
          () => crewId != null && (dash(), setView.mutate([crewId, v.id])),
        ]),
      ]
      const hit = actions.find(([accel]) => matches(e, accel))
      if (!hit) return
      e.preventDefault()
      hit[1]()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settings.data?.keybinds, crewId, runIndex, setView])

  const operators: Operator[] = crew?.squads.flatMap((p) => p.operators) ?? []
  // The Master Terminal lives in the hidden system squad, so it is looked up apart from the topology.
  const openOperator = [...operators, ...(master.data ? [master.data] : [])].find((s) => s.id === openOperatorId) ?? null

  return (
    <TooltipProvider>
      <div className="flex h-full">
        <Sidebar
          crews={crews.data ?? []}
          selected={page === 'dashboard' ? crewId : null}
          settingsOpen={page === 'settings'}
          onSelect={(id) => (setCrewId(id), setPage('dashboard'))}
          onNewCrew={() => setNewCrew(true)}
          onOpenSettings={() => setPage('settings')}
        />

        <main className="flex min-w-0 flex-1 flex-col">
          {page === 'settings' ? (
            <SettingsPage />
          ) : crews.data && crews.data.length === 0 ? (
            <Welcome onNewCrew={() => setNewCrew(true)} />
          ) : (
            <>
              <header className="flex h-14 shrink-0 items-center gap-3 border-b px-6">
                <div className="min-w-0 flex-1">
                  <h1 className="truncate text-base font-semibold">{crew?.name ?? ' '}</h1>
                  <p className="text-muted-foreground flex items-center gap-1.5 truncate font-mono text-[11px]">
                    <FolderOpen className="size-3" />
                    {crew?.folder}
                  </p>
                </div>
                <div role="group" aria-label="Crew view" className="bg-muted flex rounded-md p-0.5">
                  {CREW_VIEWS.map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      aria-pressed={v.id === view.id}
                      disabled={crewId == null}
                      onClick={() => crewId != null && setView.mutate([crewId, v.id])}
                      className={cn(
                        'flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition-colors',
                        v.id === view.id ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      <v.icon className="size-3.5" /> {v.label}
                    </button>
                  ))}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => crewId != null && runIndex.mutate([crewId])}
                  disabled={crewId == null || index.data?.indexing || runIndex.isPending}
                >
                  {index.data?.indexing || runIndex.isPending ? <Loader2 className="animate-spin" /> : <Network />}
                  {index.data?.initialized ? 'Update index' : 'Index with CodeGraph'}
                </Button>
                <Button size="sm" onClick={() => setAddSquad(true)} disabled={crewId == null}>
                  <Plus /> Squad
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label={`Actions for crew ${crew?.name ?? ''}`} disabled={!crew}>
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setCrewDialog('edit')}>Edit crew</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => setCrewDialog('delete')}>
                      Delete crew
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </header>

              <div className="flex min-h-0 flex-1">
                <div className="min-w-0 flex-1">
                  {crewId != null && crew && (
                    <View
                      crewId={crewId}
                      crew={crew}
                      onOpenOperator={(o) => setOpenOperatorId(o.id)}
                      onAddOperator={setOperatorSquad}
                      onAddSquad={() => setAddSquad(true)}
                    />
                  )}
                </div>

                <aside className="flex w-80 shrink-0 flex-col border-l xl:w-96">
                  <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col gap-0">
                    <div className="border-b px-3 py-2">
                      <TabsList className="w-full">
                        {PANEL_TABS.map((t) => (
                          <TabTrigger key={t.id} tab={t} crewId={crewId} />
                        ))}
                      </TabsList>
                    </div>
                    {PANEL_TABS.map((t) => (
                      <TabsContent key={t.id} value={t.id} className="min-h-0 flex-1">
                        {crewId != null && <t.component crewId={crewId} operators={operators} />}
                      </TabsContent>
                    ))}
                  </Tabs>
                </aside>
              </div>
            </>
          )}
        </main>
      </div>

      <NewCrewDialog open={newCrew} onOpenChange={setNewCrew} onCreated={setCrewId} />
      {crew && crewDialog === 'edit' && <EditCrewDialog crew={crew} open onOpenChange={(o) => !o && setCrewDialog(null)} />}
      {crew && crewDialog === 'delete' && (
        <DeleteCrewDialog crewId={crew.id} crewName={crew.name} open onOpenChange={(o) => !o && setCrewDialog(null)} />
      )}
      {crewId != null && <AddSquadDialog crewId={crewId} open={addSquad} onOpenChange={setAddSquad} />}
      <AddOperatorDialog
        squads={crew?.squads ?? []}
        squadId={operatorSquad}
        defaultModels={settings.data?.defaultModels}
        onOpenChange={(o) => !o && setOperatorSquad(null)}
      />
      <OperatorDrawer operator={openOperator} crewName={crew?.name ?? ''} onClose={() => setOpenOperatorId(null)} />
      <DialogsHost />
    </TooltipProvider>
  )
}

function TabTrigger({ tab, crewId }: { tab: PanelTab; crewId: number | null }) {
  const badge = tab.useBadge?.(crewId)
  return (
    <TabsTrigger value={tab.id}>
      {tab.label}
      {!!badge && <span className="text-muted-foreground tabular-nums">{badge}</span>}
    </TabsTrigger>
  )
}

// Renders whichever registered dialog openDialog(id, payload) asked for.
function DialogsHost() {
  const open = useOpenDialog()
  const Dialog = open ? DIALOGS[open.id] : undefined
  return Dialog ? <Dialog payload={open!.payload} onClose={closeDialog} /> : null
}

function Welcome({ onNewCrew }: { onNewCrew: () => void }) {
  return (
    <div className="grid flex-1 place-items-center p-10">
      <div className="max-w-md space-y-4 text-center">
        <h1 className="text-2xl font-semibold">Welcome to Operant 2</h1>
        <p className="text-muted-foreground text-sm">
          Create a crew for a project folder, add squads and operators, and run Claude Code or Codex agents as a team you can
          watch from here.
        </p>
        <Button onClick={onNewCrew}>
          <Plus /> Create your first crew
        </Button>
      </div>
    </div>
  )
}
