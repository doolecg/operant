import { useRef, useState } from 'react'
import { Plus, Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DrawerResizeHandle } from '@/components/ui/resize-handle'
import { CLI_SHORT } from '@/lib/capabilities'
import { useSettings } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { OperatorTerminal } from '@/components/dashboard/OperatorTerminal'
import type { TerminalTab } from './useTerminals'

const HEIGHT = 'operant.terminal.height'
const MIN = 15
const MAX = 80

function readHeight(): number {
  try {
    const v = Number(localStorage.getItem(HEIGHT))
    return v >= MIN && v <= MAX ? v : 35
  } catch {
    return 35
  }
}

interface Props {
  tabs: TerminalTab[]
  active: number | null
  onSelect: (scratchId: number) => void
  onClose: (scratchId: number) => void
  onNewShell: () => void
  onNewAgent: () => void
  onHide: () => void
  // While the Terminal view shows this project, its terminals are tiles there and stay out of the drawer.
  hideCrewId?: number | null
}

// Bottom drawer with the terminals opened from the project menu. Its height is a percentage of the window and
// every tab keeps running while another is shown or the drawer is hidden.
export function TerminalDrawer({ tabs: all, active, onSelect, onClose, onNewShell, onNewAgent, onHide, hideCrewId = null }: Props) {
  const tabs = all.filter((t) => t.crewId !== hideCrewId)
  const [height, setHeight] = useState(readHeight)
  const root = useRef<HTMLElement>(null)
  const cli = CLI_SHORT[useSettings().data?.mainCli ?? 'claude']

  return (
    <section
      ref={root}
      aria-label="Terminals"
      data-testid="terminal-drawer"
      style={{ flexBasis: `${height}%` }}
      className="bg-card relative mx-1.5 mb-1.5 flex min-h-0 shrink-0 flex-col rounded-2xl border shadow-xs dark:shadow-none"
    >
      <DrawerResizeHandle root={root} label="Resize terminals" storageKey={HEIGHT} onHeight={setHeight} />
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
        <div role="tablist" aria-label="Open terminals" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {tabs.map((t) => (
            <div
              key={t.scratchId}
              className={cn(
                'flex shrink-0 items-center rounded-md text-xs',
                t.scratchId === active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={t.scratchId === active}
                onClick={() => onSelect(t.scratchId)}
                className="max-w-52 truncate py-1 pr-1 pl-2"
              >
                {t.title}
                {t.exited ? ' (exited)' : ''}
              </button>
              <button
                type="button"
                aria-label={`Close ${t.title}`}
                title="Close this terminal"
                onClick={() => onClose(t.scratchId)}
                className="hover:bg-accent rounded-md p-1"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
        <Button variant="ghost" size="icon-sm" aria-label={`New ${cli} terminal in this project`} title={`New ${cli} terminal in this project`} onClick={onNewAgent}>
          <Sparkles />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="New shell in this project" title="New shell in this project" onClick={onNewShell}>
          <Plus />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Hide terminals" title="Hide (sessions keep running)" onClick={onHide}>
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-b-2xl">
        {tabs.map((t) => (
          <div key={t.scratchId} className={cn('h-full', t.scratchId !== active && 'hidden')}>
            <OperatorTerminal sessionKey={`scratch:${t.scratchId}`} autoFocus={t.scratchId === active} crewId={t.crewId} cli={t.kind} />
          </div>
        ))}
      </div>
    </section>
  )
}
