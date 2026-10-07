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

export const useLearnNow = () => useMutate('learn:run', [LEARN, ['events']])
export const useEditLesson = () => useMutate('learn:editLesson', [LEARN])
export const useMergeLessons = () => useMutate('learn:mergeLessons', [LEARN])
export const useSetLessonStatus = () => useMutate('learn:setLessonStatus', [LEARN])
export const useMoveLesson = () => useMutate('learn:moveLesson', [LEARN])
export const useEditDraft = () => useMutate('learn:editDraft', [LEARN])
export const useApproveDraft = () => useMutate('learn:approveDraft', [LEARN])
export const useRejectDraft = () => useMutate('learn:rejectDraft', [LEARN])
export const useDeleteDraft = () => useMutate('learn:deleteDraft', [LEARN])

// A learn step logs an event when it finishes (and a finished job triggers one), so those refresh the page.
registerLive((b, qc) => [
  b.on('event', (e) => {
    if (e.kind === 'learn') void qc.invalidateQueries({ queryKey: LEARN })
  }),
  b.on('run', () => void qc.invalidateQueries({ queryKey: ['learn', 'status'] })),
  // The switches and review mode are part of the status.
  b.on('settings', () => void qc.invalidateQueries({ queryKey: ['learn', 'status'] })),
])
