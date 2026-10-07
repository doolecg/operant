import type { Message } from '@shared/types'

export type ConversationKey = 'master' | 'system' | `op:${number}`

export interface Conversation {
  key: ConversationKey
  title: string
  subtitle: string
  // The `to` of messages:send, null when the user cannot write here (Operant's own notices).
  to: string | number | null
  unread: number
}

// One bubble: a single message.
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

export function entriesFor(key: ConversationKey, messages: Message[]): Entry[] {
  return messages.filter((m) => sourceOf(m) === key).map((m) => ({ ids: [m.id], message: m, copies: 1 }))
}

// The Master, Operant's notices, and every agent that has written to or been written to by the user,
// named from the messages themselves.
export function buildConversations(messages: Message[]): Conversation[] {
  const incomingUnread = (key: ConversationKey) =>
    messages.filter((m) => m.toKind === 'user' && m.readAt == null && sourceOf(m) === key).length
  const list: Conversation[] = [
    { key: 'master', title: 'Master Terminal', subtitle: 'master', to: 'master', unread: incomingUnread('master') },
  ]
  if (messages.some(isSystem)) {
    list.push({ key: 'system', title: 'Operant', subtitle: 'notices', to: null, unread: incomingUnread('system') })
  }
  const agents = new Map<number, string>()
  for (const m of messages) {
    const key = sourceOf(m)
    if (!key?.startsWith('op:')) continue
    const id = Number(key.slice(3))
    agents.set(id, m.toKind === 'user' ? m.fromLabel : m.toLabel)
  }
  for (const [id, label] of agents) {
    list.push({ key: `op:${id}`, title: label, subtitle: 'agent', to: id, unread: incomingUnread(`op:${id}`) })
  }
  return list
}
