import type { Message, SquadWithOperators } from '@shared/types'

export type ConversationKey = 'master' | 'system' | `op:${number}` | `squad:${number}`

export interface Conversation {
  key: ConversationKey
  title: string
  subtitle: string
  // The `to` of messages:send, null when the user cannot write here (Operant's own notices).
  to: string | number | null
  unread: number
}

// One bubble: a single message, or the copies of one message the user sent to a squad.
export interface Entry {
  ids: number[]
  message: Message
  copies: number
}

export const isSystem = (m: Message) => m.fromKind === 'operator' && m.fromId == null && m.toKind === 'user'

export function sourceOf(m: Message): ConversationKey | null {
  if (m.toKind === 'user') {
    if (m.fromKind === 'master') return 'master'
    return m.fromId == null ? 'system' : `op:${m.fromId}`
  }
  if (m.fromKind === 'user') {
    if (m.toKind === 'master') return 'master'
    return m.toId == null ? null : `op:${m.toId}`
  }
  return null
}

export function entriesFor(
  key: ConversationKey,
  messages: Message[],
  squads: SquadWithOperators[],
): Entry[] {
  const mine = messages
  if (!key.startsWith('squad:')) {
    return mine.filter((m) => sourceOf(m) === key).map((m) => ({ ids: [m.id], message: m, copies: 1 }))
  }
  const squad = squads.find((s) => `squad:${s.id}` === key)
  const members = new Set((squad?.operators ?? []).map((o) => `op:${o.id}`))
  const out: Entry[] = []
  const sent = new Map<string, Entry>()
  for (const m of mine) {
    const src = sourceOf(m)
    if (src == null || !members.has(src)) continue
    if (m.fromKind !== 'user') {
      out.push({ ids: [m.id], message: m, copies: 1 })
      continue
    }
    // Fan-out writes one row per member with the same body and send time.
    const k = `${m.body}\u0000${m.kind}\u0000${Math.floor(m.createdAt / 2000)}`
    const group = sent.get(k)
    if (group) {
      group.ids.push(m.id)
      group.copies += 1
      if (m.readAt != null) group.message = { ...group.message, readAt: m.readAt }
    } else {
      const entry = { ids: [m.id], message: m, copies: 1 }
      sent.set(k, entry)
      out.push(entry)
    }
  }
  return out.sort((a, b) => a.message.id - b.message.id)
}

export function buildConversations(squads: SquadWithOperators[], messages: Message[]): Conversation[] {
  const incomingUnread = (key: ConversationKey) =>
    messages.filter((m) => m.toKind === 'user' && m.readAt == null && sourceOf(m) === key).length
  const list: Conversation[] = [
    { key: 'master', title: 'Master Terminal', subtitle: 'master', to: 'master', unread: incomingUnread('master') },
  ]
  if (messages.some(isSystem)) {
    list.push({ key: 'system', title: 'Operant', subtitle: 'notices', to: null, unread: incomingUnread('system') })
  }
  for (const s of squads.filter((q) => !q.system)) {
    const live = s.operators.filter((o) => o.kind !== 'master')
    list.push({
      key: `squad:${s.id}`,
      title: s.name,
      subtitle: `squad, ${live.length} operator${live.length === 1 ? '' : 's'}`,
      to: `squad:${s.name}`,
      unread: live.reduce((n, o) => n + incomingUnread(`op:${o.id}`), 0),
    })
    for (const o of live) {
      list.push({
        key: `op:${o.id}`,
        title: o.role,
        subtitle: `operator in ${s.name}`,
        to: o.id,
        unread: incomingUnread(`op:${o.id}`),
      })
    }
  }
  return list
}
