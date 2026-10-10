import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  ChevronDown,
  ChevronRight,
  Code2,
  Download,
  FlaskConical,
  FolderOpen,
  FolderPlus,
  GripVertical,
  MoreHorizontal,
  Network,
  Plus,
  RefreshCw,
  Sparkles,
  SquareTerminal,
} from 'lucide-react'
import { decodeIpcError } from '@shared/ipc'
import type { ProjectGroup } from '@shared/projects'
import type { Crew } from '@shared/types'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ResizeHandle } from '@/components/ui/resize-handle'
import { ScrollArea } from '@/components/ui/scroll-area'
import { bridge } from '@/lib/bridge'
import { CLI_SHORT, cliBlocked } from '@/lib/capabilities'
import {
  useCapabilities,
  useCollapseGroup,
  useCreateGroup,
  useDeleteGroup,
  useGitInfo,
  useGroups,
  useIdes,
  useMoveToGroup,
  useRenameGroup,
  useReorderCrews,
  useReorderGroups,
  useSettings,
  useUpdateStatus,
} from '@/lib/queries'
import { usePanelWidth } from '@/lib/layout'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { gitSummary } from '@/components/topbar/GitChip'
import { ProjectMenuContent, type ProjectMenuHandlers } from './ProjectMenu'

interface Props {
  crews: Crew[]
  selected: number | null
  onSelect: (id: number) => void
  // A group id adds the new project to that group.
  onNewCrew: (groupId?: number) => void
  actions: Omit<ProjectMenuHandlers, 'moveTo'>
  // Icon buttons on the bottom row: Settings, the console toggle, the learning and provider usage badges, and the git chip.
  footer?: ReactNode
}

const PANEL_DEFAULT = 250
const PANEL_MIN = 160
const PANEL_MAX = 600

// The project's branch (10.5 px, at most 90 px wide) and changed-file count after its name; nothing for a folder that is not a git repository.
function RowGit({ crewId }: { crewId: number }) {
  const git = useGitInfo(crewId).data
  if (!git) return null
  return (
    <span className="flex min-w-0 shrink items-center gap-1 text-[10.5px]" title={gitSummary(git)}>
      <span className="text-muted-foreground max-w-[90px] min-w-0 truncate font-mono">{git.branch}</span>
      {git.changes > 0 && (
        <span aria-label={`${git.changes} changed files`} className="shrink-0 rounded-full bg-amber-400/15 px-1.5 font-mono text-[10px] leading-4 text-amber-400">
          {git.changes}
        </span>
      )}
    </span>
  )
}

// The ids with `id` moved to the place `target` holds.
function moved(ids: number[], id: number, target: number): number[] {
  const from = ids.indexOf(id)
  const to = ids.indexOf(target)
  if (from < 0 || to < 0 || from === to) return ids
  const next = ids.filter((i) => i !== id)
  next.splice(to, 0, id)
  return next
}

type Drag = { kind: 'crew' | 'group'; id: number }

// One stop of the keyboard walk: a project or a group header, in the order they are drawn.
type NavItem = { key: string; kind: 'crew' | 'group'; id: number; label: string; group: number | null }

// A name that becomes a text field: Enter keeps it, Esc leaves it as it was, leaving the field keeps it too.
function NameEditor({ initial, label, onCommit, onCancel }: { initial: string; label: string; onCommit: (name: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial)
  const done = useRef(false)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const finish = (commit: boolean) => {
    if (done.current) return
    done.current = true
    if (commit && value.trim() && value.trim() !== initial) onCommit(value.trim())
    else onCancel()
  }
  return (
    <input
      ref={ref}
      value={value}
      aria-label={label}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') finish(true)
        if (e.key === 'Escape') finish(false)
      }}
      onDragStart={(e) => e.preventDefault()}
      className="bg-background text-foreground min-w-0 flex-1 rounded-md border px-1.5 text-xs normal-case outline-none focus:ring-1"
    />
  )
}

const hoverOnly = 'hidden group-hover:flex group-focus-within:flex'
const tiny = 'text-muted-foreground hover:text-foreground size-5 shrink-0'
const headerBtn = 'text-muted-foreground hover:text-foreground hover:bg-foreground/[.08] size-[22px] rounded-md [&_svg]:size-3'
const ring = 'shadow-[inset_0_0_0_1.5px_var(--primary)]'

