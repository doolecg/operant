import { useQuery } from '@tanstack/react-query'
import { call, keys, registerLive, useMutate } from './core'

export const useMaster = (crewId: number | null) =>
  useQuery({ queryKey: keys.master(crewId ?? -1), queryFn: () => call('master:get', crewId!), enabled: crewId != null })

export const useUpdateOperator = () => useMutate('operators:update')
export const useStartMaster = () => useMutate('master:start')
export const useStopMaster = () => useMutate('master:stop')

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
])
