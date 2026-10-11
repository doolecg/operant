import { useEffect, useMemo, useRef, useState } from 'react'
import { Copy, Pencil, RotateCcw, Trash2, Upload } from 'lucide-react'
import {
  ACCENT_PRESETS,
  BUILTIN_THEMES,
  COLOR_KEYS,
  COLOR_LABELS,
  addCustomTheme,
  contrast,
  customToDef,
  deleteCustomTheme,
  exportTheme,
  importTheme,
  normalizeHex,
  resolveTheme,
  updateCustomTheme,
  type ColorKey,
  type CustomTheme,
} from '@shared/themes'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useSaveSettings, useSettings } from '@/lib/queries'
import { setThemePreview } from '@/lib/theme'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { ConfirmDialog, Row } from '../parts'
import { ThemePicker } from '../ThemePicker'

interface Draft {
  // The saved custom theme being edited, or null for a new one.
  id: string | null
  name: string
  base: string
  colors: CustomTheme['colors']
}

function ColorField({ k, value, onChange, onClear, overridden }: { k: ColorKey; value: string; onChange: (hex: string) => void; onClear: () => void; overridden: boolean }) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  return (
    <div className="flex items-center gap-2 py-1.5">
      <input type="color" aria-label={COLOR_LABELS[k]} data-testid={`custom-color-${k}`} value={value} onChange={(e) => onChange(e.target.value)} className="size-8 shrink-0 cursor-pointer rounded-md border bg-transparent p-0.5" />
      <span className="min-w-0 flex-1 truncate text-sm">{COLOR_LABELS[k]}</span>
      <Input
        aria-label={`${COLOR_LABELS[k]} hex`}
        data-testid={`custom-hex-${k}`}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          const hex = normalizeHex(e.target.value)
          if (hex) onChange(hex)
        }}
        onBlur={() => setText(value)}
        className="w-24 font-mono text-xs"
        maxLength={7}
      />
      <Button variant="ghost" size="icon" className="size-7" aria-label={`Reset ${COLOR_LABELS[k]}`} title="Back to the base theme's colour" disabled={!overridden} onClick={onClear}>
        <RotateCcw className="size-3.5" />
      </Button>
    </div>
  )
}

