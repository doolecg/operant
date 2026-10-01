import { useQuery } from '@tanstack/react-query'
import { call, keys, useMutate } from './core'

export const usePresets = () => useQuery({ queryKey: keys.presets, queryFn: () => call('presets:list') })

// The shipped role text of a built-in, to show next to an edit.
export const useShippedRole = (presetId: number | null) =>
  useQuery({
    queryKey: keys.shippedRole(presetId ?? -1),
    queryFn: () => call('presets:shippedRole', presetId!),
    enabled: presetId != null,
  })

const presetKeys = [keys.presets, ['topology']] as const

export const useCreatePreset = () => useMutate('presets:create', presetKeys)
export const useUpdatePreset = () => useMutate('presets:update', presetKeys)
export const useDuplicatePreset = () => useMutate('presets:duplicate', presetKeys)
export const useDeletePreset = () => useMutate('presets:delete', presetKeys)
export const useResetPreset = () => useMutate('presets:reset', presetKeys)
export const useRestoreBuiltinPresets = () => useMutate('presets:restoreBuiltins', presetKeys)
export const useApplyPresetToOperators = () => useMutate('presets:applyToOperators', presetKeys)
export const useSavePresetFromOperator = () => useMutate('presets:saveFromOperator', presetKeys)
export const useRevertOperatorToPreset = () => useMutate('presets:revertOperator', presetKeys)
