import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  applyNodeChanges,
  Background,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type NodeChange,
  type OnNodeDrag,
} from '@xyflow/react'
import { RefreshCw, Trash2 } from 'lucide-react'
import { decodeIpcError } from '@shared/ipc'
import type { GraphData, GraphEdge, GraphNode, GraphNodeType, GraphWindow, Job, Operator } from '@shared/types'
import { EditOperatorDialog } from '@/components/dashboard/Dialogs'
import { MasterEditDialog } from '@/components/operators/MasterEditDialog'
import { ConfirmDialog, MessageDialog, NewJobDialog, RenameDialog } from '@/components/graph/dialogs'
import { autoLayout, type XY } from '@/components/graph/layout'
import { ContextMenu, type MenuItem } from '@/components/graph/menu'
import { nodeTypes, type FlowNode, type GraphNodeData } from '@/components/graph/nodes'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { agentLabel } from '@/lib/format'
import { openDialog } from '@/lib/dialogs'
import {
  call,
  useAction,
  useCreateLink,
  useDeleteLink,
  useDeleteOperator,
  useDeleteSquad,
  useGraph,
  useJobs,
  useMaster,
  useStartMaster,
  useStopMaster,
  useUnread,
  useUpdateLink,
} from '@/lib/queries'
import { cn } from '@/lib/utils'
import type { ViewProps } from '@/registry'

const WINDOWS: Array<{ id: GraphWindow; label: string }> = [
  { id: '1h', label: 'Last hour' },
  { id: '24h', label: 'Last 24 hours' },
  { id: 'all', label: 'All time' },
]

const SAVE_DEBOUNCE_MS = 500
const EDGE_COLOR = { member: '#71717a', message: '#a78bfa', job: '#fbbf24', link: '#38bdf8' } as const
const NODE_COLOR: Record<GraphNodeType, string> = {
  crew: '#a1a1aa',
  squad: '#71717a',
  operator: '#34d399',
  master: '#38bdf8',
  user: '#fbbf24',
}
const miniMapColor = (n: { type?: string }) => NODE_COLOR[(n.type ?? 'operator') as GraphNodeType]
const defaultEdgeOptions = { interactionWidth: 18 }
const fitViewOptions = { padding: 0.15, minZoom: 0.6, maxZoom: 1 }
const proOptions = { hideAttribution: true }
const edgeKindLabel = { member: 'Membership', message: 'Messages', job: 'Jobs created for another operator', link: 'Link' } as const

function edgeText(e: GraphEdge): string | undefined {
  if (e.kind === 'member') return undefined
  if (e.kind === 'message') return e.label || String(e.count)
  if (e.kind === 'job') return e.label || `${e.count} job${e.count === 1 ? '' : 's'}`
  return e.label || undefined
}

