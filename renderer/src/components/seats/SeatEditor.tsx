import { useMemo, useState } from 'react'
import {
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react'
import { Armchair, Copy, Network, Pencil, Plus, Trash2, Users } from 'lucide-react'
import { decodeIpcError } from '@shared/ipc'
import type { Preset, Team } from '@shared/types'
import { PresetEditor } from '@/components/presets/PresetEditor'
import { SeatDialog } from '@/components/settings/sections/SeatDialog'
import { TeamDialog, TeamRow, limitText, seatText } from '@/components/settings/sections/TeamsSection'
import { summary } from '@/components/settings/sections/PresetsSection'
import { ConfirmDialog } from '@/components/settings/parts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useDeletePreset, useDeleteTeam, useDuplicatePreset, useHideTeam, usePresets, useSettings, useTeams } from '@/lib/queries'
import { cn } from '@/lib/utils'

type View = 'nodes' | 'list'
const VIEW_KEY = 'operant.seatEditor.view'
const POS_KEY = 'operant.seatEditor.positions'

type XY = { x: number; y: number }

function readView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'nodes'
  } catch {
    return 'nodes'
  }
}

function readPositions(): Record<string, XY> {
  try {
    return JSON.parse(localStorage.getItem(POS_KEY) ?? '{}') as Record<string, XY>
  } catch {
    return {}
  }
}

interface Actions {
  editSeat: (p: Preset) => void
  seatSettings: (p: Preset) => void
  duplicateSeat: (p: Preset) => void
  deleteSeat: (p: Preset) => void
  editTeam: (t: Team) => void
  deleteTeam: (t: Team) => void
  error: (message: string) => void
}

type SeatNodeData = { preset: Preset; teams: number; actions: Actions } & Record<string, unknown>
type TeamNodeData = { team: Team; presets: Preset[]; actions: Actions } & Record<string, unknown>

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Button variant="ghost" size="icon-sm" aria-label={label} title={label} className="nodrag nopan" onClick={onClick}>
      {children}
    </Button>
  )
}

function SeatNode({ data }: NodeProps<Node<SeatNodeData>>) {
  const { preset: p, actions } = data
  return (
    <div className="bg-card w-[300px] rounded-lg border p-3 shadow-sm">
      <Handle type="target" position={Position.Right} className="!size-2.5 !border-2" />
      <div className="flex items-center gap-2">
        <Armchair className="text-muted-foreground size-4 shrink-0" />
        <span className="truncate text-sm font-semibold">{p.name}</span>
        {p.builtin && <Badge variant="secondary">Built-in</Badge>}
      </div>
      <div className="text-muted-foreground mt-1 truncate font-mono text-xs">{summary(p)}</div>
      <div className="text-muted-foreground text-xs">
        {data.teams === 0 ? 'Not on a team' : `On ${data.teams} team${data.teams === 1 ? '' : 's'}`}
      </div>
      <div className="mt-1 flex gap-0.5">
        <IconButton label={`Edit ${p.name}`} onClick={() => actions.editSeat(p)}>
          <Pencil />
        </IconButton>
        <IconButton label={`Seat settings for ${p.name}`} onClick={() => actions.seatSettings(p)}>
          <Armchair />
        </IconButton>
        <IconButton label={`Duplicate ${p.name}`} onClick={() => actions.duplicateSeat(p)}>
          <Copy />
        </IconButton>
        <IconButton label={`Delete ${p.name}`} onClick={() => actions.deleteSeat(p)}>
          <Trash2 />
        </IconButton>
      </div>
    </div>
  )
}

function TeamNode({ data }: NodeProps<Node<TeamNodeData>>) {
  const { team: t, actions } = data
  return (
    <div className="bg-card w-[300px] rounded-lg border p-3 shadow-sm">
      <Handle type="source" position={Position.Left} className="!size-2.5 !border-2" />
      <div className="flex items-center gap-2">
        <Users className="text-muted-foreground size-4 shrink-0" />
        <span className="truncate text-sm font-semibold">{t.name}</span>
      </div>
      <div className="text-muted-foreground mt-1 text-xs break-words">{seatText(t, data.presets)}</div>
      <div className="text-muted-foreground text-xs">{limitText(t)}</div>
      <div className="mt-1 flex gap-0.5">
        <IconButton label={`Edit ${t.name}`} onClick={() => actions.editTeam(t)}>
          <Pencil />
        </IconButton>
        <IconButton label={`Delete ${t.name}`} onClick={() => actions.deleteTeam(t)}>
          <Trash2 />
        </IconButton>
      </div>
    </div>
  )
}

const nodeTypes = { seat: SeatNode, team: TeamNode }
const proOptions = { hideAttribution: true }

const SEAT_H = 150
const TEAM_H = 170
const COL_GAP = 320

