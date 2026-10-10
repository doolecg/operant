import { useQuery } from '@tanstack/react-query'
import { call, keys, useMutate } from './core'

export const usePresets = () => useQuery({ queryKey: keys.presets, queryFn: () => call('presets:list') })

const presetKeys = [keys.presets] as const

export const useCreatePreset = () => useMutate('presets:create', presetKeys)
export const useUpdatePreset = () => useMutate('presets:update', presetKeys)
export const useDuplicatePreset = () => useMutate('presets:duplicate', presetKeys)
export const useDeletePreset = () => useMutate('presets:delete', presetKeys)
export const useResetPreset = () => useMutate('presets:reset', presetKeys)
export const useRestoreBuiltinPresets = () => useMutate('presets:restoreBuiltins', presetKeys)
