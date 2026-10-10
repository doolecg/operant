import { useSyncExternalStore } from 'react'

// Which agent of a tile the Agents panel shows (null = the list). The Agent row in the chat and a row in the panel both
// set it, so there is one destination; `nonce` changes on every open so a collapsed panel can expand itself.
export interface AgentSelection {
  agent: string | null
  nonce: number
}

const none: AgentSelection = { agent: null, nonce: 0 }
const sel = new Map<number, AgentSelection>()
const listeners = new Set<() => void>()

export function selectAgent(scratchId: number, agent: string | null): void {
  const cur = sel.get(scratchId) ?? none
  sel.set(scratchId, { agent, nonce: agent ? cur.nonce + 1 : cur.nonce })
  for (const l of listeners) l()
}

export function useAgentSelection(scratchId: number): AgentSelection {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => sel.get(scratchId) ?? none,
  )
}
