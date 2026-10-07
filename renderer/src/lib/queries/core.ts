import { useEffect } from 'react'
import { useMutation, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query'
import type { IpcApi, IpcChannel, OperantBridge } from '@shared/ipc'
import type { MessageFilter, UsagePeriod } from '@shared/types'
import { bridge } from '../bridge'

export const call = <C extends IpcChannel>(channel: C, ...args: Parameters<IpcApi[C]>) => bridge().invoke(channel, ...args)

// Every cache key lives here so domain files can invalidate each other's data without importing each other.
export const keys = {
  crews: ['crews'] as const,
  topology: (crewId: number) => ['topology', crewId] as const,
  index: (crewId: number) => ['index', crewId] as const,
  events: ['events'] as const,
  summary: ['summary'] as const,
  spend: (crewId: number) => ['spend', crewId] as const,
  settings: ['settings'] as const,
  update: ['update'] as const,
  appInfo: ['appInfo'] as const,
  master: (crewId: number) => ['master', crewId] as const,
  jobs: (crewId: number, open?: boolean) => (open === undefined ? (['jobs', crewId] as const) : (['jobs', crewId, open] as const)),
  job: (jobId: number) => ['job', jobId] as const,
  runs: (crewId: number) => ['runs', crewId] as const,
  run: (runId: number) => ['run', runId] as const,
  runAgents: (runId: number) => ['runAgents', runId] as const,
  teams: ['teams'] as const,
  runLimit: ['runLimit'] as const,
  health: (crewId: number) => ['health', crewId] as const,
  messages: (crewId: number, filter?: MessageFilter) => ['messages', crewId, filter ?? null] as const,
  messagesOf: (crewId: number) => ['messages', crewId] as const,
  unread: (crewId: number) => ['unread', crewId] as const,
  breakdown: (crewId: number, period: UsagePeriod) => ['breakdown', crewId, period] as const,
  caps: ['caps'] as const,
  purge: ['purge'] as const,
  presets: ['presets'] as const,
  shippedRole: (presetId: number) => ['shippedRole', presetId] as const,
}

// Mutations invalidate the keys they name; without any they refresh everything (the data is local and cheap).
export function useMutate<C extends IpcChannel>(channel: C, invalidate?: readonly QueryKey[]) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (args: Parameters<IpcApi[C]>) => call(channel, ...args),
    onSuccess: () =>
      invalidate ? Promise.all(invalidate.map((queryKey) => qc.invalidateQueries({ queryKey }))) : qc.invalidateQueries(),
  })
}

export const useAction = <C extends IpcChannel>(channel: C) => useMutate(channel)

export const pickFolder = () => call('app:pickFolder')

// A domain file registers its push-event handlers once, at module load. A handler subscribes with `bridge.on`
// and returns the unsubscribe functions.
export type LiveHandler = (bridge: OperantBridge, qc: QueryClient) => Array<() => void>

const liveHandlers: LiveHandler[] = []

export function registerLive(handler: LiveHandler): void {
  liveHandlers.push(handler)
}

// Pushes from main keep the dashboard live without polling.
export function useLiveUpdates() {
  const qc = useQueryClient()
  useEffect(() => {
    const b = bridge()
    const offs = liveHandlers.flatMap((h) => h(b, qc))
    return () => offs.forEach((off) => off())
  }, [qc])
}
