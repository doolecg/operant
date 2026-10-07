import { useQuery, type QueryClient } from '@tanstack/react-query'
import type { GitDiffRequest } from '@shared/git'
import { call, registerLive } from './core'

// The Git page's reads. They refresh every 15 s while the page is open, on window focus and when a run finishes.
const POLL = 15_000
const all = ['gitStatus', 'gitInfo', 'gitDiff', 'gitLog', 'gitBranches'] as const

export const useRepoStatus = (crewId: number | null, open = true) =>
  useQuery({ queryKey: ['gitStatus', crewId ?? -1], queryFn: () => call('git:status', crewId!), enabled: crewId != null && open, refetchInterval: open ? POLL : false, staleTime: 2_000 })

export const useRepoDiff = (crewId: number | null, req: GitDiffRequest | null, tick: string) =>
  useQuery({ queryKey: ['gitDiff', crewId ?? -1, req, tick], queryFn: () => call('git:diff', crewId!, req!), enabled: crewId != null && req != null, staleTime: 5_000 })

export const useRepoLog = (crewId: number | null, limit: number, open = true) =>
  useQuery({ queryKey: ['gitLog', crewId ?? -1, limit], queryFn: () => call('git:log', crewId!, limit), enabled: crewId != null && open, refetchInterval: open ? POLL : false })

export const useCommitDetails = (crewId: number | null, hash: string | null) =>
  useQuery({ queryKey: ['gitCommit', crewId ?? -1, hash], queryFn: () => call('git:commitDetails', crewId!, hash!), enabled: crewId != null && hash != null, staleTime: Infinity })

export const useRepoBranches = (crewId: number | null, open = true) =>
  useQuery({ queryKey: ['gitBranches', crewId ?? -1], queryFn: () => call('git:branches', crewId!), enabled: crewId != null && open, refetchInterval: open ? POLL : false })

// After a change to the repository, whatever the Git page and the chips show is read again.
export const refreshGit = (qc: QueryClient) => Promise.all(all.map((k) => qc.invalidateQueries({ queryKey: [k] })))

registerLive((b, qc) => {
  const refresh = () => void Promise.all(['gitStatus', 'gitDiff', 'gitLog', 'gitBranches'].map((k) => qc.invalidateQueries({ queryKey: [k] })))
  window.addEventListener('focus', refresh)
  return [b.on('run', refresh), () => window.removeEventListener('focus', refresh)]
})
