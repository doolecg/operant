import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useAppInfo, useSettings } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { SECTION_COMPONENTS } from './sections'
import { SettingsNavContext } from './nav-context'
import { SETTINGS_CATEGORIES, SETTINGS_PAGES, resolveSettingsTarget, settingsSearchText, type SettingsPage as Page, type SettingsSubsection } from './pages'
import { UiScaleMenu } from '../topbar/UiScaleControl'

type Target = { page: Page; section?: SettingsSubsection }

// The section a search term names inside a page, when the page's own name does not match it.
const subsectionHit = (p: Page, q: string) => (q && !p.label.toLowerCase().includes(q) ? p.subsections.find((s) => s.label.toLowerCase().includes(q)) : undefined)

// Below 900px the grouped nav becomes a select (min-[900px] is the nav's breakpoint).
export function SettingsPage({ initialSection, onClose }: { initialSection?: string; onClose: () => void }) {
  const settings = useSettings()
  const info = useAppInfo()
  const [target, setTarget] = useState<Target>(() => resolveSettingsTarget(initialSection) ?? { page: SETTINGS_PAGES[0]! })
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const current = target.page

  // Esc closes the page unless a dialog, menu or the key recorder is using it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // A deep link from elsewhere in the app opens its page while the settings page is already open.
  useEffect(() => {
    const next = resolveSettingsTarget(initialSection)
    if (next) setTarget(next)
  }, [initialSection])

  // Each change of page scrolls to the top, or to the section a deep link or search result names.
  useEffect(() => {
    if (target.section) {
      document.getElementById(`settings-${target.section.id}`)?.scrollIntoView({ block: 'start' })
      return
    }
    document.getElementById('settings-top')?.closest<HTMLElement>('[data-radix-scroll-area-viewport]')?.scrollTo({ top: 0 })
  }, [target])

  if (!settings.data) return <div className="text-muted-foreground p-8 text-sm">Loading settings…</div>

  const goTo = (section: string) => {
    const next = resolveSettingsTarget(section)
    if (next) setTarget(next)
  }
  const categories = SETTINGS_CATEGORIES.map((c) => ({ ...c, pages: c.pages.filter((p) => !q || settingsSearchText(p).includes(q)) })).filter((c) => c.pages.length > 0)
  const openPage = (p: Page) => setTarget({ page: p, section: subsectionHit(p, q) })
  const multi = current.subsections.length > 1

  return (
    <SettingsNavContext.Provider value={goTo}>
    <div className="relative flex h-full min-h-0 flex-col min-[900px]:flex-row">
        <aside className="flex min-h-0 shrink-0 flex-col gap-3 border-b p-3 pt-3 pr-12 min-[900px]:w-60 min-[900px]:border-r min-[900px]:border-b-0 min-[900px]:pt-8 min-[900px]:pr-3">
          <Input
            type="search"
            aria-label="Search settings"
            placeholder="Search settings"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Escape' || !query) return
              e.preventDefault()
              e.stopPropagation()
              setQuery('')
            }}
          />
          <select
            aria-label="Settings page"
            value={current.id}
            onChange={(e) => {
              const p = SETTINGS_PAGES.find((x) => x.id === e.target.value)
              if (p) setTarget({ page: p })
            }}
            className="border-input bg-background h-9 w-full rounded-md border px-2.5 text-sm min-[900px]:hidden"
          >
            {!categories.some((c) => c.pages.some((p) => p.id === current.id)) && <option value={current.id}>{current.label}</option>}
            {categories.map((c) => (
              <optgroup key={c.label} label={c.label}>
                {c.pages.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <nav aria-label="Settings pages" className="hidden min-h-0 flex-1 overflow-y-auto min-[900px]:block">
            {categories.map((c) => (
              <div key={c.label} className="mb-4">
                <p className="text-foreground/80 px-2.5 pb-1 text-xs font-bold">{c.label}</p>
                <div className="space-y-0.5">
                  {c.pages.map((p) => {
                    const active = p.id === current.id
                    const hit = subsectionHit(p, q)
                    return (
                      <button
                        key={p.id}
                        type="button"
                        aria-current={active ? 'page' : undefined}
                        onClick={() => openPage(p)}
                        className={cn(
                          'w-full rounded-md px-2.5 py-1.5 text-left text-sm transition-colors',
                          active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                        )}
                      >
                        {p.label}
                        {hit && <span className="text-muted-foreground block text-xs">{hit.label}</span>}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
            {categories.length === 0 && <p className="text-muted-foreground px-2.5 text-sm">No settings match “{query.trim()}”.</p>}
          </nav>
        </aside>
        <Button variant="ghost" size="icon" aria-label="Close settings" title="Close (Esc)" className="absolute top-3 right-4 z-10" onClick={onClose}>
          <X />
        </Button>
        <ScrollArea className="min-h-0 min-w-0 flex-1">
          <div data-testid="settings-content" className="mx-auto max-w-5xl space-y-8 p-8 2xl:max-w-6xl">
            <div className="flex items-start justify-between gap-4 pr-10">
              <div>
                <h1 className="text-xl font-semibold">Settings</h1>
                <p className="text-muted-foreground text-sm">Changes apply straight away and are saved.</p>
              </div>
              <UiScaleMenu />
            </div>
            <div id="settings-top" className="space-y-1">
              <h2 className="text-lg font-semibold">{current.label}</h2>
              <p className="text-muted-foreground text-sm">{current.description}</p>
            </div>
            {current.subsections.map((sub, i) => {
              const Section = SECTION_COMPONENTS[sub.id]
              return (
                <section key={sub.id} id={`settings-${sub.id}`} className={cn('scroll-mt-6 space-y-6', multi && i > 0 && 'border-t pt-8')}>
                  {multi && <h3 className="text-base font-semibold">{sub.label}</h3>}
                  <Section />
                </section>
              )
            })}
            <p className="text-muted-foreground pb-4 text-center text-xs">Operant {info.data?.version ?? ''}</p>
          </div>
        </ScrollArea>
      </div>
    </SettingsNavContext.Provider>
  )
}
