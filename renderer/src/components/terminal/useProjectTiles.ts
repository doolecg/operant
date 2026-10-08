import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import type { JobAgent } from '@shared/types'
import { MASTER_TILE } from '@shared/tileSync'
import { call, keys, useRuns, useSettings } from '@/lib/queries'
import type { TerminalTab } from './useTerminals'

export interface TileInfo {
  id: string
  kind: 'master' | 'scratch' | 'subagent'
  title: string
  scratch?: TerminalTab
  agent?: JobAgent
}

export const agentTileId = (a: JobAgent) => `agent:${a.runId}:${a.id}`
export const scratchTileId = (id: number) => `scratch:${id}`

// The tiles this project wants open: the Master, its scratch terminals and, while a run works, its subagents. A subagent
// opens when it appears (tiles.autoOpenSubagents), and a finished one closes after tiles.closeDoneAfterSec unless it is
// pinned. Closing a subagent tile by hand keeps it closed.
export function useProjectTiles(crewId: number, scratch: TerminalTab[]) {
  const tiles = useSettings().data?.tiles
  const runs = useRuns(crewId).data ?? []
  const working = runs.filter((r) => r.status === 'working')
  const lists = useQueries({
    queries: working.map((r) => ({ queryKey: keys.runAgents(r.id), queryFn: () => call('runs:agents', r.id) })),
  })
  const agents = useMemo(() => lists.flatMap((q) => q.data ?? []), [lists.map((q) => q.dataUpdatedAt).join(',')]) // eslint-disable-line react-hooks/exhaustive-deps
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set())
  const [pinned, setPinned] = useState<Set<string>>(() => new Set())
  const [expired, setExpired] = useState<Set<string>>(() => new Set())
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const closeAfter = tiles?.closeDoneAfterSec ?? 30

  useEffect(() => {
    setDismissed(new Set())
    setPinned(new Set())
    setExpired(new Set())
  }, [crewId])

  // A finished agent's tile closes after the delay; a pinned one, or a delay of 0, keeps it.
  useEffect(() => {
    for (const a of agents) {
      const id = agentTileId(a)
      const done = a.status === 'done'
      if (done && closeAfter > 0 && !pinned.has(id) && !expired.has(id)) {
        if (!timers.current.has(id)) timers.current.set(id, setTimeout(() => setExpired((s) => new Set(s).add(id)), closeAfter * 1000))
      } else if (timers.current.has(id)) {
        clearTimeout(timers.current.get(id))
        timers.current.delete(id)
      }
    }
  }, [agents, closeAfter, pinned, expired])
  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  const list = useMemo<TileInfo[]>(() => {
    const out: TileInfo[] = [{ id: MASTER_TILE, kind: 'master', title: 'Master Terminal' }]
    for (const t of scratch) if (t.crewId === crewId) out.push({ id: scratchTileId(t.scratchId), kind: 'scratch', title: t.title + (t.exited ? ' (exited)' : ''), scratch: t })
    if (tiles?.autoOpenSubagents ?? true) {
      for (const a of agents) {
        const id = agentTileId(a)
        if (!dismissed.has(id) && !expired.has(id)) out.push({ id, kind: 'subagent', title: a.seat, agent: a })
      }
    }
    return out
  }, [scratch, crewId, agents, dismissed, expired, tiles?.autoOpenSubagents])

  return {
    list,
    dismiss: (id: string) => setDismissed((s) => new Set(s).add(id)),
    togglePin: (id: string) => setPinned((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set(s).add(id))),
    pinned,
  }
}
