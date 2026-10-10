import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { BudgetConfig, ExportFormat, ImportSource, UsageQuery, UsageSeriesQuery, UsageView } from '@shared/types'
import { call, registerLive } from './core'

// Usage page (R20): filtered reports and trends, budgets, export.
export const useUsageReport = (query: UsageQuery) =>
  useQuery({ queryKey: ['usage-report', query], queryFn: () => call('usage:report', query), placeholderData: keepPreviousData })

export const useUsageSeries = (query: UsageSeriesQuery) =>
  useQuery({ queryKey: ['usage-series', query], queryFn: () => call('usage:timeseries', query), placeholderData: keepPreviousData })

export const useBudgets = () => useQuery({ queryKey: ['budgets'], queryFn: () => call('budgets:get') })

function useBudgetMutation<A extends unknown[]>(fn: (...a: A) => Promise<unknown>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (args: A) => fn(...args),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['budgets'] }),
  })
}
export const useSetBudgets = () => useBudgetMutation((patch: Partial<BudgetConfig>) => call('budgets:set', patch))

// Opens the save dialog in the main process; `saved` is null when the person cancelled.
export const useExportUsage = () =>
  useMutation({ mutationFn: ([view, format]: [UsageView, ExportFormat]) => call('usage:export', view, format) })

// Provider limits (R22): the backend polls the services itself; the page asks again only on a slow timer and on demand.
const PROVIDERS_REFRESH_MS = 5 * 60_000
export const useProviders = () =>
  useQuery({ queryKey: ['providers'], queryFn: () => call('providers:status'), refetchInterval: PROVIDERS_REFRESH_MS })
export function useRefreshProviders() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => call('providers:refresh'),
    onSuccess: (data) => qc.setQueryData(['providers'], data),
  })
}

// Import and move (R21).
export const useImportPreview = () => useMutation({ mutationFn: (source: ImportSource) => call('import:preview', source) })
export function useImportApply() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (source: ImportSource) => call('import:apply', source),
    onSuccess: () => qc.invalidateQueries(),
  })
}
export const pickImportFile = () => call('import:pickFile')
export const useExportAllData = () => useMutation({ mutationFn: () => call('data:exportFile') })

registerLive((b, qc) => [
  b.on('budget', () => void qc.invalidateQueries({ queryKey: ['budgets'] })),
])