function NodeView({ presets, teams, actions }: { presets: Preset[]; teams: Team[]; actions: Actions }) {
  const [saved, setSaved] = useState(readPositions)

  const nodes = useMemo(() => {
    const out: Node[] = []
    presets.forEach((p, i) => {
      const id = `seat:${p.id}`
      out.push({
        id,
        type: 'seat',
        position: saved[id] ?? { x: 0, y: i * SEAT_H },
        data: {
          preset: p,
          teams: teams.filter((t) => t.seats.some((s) => s.presetId === p.id)).length,
          actions,
        } satisfies SeatNodeData,
      })
    })
    teams.forEach((t, i) => {
      const id = `team:${t.id}`
      out.push({ id, type: 'team', position: saved[id] ?? { x: 300 + COL_GAP, y: i * TEAM_H }, data: { team: t, presets, actions } satisfies TeamNodeData })
    })
    return out
  }, [presets, teams, actions, saved])

  const edges = useMemo(() => {
    const out: Edge[] = []
    const known = new Set(presets.map((p) => p.id))
    for (const t of teams)
      for (const s of t.seats)
        if (known.has(s.presetId))
          out.push({
            id: `team:${t.id}>seat:${s.presetId}`,
            source: `team:${t.id}`,
            target: `seat:${s.presetId}`,
            label: `${s.count} x`,
            markerEnd: { type: MarkerType.ArrowClosed },
          })
    return out
  }, [presets, teams])

  const onNodesChange = (changes: NodeChange[]) => {
    const moved = applyNodeChanges(changes, nodes)
    const next = { ...saved }
    let changed = false
    for (const n of moved) {
      const old = nodes.find((o) => o.id === n.id)
      if (old && (old.position.x !== n.position.x || old.position.y !== n.position.y)) {
        next[n.id] = n.position
        changed = true
      }
    }
    if (changed) setSaved(next)
  }

  const persist = () => {
    try {
      localStorage.setItem(POS_KEY, JSON.stringify(saved))
    } catch {
      /* storage unavailable */
    }
  }

  return (
    <div className="h-full" data-testid="seat-graph">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStop={persist}
        fitView
        minZoom={0.2}
        maxZoom={1.4}
        colorMode="dark"
        nodesConnectable={false}
        deleteKeyCode={null}
        proOptions={proOptions}
        aria-label="Seats and teams graph"
      >
        <Background gap={24} />
        <Controls showInteractive={false} aria-label="Graph controls" />
      </ReactFlow>
    </div>
  )
}

function ListSection({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">
        {title} <span className="text-muted-foreground tabular-nums">{count}</span>
      </h2>
      {children}
    </section>
  )
}

