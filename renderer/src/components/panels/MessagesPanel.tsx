import { useState } from 'react'
import { ConversationList } from '@/components/messages/ConversationList'
import { buildConversations, entriesFor, type ConversationKey } from '@/components/messages/model'
import { Thread } from '@/components/messages/Thread'
import { useMessages, useTopology, useUnread } from '@/lib/queries'
import type { TabProps } from '@/registry'

// Tab badge: unread messages for the user.
export function useMessagesBadge(crewId: number | null): number | undefined {
  return useUnread(crewId).data?.user
}

// The newest messages the user sent or received; operator-to-operator traffic is left out by the core.
const WINDOW = 500

export function MessagesPanel({ crewId }: TabProps) {
  const messages = useMessages(crewId, { involvesUser: true, limit: WINDOW })
  const topology = useTopology(crewId)
  const [open, setOpen] = useState<ConversationKey | null>(null)

  const squads = topology.data?.squads ?? []
  const all = messages.data ?? []
  const conversations = buildConversations(squads, all)
  const current = conversations.find((c) => c.key === open) ?? null

  if (current) {
    return <Thread crewId={crewId} conversation={current} entries={entriesFor(current.key, all, squads)} onBack={() => setOpen(null)} />
  }
  return <ConversationList items={conversations} onOpen={(c) => setOpen(c.key)} />
}
