import { useQuery } from '@tanstack/react-query'
import type { OperatorContext, OperatorPatch } from '@shared/types'
import { call, keys, registerLive, useMutate } from './core'

export const useOperatorContexts = () => useQuery({ queryKey: keys.contexts, queryFn: () => call('operators:context') })

export const useMaster = (crewId: number | null) =>
  useQuery({ queryKey: keys.master(crewId ?? -1), queryFn: () => call('master:get', crewId!), enabled: crewId != null })

// One operator by id, found across the crews' topologies (refreshed with them: the key starts with 'topology').
export const useOperator = (operatorId: number | null) =>
  useQuery({
    queryKey: ['topology', 'operator', operatorId ?? -1],
    queryFn: async () => {
      for (const crew of await call('crews:list')) {
        const found = (await call('crews:topology', crew.id))?.squads.flatMap((s) => s.operators).find((o) => o.id === operatorId)
        if (found) return found
      }
      return null
    },
    enabled: operatorId != null,
  })

export const useCreateSquad =() => useMutate('squads:create')
export const useUpdateSquad = () => useMutate('squads:update')
export const useDeleteSquad = () => useMutate('squads:delete')

export const useCreateOperator = () => useMutate('operators:create')
export const useCreateOperatorFromPreset = () => useMutate('operators:createFromPreset')
export const useUpdateOperator = () => useMutate('operators:update')
export const useDeleteOperator = () => useMutate('operators:delete')
export const useApplyOperatorChange = () => useMutate('operators:applyChange')
export const useStartMaster = () => useMutate('master:start')
export const useStopMaster = () => useMutate('master:stop')

// What a change would do (restart, cache loss, cost), without saving it.
export const useChangePlan = (operatorId: number | null, patch: OperatorPatch | null) =>
  useQuery({
    queryKey: ['changePlan', operatorId ?? -1, patch],
    queryFn: () => call('operators:previewChange', operatorId!, patch!),
    enabled: operatorId != null && patch != null,
    gcTime: 0,
  })

registerLive((b, qc) => [
  b.on('operator:status', () => {
    void qc.invalidateQueries({ queryKey: ['topology'] })
    void qc.invalidateQueries({ queryKey: ['master'] })
    void qc.invalidateQueries({ queryKey: keys.summary })
  }),
  b.on('operator:config', ({ crewId }) => {
    void qc.invalidateQueries({ queryKey: crewId != null ? keys.topology(crewId) : ['topology'] })
    void qc.invalidateQueries({ queryKey: ['master'] })
    void qc.invalidateQueries({ queryKey: keys.summary })
  }),
  b.on('usage', ({ operatorId, context }) =>
    qc.setQueryData<Record<number, OperatorContext>>(keys.contexts, (old) => ({ ...old, [operatorId]: context })),
  ),
])
