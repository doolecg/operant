import { useMemo } from 'react'
import type { TerminalTab } from './useTerminals'

export interface TileInfo {
  id: string
  title: string
  scratch: TerminalTab
}

export const scratchTileId = (id: number) => `scratch:${id}`

// The tiles this project wants open: its scratch terminals.
export function useProjectTiles(crewId: number, scratch: TerminalTab[]): TileInfo[] {
  return useMemo(
    () => scratch.filter((t) => t.crewId === crewId).map((t) => ({ id: scratchTileId(t.scratchId), title: t.title + (t.exited ? ' (exited)' : ''), scratch: t })),
    [scratch, crewId],
  )
}
