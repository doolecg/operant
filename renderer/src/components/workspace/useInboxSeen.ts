import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { inboxItems, parseSeen, pruneSeen, type InboxItem } from '@shared/board'
import { bridge } from '@/lib/bridge'
import { toast } from '@/lib/toast'
import { useRuns, useSettings } from '@/lib/queries'

const KEY = 'operant.inbox.seen'
const listeners = new Set<() => void>()
let cache: ReadonlySet<number> | null = null

function read(): ReadonlySet<number> {
  if (cache) return cache
  let raw: string | null = null
  try {
    raw = localStorage.getItem(KEY)
  } catch {
    /* storage unavailable: nothing is seen */
  }
  cache = new Set(parseSeen(raw))
  return cache
}

function write(ids: Iterable<number>) {
  cache = new Set(ids)
  try {
    localStorage.setItem(KEY, JSON.stringify([...cache]))
  } catch {
    /* kept in memory only */
  }
  listeners.forEach((l) => l())
}

export const markInboxSeen = (runId: number) => {
  if (!read().has(runId)) write([...read(), runId])
}

let pruned = false
// Once per session, forget seen failures whose job was deleted.
async function pruneOnce() {
  if (pruned) return
  pruned = true
  try {
    const crews = await bridge().invoke('crews:list')
    const lists = await Promise.all(crews.map((c) => bridge().invoke('runs:list', c.id)))
    const existing = new Set(lists.flat().map((r) => r.id))
    const kept = pruneSeen(read(), existing)
    if (kept.length !== read().size) write(kept)
  } catch {
    pruned = false
  }
}

// The failures the owner has opened or dismissed (kept locally), shared by every part of the UI.
export function useInboxSeen(): { seen: ReadonlySet<number>; markSeen: (runId: number) => void } {
  const seen = useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    read,
  )
  useEffect(() => void pruneOnce(), [])
  return { seen, markSeen: markInboxSeen }
}

// What needs the owner in this project: the items, derived from its runs and the seen list.
export function useInbox(crewId: number | null): { items: InboxItem[]; count: number; ready: boolean } {
  const runs = useRuns(crewId).data
  const { seen } = useInboxSeen()
  const items = useMemo(() => inboxItems(runs ?? [], seen), [runs, seen])
  return { items, count: items.length, ready: runs != null }
}

const KIND_TEXT: Record<InboxItem['kind'], string> = {
  question: 'asks a question',
  permission: 'waits at a permission prompt',
  master: 'stopped: the Master Terminal is not running',
  review: 'is ready for your review',
  failed: 'failed',
}

// A toast when a new inbox item appears while the board is not the open view. Silent when the setting is off.
export function useInboxToasts(crewId: number | null, boardVisible: boolean) {
  const { items, ready } = useInbox(crewId)
  const enabled = useSettings().data?.notifications.inbox ?? true
  const known = useRef<{ crewId: number | null; keys: Set<string> } | null>(null)
  useEffect(() => {
    if (!ready) return
    const keys = new Set(items.map((i) => `${i.runId}:${i.kind}`))
    const prev = known.current
    if (prev && prev.crewId === crewId && enabled && !boardVisible) {
      for (const i of items) if (!prev.keys.has(`${i.runId}:${i.kind}`)) toast(`JOB#${i.runId} ${KIND_TEXT[i.kind]}`, i.kind === 'failed')
    }
    known.current = { crewId, keys }
  }, [items, ready, crewId, enabled, boardVisible])
}
