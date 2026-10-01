import { Download, FolderGit2, Plus, Settings } from 'lucide-react'
import type { Crew } from '@shared/types'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { bridge } from '@/lib/bridge'
import { useUnread, useUpdateStatus } from '@/lib/queries'
import { cn } from '@/lib/utils'

interface Props {
  crews: Crew[]
  selected: number | null
  onSelect: (id: number) => void
  onNewCrew: () => void
  settingsOpen: boolean
  onOpenSettings: () => void
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

export function Sidebar({ crews, selected, onSelect, onNewCrew, settingsOpen, onOpenSettings }: Props) {
  const update = useUpdateStatus()
  return (
    <aside className="bg-muted/30 flex w-60 shrink-0 flex-col border-r">
      <div className="flex h-14 items-center gap-2.5 px-4">
        <div className="bg-primary text-primary-foreground grid size-7 place-items-center rounded-md text-sm font-bold">
          O
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold">Operant</div>
          <div className="text-muted-foreground text-[11px]">Agent crews</div>
        </div>
      </div>

      <div className="text-muted-foreground flex items-center justify-between px-4 pt-3 pb-1.5 text-[11px] font-medium tracking-wider uppercase">
        Crews
        <Button variant="ghost" size="icon" className="size-6" onClick={onNewCrew} aria-label="New crew">
          <Plus className="size-3.5" />
        </Button>
      </div>

      <ScrollArea className="flex-1 px-2">
        <nav className="space-y-0.5 pb-2">
          {crews.map((crew) => (
            <button
              key={crew.id}
              onClick={() => onSelect(crew.id)}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors',
                crew.id === selected
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
              )}
            >
              <FolderGit2 className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{crew.name}</span>
              <CrewUnread crewId={crew.id} />
            </button>
          ))}
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
        <Button
          variant="ghost"
          className={cn('w-full justify-start gap-2.5', settingsOpen ? 'bg-accent text-accent-foreground' : 'text-muted-foreground')}
          onClick={onOpenSettings}
        >
          <Settings className="size-4" /> Settings
        </Button>
      </div>
    </aside>
  )
}
