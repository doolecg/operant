import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Code2,
  Crown,
  Download,
  FolderPlus,
  GripVertical,
  MoreHorizontal,
  Network,
  Plus,
  Settings,
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
import {
  useCollapseGroup,
  useCreateGroup,
  useDeleteGroup,
  useGroups,
  useIdes,
  useMoveToGroup,
  useRenameGroup,
  useReorderCrews,
  useReorderGroups,
  useSettings,
  useUnread,
  useUpdateStatus,
} from '@/lib/queries'
import { usePanelWidth } from '@/lib/layout'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { ProjectMenuContent, type ProjectMenuHandlers } from './ProjectMenu'

interface Props {
  crews: Crew[]
  selected: number | null
  onSelect: (id: number) => void
  // A group id adds the new project to that group.
  onNewCrew: (groupId?: number) => void
  settingsOpen: boolean
  onOpenSettings: () => void
  actions: Omit<ProjectMenuHandlers, 'moveTo'> & { openMaster: (c: Crew) => void }
  // Icon buttons shown on the bottom row next to Settings (the Console and terminal toggles).
  footer?: ReactNode
}

function CrewUnread({ crewId }: { crewId: number }) {
  const count = useUnread(crewId).data?.user ?? 0
  if (count <= 0) return null
  return (
    <span
      aria-label={`${count} unread messages`}
      className="bg-primary text-primary-foreground inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-[10px] font-semibold tabular-nums"
    >
      {count > 99 ? '99+' : count}
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
      className="bg-background min-w-0 flex-1 rounded border px-1.5 py-0.5 text-xs outline-none focus:ring-1"
    />
  )
}

const hoverOnly = 'hidden group-hover:flex group-focus-within:flex'
const tiny = 'text-muted-foreground hover:text-foreground size-5 shrink-0'

