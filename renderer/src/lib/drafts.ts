import { useCallback, useSyncExternalStore } from 'react'
import { DRAFT_PREFIX, draftKey, pruneDrafts, type DraftKind } from '@shared/drafts'

// Drafts live in a Map (for useSyncExternalStore) and mirror to localStorage so they survive a restart.
const store = new Map<string, string>()
const listeners = new Set<() => void>()
let loaded = false

function load() {
  if (loaded) return
  loaded = true
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k?.startsWith(DRAFT_PREFIX)) store.set(k, localStorage.getItem(k) ?? '')
    }
  } catch {
    /* storage unavailable */
  }
}

function emit() {
  listeners.forEach((l) => l())
}

export function getDraft(key: string): string {
  load()
  return store.get(key) ?? ''
}

export function setDraftByKey(key: string, value: string) {
  load()
  if (value === '') return clearDraftByKey(key)
  store.set(key, value)
  try {
    localStorage.setItem(key, value)
  } catch {
    /* ignore */
  }
  emit()
}

export function clearDraftByKey(key: string) {
  load()
  if (!store.delete(key)) return
  try {
    localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
  emit()
}

// Drops drafts whose run (or project, for newtask) is gone.
export function pruneStoredDrafts(liveRuns: ReadonlySet<number>, liveProjects?: ReadonlySet<number>) {
  load()
  pruneDrafts([...store.keys()], liveRuns, liveProjects).forEach(clearDraftByKey)
}

export function useDraftByKey(key: string): [string, (v: string) => void, () => void] {
  const value = useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => getDraft(key),
  )
  const set = useCallback((v: string) => setDraftByKey(key, v), [key])
  const clear = useCallback(() => clearDraftByKey(key), [key])
  return [value, set, clear]
}

export function useDraft(kind: DraftKind, id: number): [string, (v: string) => void, () => void] {
  return useDraftByKey(draftKey(kind, id))
}

export function resetDraftsForTest() {
  store.clear()
  loaded = false
}
