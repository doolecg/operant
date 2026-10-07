import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Settings, SettingsPatch } from '@shared/settings'
import { call, keys, registerLive } from './core'

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

registerLive((b, qc) => [b.on('settings', (s) => qc.setQueryData(keys.settings, s))])