export function Sidebar({ crews, selected, onSelect, onNewCrew, settingsOpen, onOpenSettings, actions, footer }: Props) {
  const update = useUpdateStatus()
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
  const platform = bridge().platform
  const panel = usePanelWidth('sidebarWidth')
  const aside = useRef<HTMLElement>(null)

  const [dragId, setDragId] = useState<Drag | null>(null)
  // The drag in flight, readable at once by the events that follow the drag start (state lags a render).
  const dragging = useRef<Drag | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<number | null>(null)

  const ids = crews.map((c) => c.id)
  const knownGroup = (c: Crew) => (c.groupId != null && groups.some((g) => g.id === c.groupId) ? c.groupId : null)
  const inGroup = (gid: number | null) => crews.filter((c) => knownGroup(c) === gid)
  const failed = (e: unknown) => toast(decodeIpcError(e).message, true)

  const saveCrews = (next: number[]) => next !== ids && reorder.mutate(next)
  const endDrag = () => {
    dragging.current = null
    setDragId(null)
    setOver(null)
  }
  const accepts = (e: DragEvent, key: string, ok: boolean) => {
    if (!ok) return
    e.preventDefault()
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

  const onHandleKey = (e: KeyboardEvent, crew: Crew) => {
    const section = inGroup(knownGroup(crew)).map((c) => c.id)
    const i = section.indexOf(crew.id)
    const target = e.key === 'ArrowUp' ? section[i - 1] : e.key === 'ArrowDown' ? section[i + 1] : undefined
    if (target == null) return
    e.preventDefault()
    saveCrews(moved(ids, crew.id, target))
  }

  const addGroup = () =>
    createGroup.mutate([], { onSuccess: (g) => setRenaming(g.id), onError: failed })

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
    const menu = (kind: 'context' | 'dropdown') => (
      <ProjectMenuContent kind={kind} crew={crew} groups={groups} ideName={ideName} platform={platform} align="end" {...handlers} />
    )
    return (
      <ContextMenu key={crew.id}>
        <ContextMenuTrigger asChild>
          <div
            draggable
            data-crew-row={crew.id}
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
              'group relative flex items-center rounded-md transition-colors',
              crew.id === selected ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
              over === `crew:${crew.id}` && dragId?.id !== crew.id && 'ring-primary ring-1',
              dragId?.kind === 'crew' && dragId.id === crew.id && 'opacity-50',
            )}
          >
            <button
              type="button"
              aria-label={`Reorder ${crew.name}`}
              title="Drag to reorder or into a group, or use the up and down arrow keys"
              onKeyDown={(e) => onHandleKey(e, crew)}
              className="text-muted-foreground hover:text-foreground flex shrink-0 cursor-grab items-center py-2 pl-1 active:cursor-grabbing"
            >
              <GripVertical className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => onSelect(crew.id)}
              className="flex min-w-0 flex-1 items-center gap-2 py-2 pr-2.5 pl-1 text-left text-sm"
            >
              <span className="text-muted-foreground shrink-0 font-mono text-[10px] group-hover:hidden group-focus-within:hidden">PRJ#{crew.prjNumber}</span>
              <span className="min-w-0 flex-1 truncate">{crew.name}</span>
              <span className="group-hover:hidden group-focus-within:hidden">
                <CrewUnread crewId={crew.id} />
              </span>
            </button>
            <div className={cn('shrink-0 items-center pr-1', hoverOnly)}>
              <Button variant="ghost" size="icon" className={tiny} aria-label={`Open Master of ${crew.name}`} title="Open Master" onClick={() => actions.openMaster(crew)}>
                <Crown className="size-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className={tiny} aria-label={`Index ${crew.name} with CodeGraph`} title="Index with CodeGraph" onClick={() => actions.index(crew)}>
                <Network className="size-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className={tiny} aria-label={`Open ${crew.name} in ${ideName}`} title={`Open in ${ideName}`} onClick={() => actions.openIde(crew)}>
                <Code2 className="size-3.5" />
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

  const groupBlock = (g: ProjectGroup, index: number) => {
    const members = inGroup(g.id)
    const move = (by: -1 | 1) => {
      const gids = groups.map((x) => x.id)
      const target = gids[index + by]
      if (target != null) reorderGroups.mutate([moved(gids, g.id, target)])
    }
    return (
      <section key={g.id} aria-label={`Group ${g.name}`} data-group={g.id} className="pt-1">
        <div
          draggable={renaming !== g.id}
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
            'group text-muted-foreground flex items-center gap-1 rounded-md py-0.5 pr-1 text-xs',
            over === `group:${g.id}` && 'ring-primary ring-1',
            dragId?.kind === 'group' && dragId.id === g.id && 'opacity-50',
          )}
        >
          <button
            type="button"
            aria-label={`${g.collapsed ? 'Expand' : 'Collapse'} ${g.name}`}
            aria-expanded={!g.collapsed}
            onClick={() => collapseGroup.mutate([g.id, !g.collapsed], { onError: failed })}
            className="hover:text-foreground flex shrink-0 items-center p-1"
          >
            {g.collapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          </button>
          {renaming === g.id ? (
            <NameEditor
              initial={g.name}
              label={`Rename group ${g.name}`}
              onCancel={() => setRenaming(null)}
              onCommit={(name) => renameGroup.mutate([g.id, name], { onSuccess: () => setRenaming(null), onError: (e) => (failed(e), setRenaming(null)) })}
            />
          ) : (
            <span className="min-w-0 flex-1 truncate font-medium" onDoubleClick={() => setRenaming(g.id)} title="Double-click to rename">
              {g.name}
            </span>
          )}
          <span className="shrink-0 tabular-nums" aria-label={`${members.length} projects`}>
            {members.length}
          </span>
          <div className={cn('items-center', hoverOnly)}>
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
                <DropdownMenuItem disabled={index === 0} onSelect={() => move(-1)}>
                  Move group up
                </DropdownMenuItem>
                <DropdownMenuItem disabled={index === groups.length - 1} onSelect={() => move(1)}>
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
          <div className="border-border/60 ml-2 space-y-0.5 border-l pl-1">
            {members.map(crewRow)}
            {members.length === 0 && <p className="text-muted-foreground px-2.5 py-1.5 text-xs">Empty. Drag a project here.</p>}
          </div>
        )}
      </section>
    )
  }

  const ungrouped = inGroup(null)

  return (
    <aside
      ref={aside}
      aria-label="Projects"
      style={{ width: panel.width || 'min(15rem, 35vw)', minWidth: 'min(180px, 35vw)', maxWidth: '50vw' }}
      className="bg-muted/30 relative flex shrink-0 flex-col border-r"
    >
      <ResizeHandle
        target={aside}
        axis="x"
        grow={1}
        min={() => Math.min(180, window.innerWidth * 0.35)}
        max={() => window.innerWidth / 2}
        label="Resize project list"
        className="-right-1"
        {...panel.handle}
      />
      <div className="text-muted-foreground flex items-center justify-between px-4 pt-3 pb-1.5 text-[11px] font-medium tracking-wider uppercase">
        Crews
        <span className="flex">
          <Button variant="ghost" size="icon" className="size-6" onClick={addGroup} aria-label="New group" title="New group">
            <FolderPlus className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="size-6" onClick={() => onNewCrew()} aria-label="New crew" title="New crew">
            <Plus className="size-3.5" />
          </Button>
        </span>
      </div>

      <ScrollArea className="flex-1 px-2">
        <nav className="space-y-0.5 pb-2">
          {groups.map(groupBlock)}
          {groups.length > 0 && (
            <div
              onDragOver={(e) => accepts(e, 'ungrouped', dragging.current?.kind === 'crew')}
              onDrop={dropOnUngrouped}
              className={cn('text-muted-foreground rounded-md px-2 pt-2 pb-0.5 text-[11px]', over === 'ungrouped' && 'ring-primary ring-1')}
            >
              Ungrouped
            </div>
          )}
          {ungrouped.map(crewRow)}
          {crews.length === 0 && <p className="text-muted-foreground px-2.5 py-2 text-xs">No crews yet.</p>}
        </nav>
      </ScrollArea>

      <div className="space-y-2 border-t p-2">
        {update.data?.state === 'ready' && (
          <div className="bg-card space-y-2 rounded-md border p-2.5">
            <p className="text-xs">Operant {update.data.version} is ready.</p>
            <Button size="sm" className="h-7 w-full" onClick={() => void bridge().invoke('update:install')}>
              <Download className="size-3.5" /> Restart to update
            </Button>
          </div>
        )}
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            className={cn('min-w-0 flex-1 justify-start gap-2.5', settingsOpen ? 'bg-accent text-accent-foreground' : 'text-muted-foreground')}
            onClick={onOpenSettings}
          >
            <Settings className="size-4" /> Settings
          </Button>
          {footer}
        </div>
      </div>
    </aside>
  )
}
