import type { RunStatus } from '@shared/types'

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  queued: 'Queued',
  working: 'Working',
  'needs-you': 'Needs you',
  done: 'Done',
  failed: 'Failed',
}

export const RUN_STATUS_TONE: Record<RunStatus, string> = {
  queued: 'bg-zinc-500',
  working: 'bg-emerald-400',
  'needs-you': 'bg-amber-400',
  done: 'bg-sky-400',
  failed: 'bg-red-500',
}

export const runActive = (status: RunStatus) => status === 'queued' || status === 'working' || status === 'needs-you'
