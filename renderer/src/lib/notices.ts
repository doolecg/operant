import { useSyncExternalStore } from 'react'

// The notices the user sees as toasts or update messages, kept for the Activity menu: newest first, capped, and kept for
// this session (sessionStorage) so a reload keeps them. `unread` counts the notices that came in since the menu was last opened.
export type NoticeLevel = 'info' | 'error'

export interface Notice {
  id: number
  text: string
  level: NoticeLevel
  at: number
}

export interface NoticeState {
  list: Notice[]
  unread: number
}

const KEY = 'operant.notices'
const CAP = 100

function load(): NoticeState {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (raw) {
      const v = JSON.parse(raw) as Partial<NoticeState>
      if (Array.isArray(v.list)) return { list: v.list.slice(0, CAP), unread: Math.max(0, Number(v.unread) || 0) }
    }
  } catch {
    /* storage unavailable or damaged: start empty */
  }
  return { list: [], unread: 0 }
}

let state: NoticeState = load()
let nextId = Math.max(0, ...state.list.map((n) => n.id)) + 1
const listeners = new Set<() => void>()

function set(next: NoticeState) {
  state = next
  try {
    sessionStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* storage unavailable: the list lives in memory only */
  }
  listeners.forEach((l) => l())
}

export function notify(text: string, level: NoticeLevel = 'info'): void {
  set({ list: [{ id: nextId++, text, level, at: Date.now() }, ...state.list].slice(0, CAP), unread: state.unread + 1 })
}

export function markNoticesRead(): void {
  if (state.unread > 0) set({ ...state, unread: 0 })
}

export function clearNotices(): void {
  set({ list: [], unread: 0 })
}

const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l))

export const getNotices = (): NoticeState => state

export const useNotices = (): NoticeState => useSyncExternalStore(subscribe, getNotices)
