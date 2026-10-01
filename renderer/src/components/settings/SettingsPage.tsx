import { useState } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useAppInfo, useSettings } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { SETTINGS_SECTIONS } from './sections'

export function SettingsPage() {
  const settings = useSettings()
  const info = useAppInfo()
  const [sectionId, setSectionId] = useState(SETTINGS_SECTIONS[0]!.id)
  const section = SETTINGS_SECTIONS.find((s) => s.id === sectionId) ?? SETTINGS_SECTIONS[0]!
  const Section = section.component

  if (!settings.data) return <div className="text-muted-foreground p-8 text-sm">Loading settings…</div>

  return (
    <div className="flex h-full min-h-0">
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
      <ScrollArea className="min-w-0 flex-1">
        <div className="mx-auto max-w-3xl space-y-6 p-8">
          <div>
            <h1 className="text-xl font-semibold">Settings</h1>
            <p className="text-muted-foreground text-sm">Changes apply straight away and are saved.</p>
          </div>
          <Section />
          <p className="text-muted-foreground pb-4 text-center text-xs">Operant {info.data?.version ?? ''}</p>
        </div>
      </ScrollArea>
    </div>
  )
}
