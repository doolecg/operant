import { insertTile, removeTile, tileIds, type Rect, type TileNode } from './tiling'

export const MASTER_TILE = 'master'

// Brings the tree in line with the tiles that should be open: the Master is always the first leaf, tiles that are
// gone are removed, new ones are split off the focused tile (else the last). Returns the same tree when nothing changed.
export function syncTiles(tree: TileNode | null, wanted: string[], area: Rect, gap: number, focus: string | null): TileNode {
  let t: TileNode | null = tree ?? { tile: MASTER_TILE }
  const want = new Set([MASTER_TILE, ...wanted])
  let changed = tree === null
  for (const id of tileIds(t)) {
    if (!want.has(id)) {
      t = removeTile(t, id)
      changed = true
    }
  }
  t ??= { tile: MASTER_TILE }
  if (!tileIds(t).includes(MASTER_TILE)) t = insertTile(t, MASTER_TILE, null, area, gap)
  for (const id of wanted) {
    if (tileIds(t).includes(id)) continue
    t = insertTile(t, id, focus, area, gap)
    changed = true
  }
  return changed || t !== tree ? t : tree!
}
