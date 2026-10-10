import { useQuery } from '@tanstack/react-query'
import { call, keys, registerLive, useMutate } from './core'

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

// Branch and changed-file count of a project (null when the folder is not a git repository). Rows ask once; the open
// project also refreshes on a 15 s timer. Window focus and a finished run refresh every project (see below).
export const useGitInfo = (crewId: number | null, poll = false) =>
  useQuery({
    queryKey: ['gitInfo', crewId ?? -1],
    queryFn: () => call('git:info', crewId!),
    enabled: crewId != null,
    staleTime: 10_000,
    refetchInterval: poll ? 15_000 : false,
  })

registerLive((_b, qc) => {
  const refresh = () => void qc.invalidateQueries({ queryKey: ['gitInfo'] })
  window.addEventListener('focus', refresh)
  return [() => window.removeEventListener('focus', refresh)]
})
