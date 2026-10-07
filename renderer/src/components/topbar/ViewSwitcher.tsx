import { ChevronDown } from 'lucide-react'
import type { KeyboardEvent } from 'react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

export type Mode = 'workspace' | 'seats' | 'memory'
export const MODES: Mode[] = ['workspace', 'seats', 'memory']
export const MODE_LABEL: Record<Mode, string> = { workspace: 'Workspace', seats: 'Seats', memory: 'Memory' }

// Workspace | Seats | Memory as a pill track; the active pill is filled with the accent and grows wider with a springy ease.
// Left and right arrow keys move between the pills. `menu` swaps the track for a dropdown when the bar is too narrow.
export function ViewSwitcher({ mode, onMode, menu }: { mode: Mode; onMode: (m: Mode) => void; menu: boolean }) {
  if (menu) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label={`View: ${MODE_LABEL[mode]}`} className="flex h-[28px] shrink-0 items-center gap-1 rounded-full bg-[#d97757] pl-3 pr-2 text-xs font-medium text-[#1f1208]">
            {MODE_LABEL[mode]}
            <ChevronDown className="size-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {MODES.map((m) => (
            <DropdownMenuItem key={m} onSelect={() => onMode(m)}>
              {MODE_LABEL[m]}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const next = MODES[(MODES.indexOf(mode) + step + MODES.length) % MODES.length]!
    onMode(next)
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-mode="${next}"]`)?.focus()
  }
  return (
    <div role="group" aria-label="Dashboard mode" onKeyDown={onKey} className="bg-foreground/5 flex shrink-0 items-center gap-1 rounded-full p-[3px]">
      {MODES.map((m) => (
        <button
          key={m}
          type="button"
          data-mode={m}
          aria-pressed={m === mode}
          tabIndex={m === mode ? 0 : -1}
          onClick={() => onMode(m)}
          className={cn(
            'h-[22px] rounded-full text-xs outline-none transition-[padding,background-color,color] duration-[350ms] ease-[cubic-bezier(.05,.9,.1,1.05)] focus-visible:ring-[3px] focus-visible:ring-ring/50',
            m === mode ? 'bg-[#d97757] px-4 font-semibold text-[#1f1208]' : 'text-muted-foreground hover:text-foreground px-2.5',
          )}
        >
          {MODE_LABEL[m]}
        </button>
      ))}
    </div>
  )
}
