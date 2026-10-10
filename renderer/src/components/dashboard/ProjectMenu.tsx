import { Code2, Copy, FolderInput, FolderOpen, FolderOutput, FolderPlus, GitCompare, Network, Settings2, Sparkles, SquareTerminal, Trash2 } from 'lucide-react'
import type { ProjectGroup } from '@shared/projects'
import type { Crew } from '@shared/types'
import type { MainCli } from '@shared/settings'
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu'
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { CLI_SHORT, cliBlocked, MAIN_CLIS } from '@/lib/capabilities'
import { useCapabilities } from '@/lib/queries'
import { folderLabel } from './projectActions'

export interface ProjectMenuHandlers {
  newCli: (c: Crew, cli: MainCli) => void
  newShell: (c: Crew) => void
  openIde: (c: Crew) => void
  openFolder: (c: Crew) => void
  index: (c: Crew) => void
  changes: (c: Crew) => void
  copyPath: (c: Crew) => void
  // null = ungrouped, 'new' = a fresh group.
  moveTo: (c: Crew, target: number | null | 'new') => void
  defaults: (c: Crew) => void
  remove: (c: Crew) => void
}

// The right-click menu and the "..." menu of a project row show the same items, so each kit is the same set of parts.
const CONTEXT = { Content: ContextMenuContent, Item: ContextMenuItem, Separator: ContextMenuSeparator }
const DROPDOWN = { Content: DropdownMenuContent, Item: DropdownMenuItem, Separator: DropdownMenuSeparator }

interface Props extends ProjectMenuHandlers {
  kind: 'context' | 'dropdown'
  crew: Crew
  groups: ProjectGroup[]
  ideName: string
  platform: string
  align?: 'start' | 'end'
}

export function ProjectMenuContent({ kind, crew, groups, ideName, platform, align, ...h }: Props) {
  const K = (kind === 'context' ? CONTEXT : DROPDOWN) as typeof CONTEXT
  const others = groups.filter((g) => g.id !== crew.groupId)
  const contentProps = kind === 'dropdown' ? { align } : {}
  const caps = useCapabilities().data
  return (
    <K.Content aria-label={`Actions for ${crew.name}`} className="w-60" {...contentProps}>
      {MAIN_CLIS.map((cli) => {
        const blocked = cliBlocked(caps, cli)
        return (
          <K.Item key={cli} disabled={!!blocked} title={blocked} onSelect={() => h.newCli(crew, cli)}>
            <Sparkles /> New {CLI_SHORT[cli]} terminal here{blocked ? ' (not installed)' : ''}
          </K.Item>
        )
      })}
      <K.Item onSelect={() => h.newShell(crew)}>
        <SquareTerminal /> New shell here
      </K.Item>
      <K.Separator />
      <K.Item onSelect={() => h.openIde(crew)}>
        <Code2 /> Open in {ideName}
      </K.Item>
      <K.Item onSelect={() => h.openFolder(crew)}>
        <FolderOpen /> {folderLabel(platform)}
      </K.Item>
      <K.Item onSelect={() => h.index(crew)}>
        <Network /> Index with CodeGraph
      </K.Item>
      <K.Item onSelect={() => h.changes(crew)}>
        <GitCompare /> Show changes
      </K.Item>
      <K.Item onSelect={() => h.copyPath(crew)}>
        <Copy /> Copy path
      </K.Item>
      <K.Separator />
      {others.map((g) => (
        <K.Item key={g.id} onSelect={() => h.moveTo(crew, g.id)}>
          <FolderInput /> Move to {g.name}
        </K.Item>
      ))}
      <K.Item onSelect={() => h.moveTo(crew, 'new')}>
        <FolderPlus /> Move to new group
      </K.Item>
      {crew.groupId != null && (
        <K.Item onSelect={() => h.moveTo(crew, null)}>
          <FolderOutput /> Remove from group
        </K.Item>
      )}
      <K.Item onSelect={() => h.defaults(crew)}>
        <Settings2 /> Project defaults…
      </K.Item>
      <K.Separator />
      <K.Item variant="destructive" onSelect={() => h.remove(crew)}>
        <Trash2 /> Delete project…
      </K.Item>
    </K.Content>
  )
}
