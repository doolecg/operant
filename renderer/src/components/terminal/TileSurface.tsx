import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { insertTile, removeTile, tileIds, tileRects, toggleSplit, type Rect, type TileNode } from '@shared/tiling'
import { matches } from '@/lib/keys'
import { useSaveSettings, useSettings } from '@/lib/queries'
import { TileFrame } from './TileFrame'
import type { TileInfo } from './useProjectTiles'

// The tree per project, kept while the app runs so switching projects and back keeps the arrangement.
const trees = new Map<number, TileNode | null>()

const MASTER_FACTOR = 0.55

// Brings the tree in line with the tiles that should be open: gone ones are removed, new ones are split off the focused tile.
function syncTree(tree: TileNode | null, wanted: string[], area: Rect, gap: number, focus: string | null): TileNode | null {
  let t = tree
  const want = new Set(wanted)
  for (const id of tileIds(t)) if (!want.has(id)) t = removeTile(t, id)
  for (const id of wanted) if (!tileIds(t).includes(id)) t = insertTile(t, id, focus, area, gap)
  return t
}

interface Props {
  crewId: number
  tiles: TileInfo[]
  onClose: (tile: TileInfo) => void
  body: (tile: TileInfo) => ReactNode
  info?: (tile: TileInfo) => ReactNode
  // The header's icon, heading, subtitle and status for a tile.
  chrome?: (tile: TileInfo) => { icon?: ReactNode; heading?: string; subtitle?: string; badge?: ReactNode; status?: ReactNode }
  // The focused tile's id (null when none), for panels that follow the focus.
  onFocusChange?: (id: string | null) => void
  // A tile opened on purpose (a new agent or shell) that takes the focus.
  focusId?: string | null
}

// Tiling for the project's tiles: absolute frames placed from the pure tree (shared/tiling.ts), moved with a
// CSS transition. Tile keys (settings > Shortcuts) work while the focus is anywhere in the page.
export function TileSurface({ crewId, tiles, onClose, body, info, chrome, onFocusChange, focusId }: Props) {
  const settings = useSettings().data
  const save = useSaveSettings()
  const box = useRef<HTMLDivElement>(null)
  const [area, setArea] = useState<Rect>({ x: 0, y: 0, w: 0, h: 0 })
  const [tree, setTree] = useState<TileNode | null>(() => trees.get(crewId) ?? null)
  const [focus, setFocus] = useState<string | null>(null)
  useEffect(() => onFocusChange?.(focus), [focus])
  const [full, setFull] = useState<string | null>(null)
  const layout = settings?.tiles.layout ?? 'dwindle'
  const gap = settings?.tiles.gaps ?? 6
  const strip = settings?.tiles.strip ?? 'normal'

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => setArea({ x: 0, y: 0, w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // A project switch loads that project's arrangement.
  useEffect(() => {
    setTree(trees.get(crewId) ?? null)
    setFocus(null)
    setFull(null)
  }, [crewId])
  useEffect(() => {
    if (focusId && tiles.some((t) => t.id === focusId)) setFocus(focusId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId])

  const wanted = tiles.map((t) => t.id)
  const wantedKey = wanted.join('|')
  useEffect(() => {
    setTree((cur) => {
      const next = syncTree(cur, wanted, area, gap, focus)
      trees.set(crewId, next)
      return next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedKey, crewId, area.w > 0])
  useEffect(() => {
    const ids = tileIds(tree)
    if (focus && !ids.includes(focus)) setFocus(ids[0] ?? null)
    if (full && !ids.includes(full)) setFull(null)
  }, [tree, focus, full])

  const act = useCallback(
    (what: 'layout' | 'split' | 'full' | 'next' | 'prev' | 'close') => {
      const ids = tileIds(tree)
      if (what === 'layout') return save.mutate({ tiles: { layout: layout === 'dwindle' ? 'master' : 'dwindle' } })
      if (what === 'split') {
        if (!tree || !focus) return
        const next = toggleSplit(tree, focus)
        trees.set(crewId, next)
        return setTree(next)
      }
      if (what === 'full') return setFull((f) => (f === focus ? null : focus))
      if (what === 'close') {
        const t = tiles.find((x) => x.id === focus)
        return t && onClose(t)
      }
      if (ids.length === 0) return
      const at = focus ? ids.indexOf(focus) : -1
      setFocus(ids[(at + (what === 'next' ? 1 : -1) + ids.length) % ids.length]!)
    },
    [tree, focus, tiles, layout, crewId, save, onClose],
  )
  const actRef = useRef(act)
  actRef.current = act
  const binds = settings?.keybinds
  useEffect(() => {
    if (!binds) return
    const map: Array<[string, Parameters<typeof act>[0]]> = [
      [binds.tileLayout, 'layout'],
      [binds.tileSplit, 'split'],
      [binds.tileFullscreen, 'full'],
      [binds.tileFocusNext, 'next'],
      [binds.tileFocusPrev, 'prev'],
      [binds.tileClose, 'close'],
    ]
    const onKey = (e: KeyboardEvent) => {
      const hit = map.find(([accel]) => matches(e, accel))
      if (!hit) return
      e.preventDefault()
      actRef.current(hit[1])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [binds])

  const rects = tileRects(tree, area, layout, MASTER_FACTOR, gap)
  return (
    <div ref={box} className="relative min-h-0 flex-1 overflow-hidden p-0" data-testid="tile-surface" data-layout={layout}>
      {tiles.map((t) => {
        const r = (full === t.id ? area : rects.get(t.id)) ?? { x: 0, y: 0, w: 0, h: 0 }
        return (
          <TileFrame
            key={t.id}
            id={t.id}
            title={t.title}
            focused={focus === t.id}
            fullscreen={full === t.id}
            hidden={full !== null && full !== t.id}
            style={{ left: r.x, top: r.y, width: r.w, height: r.h, zIndex: full === t.id ? 10 : 0 }}
            strip={strip}
            info={info?.(t)}
            {...chrome?.(t)}
            onClose={() => onClose(t)}
            onFocus={() => setFocus(t.id)}
            onFullscreen={() => (setFocus(t.id), setFull((f) => (f === t.id ? null : t.id)))}
          >
            {body(t)}
          </TileFrame>
        )
      })}
    </div>
  )
}
