import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { TeamInput, TeamPatch } from '@shared/types'
import { call, keys, useMutate } from './core'

const teamsKey = keys.teams

export const useTeams = () => useQuery({ queryKey: teamsKey, queryFn: () => call('teams:list') })

export function useCreateTeam() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: TeamInput) => call('teams:create', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: teamsKey }),
  })
}

export function useUpdateTeam() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: TeamPatch }) => call('teams:update', id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: teamsKey }),
  })
}

export function useDeleteTeam() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => call('teams:delete', id),
    onSuccess: () => qc.invalidateQueries({ queryKey: teamsKey }),
  })
}

const teamKeys = [keys.teams] as const

export const useDuplicateTeam = () => useMutate('teams:duplicate', teamKeys)
export const useResetTeam = () => useMutate('teams:reset', teamKeys)
export const useHideTeam = () => useMutate('teams:setHidden', teamKeys)
export const useExportTeams = () => useMutate('teams:export', [])
export const useTeamImportPreview = () => useMutate('teams:importPreview', [])
export const useImportTeams = () => useMutate('teams:import', teamKeys)
