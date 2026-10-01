import { useSyncExternalStore } from 'react'

// Dialogs registered in registry.ts open from anywhere with openDialog(id, payload); the host in App renders them.
export interface OpenDialog {
  id: string
  payload: unknown
}

let current: OpenDialog | null = null
const listeners = new Set<() => void>()

const set = (next: OpenDialog | null) => {
  current = next
  listeners.forEach((l) => l())
}

export const openDialog = (id: string, payload?: unknown) => set({ id, payload })
export const closeDialog = () => set(null)

export const useOpenDialog = (): OpenDialog | null =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => current,
  )
