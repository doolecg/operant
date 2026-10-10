import { useEffect, useState } from 'react'
import { emptyChatState, reduceChat, tileState, type ChatState } from '@shared/claude-chat'
import { bridge } from '@/lib/bridge'

// Chat tiles keep only their newest items here: the turn phase is all this needs.
const KEEP = 40

// The ids of the Claude tiles that wait for the owner (a permission, a question, a plan), from the same two feeds the
// Windows notifier follows: the Chat view's ops and the Terminal view's hook state.
export function useWaitingTiles(): Set<number> {
  const [waiting, setWaiting] = useState<Set<number>>(() => new Set())
  useEffect(() => {
    const b = bridge()
    const chats = new Map<number, ChatState>()
    const set = (id: number, on: boolean) =>
      setWaiting((cur) => {
        if (cur.has(id) === on) return cur
        const next = new Set(cur)
        if (on) next.add(id)
        else next.delete(id)
        return next
      })
    const offOps = b.on('chat:ops', ({ scratchId, ops }) => {
      let next = reduceChat(chats.get(scratchId) ?? emptyChatState(scratchId), ops)
      if (next.items.length > KEEP) next = { ...next, items: next.items.slice(-KEEP) }
      chats.set(scratchId, next)
      set(scratchId, tileState(next) === 'Waiting for you')
    })
    const offState = b.on('claudeMods:state', (s) => {
      // A tile in the Chat view reports through chat:ops; this feed decides only for tiles with no chat state.
      if (!chats.has(s.tileId)) set(s.tileId, s.session.phase === 'waiting')
    })
    return () => {
      offOps()
      offState()
    }
  }, [])
  return waiting
}
