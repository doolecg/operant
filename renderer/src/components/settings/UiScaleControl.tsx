import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useSaveSettings, useSettings } from '@/lib/queries'
import { SCALE_STEPS } from '@/lib/uiScale'

const pct = (f: number) => `${Math.round(f * 100)}%`

// The UI scale as a select: Automatic follows the window, the rest are fixed. Saved and applied live.
export function UiScaleSelect({ id, className }: { id?: string; className?: string }) {
  const settings = useSettings()
  const save = useSaveSettings()
  if (!settings.data) return null
  return (
    <Select value={String(settings.data.uiScale)} onValueChange={(v) => save.mutate({ uiScale: Number(v) })}>
      <SelectTrigger id={id} aria-label="UI scale" className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="0">Automatic</SelectItem>
        {SCALE_STEPS.map((f) => (
          <SelectItem key={f} value={String(f)}>
            {pct(f)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
