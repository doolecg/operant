import { useQuery } from '@tanstack/react-query'
import type { MessageFilter } from '@shared/types'
import { call, keys, registerLive, useMutate } from './core'

export const useMessages = (crewId: number | null, filter?: MessageFilter) =>
  useQuery({
    queryKey: keys.messages(crewId ?? -1, filter),
    queryFn: () => call('messages:list', crewId!, filter),
    enabled: crewId != null,
  })

// Unread counts for the user inbox, the Master and each operator.
export const useUnread = (crewId: number | null) =>
  useQuery({ queryKey: keys.unread(crewId ?? -1), queryFn: () => call('messages:unread', crewId!), enabled: crewId != null })

const messageKeys = [['messages'], ['unread']] as const

export const useSendMessage = () => useMutate('messages:send', messageKeys)
export const useEditMessage = () => useMutate('messages:edit', messageKeys)
export const useDeleteMessage = () => useMutate('messages:delete', messageKeys)
export const useMarkRead = () => useMutate('messages:markRead', messageKeys)
export const useAnswerMessage = () => useMutate('messages:answer', [...messageKeys, ['jobs']])

registerLive((b, qc) => [
  b.on('message', ({ crewId }) => void qc.invalidateQueries({ queryKey: keys.messagesOf(crewId) })),
  b.on('unread', ({ crewId }) => void qc.invalidateQueries({ queryKey: keys.unread(crewId) })),
])
