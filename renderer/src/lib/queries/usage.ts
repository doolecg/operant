import { useQuery } from '@tanstack/react-query'
import type { UsagePeriod } from '@shared/types'
import { call, keys, registerLive, useMutate } from './core'

export const useSpendSeries = (crewId: number | null) =>
  useQuery({ queryKey: keys.spend(crewId ?? -1), queryFn: () => call('usage:series', crewId!), enabled: crewId != null })

export const useUsageBreakdown = (crewId: number | null, period: UsagePeriod) =>
  useQuery({
    queryKey: keys.breakdown(crewId ?? -1, period),
    queryFn: () => call('usage:breakdown', crewId!, period),
    enabled: crewId != null,
  })

export const useCapStatus = () => useQuery({ queryKey: keys.caps, queryFn: () => call('caps:status') })
export const useResetCaps = () => useMutate('caps:reset', [keys.caps, ['breakdown'], ['topology']])

export const usePurgeStatus = () => useQuery({ queryKey: keys.purge, queryFn: () => call('purge:status') })
export const usePurgeNow = () => useMutate('purge:now', [keys.purge, ['topology']])

registerLive((b, qc) => [
  b.on('usage', () => {
    void qc.invalidateQueries({ queryKey: keys.summary })
    void qc.invalidateQueries({ queryKey: ['spend'] })
    void qc.invalidateQueries({ queryKey: ['breakdown'] })
  }),
  b.on('caps', () => {
    void qc.invalidateQueries({ queryKey: keys.caps })
    void qc.invalidateQueries({ queryKey: ['breakdown'] })
  }),
  b.on('purge', () => {
    void qc.invalidateQueries({ queryKey: keys.purge })
    void qc.invalidateQueries({ queryKey: ['topology'] })
  }),
])
