import { useQuery } from '@tanstack/react-query'
import { call, keys, useMutate } from './core'

const GROUPS = ['groups'] as const

export const useGroups = () => useQuery({ queryKey: GROUPS, queryFn: () => call('groups:list') })

// Group changes also change what the project list shows (a project's group), so both lists refresh.
const both = [GROUPS, keys.crews] as const
export const useCreateGroup = () => useMutate('groups:create', both)
export const useRenameGroup = () => useMutate('groups:rename', both)
export const useDeleteGroup = () => useMutate('groups:delete', both)
export const useCollapseGroup = () => useMutate('groups:collapse', both)
export const useReorderGroups = () => useMutate('groups:reorder', both)
export const useMoveToGroup = () => useMutate('groups:move', both)

// Which IDEs are installed, for the "Open in" menu item and the settings page.
export const useIdes = () => useQuery({ queryKey: ['ides'], queryFn: () => call('ide:list'), staleTime: 60_000 })

export const useGitChanges = (crewId: number | null, enabled = true) =>
  useQuery({
    queryKey: ['gitChanges', crewId ?? -1],
    queryFn: () => call('git:changes', crewId!),
    enabled: enabled && crewId != null,
    gcTime: 0,
  })