function CustomEditor({ customs, onChange, currentThemeId }: { customs: CustomTheme[]; onChange: (next: CustomTheme[], select?: string) => void; currentThemeId: string }) {
  const settings = useSettings().data!
  const systemDark = typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
  const start = (): Draft => {
    const cur = customs.find((t) => t.id === currentThemeId)
    if (cur) return { id: cur.id, name: cur.name, base: cur.base, colors: { ...cur.colors } }
    const d = resolveTheme(settings.appearance, systemDark)
    return { id: null, name: '', base: d.id, colors: {} }
  }
  const [draft, setDraft] = useState<Draft>(start)
  const [dirty, setDirty] = useState(false)
  // Until the user edits, the editor starts from whatever theme is in use.
  useEffect(() => {
    if (!dirty) setDraft(start())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentThemeId, customs])
  const [confirmDelete, setConfirmDelete] = useState<CustomTheme | null>(null)
  const [importText, setImportText] = useState('')
  const [importError, setImportError] = useState<string | null>(null)
  const file = useRef<HTMLInputElement>(null)

  const def = useMemo(() => customToDef({ id: draft.id ?? 'custom-draft', name: draft.name || 'Custom theme', base: draft.base, colors: draft.colors }), [draft])
  const baseDef = BUILTIN_THEMES.find((b) => b.id === draft.base) ?? BUILTIN_THEMES[0]!
  const accent = settings.appearance.accent

  useEffect(() => {
    setThemePreview(dirty ? { def, accent } : null)
  }, [dirty, def, accent])
  useEffect(() => () => setThemePreview(null), [])

  const edit = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }))
    setDirty(true)
  }
  const load = (t: CustomTheme | null) => {
    setDraft(t ? { id: t.id, name: t.name, base: t.base, colors: { ...t.colors } } : { id: null, name: '', base: draft.base, colors: {} })
    setDirty(false)
  }
  const ratio = contrast(def.text, def.bg)
  const muted = contrast(def.dim, def.bg)
  const saved = draft.id ? customs.find((t) => t.id === draft.id) : undefined

  const save = () => {
    const name = draft.name.trim() || 'My theme'
    if (saved) {
      onChange(updateCustomTheme(customs, saved.id, { name, base: draft.base, colors: draft.colors }))
    } else {
      const next = addCustomTheme(customs, { name, base: draft.base, colors: draft.colors })
      const added = next[next.length - 1]!
      onChange(next, added.id)
      setDraft({ id: added.id, name: added.name, base: added.base, colors: { ...added.colors } })
    }
    setDirty(false)
    toast(`Saved "${name}"`)
  }
  const doImport = (text: string) => {
    try {
      const next = importTheme(text, customs)
      const added = next[next.length - 1]!
      onChange(next, added.id)
      load(added)
      setImportText('')
      setImportError(null)
      toast(`Imported "${added.name}"`)
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e))
    }
  }
  const copy = (t: CustomTheme) =>
    void navigator.clipboard?.writeText(exportTheme(t)).then(() => toast(`Copied "${t.name}" as JSON`)).catch(() => toast('Could not copy'))

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Custom themes</CardTitle>
        <CardDescription>Start from any theme, change its main colours and save it under a name. Changes show live while you edit. Saved themes can be edited, deleted, exported and imported.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
          <div className="space-y-3">
            <Row label="Start from" htmlFor="custom-base">
              <Select value={draft.base} onValueChange={(v) => edit({ base: v })}>
                <SelectTrigger id="custom-base" className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BUILTIN_THEMES.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
            <Row label="Name" htmlFor="custom-name">
              <Input id="custom-name" data-testid="custom-name" value={draft.name} maxLength={40} placeholder="My theme" onChange={(e) => edit({ name: e.target.value })} className="w-44" />
            </Row>
          </div>
          <div className="divide-y">
            {COLOR_KEYS.map((k) => (
              <ColorField
                key={k}
                k={k}
                value={draft.colors[k] ?? baseDef[k]}
                overridden={draft.colors[k] !== undefined}
                onChange={(hex) => edit({ colors: { ...draft.colors, [k]: hex } })}
                onClear={() => {
                  const { [k]: _gone, ...rest } = draft.colors
                  edit({ colors: rest })
                }}
              />
            ))}
          </div>
        </div>
        <p className={cn('text-xs', ratio < 4.5 || muted < 4.5 ? 'text-warning' : 'text-muted-foreground')} data-testid="custom-contrast">
          Text on background {ratio.toFixed(1)}:1, muted text {muted.toFixed(1)}:1.{' '}
          {ratio < 4.5 ? 'Low contrast: body text is hard to read (WCAG AA wants 4.5:1).' : muted < 4.5 ? 'Muted text is lightened or darkened automatically to stay readable.' : 'Readable (WCAG AA).'}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button data-testid="custom-save" onClick={save}>
            {saved ? 'Save changes' : 'Save as new theme'}
          </Button>
          {saved && (
            <Button variant="outline" data-testid="custom-save-new" onClick={() => onChange(addCustomTheme(customs, { name: `${draft.name.trim() || 'My theme'} copy`, base: draft.base, colors: draft.colors }))}>
              Save as copy
            </Button>
          )}
          <Button variant="outline" data-testid="custom-reset" disabled={!dirty && Object.keys(draft.colors).length === 0} onClick={() => (saved ? load(saved) : (setDraft({ ...draft, colors: {} }), setDirty(false)))}>
            <RotateCcw /> Reset colours
          </Button>
          {saved && (
            <Button variant="outline" onClick={() => load(null)}>
              New theme
            </Button>
          )}
        </div>

        {customs.length > 0 && (
          <ul className="divide-y rounded-md border" data-testid="custom-list">
            {customs.map((t) => (
              <li key={t.id} className="flex items-center gap-2 px-3 py-2" data-testid={`custom-item-${t.id}`}>
                <span className="min-w-0 flex-1 truncate text-sm">{t.name}</span>
                <Button variant="ghost" size="sm" aria-label={`Edit ${t.name}`} onClick={() => load(t)}>
                  <Pencil /> Edit
                </Button>
                <Button variant="ghost" size="sm" aria-label={`Copy ${t.name} as JSON`} onClick={() => copy(t)}>
                  <Copy /> Export
                </Button>
                <Button variant="ghost" size="sm" aria-label={`Delete ${t.name}`} onClick={() => setConfirmDelete(t)}>
                  <Trash2 /> Delete
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="space-y-2">
          <div className="text-sm font-medium">Import a theme</div>
          <Textarea aria-label="Theme JSON" data-testid="custom-import-text" value={importText} onChange={(e) => setImportText(e.target.value)} placeholder="Paste exported theme JSON, or choose a file" className="h-20 font-mono text-xs" />
          {importError && (
            <p role="alert" className="text-destructive text-xs">
              {importError}
            </p>
          )}
          <div className="flex gap-2">
            <Button variant="outline" data-testid="custom-import" disabled={!importText.trim()} onClick={() => doImport(importText)}>
              Import
            </Button>
            <Button variant="outline" onClick={() => file.current?.click()}>
              <Upload /> From file
            </Button>
            <input
              ref={file}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) void f.text().then(doImport)
              }}
            />
          </div>
        </div>
      </CardContent>
      <ConfirmDialog
        open={!!confirmDelete}
        title={`Delete "${confirmDelete?.name ?? ''}"?`}
        confirmLabel="Delete theme"
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => {
          const t = confirmDelete!
          onChange(deleteCustomTheme(customs, t.id))
          if (draft.id === t.id) load(null)
          setConfirmDelete(null)
        }}
      >
        <p>The theme is removed from this computer. {currentThemeId === confirmDelete?.id ? 'It is in use, so the app goes back to Dark.' : 'Export it first if you may want it back.'}</p>
      </ConfirmDialog>
    </Card>
  )
}

