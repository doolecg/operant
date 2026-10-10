import { useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { DEFAULT_SETTINGS, KEY_ACTIONS, type KeyAction } from '@shared/settings'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { formatAccel } from '@/lib/keys'
import { useSaveSettings, useSettings } from '@/lib/queries'
import { KeyRecorder, Row } from '../parts'

const GROUPS: Array<{ title: string; ids: KeyAction[] }> = [
  { title: 'Projects', ids: ['newCrew', 'indexCrew', 'openSettings', 'toggleConsole', 'openPlayground'] },
  { title: 'Project actions', ids: ['newShell', 'openInIde'] },
  { title: 'Panels', ids: ['toggleSidebar', 'toggleAllPanels'] },
  { title: 'Tiles', ids: ['tileLayout', 'tileSplit', 'tileFullscreen', 'tileFocusNext', 'tileFocusPrev', 'tileClose'] },
  { title: 'View', ids: ['zoomIn', 'zoomOut', 'zoomReset'] },
  { title: 'Media (Windows)', ids: ['mediaPlayPause', 'mediaNext', 'mediaPrev', 'mediaShuffle'] },
]

const labelOf = (id: KeyAction) => KEY_ACTIONS.find((a) => a.id === id)?.label ?? id

interface Moved {
  id: KeyAction
  from: KeyAction
  accel: string
  previous: string
}

export function ShortcutsSection() {
  const settings = useSettings()
  const save = useSaveSettings()
  const [moved, setMoved] = useState<Moved | null>(null)
  const s = settings.data
  if (!s) return null

  // One accelerator per action: taking a key from another action unbinds it there, and says so (with Undo).
  const setKey = (id: KeyAction, accel: string) => {
    const clash = accel ? KEY_ACTIONS.find((a) => a.id !== id && s.keybinds[a.id] === accel) : undefined
    setMoved(clash ? { id, from: clash.id, accel, previous: s.keybinds[id] } : null)
    save.mutate({ keybinds: { [id]: accel, ...(clash ? { [clash.id]: '' } : {}) } })
  }
  const undo = () => {
    if (!moved) return
    save.mutate({ keybinds: { [moved.id]: moved.previous, [moved.from]: moved.accel } })
    setMoved(null)
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Keyboard shortcuts</CardTitle>
          <CardDescription>
            Click a shortcut, then press the new keys. Backspace unbinds, Esc cancels. A key can belong to one action only.
          </CardDescription>
          <CardAction>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setMoved(null)
                save.mutate({ keybinds: DEFAULT_SETTINGS.keybinds })
              }}
            >
              <RotateCcw /> Reset all
            </Button>
          </CardAction>
        </CardHeader>
        {moved && (
          <CardContent>
            <div role="status" className="flex items-center justify-between gap-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
              <span>
                {formatAccel(moved.accel)} was bound to {labelOf(moved.from)}; it is now unbound there.
              </span>
              <Button variant="outline" size="sm" onClick={undo}>
                Undo
              </Button>
            </div>
          </CardContent>
        )}
      </Card>

      {GROUPS.map((g) => (
        <Card key={g.title}>
          <CardHeader>
            <CardTitle className="text-base">{g.title}</CardTitle>
          </CardHeader>
          <CardContent className="divide-y">
            {g.ids.map((id) => (
              <Row key={id} label={labelOf(id)}>
                <div className="flex items-center gap-2">
                  <KeyRecorder label={labelOf(id)} value={s.keybinds[id]} onChange={(accel) => setKey(id, accel)} />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Reset ${labelOf(id)} shortcut`}
                    title="Back to the default"
                    disabled={s.keybinds[id] === DEFAULT_SETTINGS.keybinds[id]}
                    onClick={() => setKey(id, DEFAULT_SETTINGS.keybinds[id])}
                  >
                    <RotateCcw />
                  </Button>
                </div>
              </Row>
            ))}
          </CardContent>
        </Card>
      ))}
    </>
  )
}
