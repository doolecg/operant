import { useEffect, useState } from 'react'
import { Check, ZoomIn } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { iconBtn } from './pill'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useSaveSettings, useSettings } from '@/lib/queries'
import { effectiveScale, SCALE_STEPS } from '@/lib/uiScale'

const pct = (f: number) => `${Math.round(f * 100)}%`

// A small "100%" button that opens the scales and Reset (back to automatic); it shows the scale in use.
export function UiScaleMenu() {
  const settings = useSettings()
  const save = useSaveSettings()
  const [, tick] = useState(0)
  // Automatic follows the window size, so the label does too (the scale itself applies 120 ms after a resize).
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined
    const on = () => (clearTimeout(t), (t = setTimeout(() => tick((n) => n + 1), 200)))
    window.addEventListener('resize', on)
    return () => (clearTimeout(t), window.removeEventListener('resize', on))
  }, [])
  const setting = settings.data?.uiScale
  if (setting === undefined) return null
  const now = effectiveScale(setting)
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button type="button" className={cn(iconBtn, 'w-auto gap-1 px-1.5 tabular-nums')} aria-label={`UI scale ${pct(now)}${setting === 0 ? ' (automatic)' : ''}`}>
              <ZoomIn />
              <span className="text-[11px]">{pct(now)}</span>
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>UI scale</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" aria-label="UI scale">
        <DropdownMenuItem onSelect={() => save.mutate({ uiScale: 0 })}>
          <Check className={setting === 0 ? '' : 'invisible'} /> Automatic
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {SCALE_STEPS.map((f) => (
          <DropdownMenuItem key={f} onSelect={() => save.mutate({ uiScale: f })}>
            <Check className={setting === f ? '' : 'invisible'} /> {pct(f)}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={setting === 0} onSelect={() => save.mutate({ uiScale: 0 })}>
          Reset
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