export function Sidebar({ crews: allCrews, selected, onSelect, onNewCrew, actions, footer }: Props) {
  // The Playground is pinned above the list; every list below works on the real projects only.
  const playground = allCrews.find((c) => c.kind === 'playground')
  const crews = allCrews.filter((c) => c.kind !== 'playground')
  const update = useUpdateStatus()
  const qc = useQueryClient()
  const reorder = useReorderCrews()
  const groupsQ = useGroups()
  const groups = groupsQ.data ?? []
  const createGroup = useCreateGroup()
  const renameGroup = useRenameGroup()
  const deleteGroup = useDeleteGroup()
  const collapseGroup = useCollapseGroup()
  const reorderGroups = useReorderGroups()
  const moveTo = useMoveToGroup()
  const ides = useIdes().data
  const defaultIde = useSettings().data?.ide.default ?? 'code'
  const ideName = ides?.find((i) => i.id === defaultIde)?.name ?? 'IDE'
  const mainCli = useSettings().data?.mainCli ?? 'claude'
  const agentBlocked = cliBlocked(useCapabilities().data, mainCli)
  const platform = bridge().platform
  const panel = usePanelWidth('sidebarWidth')
  const aside = useRef<HTMLElement>(null)
  const tree = useRef<HTMLDivElement>(null)

  const [dragId, setDragId] = useState<Drag | null>(null)
  // The drag in flight, readable at once by the events that follow the drag start (state lags a render).
  const dragging = useRef<Drag | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<number | null>(null)
  // The keyboard's current row (shown with a ring while the list has focus).
  const [cursor, setCursor] = useState<string | null>(null)
  const [focused, setFocused] = useState(false)
  const headerClick = useRef<number | undefined>(undefined)

  const ids = crews.map((c) => c.id)
  const knownGroup = (c: Crew) => (c.groupId != null && groups.some((g) => g.id === c.groupId) ? c.groupId : null)
  const inGroup = (gid: number | null) => crews.filter((c) => knownGroup(c) === gid)
  const failed = (e: unknown) => toast(decodeIpcError(e).message, true)

  const ungrouped = inGroup(null)
  const items: NavItem[] = [
    ...ungrouped.map((c): NavItem => ({ key: `p:${c.id}`, kind: 'crew', id: c.id, label: `project:${c.name}`, group: null })),
    ...groups.flatMap((g): NavItem[] => [
      { key: `g:${g.id}`, kind: 'group', id: g.id, label: `group:${g.name}`, group: g.id },
      ...(g.collapsed ? [] : inGroup(g.id).map((c): NavItem => ({ key: `p:${c.id}`, kind: 'crew', id: c.id, label: `project:${c.name}`, group: g.id }))),
    ]),
  ]
  const current = items.find((i) => i.key === cursor)

  useEffect(() => {
    if (focused) tree.current?.querySelector('[data-nav-current="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [cursor, focused])

  const saveCrews = (next: number[]) => next !== ids && reorder.mutate(next)
  const endDrag = () => {
    dragging.current = null
    setDragId(null)
    setOver(null)
  }
  const accepts = (e: DragEvent, key: string, ok: boolean) => {
    if (!ok) return
    e.preventDefault()
    e.stopPropagation()
    setOver(key)
  }

  const dropOnCrew = (e: DragEvent, target: Crew) => {
    e.preventDefault()
    const d = dragging.current
    endDrag()
    if (d?.kind !== 'crew' || d.id === target.id) return
    const mine = crews.find((c) => c.id === d.id)
    if (!mine) return
    if (knownGroup(mine) === knownGroup(target)) saveCrews(moved(ids, d.id, target.id))
    else moveTo.mutate([d.id, knownGroup(target), target.id], { onError: failed })
  }
  const dropOnGroup = (e: DragEvent, g: ProjectGroup) => {
    e.preventDefault()
    const d = dragging.current
    endDrag()
    if (!d) return
    if (d.kind === 'crew') moveTo.mutate([d.id, g.id], { onError: failed })
    else if (d.id !== g.id) reorderGroups.mutate([moved(groups.map((x) => x.id), d.id, g.id)])
  }
  const dropOnUngrouped = (e: DragEvent) => {
    e.preventDefault()
    const d = dragging.current
    endDrag()
    if (d?.kind === 'crew') moveTo.mutate([d.id, null], { onError: failed })
  }

  const moveCrew = (crew: Crew, by: -1 | 1) => {
    const section = inGroup(knownGroup(crew)).map((c) => c.id)
    const target = section[section.indexOf(crew.id) + by]
    if (target != null) saveCrews(moved(ids, crew.id, target))
  }
  const moveGroup = (g: ProjectGroup, by: -1 | 1) => {
    const gids = groups.map((x) => x.id)
    const target = gids[gids.indexOf(g.id) + by]
    if (target != null) reorderGroups.mutate([moved(gids, g.id, target)])
  }
  const onHandleKey = (e: KeyboardEvent, crew: Crew) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    e.preventDefault()
    e.stopPropagation()
    moveCrew(crew, e.key === 'ArrowUp' ? -1 : 1)
  }

  const toggle = (g: ProjectGroup, collapsed = !g.collapsed) => collapseGroup.mutate([g.id, collapsed], { onError: failed })

  // The list is one tab stop: arrows walk the rows, Alt+arrows reorder, Enter opens, Right and Left expand and collapse, F2 renames a group, Esc leaves.
  const onTreeKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input, textarea, [data-no-nav]') || e.ctrlKey || e.metaKey) return
    const at = items.findIndex((i) => i.key === cursor)
    const go = (i: number) => {
      const item = items[Math.min(items.length - 1, Math.max(0, i))]
      if (item) setCursor(item.key)
    }
    const cur = at >= 0 ? items[at] : undefined
    const crew = cur?.kind === 'crew' ? crews.find((c) => c.id === cur.id) : undefined
    const group = cur?.kind === 'group' ? groups.find((g) => g.id === cur.id) : undefined
    const handled = () => (e.preventDefault(), e.stopPropagation())
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      handled()
      const by = e.key === 'ArrowUp' ? -1 : 1
      if (crew) moveCrew(crew, by)
      else if (group) moveGroup(group, by)
      return
    }
    if (e.altKey || e.shiftKey) return
    switch (e.key) {
      case 'ArrowDown':
        handled()
        go(at < 0 ? 0 : at + 1)
        break
      case 'ArrowUp':
        handled()
        go(at < 0 ? 0 : at - 1)
        break
      case 'Home':
        handled()
        go(0)
        break
      case 'End':
        handled()
        go(items.length - 1)
        break
      case 'Enter':
        handled()
        if (crew) onSelect(crew.id)
        else if (group) toggle(group)
        break
      case 'ArrowRight':
        handled()
        if (group?.collapsed) toggle(group, false)
        else if (group) go(at + 1)
        break
      case 'ArrowLeft':
        handled()
        if (group && !group.collapsed) toggle(group, true)
        else if (cur?.kind === 'crew' && cur.group != null) setCursor(`g:${cur.group}`)
        break
      case 'F2':
        if (group) (handled(), setRenaming(group.id))
        break
      case 'Escape':
        handled()
        ;(document.activeElement as HTMLElement | null)?.blur()
        break
    }
  }

  const addGroup = () => createGroup.mutate([], { onSuccess: (g) => setRenaming(g.id), onError: failed })
  const indexAll = async () => {
    for (const c of crews) await bridge().invoke('index:run', c.id).catch(failed)
  }

  const handlers: ProjectMenuHandlers = {
    ...actions,
    moveTo: (crew, target) => {
      if (target === 'new') {
        createGroup.mutate([], {
          onSuccess: (g) => moveTo.mutate([crew.id, g.id], { onSuccess: () => setRenaming(g.id), onError: failed }),
          onError: failed,
        })
      } else moveTo.mutate([crew.id, target], { onError: failed })
    },
  }

  const indexGroup = async (g: ProjectGroup) => {
    for (const c of inGroup(g.id)) await bridge().invoke('index:run', c.id).catch(failed)
  }

  const crewRow = (crew: Crew) => {
    const key = `p:${crew.id}`
    const isCurrent = cursor === key
    const isSelected = crew.id === selected
    const menu = (kind: 'context' | 'dropdown') => (
      <ProjectMenuContent kind={kind} crew={crew} groups={groups} ideName={ideName} platform={platform} align="end" {...handlers} />
    )
    return (
      <ContextMenu key={crew.id}>
        <ContextMenuTrigger asChild>
          <div
            role="treeitem"
            aria-selected={isSelected}
            draggable
            data-crew-row={crew.id}
            data-nav-current={isCurrent && focused ? 'true' : undefined}
            data-nav-label={`project:${crew.name}`}
            onDragStart={(e) => {
              dragging.current = { kind: 'crew', id: crew.id }
              setDragId(dragging.current)
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', String(crew.id))
            }}
            onDragOver={(e) => accepts(e, `crew:${crew.id}`, dragging.current?.kind === 'crew')}
            onDrop={(e) => dropOnCrew(e, crew)}
            onDragEnd={endDrag}
            className={cn(
              'group relative flex h-6 items-center gap-[5px] rounded-md pr-1 pl-4 text-[13px] transition-colors',
              isSelected ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
              over === `crew:${crew.id}` && dragId?.id !== crew.id && 'ring-primary ring-1',
              dragId?.kind === 'crew' && dragId.id === crew.id && 'opacity-50',
              isCurrent && focused && ring,
            )}
          >
            <button
              type="button"
              data-no-nav
              aria-label={`Reorder ${crew.name}`}
              title="Drag to reorder or into a group, or use the up and down arrow keys"
              onKeyDown={(e) => onHandleKey(e, crew)}
              className="text-muted-foreground hover:text-foreground focus-visible:ring-primary absolute inset-y-0 left-0 flex w-3.5 cursor-grab items-center justify-center rounded-l-md opacity-0 outline-none group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:ring-1 active:cursor-grabbing"
            >
              <GripVertical className="size-3" />
            </button>
            <button
              type="button"
              tabIndex={-1}
              onClick={() => (setCursor(key), onSelect(crew.id))}
              className="flex h-full min-w-0 flex-1 items-center gap-[5px] text-left outline-none"
            >
              <span className={cn('max-w-[60%] shrink-0 truncate font-semibold', isSelected && 'text-primary')}>{crew.name}</span>
              <RowGit crewId={crew.id} />
              <span className="flex-1" />
              <span className="text-muted-foreground/70 shrink-0 font-mono text-[9px] group-hover:hidden group-focus-within:hidden">PRJ#{crew.prjNumber}</span>
            </button>
            <div data-no-nav className={cn('shrink-0 items-center', hoverOnly)}>
              <Button variant="ghost" size="icon" className={tiny} aria-label={`Index ${crew.name} with CodeGraph`} title="Index with CodeGraph" onClick={() => actions.index(crew)}>
                <Network className="size-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className={tiny} aria-label={`Open ${crew.name} in ${ideName}`} title={`Open in ${ideName}`} onClick={() => actions.openIde(crew)}>
                <Code2 className="size-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className={tiny} aria-label={`New ${CLI_SHORT[mainCli]} terminal in ${crew.name}`} title={agentBlocked ?? `New ${CLI_SHORT[mainCli]} terminal here`} disabled={!!agentBlocked} onClick={() => actions.newCli(crew, mainCli)}>
                <Sparkles className="size-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className={tiny} aria-label={`New shell in ${crew.name}`} title="New shell here" onClick={() => actions.newShell(crew)}>
                <SquareTerminal className="size-3.5" />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className={tiny} aria-label={`More actions for ${crew.name}`} title="More">
                    <MoreHorizontal className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                {menu('dropdown')}
              </DropdownMenu>
            </div>
          </div>
        </ContextMenuTrigger>
        {menu('context')}
      </ContextMenu>
    )
  }

  const playgroundRow = (pg: Crew) => {
    const isSelected = pg.id === selected
    return (
      <div
        role="treeitem"
        aria-selected={isSelected}
        data-playground-row={pg.id}
        className={cn(
          'group relative flex h-7 items-center gap-[5px] rounded-md pr-1 pl-2 text-[13px] transition-colors',
          isSelected ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
        )}
      >
        <button type="button" onClick={() => onSelect(pg.id)} title={pg.folder} className="flex h-full min-w-0 flex-1 items-center gap-[6px] text-left outline-none">
          <FlaskConical aria-hidden className={cn('size-3.5 shrink-0', isSelected ? 'text-primary' : 'text-orange-400')} />
          <span className={cn('max-w-[60%] shrink-0 truncate font-semibold', isSelected && 'text-primary')}>{pg.name}</span>
          <RowGit crewId={pg.id} />
          <span className="flex-1" />
        </button>
        <div className={cn('shrink-0 items-center', hoverOnly)}>
          <Button variant="ghost" size="icon" className={tiny} aria-label={`New ${CLI_SHORT[mainCli]} terminal in ${pg.name}`} title={agentBlocked ?? `New ${CLI_SHORT[mainCli]} terminal here`} disabled={!!agentBlocked} onClick={() => actions.newCli(pg, mainCli)}>
            <Sparkles className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className={tiny} aria-label={`New shell in ${pg.name}`} title="New shell here" onClick={() => actions.newShell(pg)}>
            <SquareTerminal className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className={tiny} aria-label={`Open ${pg.name} in ${ideName}`} title={`Open in ${ideName}`} onClick={() => actions.openIde(pg)}>
            <Code2 className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className={tiny} aria-label={`Open the folder of ${pg.name}`} title="Open folder" onClick={() => actions.openFolder(pg)}>
            <FolderOpen className="size-3.5" />
          </Button>
        </div>
      </div>
    )
  }

  const groupBlock = (g: ProjectGroup, index: number) => {
    const members = inGroup(g.id)
    const key = `g:${g.id}`
    const isCurrent = cursor === key
    return (
      <section key={g.id} aria-label={`Group ${g.name}`} data-group={g.id}>
        <div
          draggable={renaming !== g.id}
          data-nav-current={isCurrent && focused ? 'true' : undefined}
          data-nav-label={`group:${g.name}`}
          role="treeitem"
          aria-expanded={!g.collapsed}
          onClick={(e) => {
            if ((e.target as HTMLElement).closest('input')) return
            setCursor(key)
            window.clearTimeout(headerClick.current)
            headerClick.current = window.setTimeout(() => toggle(g), 220)
          }}
          onDoubleClick={() => {
            window.clearTimeout(headerClick.current)
            setRenaming(g.id)
          }}
          onDragStart={(e) => {
            dragging.current = { kind: 'group', id: g.id }
            setDragId(dragging.current)
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('text/plain', `group:${g.id}`)
          }}
          onDragOver={(e) => accepts(e, `group:${g.id}`, dragging.current != null && !(dragging.current.kind === 'group' && dragging.current.id === g.id))}
          onDrop={(e) => dropOnGroup(e, g)}
          onDragEnd={endDrag}
          className={cn(
            'group text-muted-foreground relative mt-2 flex h-6 cursor-pointer items-center gap-1 rounded-md pr-1 pl-4 text-[10.5px] font-semibold tracking-[.06em] uppercase',
            over === `group:${g.id}` && 'ring-primary ring-1',
            dragId?.kind === 'group' && dragId.id === g.id && 'opacity-50',
            isCurrent && focused && ring,
          )}
        >
          <button
            type="button"
            data-no-nav
            aria-label={`Reorder group ${g.name}`}
            title="Drag to reorder the group, or use the up and down arrow keys"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
              e.preventDefault()
              moveGroup(g, e.key === 'ArrowUp' ? -1 : 1)
            }}
            className="hover:text-foreground focus-visible:ring-primary absolute inset-y-0 left-0 flex w-3.5 cursor-grab items-center justify-center rounded-l-md opacity-0 outline-none group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:ring-1 active:cursor-grabbing"
          >
            <GripVertical className="size-3" />
          </button>
          <button
            type="button"
            tabIndex={-1}
            data-no-nav
            aria-label={`${g.collapsed ? 'Expand' : 'Collapse'} ${g.name}`}
            aria-expanded={!g.collapsed}
            onClick={(e) => (e.stopPropagation(), setCursor(key), toggle(g))}
            className="hover:text-foreground flex shrink-0 items-center"
          >
            {g.collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
          </button>
          {renaming === g.id ? (
            <NameEditor
              initial={g.name}
              label={`Rename group ${g.name}`}
              onCancel={() => setRenaming(null)}
              onCommit={(name) => renameGroup.mutate([g.id, name], { onSuccess: () => setRenaming(null), onError: (e) => (failed(e), setRenaming(null)) })}
            />
          ) : (
            <span className="min-w-0 flex-1 truncate" title="Double-click to rename">
              {g.name}
            </span>
          )}
          <span className="shrink-0 tabular-nums" aria-label={`${members.length} projects`}>
            {members.length}
          </span>
          <div data-no-nav className={cn('items-center', hoverOnly)} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
            <Button variant="ghost" size="icon" className={tiny} aria-label={`Index group ${g.name}`} title="Index every project in the group" onClick={() => void indexGroup(g)} disabled={members.length === 0}>
              <Network className="size-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className={tiny} aria-label={`Add a project to ${g.name}`} title="Add a project to this group" onClick={() => onNewCrew(g.id)}>
              <Plus className="size-3.5" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className={tiny} aria-label={`Actions for group ${g.name}`}>
                  <MoreHorizontal className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setRenaming(g.id)}>Rename group</DropdownMenuItem>
                <DropdownMenuItem disabled={index === 0} onSelect={() => moveGroup(g, -1)}>
                  Move group up
                </DropdownMenuItem>
                <DropdownMenuItem disabled={index === groups.length - 1} onSelect={() => moveGroup(g, 1)}>
                  Move group down
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => deleteGroup.mutate([g.id], { onError: failed })}>
                  Remove group
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        {!g.collapsed && (
          <div className="space-y-px pt-px">
            {members.map(crewRow)}
            {members.length === 0 && <p className="text-muted-foreground px-4 py-1 text-xs">Empty. Drag a project here.</p>}
          </div>
        )}
      </section>
    )
  }

  return (
    <aside
      ref={aside}
      aria-label="Projects"
      style={{ width: panel.width || `min(${PANEL_DEFAULT}px, 35vw)`, minWidth: `min(${PANEL_MIN}px, 35vw)`, maxWidth: `min(${PANEL_MAX}px, 50vw)` }}
      className="bg-card relative m-1.5 mr-0 flex shrink-0 flex-col rounded-2xl border shadow-xs dark:shadow-none"
    >
      <ResizeHandle
        target={aside}
        axis="x"
        grow={1}
        min={() => Math.min(PANEL_MIN, window.innerWidth * 0.35)}
        max={() => Math.min(PANEL_MAX, window.innerWidth / 2)}
        label="Resize project list"
        className="-right-[3px] w-1.5 cursor-ew-resize"
        {...panel.handle}
      />
      <div data-testid="project-panel-header" className="flex h-8 shrink-0 items-center gap-0.5 pr-1.5 pl-3.5">
        <span className="text-primary mr-auto text-[10.5px] font-semibold tracking-[.09em] uppercase">Projects</span>
        <Button variant="ghost" size="icon" className={headerBtn} onClick={() => onNewCrew()} aria-label="Add project" title="Add project">
          <Plus />
        </Button>
        <Button variant="ghost" size="icon" className={headerBtn} onClick={addGroup} aria-label="New group" title="New group">
          <FolderPlus />
        </Button>
        <Button variant="ghost" size="icon" className={headerBtn} onClick={() => void indexAll()} disabled={crews.length === 0} aria-label="Index all projects with CodeGraph" title="Index all projects with CodeGraph">
          <Network />
        </Button>
        <Button variant="ghost" size="icon" className={headerBtn} onClick={() => void qc.invalidateQueries()} aria-label="Refresh projects" title="Refresh projects">
          <RefreshCw />
        </Button>
      </div>

      {playground && (
        <div role="group" aria-label="Playground" className="shrink-0 border-b px-1.5 pb-1.5">
          {playgroundRow(playground)}
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1 px-1.5">
        <div
          ref={tree}
          role="tree"
          aria-label="Project list"
          tabIndex={0}
          onKeyDown={onTreeKey}
          onFocus={(e) => {
            setFocused(true)
            if (e.target === e.currentTarget && !current) setCursor(items.find((i) => i.key === `p:${selected}`)?.key ?? items[0]?.key ?? null)
          }}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false)
          }}
          className="space-y-px pb-2 outline-none"
        >
          <div
            onDragOver={(e) => accepts(e, 'ungrouped', dragging.current?.kind === 'crew')}
            onDrop={dropOnUngrouped}
            className={cn('space-y-px rounded-md', over === 'ungrouped' && 'ring-primary ring-1')}
          >
            {ungrouped.map(crewRow)}
            {groups.length > 0 && ungrouped.length === 0 && crews.length > 0 && dragId?.kind === 'crew' && (
              <p className="text-muted-foreground px-4 py-1 text-xs">Drop here to take it out of its group.</p>
            )}
          </div>
          {crews.length === 0 && <p className="text-muted-foreground px-3.5 py-2 text-xs">No projects yet. Use + to add one.</p>}
          {groups.map(groupBlock)}
        </div>
      </ScrollArea>

      <div className="space-y-2 border-t p-2">
        {update.data?.state === 'ready' && (
          <div className="bg-card space-y-2 rounded-xl border p-2.5">
            <p className="text-xs">Operant {update.data.version} is ready.</p>
            <Button size="sm" className="h-7 w-full" onClick={() => void bridge().invoke('update:install')}>
              <Download className="size-3.5" /> Restart to update
            </Button>
          </div>
        )}
        <div className="flex min-w-0 items-center gap-0.5" data-testid="sidebar-footer">
          {footer}
        </div>
      </div>
    </aside>
  )
}
