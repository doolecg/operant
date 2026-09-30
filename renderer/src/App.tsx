import { useEffect, useState } from 'react'
import { FolderOpen, Loader2, Network, Plus } from 'lucide-react'
import type { Operator } from '@shared/types'
import { ActivityFeed } from '@/components/dashboard/ActivityFeed'
import { CostPanel } from '@/components/dashboard/CostPanel'
import { AddSquadDialog, AddOperatorDialog, NewCrewDialog } from '@/components/dashboard/Dialogs'
import { OperatorDrawer } from '@/components/dashboard/OperatorDrawer'
import { Sidebar } from '@/components/dashboard/Sidebar'
import { StatStrip } from '@/components/dashboard/StatStrip'
import { TasksPanel } from '@/components/dashboard/TasksPanel'
import { Topology } from '@/components/dashboard/Topology'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { TooltipProvider } from '@/components/ui/tooltip'
import { matches } from '@/lib/keys'
import {
  useAction,
  useEvents,
  useIndexStatus,
  useLiveUpdates,
  useCrews,
  useOperatorContexts,
  useSettings,
  useSpendSeries,
  useSummary,
  useTasks,
  useTopology,
} from '@/lib/queries'

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
  const [operatorSquad, setOperatorSquad] = useState<number | null>(null)
  const [openOperatorId, setOpenOperatorId] = useState<number | null>(null)
  const [view, setView] = useState<'dashboard' | 'settings'>('dashboard')
  const [tab, setTab] = useState('activity')

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
  const tasks = useTasks(crewId)
  const index = useIndexStatus(crewId)
  const events = useEvents()
  const summary = useSummary()
  const contexts = useOperatorContexts()
  const spend = useSpendSeries(crewId)
  const runIndex = useAction('index:run')
  const settings = useSettings()

  // Rebindable shortcuts from Settings; dialogs and the key recorder take keys first.
  useEffect(() => {
    const binds = settings.data?.keybinds
    if (!binds) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const dash = () => setView('dashboard')
      const actions: Array<[string, () => void]> = [
        [binds.newCrew, () => (dash(), setNewCrew(true))],
        [binds.addSquad, () => crewId != null && (dash(), setAddSquad(true))],
        [binds.indexCrew, () => crewId != null && runIndex.mutate([crewId])],
        [binds.tabActivity, () => (dash(), setTab('activity'))],
        [binds.tabTasks, () => (dash(), setTab('tasks'))],
        [binds.tabCost, () => (dash(), setTab('cost'))],
        [binds.openSettings, () => setView((v) => (v === 'settings' ? 'dashboard' : 'settings'))],
      ]
      const hit = actions.find(([accel]) => matches(e, accel))
      if (!hit) return
      e.preventDefault()
      hit[1]()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settings.data?.keybinds, crewId, runIndex])

  const crew = topology.data
  const operators: Operator[] = crew?.squads.flatMap((p) => p.operators) ?? []
  const openOperator = operators.find((s) => s.id === openOperatorId) ?? null

  return (
    <TooltipProvider>
      <div className="flex h-full">
        <Sidebar
          crews={crews.data ?? []}
          selected={view === 'dashboard' ? crewId : null}
          settingsOpen={view === 'settings'}
          onSelect={(id) => (setCrewId(id), setView('dashboard'))}
          onNewCrew={() => setNewCrew(true)}
          onOpenSettings={() => setView('settings')}
        />

        <main className="flex min-w-0 flex-1 flex-col">
          {view === 'settings' ? (
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
              </header>

              <div className="flex min-h-0 flex-1">
                <ScrollArea className="min-w-0 flex-1">
                  <div className="space-y-6 p-6">
                    <StatStrip summary={summary.data} index={index.data} />
                    {crew && (
                      <Topology
                        crewName={crew.name}
                        squads={crew.squads}
                        tasks={tasks.data ?? []}
                        contexts={contexts.data ?? {}}
                        onOpenOperator={(s) => setOpenOperatorId(s.id)}
                        onAddOperator={setOperatorSquad}
                        onAddSquad={() => setAddSquad(true)}
                      />
                    )}
                  </div>
                </ScrollArea>

                <aside className="flex w-80 shrink-0 flex-col border-l xl:w-96">
                  <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col gap-0">
                    <div className="border-b px-3 py-2">
                      <TabsList className="w-full">
                        <TabsTrigger value="activity">Activity</TabsTrigger>
                        <TabsTrigger value="tasks">
                          Tasks
                          {!!tasks.data?.filter((t) => t.state !== 'done').length && (
                            <span className="text-muted-foreground tabular-nums">
                              {tasks.data.filter((t) => t.state !== 'done').length}
                            </span>
                          )}
                        </TabsTrigger>
                        <TabsTrigger value="cost">Cost</TabsTrigger>
                      </TabsList>
                    </div>
                    <TabsContent value="activity" className="min-h-0 flex-1">
                      <ScrollArea className="h-full">
                        <ActivityFeed events={events.data ?? []} crewId={crewId} />
                      </ScrollArea>
                    </TabsContent>
                    <TabsContent value="tasks" className="min-h-0 flex-1">
                      <ScrollArea className="h-full">
                        {crewId != null && <TasksPanel crewId={crewId} tasks={tasks.data ?? []} operators={operators} />}
                      </ScrollArea>
                    </TabsContent>
                    <TabsContent value="cost" className="min-h-0 flex-1">
                      <ScrollArea className="h-full">
                        <CostPanel series={spend.data ?? []} operators={operators} />
                      </ScrollArea>
                    </TabsContent>
                  </Tabs>
                </aside>
              </div>
            </>
          )}
        </main>
      </div>

      <NewCrewDialog open={newCrew} onOpenChange={setNewCrew} onCreated={setCrewId} />
      {crewId != null && <AddSquadDialog crewId={crewId} open={addSquad} onOpenChange={setAddSquad} />}
      <AddOperatorDialog
        squads={crew?.squads ?? []}
        squadId={operatorSquad}
        defaultModels={settings.data?.defaultModels}
        onOpenChange={(o) => !o && setOperatorSquad(null)}
      />
      <OperatorDrawer operator={openOperator} crewName={crew?.name ?? ''} onClose={() => setOpenOperatorId(null)} />
    </TooltipProvider>
  )
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