function flowEdge(e: GraphEdge, selected: boolean): Edge {
  const color = EDGE_COLOR[e.kind]
  const width = e.kind === 'message' ? Math.min(4, 1 + Math.log2(Math.max(1, e.count))) : e.kind === 'link' ? 2 : 1
  return {
    id: e.id,
    source: e.from,
    target: e.to,
    label: edgeText(e),
    selectable: e.kind !== 'member',
    focusable: e.kind !== 'member',
    selected,
    data: { kind: e.kind },
    style: {
      stroke: color,
      strokeWidth: selected ? width + 1.5 : width,
      strokeDasharray: e.kind === 'job' ? '6 4' : undefined,
      opacity: e.kind === 'member' ? 0.55 : 1,
    },
    labelStyle: { fill: 'var(--foreground)', fontSize: 11 },
    labelBgStyle: { fill: 'var(--card)' },
    labelBgPadding: [4, 2],
    labelBgBorderRadius: 4,
    markerEnd: e.kind === 'member' ? undefined : { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
  }
}

const sameData = (a: GraphNodeData, b: GraphNodeData) =>
  a.kind === b.kind && a.label === b.label && a.status === b.status && a.agent === b.agent && a.unread === b.unread && a.job === b.job

interface OpInfo {
  operator: Operator
  squadName: string
}

type Pending =
  | { kind: 'message'; to: number | 'master'; label: string }
  | { kind: 'job'; operatorId: number; label: string }
  | { kind: 'edit'; operatorId: number }
  | { kind: 'rename'; what: 'crew' | 'squad'; id: number; name: string }
  | { kind: 'deleteOperator'; operator: Operator; jobs: number; links: number; unread: number }
  | { kind: 'deleteSquad'; id: number; name: string; operators: number }
  | { kind: 'deleteLink'; linkId: number; label: string }

interface MenuState {
  x: number
  y: number
  node: FlowNode
}

type CanvasProps = ViewProps & { data: GraphData; window: GraphWindow; setWindow: (w: GraphWindow) => void }

function GraphCanvas({ crewId, crew, data, window: win, setWindow, onAddOperator, onAddSquad }: CanvasProps) {
  const unread = useUnread(crewId)
  const jobs = useJobs(crewId, true)
  const master = useMaster(crewId).data
  const { fitView } = useReactFlow()

  const startOperator = useAction('operators:start')
  const stopOperator = useAction('operators:stop')
  const restartOperator = useAction('operators:restart')
  const startMaster = useStartMaster()
  const stopMaster = useStopMaster()
  const deleteOperator = useDeleteOperator()
  const deleteSquad = useDeleteSquad()
  const createLink = useCreateLink()
  const updateLink = useUpdateLink()
  const deleteLink = useDeleteLink()

  const [notice, setNotice] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null)
  const [linkLabel, setLinkLabel] = useState('')

  const fail = useCallback((e: unknown) => setNotice(decodeIpcError(e).message), [])
  const closeMenu = useCallback(() => setMenu(null), [])

  const operators = useMemo(() => {
    const m = new Map<number, OpInfo>()
    for (const s of crew.squads) for (const o of s.operators) m.set(o.id, { operator: o, squadName: s.name })
    return m
  }, [crew.squads])

  const jobInfo = useMemo(() => {
    const doing = new Map<number, string>()
    const open = new Map<number, number>()
    for (const j of jobs.data ?? ([] as Job[])) {
      if (j.assigneeId == null) continue
      if (j.state === 'doing') doing.set(j.assigneeId, j.title)
      if (j.state === 'todo' || j.state === 'doing') open.set(j.assigneeId, (open.get(j.assigneeId) ?? 0) + 1)
    }
    return { doing, open }
  }, [jobs.data])

  // Auto layout reruns only when the tree changes, not on every message count.
  const structure = useMemo(
    () =>
      data.nodes.map((n) => n.key).join('|') +
      '#' +
      data.edges
        .filter((e) => e.kind === 'member')
        .map((e) => `${e.from}>${e.to}`)
        .join('|'),
    [data.nodes, data.edges],
  )
  const auto = useMemo(() => autoLayout(data.nodes, data.edges), [structure]) // eslint-disable-line react-hooks/exhaustive-deps
  const saved = useMemo(() => new Map(data.positions.map((p) => [p.nodeKey, { x: p.x, y: p.y }])), [data.positions])

  // Node data keeps its identity while its fields do not change, so memoised nodes skip re-rendering.
  const dataCache = useRef(new Map<string, GraphNodeData>())
  const derived = useMemo(() => {
    const cache = dataCache.current
    const seen = new Set<string>()
    const out: FlowNode[] = data.nodes.map((n: GraphNode) => {
      const info = n.operatorId != null ? operators.get(n.operatorId) : undefined
      const next: GraphNodeData = {
        kind: n.type,
        label: n.label,
        status: n.status ?? info?.operator.status,
        agent: info ? `${agentLabel[info.operator.agent]}${info.operator.agent === 'shell' ? '' : ` - ${info.operator.model}`}` : undefined,
        unread:
          n.type === 'user'
            ? (unread.data?.user ?? 0)
            : n.type === 'master'
              ? (unread.data?.master ?? 0)
              : n.operatorId != null
                ? (unread.data?.operators[n.operatorId] ?? 0)
                : 0,
        job: n.operatorId != null ? jobInfo.doing.get(n.operatorId) : undefined,
      }
      const prev = cache.get(n.key)
      const stable = prev && sameData(prev, next) ? prev : next
      cache.set(n.key, stable)
      seen.add(n.key)
      return {
        id: n.key,
        type: n.type,
        position: saved.get(n.key) ?? auto.get(n.key) ?? { x: 0, y: 0 },
        data: stable,
        ariaLabel: `${n.type} ${n.label}${stable.status ? `, ${stable.status}` : ''}`,
      }
    })
    for (const k of cache.keys()) if (!seen.has(k)) cache.delete(k)
    return out
  }, [data.nodes, operators, unread.data, jobInfo, saved, auto])

  const [nodes, setNodes] = useState<FlowNode[]>(derived)
  useEffect(() => {
    setNodes((prev) => {
      const old = new Map(prev.map((n) => [n.id, n]))
      return derived.map((d) => {
        const o = old.get(d.id)
        return o ? { ...d, position: o.position, selected: o.selected, measured: o.measured } : d
      })
    })
  }, [derived])

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => setNodes((ns) => applyNodeChanges(changes, ns)), [])

  const edges = useMemo(() => data.edges.map((e) => flowEdge(e, e.id === selectedEdge)), [data.edges, selectedEdge])
  const edgeById = useMemo(() => new Map(data.edges.map((e) => [e.id, e])), [data.edges])
  const nodeByKey = useMemo(() => new Map(data.nodes.map((n) => [n.key, n])), [data.nodes])

  // Saved positions: batch what was dragged and write once the user has stopped.
  const dragged = useRef(new Map<string, XY>())
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const flush = useCallback(() => {
    clearTimeout(timer.current)
    if (dragged.current.size === 0) return
    const batch = [...dragged.current].map(([nodeKey, p]) => ({ nodeKey, x: Math.round(p.x), y: Math.round(p.y) }))
    dragged.current.clear()
    call('graph:savePositions', crewId, batch).catch(fail)
  }, [crewId, fail])
  useEffect(() => flush, [flush])
  const onNodeDragStop: OnNodeDrag<FlowNode> = useCallback(
    (_e, _node, all) => {
      for (const n of all) dragged.current.set(n.id, n.position)
      clearTimeout(timer.current)
      timer.current = setTimeout(flush, SAVE_DEBOUNCE_MS)
    },
    [flush],
  )

  const relayout = async () => {
    clearTimeout(timer.current)
    dragged.current.clear()
    try {
      await call('graph:clear', crewId)
    } catch (e) {
      return fail(e)
    }
    setNodes((ns) => ns.map((n) => ({ ...n, position: auto.get(n.id) ?? n.position })))
    requestAnimationFrame(() => void fitView({ ...fitViewOptions, duration: 200 }))
  }

  const isValidConnection = useCallback(
    (c: Connection | Edge) => {
      const a = nodeByKey.get(c.source)?.operatorId
      const b = nodeByKey.get(c.target)?.operatorId
      return a != null && b != null && a !== b
    },
    [nodeByKey],
  )
  const onConnect = useCallback(
    (c: Connection) => {
      const fromId = nodeByKey.get(c.source)?.operatorId
      const toId = nodeByKey.get(c.target)?.operatorId
      if (fromId == null || toId == null) return
      setNotice(null)
      createLink.mutate([{ crewId, fromId, toId }], { onError: fail })
    },
    [crewId, nodeByKey, createLink, fail],
  )

  const onNodeContextMenu = useCallback((e: React.MouseEvent, node: FlowNode) => {
    if (node.type === 'user') return
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, node })
  }, [])

  const onNodeDoubleClick = useCallback(
    (_e: React.MouseEvent, node: FlowNode) => {
      const gn = nodeByKey.get(node.id)
      if (!gn) return
      if ((gn.type === 'operator' || gn.type === 'master') && gn.operatorId != null) setPending({ kind: 'edit', operatorId: gn.operatorId })
      else if (gn.type === 'squad' && gn.squadId != null) setPending({ kind: 'rename', what: 'squad', id: gn.squadId, name: gn.label })
      else if (gn.type === 'crew') setPending({ kind: 'rename', what: 'crew', id: crewId, name: crew.name })
    },
    [nodeByKey, crewId, crew.name],
  )

  const menuItems = (node: FlowNode): MenuItem[] => {
    const gn = nodeByKey.get(node.id)
    if (!gn) return []
    const status = node.data.status ?? 'stopped'
    const active = status === 'running' || status === 'idle' || status === 'starting'
    if (gn.type === 'operator' && gn.operatorId != null) {
      const id = gn.operatorId
      const info = operators.get(id)
      const items: MenuItem[] = []
      if (!active) items.push({ label: 'Start', onSelect: () => startOperator.mutate([id], { onError: fail }) })
      if (active) items.push({ label: 'Stop', onSelect: () => stopOperator.mutate([id], { onError: fail }) })
      if (active) items.push({ label: 'Restart', onSelect: () => restartOperator.mutate([id], { onError: fail }) })
      items.push({ label: 'Message', onSelect: () => setPending({ kind: 'message', to: id, label: gn.label }), separatorBefore: true })
      items.push({ label: 'New job for', onSelect: () => setPending({ kind: 'job', operatorId: id, label: gn.label }) })
      if (info?.operator.agent !== 'shell')
        items.push({ label: 'Change model/effort', onSelect: () => openDialog('changeModelEffort', { operatorId: id }) })
      if (info)
        items.push({
          label: 'Delete',
          destructive: true,
          separatorBefore: true,
          onSelect: () =>
            setPending({
              kind: 'deleteOperator',
              operator: info.operator,
              jobs: jobInfo.open.get(id) ?? 0,
              links: data.edges.filter((e) => e.kind === 'link' && (e.from === gn.key || e.to === gn.key)).length,
              unread: unread.data?.operators[id] ?? 0,
            }),
        })
      return items
    }
    if (gn.type === 'master') {
      return [
        active
          ? { label: 'Stop Master Terminal', onSelect: () => stopMaster.mutate([crewId], { onError: fail }) }
          : { label: 'Start Master Terminal', onSelect: () => startMaster.mutate([crewId], { onError: fail }) },
        { label: 'Message', onSelect: () => setPending({ kind: 'message', to: 'master', label: 'Master Terminal' }), separatorBefore: true },
      ]
    }
    if (gn.type === 'squad' && gn.squadId != null) {
      const squadId = gn.squadId
      const count = crew.squads.find((s) => s.id === squadId)?.operators.length ?? 0
      return [
        { label: 'Rename', onSelect: () => setPending({ kind: 'rename', what: 'squad', id: squadId, name: gn.label }) },
        { label: 'Add operator', onSelect: () => onAddOperator(squadId) },
        {
          label: 'Delete',
          destructive: true,
          separatorBefore: true,
          onSelect: () => setPending({ kind: 'deleteSquad', id: squadId, name: gn.label, operators: count }),
        },
      ]
    }
    if (gn.type === 'crew') {
      return [
        { label: 'Rename', onSelect: () => setPending({ kind: 'rename', what: 'crew', id: crewId, name: crew.name }) },
        { label: 'Add squad', onSelect: onAddSquad },
      ]
    }
    return []
  }

  const edge = selectedEdge ? edgeById.get(selectedEdge) : undefined
  useEffect(() => {
    setLinkLabel(edge?.kind === 'link' ? edge.label : '')
  }, [edge?.id, edge?.kind, edge?.label])
  const labelOf = (key: string) => nodeByKey.get(key)?.label ?? key

  return (
    <div className="relative h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onNodeContextMenu={onNodeContextMenu}
        onNodeDoubleClick={onNodeDoubleClick}
        onNodeClick={() => setSelectedEdge(null)}
        onEdgeClick={(_e, e) => setSelectedEdge(e.id)}
        onPaneClick={() => setSelectedEdge(null)}
        defaultEdgeOptions={defaultEdgeOptions}
        fitView
        fitViewOptions={fitViewOptions}
        minZoom={0.2}
        maxZoom={1.6}
        colorMode="dark"
        deleteKeyCode={null}
        nodesConnectable
        proOptions={proOptions}
        aria-label="Crew graph"
      >
        <Background gap={24} />
        <Controls showInteractive={false} aria-label="Graph controls" />
        <MiniMap pannable zoomable nodeColor={miniMapColor} aria-label="Graph overview" />
        <Panel position="top-left" className="flex items-center gap-2">
          <div role="group" aria-label="Edge window" className="bg-card flex rounded-md border p-0.5">
            {WINDOWS.map((w) => (
              <button
                key={w.id}
                aria-pressed={win === w.id}
                onClick={() => setWindow(w.id)}
                className={cn(
                  'rounded-sm px-2.5 py-1 text-xs transition-colors',
                  win === w.id ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {w.label}
              </button>
            ))}
          </div>
          <Button size="sm" variant="outline" className="bg-card h-8" onClick={() => void relayout()}>
            <RefreshCw className="size-3.5" /> Re-layout
          </Button>
        </Panel>
        <Panel position="bottom-center" className="flex flex-col items-center gap-2">
          {notice && (
            <p role="alert" className="bg-card text-destructive rounded-md border px-3 py-1.5 text-xs">
              {notice}
              <button className="text-muted-foreground hover:text-foreground ml-2" aria-label="Dismiss message" onClick={() => setNotice(null)}>
                x
              </button>
            </p>
          )}
          {edge && (
            <div className="bg-card flex items-center gap-2 rounded-md border px-3 py-2 text-xs" role="region" aria-label="Selected edge">
              <span className="text-muted-foreground">
                {edgeKindLabel[edge.kind]}: <span className="text-foreground">{labelOf(edge.from)}</span> to{' '}
                <span className="text-foreground">{labelOf(edge.to)}</span>
                {edge.kind !== 'link' && ` (${edge.count})`}
              </span>
              {edge.kind === 'link' && edge.linkId != null && (
                <>
                  <Input
                    aria-label="Link label"
                    value={linkLabel}
                    onChange={(e) => setLinkLabel(e.target.value)}
                    placeholder="Label"
                    maxLength={80}
                    className="h-7 w-44 text-xs"
                  />
                  <Button
                    size="sm"
                    className="h-7"
                    disabled={linkLabel === edge.label || updateLink.isPending}
                    onClick={() => updateLink.mutate([edge.linkId!, { label: linkLabel }], { onError: fail })}
                  >
                    Save label
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7"
                    aria-label="Delete link"
                    onClick={() =>
                      setPending({ kind: 'deleteLink', linkId: edge.linkId!, label: `${labelOf(edge.from)} to ${labelOf(edge.to)}` })
                    }
                  >
                    <Trash2 className="size-3.5" /> Delete
                  </Button>
                </>
              )}
            </div>
          )}
        </Panel>
      </ReactFlow>

      {menu && <ContextMenu x={menu.x} y={menu.y} label={`${menu.node.data.label} actions`} items={menuItems(menu.node)} onClose={closeMenu} />}

      {pending?.kind === 'message' && <MessageDialog crewId={crewId} to={pending.to} label={pending.label} onClose={() => setPending(null)} />}
      {pending?.kind === 'job' && (
        <NewJobDialog crewId={crewId} operatorId={pending.operatorId} label={pending.label} onClose={() => setPending(null)} />
      )}
      {pending?.kind === 'edit' &&
        (master?.id === pending.operatorId ? (
          <MasterEditDialog master={master} open onOpenChange={(o) => !o && setPending(null)} />
        ) : (
          operators.get(pending.operatorId) && (
            <EditOperatorDialog operator={operators.get(pending.operatorId)!.operator} squads={crew.squads} open onOpenChange={(o) => !o && setPending(null)} />
          )
        ))}
      {pending?.kind === 'rename' && <RenameDialog kind={pending.what} id={pending.id} name={pending.name} onClose={() => setPending(null)} />}
      {pending?.kind === 'deleteOperator' && (
        <ConfirmDialog
          title={`Delete ${pending.operator.role}?`}
          description={`This stops it and removes it from the crew. It holds ${pending.jobs} open job${pending.jobs === 1 ? '' : 's'} (they return to the board), has ${pending.links} link${pending.links === 1 ? '' : 's'} and ${pending.unread} unread message${pending.unread === 1 ? '' : 's'}.`}
          confirmLabel="Delete operator"
          run={() => deleteOperator.mutateAsync([pending.operator.id])}
          onClose={() => setPending(null)}
        />
      )}
      {pending?.kind === 'deleteSquad' && (
        <ConfirmDialog
          title={`Delete squad ${pending.name}?`}
          description={`This also deletes its ${pending.operators} operator${pending.operators === 1 ? '' : 's'}, stopping any that run.`}
          confirmLabel="Delete squad"
          run={() => deleteSquad.mutateAsync([pending.id])}
          onClose={() => setPending(null)}
        />
      )}
      {pending?.kind === 'deleteLink' && (
        <ConfirmDialog
          title="Delete this link?"
          description={`The link ${pending.label} is removed. Operators can still message each other.`}
          confirmLabel="Delete link"
          run={async () => {
            await deleteLink.mutateAsync([pending.linkId])
            setSelectedEdge(null)
          }}
          onClose={() => setPending(null)}
        />
      )}
    </div>
  )
}

export function GraphView(props: ViewProps) {
  const [win, setWin] = useState<GraphWindow>('24h')
  const graph = useGraph(props.crewId, win)
  const data = graph.data?.crewId === props.crewId ? graph.data : undefined

  if (!data) {
    return (
      <div className="grid h-full place-items-center p-6">
        <p className="text-muted-foreground text-sm">{graph.error ? decodeIpcError(graph.error).message : 'Loading graph'}</p>
      </div>
    )
  }
  return (
    <ReactFlowProvider>
      <GraphCanvas key={props.crewId} {...props} data={data} window={win} setWindow={setWin} />
    </ReactFlowProvider>
  )
}
