import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useAppInfo, useSettings } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { SETTINGS_SECTIONS } from './sections'
import { UiScaleMenu } from '../topbar/UiScaleControl'

export function SettingsPage({ initialSection, onClose }: { initialSection?: string; onClose: () => void }) {
  const settings = useSettings()
  const info = useAppInfo()
  const [sectionId, setSectionId] = useState(SETTINGS_SECTIONS.find((s) => s.id === initialSection)?.id ?? SETTINGS_SECTIONS[0]!.id)
  const section = SETTINGS_SECTIONS.find((s) => s.id === sectionId) ?? SETTINGS_SECTIONS[0]!
  const Section = section.component

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

  if (!settings.data) return <div className="text-muted-foreground p-8 text-sm">Loading settings…</div>

  return (
    <div className="relative flex h-full min-h-0">
      <nav className="w-48 shrink-0 space-y-0.5 border-r p-3 pt-8">
        {SETTINGS_SECTIONS.map((s) => (
          <button
            key={s.id}
            onClick={() => setSectionId(s.id)}
            className={cn(
              'w-full rounded-md px-2.5 py-1.5 text-left text-sm transition-colors',
              s.id === section.id
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            )}
          >
            {s.label}
          </button>
        ))}
      </nav>
      <Button variant="ghost" size="icon" aria-label="Close settings" title="Close (Esc)" className="absolute top-3 right-4 z-10" onClick={onClose}>
        <X />
      </Button>
      <ScrollArea className="min-w-0 flex-1">
        <div data-testid="settings-content" className="mx-auto max-w-5xl space-y-6 p-8 2xl:max-w-6xl">
          <div className="flex items-start justify-between gap-4 pr-10">
            <div>
              <h1 className="text-xl font-semibold">Settings</h1>
              <p className="text-muted-foreground text-sm">Changes apply straight away and are saved.</p>
            </div>
            <UiScaleMenu />
          </div>
          <Section />
          <p className="text-muted-foreground pb-4 text-center text-xs">Operant {info.data?.version ?? ''}</p>
        </div>
      </ScrollArea>
    </div>
  )
}