export function AppearanceSection() {
  const settings = useSettings()
  const save = useSaveSettings()
  const a = settings.data?.appearance
  const [hex, setHex] = useState(a?.accent ?? '')
  useEffect(() => setHex(a?.accent ?? ''), [a?.accent])
  if (!a) return null
  const set = (patch: Partial<typeof a>) => save.mutate({ appearance: patch })
  const current = resolveTheme(a, window.matchMedia('(prefers-color-scheme: dark)').matches)

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Theme</CardTitle>
          <CardDescription>Point at a theme to see it across the app; click to keep it. System follows your operating system's light or dark mode.</CardDescription>
        </CardHeader>
        <CardContent>
          <ThemePicker theme={a.theme} accent={a.accent} customs={a.customThemes} onPick={(id) => set({ theme: id })} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Accent colour</CardTitle>
          <CardDescription>Buttons, links, the selection and the terminal cursor. Theme default uses {current.name}'s own accent.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Accent colour">
            <button
              type="button"
              data-testid="accent-default"
              aria-pressed={a.accent === ''}
              title="Theme default"
              onClick={() => set({ accent: '' })}
              className={cn('relative size-7 overflow-hidden rounded-full border', a.accent === '' && 'ring-primary ring-2 ring-offset-2 ring-offset-[var(--background)]')}
              style={{ background: current.accent }}
            >
              <span className="absolute inset-0 bg-[linear-gradient(135deg,transparent_45%,var(--background)_45%,var(--background)_55%,transparent_55%)]" />
            </button>
            {ACCENT_PRESETS.map(([c, n]) => (
              <button
                key={c}
                type="button"
                data-testid={`accent-${c.slice(1)}`}
                aria-pressed={a.accent === c}
                aria-label={n}
                title={n}
                onClick={() => set({ accent: c })}
                className={cn('size-7 rounded-full border', a.accent === c && 'ring-primary ring-2 ring-offset-2 ring-offset-[var(--background)]')}
                style={{ background: c }}
              />
            ))}
            <input type="color" aria-label="Custom accent colour" data-testid="accent-picker" value={a.accent || current.accent} onChange={(e) => set({ accent: e.target.value })} className="size-8 cursor-pointer rounded-md border bg-transparent p-0.5" />
            <Input
              aria-label="Accent hex"
              data-testid="accent-hex"
              value={hex}
              placeholder={current.accent}
              maxLength={7}
              onChange={(e) => {
                setHex(e.target.value)
                const n = normalizeHex(e.target.value)
                if (n) set({ accent: n })
              }}
              onBlur={() => setHex(a.accent)}
              className="w-24 font-mono text-xs"
            />
            <Button variant="ghost" size="sm" disabled={a.accent === ''} onClick={() => set({ accent: '' })}>
              <RotateCcw /> Reset
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Texture</CardTitle>
          <CardDescription>A fine grain over the whole window, like Zen. Applies live.</CardDescription>
        </CardHeader>
        <CardContent>
          <Row label="Noise" hint="0 turns the grain off." htmlFor="appearance-noise">
            <div className="flex items-center gap-2">
              <input
                id="appearance-noise"
                type="range"
                min={0}
                max={100}
                value={a.noise}
                aria-label="Noise"
                onChange={(e) => set({ noise: Number(e.target.value) })}
                className="accent-primary h-1 w-40"
              />
              <span className="text-muted-foreground w-8 text-right text-xs tabular-nums">{a.noise}</span>
            </div>
          </Row>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Terminals</CardTitle>
        </CardHeader>
        <CardContent>
          <Row label="Terminals follow the theme" hint="The Master Terminal, the drawer and the console take the theme's colours and ANSI palette. Off keeps them dark." htmlFor="term-follows">
            <Switch id="term-follows" checked={a.terminalFollowsTheme} onCheckedChange={(v) => set({ terminalFollowsTheme: v })} />
          </Row>
        </CardContent>
      </Card>

      <CustomEditor
        customs={a.customThemes}
        currentThemeId={a.theme}
        onChange={(next, select) => {
          const stillThere = next.some((t) => t.id === a.theme) || !a.theme.startsWith('custom-')
          set({ customThemes: next, ...(select ? { theme: select } : !stillThere ? { theme: 'dark' } : {}) })
        }}
      />
    </>
  )
}
