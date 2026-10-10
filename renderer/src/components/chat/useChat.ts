import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { decodeIpcError } from '@shared/ipc'
import { emptyChatState, reduceChat, type ChatDecision, type ChatItem, type ChatOp, type ChatState } from '@shared/claude-chat'
import { bridge } from '@/lib/bridge'
import { toast } from '@/lib/toast'

// One shared ChatState per Claude tile: the conversation, the tile header and the Agents panel all read the same one.
// It is fetched with chat:snapshot when the first of them mounts and kept current by the chat:ops batches, which are
// folded together at most every 16 ms.

interface Entry {
  state: ChatState | null
  listeners: Set<() => void>
  pending: ChatOp[]
  timer: ReturnType<typeof setTimeout> | null
  off: (() => void) | null
}

const entries = new Map<number, Entry>()

function flush(e: Entry): void {
  e.timer = null
  if (!e.state || e.pending.length === 0) return
  const ops = e.pending
  e.pending = []
  e.state = reduceChat(e.state, ops)
  for (const l of e.listeners) l()
}

function push(e: Entry, ops: ChatOp[]): void {
  e.pending.push(...ops)
  if (e.state && e.timer === null) e.timer = setTimeout(() => flush(e), 16)
}

function setState(e: Entry, s: ChatState): void {
  e.state = s
  for (const l of e.listeners) l()
}

function attach(id: number): Entry {
  const e: Entry = { state: null, listeners: new Set(), pending: [], timer: null, off: null }
  e.off = bridge().on('chat:ops', (m) => {
    if (m.scratchId === id) push(e, m.ops)
  })
  bridge()
    .invoke('chat:snapshot', id)
    .then((s) => {
      setState(e, s)
      flush(e)
    })
    .catch(() => setState(e, emptyChatState(id)))
  return e
}

function subscribeTo(id: number, listener: () => void): () => void {
  let e = entries.get(id)
  if (!e) {
    e = attach(id)
    entries.set(id, e)
  }
  e.listeners.add(listener)
  return () => {
    const cur = entries.get(id)
    if (!cur) return
    cur.listeners.delete(listener)
    if (cur.listeners.size === 0) {
      cur.off?.()
      if (cur.timer !== null) clearTimeout(cur.timer)
      entries.delete(id)
    }
  }
}

// The live state of a Claude tile in the Chat view; null until the snapshot arrives.
export function useChatState(scratchId: number | null): ChatState | null {
  const subscribe = useCallback((l: () => void) => (scratchId === null ? () => {} : subscribeTo(scratchId, l)), [scratchId])
  return useSyncExternalStore(
    subscribe,
    () => (scratchId === null ? null : (entries.get(scratchId)?.state ?? null)),
  )
}

const fail = (e: unknown) => toast(decodeIpcError(e).message, true)

export const chatActions = {
  async send(id: number, text: string, images: Array<{ mediaType: string; base64: string }> = []): Promise<boolean> {
    try {
      await bridge().invoke('chat:send', id, { text, ...(images.length ? { images } : {}) })
      return true
    } catch (e) {
      fail(e)
      return false
    }
  },
  interrupt: (id: number) => void bridge().invoke('chat:interrupt', id).catch(fail),
  permission: (id: number, requestId: string, decision: ChatDecision) =>
    void bridge().invoke('chat:permission', id, requestId, decision).catch(fail),
  setMode: (id: number, mode: string) => void bridge().invoke('chat:setMode', id, mode).catch(fail),
  setModel: (id: number, model: string) => bridge().invoke('chat:setModel', id, model).catch(fail),
  setEffort: (id: number, level: string) => void bridge().invoke('chat:setEffort', id, level).catch(fail),
  async restart(id: number): Promise<void> {
    try {
      const s = await bridge().invoke('chat:restart', id)
      const e = entries.get(id)
      if (e) setState(e, s)
    } catch (err) {
      fail(err)
    }
  },
  // Older items from the transcript: prepends them to the state.
  async loadEarlier(id: number): Promise<void> {
    const e = entries.get(id)
    if (!e?.state || !e.state.hasEarlier) return
    try {
      const page = await bridge().invoke('chat:history', id, e.state.historyStart)
      const cur = entries.get(id)?.state
      if (!cur) return
      const have = new Set(cur.items.map((i) => i.id))
      const older = page.items.filter((i) => !have.has(i.id))
      setState(e, { ...cur, items: [...older, ...cur.items], historyStart: page.historyStart, hasEarlier: page.historyStart > 0 })
    } catch (err) {
      fail(err)
    }
  },
}

// Ticks while `active` so elapsed times move.
export function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [active, ms])
  return now
}

// The history of one sub-agent read from its transcript, for agents the stream has no items for.
export function useAgentHistory(scratchId: number, agentItemId: string, enabled: boolean): ChatItem[] | null {
  const [items, setItems] = useState<ChatItem[] | null>(null)
  useEffect(() => {
    setItems(null)
    if (!enabled) return
    let live = true
    bridge()
      .invoke('chat:agentHistory', scratchId, agentItemId)
      .then((r) => live && setItems(r))
      .catch(() => live && setItems([]))
    return () => {
      live = false
    }
  }, [scratchId, agentItemId, enabled])
  return items
}
