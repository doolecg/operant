import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { BudgetConfig, BudgetTarget, ExportFormat, ImportSource, UsagePeriod, UsageQuery, UsageSeriesQuery, UsageView } from '@shared/types'
import { call, keys, registerLive, useMutate } from './core'

export const useSpendSeries = (crewId: number | null) =>
  useQuery({ queryKey: keys.spend(crewId ?? -1), queryFn: () => call('usage:series', crewId!), enabled: crewId != null })

export const useUsageBreakdown = (crewId: number | null, period: UsagePeriod) =>
  useQuery({
    queryKey: keys.breakdown(crewId ?? -1, period),
    queryFn: () => call('usage:breakdown', crewId!, period),
    enabled: crewId != null,
  })

export const useCapStatus = () => useQuery({ queryKey: keys.caps, queryFn: () => call('caps:status') })
export const useResetCaps = () => useMutate('caps:reset', [keys.caps, ['breakdown'], ['topology']])

export const usePurgeStatus = () => useQuery({ queryKey: keys.purge, queryFn: () => call('purge:status') })
export const usePurgeNow = () => useMutate('purge:now', [keys.purge, ['topology']])

// Usage page (R20): filtered reports and trends, a job's agents, budgets, export.
export const useUsageReport = (query: UsageQuery) =>
  useQuery({ queryKey: ['usage-report', query], queryFn: () => call('usage:report', query), placeholderData: keepPreviousData })

export const useUsageSeries = (query: UsageSeriesQuery) =>
  useQuery({ queryKey: ['usage-series', query], queryFn: () => call('usage:timeseries', query), placeholderData: keepPreviousData })

export const useJobUsage = (runId: number | null) =>
  useQuery({ queryKey: ['usage-job', runId], queryFn: () => call('usage:job', runId!), enabled: runId != null, retry: false })

export const useBudgets = () => useQuery({ queryKey: ['budgets'], queryFn: () => call('budgets:get') })

function useBudgetMutation<A extends unknown[]>(fn: (...a: A) => Promise<unknown>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (args: A) => fn(...args),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: ['budgets'] }), qc.invalidateQueries({ queryKey: keys.caps }), qc.invalidateQueries({ queryKey: ['runs'] })]),
  })
}
export const useSetBudgets = () => useBudgetMutation((patch: Partial<BudgetConfig>) => call('budgets:set', patch))
export const useResumeBudget = () => useBudgetMutation((target: BudgetTarget) => call('budgets:resume', target))

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

const invalidateUsage = (qc: import('@tanstack/react-query').QueryClient) => {
  for (const k of ['usage-report', 'usage-series', 'usage-job', 'budgets'] as const) void qc.invalidateQueries({ queryKey: [k] })
}

registerLive((b, qc) => [
  b.on('run:agents', () => invalidateUsage(qc)),
  b.on('usage', () => {
    invalidateUsage(qc)
    void qc.invalidateQueries({ queryKey: keys.summary })
    void qc.invalidateQueries({ queryKey: ['spend'] })
    void qc.invalidateQueries({ queryKey: ['breakdown'] })
  }),
  b.on('caps', () => {
    invalidateUsage(qc)
    void qc.invalidateQueries({ queryKey: keys.caps })
    void qc.invalidateQueries({ queryKey: ['breakdown'] })
  }),
  b.on('purge', () => {
    void qc.invalidateQueries({ queryKey: keys.purge })
    void qc.invalidateQueries({ queryKey: ['topology'] })
  }),
])
