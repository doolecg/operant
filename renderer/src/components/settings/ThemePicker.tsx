import { useMemo } from 'react'
import { Check } from 'lucide-react'
import { BUILTIN_THEMES, SYSTEM_THEME, customToDef, type CustomTheme, type ThemeDef } from '@shared/themes'
import { setThemePreview } from '@/lib/theme'
import { cn } from '@/lib/utils'

// One card per theme: a small mock window in the theme's colours, its swatches and its name. Hovering or focusing a card
// shows the theme live across the whole app; clicking keeps it.
function Mini({ d, accent }: { d: ThemeDef; accent: string }) {
  return (
    <div className="flex h-16 overflow-hidden rounded-md border" style={{ background: d.bg, borderColor: d.dim + '55' }} aria-hidden>
      <div className="w-1/4 space-y-1 p-1.5" style={{ background: d.card }}>
        <div className="h-1 w-3/4 rounded-full" style={{ background: accent }} />
        <div className="h-1 w-full rounded-full" style={{ background: d.dim, opacity: 0.5 }} />
        <div className="h-1 w-2/3 rounded-full" style={{ background: d.dim, opacity: 0.5 }} />
      </div>
      <div className="flex-1 space-y-1.5 p-2">
        <div className="h-1.5 w-2/3 rounded-full" style={{ background: d.text }} />
        <div className="h-1 w-5/6 rounded-full" style={{ background: d.dim }} />
        <div className="flex items-center gap-1 pt-0.5">
          <div className="h-3 w-8 rounded-sm" style={{ background: accent }} />
          <div className="size-1.5 rounded-full" style={{ background: d.done }} />
          <div className="size-1.5 rounded-full" style={{ background: d.warn }} />
          <div className="size-1.5 rounded-full" style={{ background: d.danger }} />
        </div>
      </div>
    </div>
  )
}

function ThemeCard({ id, def, other, name, note, selected, accent, onPick }: {
  id: string
  def: ThemeDef
  other?: ThemeDef
  name: string
  note: string
  selected: boolean
  accent: string
  onPick: () => void
}) {
  const show = (on: boolean) => setThemePreview(on ? { def, accent } : null)
  return (
    <button
      type="button"
      data-testid={`theme-card-${id}`}
      aria-pressed={selected}
      onClick={onPick}
      onMouseEnter={() => show(true)}
      onMouseLeave={() => show(false)}
      onFocus={() => show(true)}
      onBlur={() => show(false)}
      className={cn('hover:bg-accent/40 space-y-2 rounded-lg border p-2 text-left transition-colors', selected && 'border-primary ring-primary/40 ring-2')}
    >
      <div className={cn(other && 'grid grid-cols-2 gap-1')}>
        <Mini d={def} accent={accent || def.accent} />
        {other && <Mini d={other} accent={accent || other.accent} />}
      </div>
      <div className="flex items-center gap-1.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1 text-sm font-medium">
            <span className="truncate">{name}</span>
            {selected && <Check className="text-primary size-3.5 shrink-0" aria-label="Selected" />}
          </div>
          <div className="text-muted-foreground truncate text-xs">{note}</div>
        </div>
        <div className="flex shrink-0 -space-x-1" aria-hidden>
          {[def.bg, def.card, def.text, accent || def.accent, def.done, def.danger].map((c, i) => (
            <span key={i} className="size-3.5 rounded-full border" style={{ background: c }} />
          ))}
        </div>
      </div>
    </button>
  )
}

export function ThemePicker({ theme, accent, customs, onPick }: { theme: string; accent: string; customs: CustomTheme[]; onPick: (id: string) => void }) {
  const dark = BUILTIN_THEMES.filter((t) => t.scheme === 'dark')
  const light = BUILTIN_THEMES.filter((t) => t.scheme === 'light')
  const customDefs = useMemo(() => customs.map((t) => [t, customToDef(t)] as const), [customs])
  const group = (label: string, children: React.ReactNode) => (
    <div className="space-y-2">
      <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{label}</div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3">{children}</div>
    </div>
  )
  const card = (d: ThemeDef) => (
    <ThemeCard key={d.id} id={d.id} def={d} name={d.name} note={d.note} selected={theme === d.id} accent={accent} onPick={() => onPick(d.id)} />
  )
  return (
    <div className="space-y-5">
      {group(
        'Automatic',
        <ThemeCard
          id={SYSTEM_THEME}
          def={BUILTIN_THEMES[0]!}
          other={BUILTIN_THEMES[1]!}
          name="System"
          note="Follows the OS light or dark mode"
          selected={theme === SYSTEM_THEME}
          accent={accent}
          onPick={() => onPick(SYSTEM_THEME)}
        />,
      )}
      {group('Dark', dark.map(card))}
      {group('Light', light.map(card))}
      {customDefs.length > 0 &&
        group(
          'Custom',
          customDefs.map(([t, d]) => (
            <ThemeCard key={t.id} id={t.id} def={d} name={t.name} note={`Based on ${BUILTIN_THEMES.find((b) => b.id === t.base)?.name ?? 'Dark'}`} selected={theme === t.id} accent={accent} onPick={() => onPick(t.id)} />
          )),
        )}
    </div>
  )
}
