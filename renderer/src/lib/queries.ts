import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { IpcApi, IpcChannel } from '@shared/ipc'
import type { OperantEvent, OperatorContext } from '@shared/types'
import type { SettingsPatch } from '@shared/settings'
import { bridge } from './bridge'

const call = <C extends IpcChannel>(channel: C, ...args: Parameters<IpcApi[C]>) => bridge().invoke(channel, ...args)

export const keys = {
  crews: ['crews'] as const,
  topology: (crewId: number) => ['topology', crewId] as const,
  tasks: (crewId: number) => ['tasks', crewId] as const,
  index: (crewId: number) => ['index', crewId] as const,
  events: ['events'] as const,
  summary: ['summary'] as const,
  contexts: ['contexts'] as const,
  spend: (crewId: number) => ['spend', crewId] as const,
  settings: ['settings'] as const,
  update: ['update'] as const,
  appInfo: ['appInfo'] as const,
}

export const useCrews = () => useQuery({ queryKey: keys.crews, queryFn: () => call('crews:list') })

export const useTopology = (crewId: number | null) =>
  useQuery({
    queryKey: keys.topology(crewId ?? -1),
    queryFn: () => call('crews:topology', crewId!),
    enabled: crewId != null,
  })

export const useTasks = (crewId: number | null) =>
  useQuery({ queryKey: keys.tasks(crewId ?? -1), queryFn: () => call('tasks:list', crewId!), enabled: crewId != null })

export const useIndexStatus = (crewId: number | null) =>
  useQuery({ queryKey: keys.index(crewId ?? -1), queryFn: () => call('index:status', crewId!), enabled: crewId != null })

export const useEvents = () => useQuery({ queryKey: keys.events, queryFn: () => call('events:recent', 100) })

export const useOperatorContexts = () => useQuery({ queryKey: keys.contexts, queryFn: () => call('operators:context') })

export const useSpendSeries = (crewId: number | null) =>
  useQuery({ queryKey: keys.spend(crewId ?? -1), queryFn: () => call('usage:series', crewId!), enabled: crewId != null })

export const useSettings = () => useQuery({ queryKey: keys.settings, queryFn: () => call('settings:get') })

export const useUpdateStatus = () => useQuery({ queryKey: keys.update, queryFn: () => call('update:status') })

export const useAppInfo = () => useQuery({ queryKey: keys.appInfo, queryFn: () => call('app:info'), staleTime: Infinity })

// Settings apply as soon as they change; the saved copy comes back and replaces the cache.
export function useSaveSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: SettingsPatch) => call('settings:set', patch),
    onSuccess: (s) => {
      qc.setQueryData(keys.settings, s)
      void qc.invalidateQueries({ queryKey: keys.summary })
    },
  })
}

export const useSummary = () => useQuery({ queryKey: keys.summary, queryFn: () => call('dashboard:summary') })

// Mutations invalidate everything they can touch; the data is local and cheap to refetch.
export function useAction<C extends IpcChannel>(channel: C) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (args: Parameters<IpcApi[C]>) => call(channel, ...args),
    onSuccess: () => qc.invalidateQueries(),
  })
}

export const pickFolder = () => call('app:pickFolder')

// Pushes from main keep the dashboard live without polling.
export function useLiveUpdates() {
  const qc = useQueryClient()
  useEffect(() => {
    const b = bridge()
    const offs = [
      b.on('event', (e) => {
        qc.setQueryData<OperantEvent[]>(keys.events, (old) => [e, ...(old ?? [])].slice(0, 100))
        void qc.invalidateQueries({ queryKey: keys.summary })
        void qc.invalidateQueries({ queryKey: keys.crews })
        if (e.crewId != null) {
          void qc.invalidateQueries({ queryKey: keys.topology(e.crewId) })
          void qc.invalidateQueries({ queryKey: keys.tasks(e.crewId) })
        }
      }),
      b.on('operator:status', () => {
        void qc.invalidateQueries({ queryKey: ['topology'] })
        void qc.invalidateQueries({ queryKey: keys.summary })
      }),
      b.on('index:status', ({ crewId, status }) => qc.setQueryData(keys.index(crewId), status)),
      b.on('settings', (s) => qc.setQueryData(keys.settings, s)),
      b.on('update', (s) => qc.setQueryData(keys.update, s)),
      b.on('usage', ({ operatorId, context }) => {
        qc.setQueryData<Record<number, OperatorContext>>(keys.contexts, (old) => ({ ...old, [operatorId]: context }))
        void qc.invalidateQueries({ queryKey: keys.summary })
        void qc.invalidateQueries({ queryKey: ['spend'] })
      }),
    ]
    return () => offs.forEach((off) => off())
  }, [qc])
}
