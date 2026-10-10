import { useSyncExternalStore } from 'react'

// The scratch id of the Claude Code tile the Subagent Panel follows (null when the project has none open). Published by the
// Terminal view so the Learning settings can learn from that session.
let active: number | null = null
const listeners = new Set<() => void>()

export function setActiveClaudeTile(id: number | null): void {
  if (active === id) return
  active = id
  for (const l of listeners) l()
}

export function useActiveClaudeTile(): number | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => active,
  )
}
