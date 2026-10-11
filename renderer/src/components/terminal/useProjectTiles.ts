import { useMemo } from 'react'
import { useBrowserState } from '@/components/browser/useBrowser'
import type { TerminalTab } from './useTerminals'

// A terminal tile has its scratch terminal; the browser tile has none.
export interface TileInfo {
  id: string
  title: string
  scratch: TerminalTab | null
}

export type ScratchTileInfo = TileInfo & { scratch: TerminalTab }

export const scratchTileId = (id: number) => `scratch:${id}`
export const BROWSER_TILE_ID = 'browser'

export const isScratchTile = (t: TileInfo): t is ScratchTileInfo => t.scratch != null

// The tiles this project wants open: its scratch terminals, and the browser while it is open.
export function useProjectTiles(crewId: number, scratch: TerminalTab[]): TileInfo[] {
  const browserOpen = useBrowserState(crewId).data?.open ?? false
  return useMemo(() => {
    const tiles: TileInfo[] = scratch
      .filter((t) => t.crewId === crewId)
      .map((t) => ({ id: scratchTileId(t.scratchId), title: t.title + (t.exited ? ' (exited)' : ''), scratch: t }))
    if (browserOpen) tiles.push({ id: BROWSER_TILE_ID, title: 'Browser', scratch: null })
    return tiles
  }, [scratch, crewId, browserOpen])
}
