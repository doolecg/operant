import type { TileLayout, TileStrip } from '@shared/settings'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useSaveSettings, useSettings } from '@/lib/queries'
import { CommitInput, Row } from '../parts'

// A number field that saves on blur or Enter; the main process clamps it to its range.
function NumberField({ id, value, min, max, onCommit }: { id: string; value: number; min: number; max: number; onCommit: (n: number) => void }) {
  return (
    <CommitInput
      id={id}
      type="number"
      min={min}
      max={max}
      className="w-28"
      value={String(value)}
      onCommit={(v) => {
        const n = Number(v)
        if (v.trim() !== '' && Number.isFinite(n)) onCommit(Math.min(max, Math.max(min, Math.round(n))))
      }}
    />
  )
}

export function TerminalSection() {
  const settings = useSettings()
  const save = useSaveSettings()
  const s = settings.data
  if (!s) return null
  const t = s.terminal
  const set = (patch: Partial<typeof t>) => save.mutate({ terminal: patch })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Terminal</CardTitle>
        <CardDescription>How the terminals behave. Open terminals pick these up straight away.</CardDescription>
      </CardHeader>
      <CardContent className="divide-y">
        <Row label="Copy on select" hint="Selecting text copies it once, when you let go of the mouse." htmlFor="term-copy">
          <Switch id="term-copy" checked={t.copyOnSelect} onCheckedChange={(v) => set({ copyOnSelect: v })} />
        </Row>
        <Row label="Font size" hint="In px, 8 to 32." htmlFor="term-font">
          <NumberField id="term-font" value={t.fontSize} min={8} max={32} onCommit={(n) => set({ fontSize: n })} />
        </Row>
        <Row label="Scrollback" hint="Lines kept per terminal, 500 to 100000." htmlFor="term-scroll">
          <NumberField id="term-scroll" value={t.scrollback} min={500} max={100000} onCommit={(n) => set({ scrollback: n })} />
        </Row>
        <Row label="Ctrl+click file paths" hint="Opens a file path in the terminal output." htmlFor="term-links">
          <Switch id="term-links" checked={t.fileLinks} onCheckedChange={(v) => set({ fileLinks: v })} />
        </Row>
        <Row label="Dropped files type their paths" hint="Drop a file on a terminal to type its path." htmlFor="term-drop">
          <Switch id="term-drop" checked={t.dropPaths} onCheckedChange={(v) => set({ dropPaths: v })} />
        </Row>
      </CardContent>
    </Card>
  )
}

export function TilesSection() {
  const settings = useSettings()
  const save = useSaveSettings()
  const s = settings.data
  if (!s) return null
  const t = s.tiles
  const set = (patch: Partial<typeof t>) => save.mutate({ tiles: patch })

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tiles</CardTitle>
          <CardDescription>The Terminal view's tiling surface. Changes apply live. Tile shortcuts are under Shortcuts.</CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          <Row label="Layout" hint="Dwindle splits the space in halves; master keeps one large tile beside a stack." htmlFor="tiles-layout">
            <Select value={t.layout} onValueChange={(v) => set({ layout: v as TileLayout })}>
              <SelectTrigger id="tiles-layout" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="dwindle">Dwindle</SelectItem>
                <SelectItem value="master">Master</SelectItem>
              </SelectContent>
            </Select>
          </Row>
          <Row label="Gap" hint="Space between tiles, in px (0 to 40)." htmlFor="tiles-gap">
            <NumberField id="tiles-gap" value={t.gaps} min={0} max={40} onCommit={(n) => set({ gaps: n })} />
          </Row>
          <Row label="Master tile strip" hint="The context strip on the Master tile." htmlFor="tiles-strip">
            <Select value={t.strip} onValueChange={(v) => set({ strip: v as TileStrip })}>
              <SelectTrigger id="tiles-strip" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="normal">Normal</SelectItem>
                <SelectItem value="compact">Compact</SelectItem>
                <SelectItem value="hide">Hidden</SelectItem>
              </SelectContent>
            </Select>
          </Row>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Subagents and runs</CardTitle>
        </CardHeader>
        <CardContent className="divide-y">
          <Row label="Open subagent tiles automatically" hint="A tile opens when a subagent starts." htmlFor="tiles-auto">
            <Switch id="tiles-auto" checked={t.autoOpenSubagents} onCheckedChange={(v) => set({ autoOpenSubagents: v })} />
          </Row>
          <Row label="Close finished subagent tiles after" hint="Seconds. 0 keeps them open." htmlFor="tiles-close">
            <NumberField id="tiles-close" value={t.closeDoneAfterSec} min={0} max={3600} onCommit={(n) => set({ closeDoneAfterSec: n })} />
          </Row>
        </CardContent>
      </Card>
    </>
  )
}
