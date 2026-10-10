import { useSyncExternalStore } from 'react'
import { notify } from './notices'

export interface Toast {
  id: number
  text: string
  error: boolean
}

let toasts: Toast[] = []
let next = 1
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export function dismissToast(id: number): void {
  toasts = toasts.filter((t) => t.id !== id)
  emit()
}

// A short message in the corner; it clears itself (errors stay longer).
export function toast(text: string, error = false): void {
  notify(text, error ? 'error' : 'info')
  const id = next++
  toasts = [...toasts.slice(-3), { id, text, error }]
  emit()
  setTimeout(() => dismissToast(id), error ? 9000 : 4000)
}

export const useToasts = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => toasts,
  )
