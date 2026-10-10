import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { ChevronDown, CircleHelp } from 'lucide-react'
import type { ChatModel } from '@shared/claude-chat'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { capitalize, effortDisabledReason, effortStops } from './chatHelpers'

const HELP = 'How much Claude thinks before it acts. Higher is slower and uses more tokens. Applies to this session (sent as /effort).'

interface Props {
  model: ChatModel | null
  modelName: string | null
  // The level now in force (null when Claude Code has not reported one).
  effort: string | null
  // The level the tile was launched with: marked "Default".
  defaultLevel: string | null
  onChange: (level: string) => void
  triggerClass: string
}

// The effort button and its popover: one stop per level Claude Code lists for the model, a white thumb on the current
// one, "Faster" / "Smarter" at the ends. Disabled with a reason when the model has no effort.
export function EffortPopover({ model, modelName, effort, defaultLevel, onChange, triggerClass }: Props) {
  const stops = effortStops(model)
  const reason = effortDisabledReason(model, modelName)
  const track = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [drag, setDrag] = useState<number | null>(null)
  const current = Math.max(0, stops.indexOf(effort ?? ''))
  const shown = drag ?? current
  const pos = (i: number) => (stops.length > 1 ? (i / (stops.length - 1)) * 100 : 50)
  const label = effort ? capitalize(effort) : 'Effort'

  if (reason)
    return (
      <button type="button" disabled title={reason} aria-label={`Effort: ${reason}`} className={cn(triggerClass, 'cursor-not-allowed opacity-50')}>
        Effort
      </button>
    )

  const indexAt = (e: PointerEvent): number => {
    const r = track.current!.getBoundingClientRect()
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    return Math.round(f * (stops.length - 1))
  }
  const commit = (i: number) => stops[i] && stops[i] !== effort && onChange(stops[i]!)
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') (e.preventDefault(), commit(Math.max(0, current - 1)))
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') (e.preventDefault(), commit(Math.min(stops.length - 1, current + 1)))
    else if (e.key === 'Enter') setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className={cn(triggerClass, open && 'bg-accent text-foreground')} aria-label={`Effort: ${label}`}>
        {label}
        <ChevronDown className="size-3" aria-hidden />
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={8} className="w-80 rounded-2xl px-[18px] py-3.5 shadow-xl" data-chat="effort-popover">
        <div className="mb-[18px] flex items-center gap-1.5 text-[13px]">
          <span className="font-semibold">Effort</span>
          <span className="text-muted-foreground">{capitalize(stops[shown] ?? '')}</span>
          <span title={HELP} aria-label={HELP} role="img" className="text-muted-foreground/70 ml-auto">
            <CircleHelp className="size-[13px]" />
          </span>
        </div>
        <div
          ref={track}
          role="slider"
          tabIndex={0}
          aria-label="Effort"
          aria-valuemin={0}
          aria-valuemax={stops.length - 1}
          aria-valuenow={shown}
          aria-valuetext={stops[shown]}
          onKeyDown={onKey}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            setDrag(indexAt(e))
          }}
          onPointerMove={(e) => drag !== null && setDrag(indexAt(e))}
          onPointerUp={(e) => {
            const i = indexAt(e)
            setDrag(null)
            commit(i)
          }}
          className="focus-visible:ring-ring/50 relative mx-2 h-5 cursor-pointer touch-none rounded-full outline-none focus-visible:ring-2"
        >
          <div className="bg-input absolute inset-x-0 top-[9px] h-0.5 rounded-sm" />
          {stops.map((s, i) => (
            <span key={s} title={capitalize(s)} className="bg-muted-foreground/70 absolute top-[6px] size-2 -translate-x-1/2 rounded-full" style={{ left: `${pos(i)}%` }} />
          ))}
          <span className="absolute top-0 size-5 -translate-x-1/2 rounded-full bg-white shadow-[0_1px_4px_rgba(0,0,0,.35)]" style={{ left: `${pos(shown)}%` }} />
        </div>
        <div className="relative mx-2 mt-1 h-4">
          {defaultLevel && stops.includes(defaultLevel) && (
            <span className="text-muted-foreground absolute -translate-x-1/2 text-xs" style={{ left: `${pos(stops.indexOf(defaultLevel))}%` }}>
              Default
            </span>
          )}
        </div>
        <div className="text-muted-foreground mt-3 flex justify-between text-xs">
          <span>Faster</span>
          <span>Smarter</span>
        </div>
      </PopoverContent>
    </Popover>
  )
}