function ListView({ presets, teams, actions }: { presets: Preset[]; teams: Team[]; actions: Actions }) {
  return (
    <div className="mx-auto max-w-[96rem] space-y-8 overflow-y-auto p-6">
      <ListSection title="Seats" count={presets.length}>
        {presets.length === 0 ? (
          <p className="text-muted-foreground text-sm">No seats. Create one.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {presets.map((p) => {
              const on = teams.filter((t) => t.seats.some((s) => s.presetId === p.id))
              return (
                <li key={p.id} className="flex items-center justify-between gap-4 px-3 py-2.5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{p.name}</span>
                      {p.builtin && <Badge variant="secondary">Built-in</Badge>}
                    </div>
                    <div className="text-muted-foreground truncate font-mono text-xs">{summary(p)}</div>
                    <div className="text-muted-foreground truncate text-xs">
                      {on.length === 0 ? 'Not on a team' : `Teams: ${on.map((t) => t.name).join(', ')}`}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <IconButton label={`Edit ${p.name}`} onClick={() => actions.editSeat(p)}>
                      <Pencil />
                    </IconButton>
                    <IconButton label={`Seat settings for ${p.name}`} onClick={() => actions.seatSettings(p)}>
                      <Armchair />
                    </IconButton>
                    <IconButton label={`Duplicate ${p.name}`} onClick={() => actions.duplicateSeat(p)}>
                      <Copy />
                    </IconButton>
                    <IconButton label={`Delete ${p.name}`} onClick={() => actions.deleteSeat(p)}>
                      <Trash2 />
                    </IconButton>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </ListSection>
      <ListSection title="Teams" count={teams.length}>
        {teams.length === 0 ? (
          <p className="text-muted-foreground text-sm">No teams. Create one to give jobs a set of seats.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {teams.map((t) => (
              <TeamRow key={t.id} team={t} presets={presets} onEdit={actions.editTeam} onDelete={actions.deleteTeam} onError={actions.error} />
            ))}
          </ul>
        )}
      </ListSection>
    </div>
  )
}

// Seats (presets) and teams as two views of the same data; both views edit through the same dialogs.
export function SeatEditor() {
  const presetsQ = usePresets()
  const teamsQ = useTeams()
  const settings = useSettings()
  const duplicate = useDuplicatePreset()
  const removeSeat = useDeletePreset()
  const removeTeam = useDeleteTeam()
  const hideTeam = useHideTeam()
  const [view, setViewState] = useState<View>(readView)
  const [editingSeat, setEditingSeat] = useState<Preset | 'new' | null>(null)
  const [settingsSeat, setSettingsSeat] = useState<Preset | null>(null)
  const [editingTeam, setEditingTeam] = useState<Team | 'new' | null>(null)
  const [delSeat, setDelSeat] = useState<Preset | null>(null)
  const [delTeam, setDelTeam] = useState<Team | null>(null)
  const [error, setError] = useState<string | null>(null)

  const presets = presetsQ.data ?? []
  const teams = (teamsQ.data ?? []).filter((t) => !t.hidden)

  const setView = (v: View) => {
    setViewState(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      /* storage unavailable */
    }
  }

  const actions = useMemo<Actions>(
    () => ({
      editSeat: setEditingSeat,
      seatSettings: setSettingsSeat,
      duplicateSeat: (p) => {
        setError(null)
        duplicate.mutateAsync([p.id]).then(setEditingSeat, (e) => setError(decodeIpcError(e).message))
      },
      deleteSeat: (p) => (setError(null), setDelSeat(p)),
      editTeam: setEditingTeam,
      deleteTeam: (t) => {
        setError(null)
        if (t.builtin) hideTeam.mutateAsync([t.id, true]).catch((e: unknown) => setError(decodeIpcError(e).message))
        else setDelTeam(t)
      },
      error: (m) => setError(m || null),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [duplicate.mutateAsync, hideTeam.mutateAsync],
  )

  const confirmDelete = async () => {
    setError(null)
    try {
      if (delSeat) await removeSeat.mutateAsync([delSeat.id])
      if (delTeam) await removeTeam.mutateAsync(delTeam.id)
      setDelSeat(null)
      setDelTeam(null)
    } catch (e) {
      setError(decodeIpcError(e).message)
    }
  }

  const usedBy = delSeat ? teams.filter((t) => t.seats.some((s) => s.presetId === delSeat.id)).length : 0
  const loading = presetsQ.isLoading || teamsQ.isLoading

  return (
    <section aria-label="Seat editor" className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b px-6">
        <h2 className="flex-1 text-sm font-medium">Seats and teams</h2>
        <div role="group" aria-label="Seat editor view" className="bg-muted flex rounded-md p-0.5">
          {(['nodes', 'list'] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={v === view}
              onClick={() => setView(v)}
              className={cn(
                'flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition-colors',
                v === view ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {v === 'nodes' ? <Network className="size-3.5" /> : null}
              {v === 'nodes' ? 'Nodes' : 'List'}
            </button>
          ))}
        </div>
        <Button variant="outline" size="sm" onClick={() => setEditingTeam('new')}>
          <Plus /> New team
        </Button>
        <Button size="sm" onClick={() => setEditingSeat('new')}>
          <Plus /> New seat
        </Button>
      </div>
      {error && !delSeat && !delTeam && (
        <p role="alert" className="text-destructive border-b px-6 py-2 text-sm">
          {error}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        {loading ? (
          <p className="text-muted-foreground p-6 text-sm">Loading…</p>
        ) : view === 'nodes' ? (
          <ReactFlowProvider>
            <NodeView presets={presets} teams={teams} actions={actions} />
          </ReactFlowProvider>
        ) : (
          <div className="h-full overflow-y-auto">
            <ListView presets={presets} teams={teams} actions={actions} />
          </div>
        )}
      </div>

      {editingSeat && (
        <PresetEditor
          open
          preset={editingSeat === 'new' ? null : editingSeat}
          defaultModel={settings.data?.defaultModels.claude ?? 'sonnet'}
          onClose={() => setEditingSeat(null)}
        />
      )}
      {settingsSeat && <SeatDialog key={settingsSeat.id} preset={settingsSeat} onClose={() => setSettingsSeat(null)} />}
      {editingTeam && <TeamDialog team={editingTeam === 'new' ? null : editingTeam} presets={presets} onClose={() => setEditingTeam(null)} />}

      <ConfirmDialog
        open={delSeat != null || delTeam != null}
        title={delSeat ? `Delete ${delSeat.name}?` : `Delete ${delTeam?.name}?`}
        confirmLabel={delSeat ? 'Delete seat' : 'Delete team'}
        busy={removeSeat.isPending || removeTeam.isPending}
        error={error}
        onConfirm={() => void confirmDelete()}
        onClose={() => {
          setDelSeat(null)
          setDelTeam(null)
          setError(null)
        }}
      >
        {delSeat ? (
          <p>
            It is on {usedBy} team{usedBy === 1 ? '' : 's'}, which then show it as a deleted preset.{' '}
            {delSeat.builtin ? 'Restore built-ins in Settings brings it back.' : 'This cannot be undone.'}
          </p>
        ) : (
          <p>
            Its {delTeam?.seats.length ?? 0} seat{delTeam?.seats.length === 1 ? '' : 's'}, limits and rules are removed. Jobs already sent keep
            their own copy. This cannot be undone.
          </p>
        )}
      </ConfirmDialog>
    </section>
  )
}
