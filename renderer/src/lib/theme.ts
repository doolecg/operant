import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { DEFAULT_APPEARANCE, resolveTheme, tokensFor, xtermColors, type ThemeDef, type XtermColors } from '@shared/themes'
import { useSettings } from '@/lib/queries'

// Writes a theme's variables onto <html>, live. The last one is kept in localStorage and applied before the first
// render, so a reload does not flash the default colours (the window background itself is set by main).
const STORE_KEY = 'operant.theme'

export function applyTheme(d: ThemeDef, accent: string): void {
  const root = document.documentElement
  const vars = tokensFor(d, accent)
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)
  root.dataset.theme = d.id
  root.dataset.scheme = d.scheme
  root.classList.toggle('dark', d.scheme === 'dark')
  root.style.colorScheme = d.scheme
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ id: d.id, scheme: d.scheme, vars }))
  } catch {
    // Private windows and blocked storage just skip the early paint.
  }
}

export function applyStoredTheme(): void {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return
    const s = JSON.parse(raw) as { id?: unknown; scheme?: unknown; vars?: unknown }
    if (typeof s.id !== 'string' || (s.scheme !== 'dark' && s.scheme !== 'light') || !s.vars || typeof s.vars !== 'object') return
    const root = document.documentElement
    for (const [k, v] of Object.entries(s.vars as Record<string, unknown>)) if (typeof v === 'string') root.style.setProperty(k, v)
    root.dataset.theme = s.id
    root.dataset.scheme = s.scheme
    root.classList.toggle('dark', s.scheme === 'dark')
    root.style.colorScheme = s.scheme
  } catch {
    // Nothing stored or unreadable: the stylesheet's Dark tokens stay.
  }
}

// A theme shown without saving it: the picker hovers and the colour editor set it, null returns to the saved one.
interface Preview {
  def: ThemeDef
  accent: string
}
let preview: Preview | null = null
const listeners = new Set<() => void>()
export function setThemePreview(p: Preview | null): void {
  preview = p
  listeners.forEach((l) => l())
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
const usePreview = () => useSyncExternalStore(subscribe, () => preview)

const DARK_QUERY = '(prefers-color-scheme: dark)'
function useSystemDark(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(DARK_QUERY)
      mq.addEventListener('change', cb)
      return () => mq.removeEventListener('change', cb)
    },
    () => window.matchMedia(DARK_QUERY).matches,
  )
}

// The saved theme (System resolved), unless a preview is showing.
export function useActiveTheme(): { def: ThemeDef; accent: string; terminalFollowsTheme: boolean } | null {
  const settings = useSettings().data
  const systemDark = useSystemDark()
  const prev = usePreview()
  const a = settings?.appearance
  return useMemo(() => {
    if (prev) return { def: prev.def, accent: prev.accent, terminalFollowsTheme: a?.terminalFollowsTheme ?? true }
    if (!a) return null
    return { def: resolveTheme(a, systemDark), accent: a.accent, terminalFollowsTheme: a.terminalFollowsTheme }
  }, [a, systemDark, prev])
}

// Mounted once at the root; keeps <html> in step with the settings, the OS and any preview.
export function ThemeApplier(): null {
  const t = useActiveTheme()
  useEffect(() => {
    if (t) applyTheme(t.def, t.accent)
  }, [t])
  return null
}

// What xterm.js is given; changes with the theme, so open terminals can restyle themselves.
export function useTerminalColors(): XtermColors {
  const t = useActiveTheme()
  return useMemo(() => {
    const fallback = resolveTheme(DEFAULT_APPEARANCE, true)
    return xtermColors(t?.def ?? fallback, t?.accent ?? '', t?.terminalFollowsTheme ?? true)
  }, [t])
}
