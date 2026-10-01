import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type { GraphWindow } from '@shared/types'
import { call, keys, registerLive, useMutate } from './core'

export const useGraph = (crewId: number | null, window: GraphWindow = '24h') =>
  useQuery({ queryKey: keys.graph(crewId ?? -1, window), queryFn: () => call('graph:get', crewId!, window), enabled: crewId != null, placeholderData: keepPreviousData })

export const useLinks = (crewId: number | null) =>
  useQuery({ queryKey: keys.links(crewId ?? -1), queryFn: () => call('links:list', crewId!), enabled: crewId != null })

const linkKeys = [['links'], ['graph']] as const

export const useCreateLink = () => useMutate('links:create', linkKeys)
export const useUpdateLink = () => useMutate('links:update', linkKeys)
export const useDeleteLink = () => useMutate('links:delete', linkKeys)
// Positions are saved while dragging; the view owns them, so nothing is refetched.
export const useSaveGraphPositions = () => useMutate('graph:savePositions', [])
export const useClearGraphPositions = () => useMutate('graph:clear', [['graph']])

registerLive((b, qc) => [
  b.on('job', ({ crewId }) => void qc.invalidateQueries({ queryKey: keys.graph(crewId) })),
  b.on('message', ({ crewId }) => void qc.invalidateQueries({ queryKey: keys.graph(crewId) })),
  b.on('operator:config', () => void qc.invalidateQueries({ queryKey: ['graph'] })),
])
