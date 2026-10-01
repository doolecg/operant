import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Settings, SettingsPatch } from '@shared/settings'
import { call, keys, registerLive } from './core'
import { useCrews } from './crews'

export const useSettings = () => useQuery({ queryKey: keys.settings, queryFn: () => call('settings:get') })

export const useAppInfo = () => useQuery({ queryKey: keys.appInfo, queryFn: () => call('app:info'), staleTime: Infinity })

// Settings apply as soon as they change; the saved copy comes back and replaces the cache.
export function useSaveSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: SettingsPatch) => call('settings:set', patch),
    onSuccess: (s) => {
      qc.setQueryData(keys.settings, s)
      void qc.invalidateQueries({ queryKey: keys.summary })
    },
  })
}

// "Reset section to defaults".
export function useResetSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (section: keyof Settings) => call('settings:reset', section),
    onSuccess: (s) => {
      qc.setQueryData(keys.settings, s)
      void qc.invalidateQueries({ queryKey: keys.summary })
    },
  })
}

export interface PresetUsage {
  operators: number
  modified: number
}

// How many operators use each preset and how many of those differ from it, read from the crews' topologies.
export function usePresetUsage(): Map<number, PresetUsage> {
  const crews = useCrews()
  const tops = useQueries({
    queries: (crews.data ?? []).map((c) => ({ queryKey: keys.topology(c.id), queryFn: () => call('crews:topology', c.id) })),
  })
  const usage = new Map<number, PresetUsage>()
  for (const t of tops)
    for (const sq of t.data?.squads ?? [])
      for (const op of sq.operators) {
        if (op.presetId == null) continue
        const u = usage.get(op.presetId) ?? { operators: 0, modified: 0 }
        u.operators++
        if (op.modified) u.modified++
        usage.set(op.presetId, u)
      }
  return usage
}

registerLive((b, qc) => [b.on('settings', (s) => qc.setQueryData(keys.settings, s))])
