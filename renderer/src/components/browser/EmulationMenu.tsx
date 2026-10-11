import { useState } from 'react'
import { Smartphone } from 'lucide-react'
import {
  COLOR_SCHEME_LABELS,
  DEFAULT_EMULATION,
  DEVICE_PRESETS,
  describeEmulation,
  isDefaultEmulation,
  PRESET_LABELS,
  SCALE_MAX,
  SCALE_MIN,
  SIZE_MAX,
  SIZE_MIN,
  THROTTLE_PROFILES,
  type ColorScheme,
  type Emulation,
  type EmulationPreset,
  type Throttle,
} from '@shared/browser-inspect'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

interface Props {
  emulation: Emulation
  // Called with the new setting; the owner sends it to main (browser:inspect:setEmulation).
  onChange: (next: Emulation) => void
  disabled?: boolean
}

const PRESETS: readonly EmulationPreset[] = ['none', 'mobile', 'tablet', 'desktop']
const SCHEMES: readonly ColorScheme[] = ['system', 'light', 'dark']
const THROTTLES: readonly Throttle[] = ['none', 'fast3g', 'slow3g', 'offline']

// Viewport / device presets, colour scheme and network throttling in one menu. Picking an entry closes the menu so the
// page is visible again, and its look changes straight away.
export function EmulationMenu({ emulation, onChange, disabled }: Props) {
  const [custom, setCustom] = useState(false)
  const active = !isDefaultEmulation(emulation)
  const summary = describeEmulation(emulation)

  const setPreset = (p: EmulationPreset) => onChange({ ...emulation, preset: p, width: undefined, height: undefined, deviceScaleFactor: undefined, mobile: undefined })

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn('size-7 shrink-0', active && 'text-primary')}
            aria-label={active ? `Device emulation: ${summary}` : 'Device emulation'}
            title={active ? `Emulating ${summary}` : 'Device emulation'}
            disabled={disabled}
          >
            <Smartphone className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56">
          <DropdownMenuLabel className="text-muted-foreground text-xs">Viewport</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={emulation.preset} onValueChange={(v) => v !== 'custom' && setPreset(v as EmulationPreset)}>
            {PRESETS.map((p) => (
              <DropdownMenuRadioItem key={p} value={p}>
                {PRESET_LABELS[p]}
              </DropdownMenuRadioItem>
            ))}
            {emulation.preset === 'custom' && (
              <DropdownMenuRadioItem value="custom" disabled>
                {emulation.width ?? 800} x {emulation.height ?? 600} (custom)
              </DropdownMenuRadioItem>
            )}
          </DropdownMenuRadioGroup>
          <DropdownMenuItem onSelect={() => setCustom(true)}>Custom size and user agent…</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-muted-foreground text-xs">Colour scheme</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={emulation.colorScheme} onValueChange={(v) => onChange({ ...emulation, colorScheme: v as ColorScheme })}>
            {SCHEMES.map((s) => (
              <DropdownMenuRadioItem key={s} value={s}>
                {COLOR_SCHEME_LABELS[s]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-muted-foreground text-xs">Network</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={emulation.throttle} onValueChange={(v) => onChange({ ...emulation, throttle: v as Throttle })}>
            {THROTTLES.map((t) => (
              <DropdownMenuRadioItem key={t} value={t}>
                {THROTTLE_PROFILES[t].label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {active && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => onChange({ ...DEFAULT_EMULATION })}>Reset emulation</DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {custom && <CustomDialog emulation={emulation} onClose={() => setCustom(false)} onApply={onChange} />}
    </>
  )
}

function CustomDialog({ emulation, onClose, onApply }: { emulation: Emulation; onClose: () => void; onApply: (e: Emulation) => void }) {
  const base = emulation.preset === 'custom' ? emulation : emulation.preset === 'none' ? null : DEVICE_PRESETS[emulation.preset]
  const [width, setWidth] = useState(String(base?.width ?? 800))
  const [height, setHeight] = useState(String(base?.height ?? 600))
  const [scale, setScale] = useState(String(base?.deviceScaleFactor ?? 1))
  const [mobile, setMobile] = useState(base?.mobile ?? false)
  const [ua, setUa] = useState(emulation.userAgent ?? '')

  const w = Number(width)
  const h = Number(height)
  const s = Number(scale)
  const bad =
    !Number.isFinite(w) || w < SIZE_MIN || w > SIZE_MAX
      ? `Width must be ${SIZE_MIN} to ${SIZE_MAX}`
      : !Number.isFinite(h) || h < SIZE_MIN || h > SIZE_MAX
        ? `Height must be ${SIZE_MIN} to ${SIZE_MAX}`
        : !Number.isFinite(s) || s < SCALE_MIN || s > SCALE_MAX
          ? `Pixel ratio must be ${SCALE_MIN} to ${SCALE_MAX}`
          : null

  const apply = () => {
    if (bad) return
    onApply({ ...emulation, preset: 'custom', width: Math.round(w), height: Math.round(h), deviceScaleFactor: s, mobile, userAgent: ua.trim() || undefined })
    onClose()
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        size="sm"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.target instanceof HTMLInputElement) {
            e.preventDefault()
            apply()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Custom viewport</DialogTitle>
          <DialogDescription>Size the page as a device would see it. Leave the user agent empty to keep the default.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 px-6">
          <div className="grid grid-cols-3 gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor="emu-width">Width</Label>
              <Input id="emu-width" type="number" inputMode="numeric" value={width} onChange={(e) => setWidth(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="emu-height">Height</Label>
              <Input id="emu-height" type="number" inputMode="numeric" value={height} onChange={(e) => setHeight(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="emu-scale">Pixel ratio</Label>
              <Input id="emu-scale" type="number" step="0.25" value={scale} onChange={(e) => setScale(e.target.value)} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="accent-primary size-4" checked={mobile} onChange={(e) => setMobile(e.target.checked)} />
            Mobile (touch events, mobile layout)
          </label>
          <div className="grid gap-1.5">
            <Label htmlFor="emu-ua">User agent</Label>
            <Input id="emu-ua" spellCheck={false} autoComplete="off" placeholder="Default" value={ua} onChange={(e) => setUa(e.target.value)} />
          </div>
          {bad && (
            <p role="alert" className="text-destructive text-xs">
              {bad}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={apply} disabled={bad !== null}>
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
