import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { call, registerLive, useMutate } from './core'

// Memory, auxiliary model calls, CodeGraph, backups, Superpowers, CLI capabilities and Claude tile state.

export const useMemoryDiagnostics = () => useQuery({ queryKey: ['memory', 'diagnostics'] as const, queryFn: () => call('memory:diagnostics') })
export const useMemoryExport = () => useMutate('memory:export', [])
export const useMemoryReset = () => useMutate('memory:reset', [['memory'], ['learn']])
export const useMemoryEdit = () => useMutate('memory:edit', [['learn'], ['memory']])
export const useMemoryDelete = () => useMutate('memory:delete', [['learn'], ['memory']])

export const useAuxStatus = () => useQuery({ queryKey: ['aux', 'status'] as const, queryFn: () => call('aux:status'), refetchInterval: 15_000 })

export const useCodegraphStatus = (folder: string | undefined) =>
  useQuery({ queryKey: ['codegraph', 'status', folder ?? ''] as const, queryFn: () => call('codegraph:status', folder!), enabled: !!folder })
export const useCodegraphRebuild = () => useMutate('codegraph:rebuild', [['codegraph']])

export const useBackups = () => useQuery({ queryKey: ['backups'] as const, queryFn: () => call('backup:list') })
export const useCreateBackup = () => useMutate('backup:create', [['backups']])
export const useRestoreBackup = () => useMutate('backup:restore', [])
export const useDeleteBackup = () => useMutate('backup:delete', [['backups']])

export const useSuperpowers = () => useQuery({ queryKey: ['superpowers'] as const, queryFn: () => call('superpowers:status') })

// Which CLIs are installed and what each can do. Cached by the main process; a failed probe shows as not installed, never as working.
export const capabilityKey = ['capabilities'] as const
export const useCapabilities = () => useQuery({ queryKey: capabilityKey, queryFn: () => call('capabilities:get'), staleTime: 60_000 })
export function useRefreshCapabilities() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => call('capabilities:refresh'),
    onSuccess: (r) => qc.setQueryData(capabilityKey, r),
  })
}

// A Claude Code tile's state (sub-agents, status line). The tile id is the scratch terminal's id.
export const claudeTileKey = (tileId: number) => ['claudeMods', tileId] as const
export const useClaudeTileState = (tileId: number | null) =>
  useQuery({ queryKey: claudeTileKey(tileId ?? -1), queryFn: () => call('claudeMods:get', tileId!), enabled: tileId != null })

registerLive((b, qc) => [
  b.on('claudeMods:state', (s) => qc.setQueryData(claudeTileKey(s.tileId), s)),
  b.on('settings', () => void qc.invalidateQueries({ queryKey: ['aux'] })),
])
