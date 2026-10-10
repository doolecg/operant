import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Crew, OperantEvent } from '@shared/types'
import { call, keys, registerLive, useMutate } from './core'

export const useCrews = () => useQuery({ queryKey: keys.crews, queryFn: () => call('crews:list') })

export const useUpdateCrew = () => useMutate('crews:update')
export const useDeleteCrew = () => useMutate('crews:delete')
// Saves the project list order. The list reorders at once and rolls back if the save fails.
export function useReorderCrews() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (crewIds: number[]) => call('crews:reorder', crewIds),
    onMutate: async (crewIds) => {
      await qc.cancelQueries({ queryKey: keys.crews })
      const before = qc.getQueryData<Crew[]>(keys.crews)
      if (before) qc.setQueryData<Crew[]>(keys.crews, crewIds.flatMap((id) => before.filter((c) => c.id === id)))
      return { before }
    },
    onError: (_e, _ids, ctx) => ctx?.before && qc.setQueryData(keys.crews, ctx.before),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.crews }),
  })
}

export const useIndexStatus = (crewId: number | null) =>
  useQuery({ queryKey: keys.index(crewId ?? -1), queryFn: () => call('index:status', crewId!), enabled: crewId != null })

export const useEvents = () => useQuery({ queryKey: keys.events, queryFn: () => call('events:recent', 100) })

// Clears the activity feed for every project.
export function useClearEvents() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => call('events:clear'),
    onSuccess: () => qc.setQueryData<OperantEvent[]>(keys.events, []),
  })
}

registerLive((b, qc) => [
  b.on('event', (e) => {
    qc.setQueryData<OperantEvent[]>(keys.events, (old) => [e, ...(old ?? [])].slice(0, 100))
    void qc.invalidateQueries({ queryKey: keys.crews })
  }),
  b.on('index:status', ({ crewId, status }) => qc.setQueryData(keys.index(crewId), status)),
])
