import type { Job, JobState, Operator } from '@shared/types'
import { decodeIpcError } from '@shared/ipc'

export const STATES: Array<{ state: JobState; label: string }> = [
  { state: 'held', label: 'Held' },
  { state: 'review', label: 'Review' },
  { state: 'doing', label: 'Doing' },
  { state: 'todo', label: 'To do' },
  { state: 'done', label: 'Done' },
]

export const stateLabel = (s: JobState) => STATES.find((x) => x.state === s)!.label

export const errorText = (e: unknown): string => decodeIpcError(e).message

export const operatorLabel = (operators: Operator[], id: number | null, none = 'Unassigned'): string => {
  if (id == null) return none
  return operators.find((o) => o.id === id)?.role ?? `operator ${id}`
}

export const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export const leaseText = (job: Job, now = Date.now()): string | null => {
  if (job.leaseUntil == null || job.state !== 'doing') return null
  return job.leaseUntil <= now ? 'lease expired' : `lease until ${clock(job.leaseUntil)}`
}
