import { useQuery } from '@tanstack/react-query'
import type { DraftStatus, LessonFilter } from '@shared/learn'
import { call, registerLive, useMutate } from './core'

const LEARN = ['learn'] as const

export const useLearnStatus = (crewId?: number) =>
  useQuery({ queryKey: ['learn', 'status', crewId ?? null] as const, queryFn: () => call('learn:status', crewId) })

export const useLessons = (filter: LessonFilter) =>
  useQuery({ queryKey: ['learn', 'lessons', filter] as const, queryFn: () => call('learn:lessons', filter) })

export const useHindsightEntries = (crewId: number | null, query: string, enabled: boolean) =>
  useQuery({
    queryKey: ['learn', 'hindsight', crewId, query] as const,
    queryFn: () => call('learn:hindsightEntries', crewId!, query),
    enabled: enabled && crewId != null,
  })

export const useMemoryFiles = (crewId: number | null) =>
  useQuery({ queryKey: ['learn', 'memoryFiles', crewId] as const, queryFn: () => call('learn:memoryFiles', crewId!), enabled: crewId != null })

export const useDrafts = (crewId?: number, status?: DraftStatus) =>
  useQuery({ queryKey: ['learn', 'drafts', crewId ?? null, status ?? null] as const, queryFn: () => call('learn:drafts', crewId, status) })

// The AI the learn step asks now, an empty model resolved to the cheap default (OpenCode's is looked up at run time).
export const useLearnAi = () => useQuery({ queryKey: ['learn', 'ai'] as const, queryFn: () => call('learn:ai'), staleTime: 60_000 })
export const useTestLearnAi = () => useMutate('learn:test', [])
// What the local server offers; the URL is in the key so a changed endpoint asks again.
export const useLocalModels = (url: string, enabled: boolean) =>
  useQuery({ queryKey: ['learn', 'localModels', url] as const, queryFn: () => call('learn:localModels'), enabled, retry: false })
export const useLocalKey = () => useQuery({ queryKey: ['learn', 'localKey'] as const, queryFn: () => call('learn:localKey') })
export const useSetLocalKey = () => useMutate('learn:setLocalKey', [['learn', 'localKey'], ['learn', 'ai']])
export const useEditLesson = () => useMutate('learn:editLesson', [LEARN])
export const useMergeLessons = () => useMutate('learn:mergeLessons', [LEARN])
export const useSetLessonStatus = () => useMutate('learn:setLessonStatus', [LEARN])
export const useMoveLesson = () => useMutate('learn:moveLesson', [LEARN])
export const useLearnRecords = () => useQuery({ queryKey: ['learn', 'records'] as const, queryFn: () => call('learn:records') })
export const useRollbackChange = () => useMutate('learn:rollback', [LEARN])
export const useClearRecords = () => useMutate('learn:clearRecords', [LEARN])
export const useEditDraft =() => useMutate('learn:editDraft', [LEARN])
export const useApproveDraft = () => useMutate('learn:approveDraft', [LEARN])
export const useRejectDraft = () => useMutate('learn:rejectDraft', [LEARN])
export const useDeleteDraft = () => useMutate('learn:deleteDraft', [LEARN])

// A learn step logs an event when it finishes (and a finished job triggers one), so those refresh the page.
registerLive((b, qc) => [
  b.on('event', (e) => {
    if (e.kind === 'learn') void qc.invalidateQueries({ queryKey: LEARN })
  }),
  // The switches and review mode are part of the status.
  b.on('settings', () => void Promise.all([qc.invalidateQueries({ queryKey: ['learn', 'status'] }), qc.invalidateQueries({ queryKey: ['learn', 'ai'] }), qc.invalidateQueries({ queryKey: ['learn', 'localModels'] })])),
])
