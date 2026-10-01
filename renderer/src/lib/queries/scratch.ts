import { useQuery } from '@tanstack/react-query'
import { call, keys, registerLive, useMutate } from './core'

export const useScratch = (crewId: number | null) =>
  useQuery({ queryKey: keys.scratch(crewId ?? -1), queryFn: () => call('scratch:list', crewId!), enabled: crewId != null })

export const useTileLayout = (crewId: number | null) =>
  useQuery({ queryKey: keys.tiles(crewId ?? -1), queryFn: () => call('tiles:getLayout', crewId!), enabled: crewId != null })

// Saving a layout does not refetch it: the Tiles view owns the layout state while it is open.
export const useSaveTileLayout = () => useMutate('tiles:saveLayout', [])

const scratchKeys = [['scratch']] as const

export const useCreateScratch = () => useMutate('scratch:create', scratchKeys)
export const useUpdateScratch = () => useMutate('scratch:update', scratchKeys)
export const useDeleteScratch = () => useMutate('scratch:delete', [...scratchKeys, ['breakdown'], ['spend']])
export const useStartScratch = () => useMutate('scratch:start', scratchKeys)
export const useStopScratch = () => useMutate('scratch:stop', scratchKeys)

registerLive((b, qc) => [b.on('scratch:exit', () => void qc.invalidateQueries({ queryKey: ['scratch'] }))])

// Last 24 hours per scratch terminal of the crew, for the tile badges (refreshed with the scratch queries).
export const useScratchSpends = (crewId: number | null) =>
  useQuery({
    queryKey: ['scratch', 'spend', crewId ?? -1],
    queryFn: () => call('scratch:spend', crewId!),
    enabled: crewId != null,
    refetchInterval: 30_000,
  })

// What scratch terminals spent over the last 24 hours (the Cost tab shows the full split).
export const useScratchSpend = (crewId: number | null) =>
  useQuery({
    queryKey: keys.breakdown(crewId ?? -1, '24h'),
    queryFn: () => call('usage:breakdown', crewId!, '24h'),
    enabled: crewId != null,
    select: (b) => b.scratch,
  })
