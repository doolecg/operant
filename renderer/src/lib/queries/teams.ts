import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { TeamInput, TeamPatch } from '@shared/types'
import { call, keys, useMutate } from './core'

const teamsKey = keys.teams
const limitKey = ['runs', 'limit'] as const

// The team list itself is useTeams in runs.ts.
export function useCreateTeam() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: TeamInput) => call('teams:create', input),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: teamsKey }), qc.invalidateQueries({ queryKey: ['mcp', 'health'] })]),
  })
}

export function useUpdateTeam() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: TeamPatch }) => call('teams:update', id, patch),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: teamsKey }), qc.invalidateQueries({ queryKey: ['mcp', 'health'] })]),
  })
}

export function useDeleteTeam() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => call('teams:delete', id),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: teamsKey }), qc.invalidateQueries({ queryKey: ['mcp', 'health'] })]),
  })
}

const teamKeys = [keys.teams, ['mcp', 'health']] as const

export const useDuplicateTeam = () => useMutate('teams:duplicate', teamKeys)
export const useResetTeam = () => useMutate('teams:reset', teamKeys)
export const useHideTeam = () => useMutate('teams:setHidden', teamKeys)
export const useExportTeams = () => useMutate('teams:export', [])
export const useTeamImportPreview = () => useMutate('teams:importPreview', [])
export const useImportTeams = () => useMutate('teams:import', teamKeys)

// Queue concurrency limit for runs.
export const useRunLimit = () => useQuery({ queryKey: limitKey, queryFn: () => call('runs:getLimit') })

export function useSetRunLimit() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (limit: number) => call('runs:setLimit', limit),
    onSuccess: (saved) => qc.setQueryData(limitKey, saved),
  })
}
