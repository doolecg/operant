import { useSyncExternalStore } from 'react'
import type { EnhanceContext } from '@shared/prompt-enhance'

export interface TileActivity {
  // What Enhance prompt is doing now.
  phase: 'idle' | 'context' | 'rewrite'
  // What the last enhance was given: Hindsight memories and CodeGraph symbols.
  context: EnhanceContext | null
}

const IDLE: TileActivity = { phase: 'idle', context: null }
const state = new Map<number, TileActivity>()
const listeners = new Set<() => void>()

// Per chat tile, kept while the app runs; the Composer writes it, the activity box reads it.
export function setActivity(scratchId: number, patch: Partial<TileActivity>): void {
  state.set(scratchId, { ...(state.get(scratchId) ?? IDLE), ...patch })
  listeners.forEach((l) => l())
}

export const useActivity = (scratchId: number): TileActivity =>
  useSyncExternalStore(
    (cb) => (listeners.add(cb), () => void listeners.delete(cb)),
    () => state.get(scratchId) ?? IDLE,
  )
