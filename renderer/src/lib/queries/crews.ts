import { useQuery } from '@tanstack/react-query'
import type { OperantEvent } from '@shared/types'
import { call, keys, registerLive, useMutate } from './core'

export const useCrews = () => useQuery({ queryKey: keys.crews, queryFn: () => call('crews:list') })

export const useTopology = (crewId: number | null) =>
  useQuery({
    queryKey: keys.topology(crewId ?? -1),
    queryFn: () => call('crews:topology', crewId!),
    enabled: crewId != null,
  })

// What deleting the crew would remove, for the confirm dialog.
export const useCrewCounts = (crewId: number | null, enabled = true) =>
  useQuery({
    queryKey: ['crewCounts', crewId ?? -1],
    queryFn: () => call('crews:counts', crewId!),
    enabled: enabled && crewId != null,
    gcTime: 0,
  })

export const useCreateCrew = () => useMutate('crews:create')
export const useUpdateCrew = () => useMutate('crews:update')
export const useDeleteCrew = () => useMutate('crews:delete')
// Saves the crew's view; Cards is the default.
export const useSetCrewView = () => useMutate('views:set', [keys.crews, ['topology']])

export const useIndexStatus = (crewId: number | null) =>
  useQuery({ queryKey: keys.index(crewId ?? -1), queryFn: () => call('index:status', crewId!), enabled: crewId != null })

export const useEvents = () => useQuery({ queryKey: keys.events, queryFn: () => call('events:recent', 100) })

export const useSummary = () => useQuery({ queryKey: keys.summary, queryFn: () => call('dashboard:summary') })

registerLive((b, qc) => [
  b.on('event', (e) => {
    qc.setQueryData<OperantEvent[]>(keys.events, (old) => [e, ...(old ?? [])].slice(0, 100))
    void qc.invalidateQueries({ queryKey: keys.summary })
    void qc.invalidateQueries({ queryKey: keys.crews })
    if (e.crewId != null) void qc.invalidateQueries({ queryKey: keys.topology(e.crewId) })
  }),
  b.on('index:status', ({ crewId, status }) => qc.setQueryData(keys.index(crewId), status)),
])
