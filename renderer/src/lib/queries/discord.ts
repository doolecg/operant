import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { DiscordBotAi, DiscordBotInput, DiscordBotPatch, DiscordBotView, DiscordHealth } from '@shared/types'
import { call, registerLive } from './core'

const botsKey = ['discord', 'bots'] as const
const pairingsKey = (botId: number) => ['discord', 'pairings', botId] as const

export const useDiscordBots = () => useQuery({ queryKey: botsKey, queryFn: () => call('discord:list') })

export const useDiscordPairings = (botId: number) =>
  useQuery({ queryKey: pairingsKey(botId), queryFn: () => call('discord:pairings', botId) })

function useBotMutation<A extends unknown[]>(fn: (...args: A) => Promise<unknown>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (args: A) => fn(...args),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['discord'] }),
  })
}

export const useCreateDiscordBot = () => useBotMutation((input: DiscordBotInput) => call('discord:create', input))
export const useUpdateDiscordBot = () =>
  useBotMutation((botId: number, patch: DiscordBotPatch) => call('discord:update', botId, patch))
export const useDeleteDiscordBot = () => useBotMutation((botId: number) => call('discord:delete', botId))
export const useSetDiscordToken = () => useBotMutation((botId: number, token: string) => call('discord:setToken', botId, token))
export const useClearDiscordToken = () => useBotMutation((botId: number) => call('discord:clearToken', botId))
export const useConnectDiscordBot = () => useBotMutation((botId: number) => call('discord:connect', botId))
export const useDisconnectDiscordBot = () => useBotMutation((botId: number) => call('discord:disconnect', botId))
export const useApproveDiscordPairing = () =>
  useBotMutation((botId: number, code: string) => call('discord:approvePairing', botId, code))
export const useDenyDiscordPairing = () => useBotMutation((botId: number, code: string) => call('discord:denyPairing', botId, code))

// A test connects and disconnects, so it is a mutation the page reads the result of.
export const useTestDiscordBot = () => useMutation({ mutationFn: (botId: number) => call('discord:test', botId) })

export const useTestDiscordAi = () => useMutation({ mutationFn: ([botId, ai]: [number, Partial<DiscordBotAi>]) => call('discord:testAi', botId, ai) })
export const useDiscordLocalModels = () => useMutation({ mutationFn: (url: string) => call('discord:localModels', url) })

registerLive((b, qc) => [
  b.on('discord:status', (h: DiscordHealth) => {
    qc.setQueryData<DiscordBotView[]>(botsKey, (old) => old?.map((bot) => (bot.id === h.botId ? { ...bot, health: h } : bot)))
    void qc.invalidateQueries({ queryKey: pairingsKey(h.botId) })
  }),
  b.on('discord:pairing', ({ botId }) => {
    void qc.invalidateQueries({ queryKey: pairingsKey(botId) })
  }),
])
