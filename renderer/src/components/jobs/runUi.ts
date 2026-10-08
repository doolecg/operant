import type { MasterPhase, Run, RunEvent, RunStatus, RunWaiting } from '@shared/types'

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  queued: 'Queued',
  working: 'Working',
  'needs-you': 'Needs you',
  review: 'Review',
  done: 'Done',
  failed: 'Failed',
}

export const RUN_STATUS_TONE: Record<RunStatus, string> = {
  queued: 'bg-zinc-500',
  working: 'bg-emerald-400',
  'needs-you': 'bg-amber-400',
  review: 'bg-violet-400',
  done: 'bg-sky-400',
  failed: 'bg-red-500',
}

export const WAITING_LABEL: Record<RunWaiting, string> = {
  question: 'question',
  permission: 'permission',
  master: 'Master stopped',
}

// "Needs you: question", "Needs you: permission", "Needs you: Master stopped"; the plain label for every other state.
export function runLabel(status: RunStatus, waiting: RunWaiting | '' = ''): string {
  return status === 'needs-you' && waiting ? `${RUN_STATUS_LABEL[status]}: ${WAITING_LABEL[waiting]}` : RUN_STATUS_LABEL[status]
}

export const runActive = (status: RunStatus) => status === 'queued' || status === 'working' || status === 'needs-you' || status === 'review'

// Waiting for the owner: an answer, a permission, a stopped Master, or the review.
export const runNeedsOwner = (run: Pick<Run, 'status'>) => run.status === 'needs-you' || run.status === 'review'

// The answer-able kind of needs-you.
export const runIsQuestion = (run: Pick<Run, 'status' | 'waiting'>) => run.status === 'needs-you' && run.waiting === 'question'

export function sortNeedsYouFirst<T extends Pick<Run, 'status'>>(runs: T[]): T[] {
  return [...runs].sort((a, b) => Number(runNeedsOwner(b)) - Number(runNeedsOwner(a)))
}

export const MASTER_PHASE_LABEL: Record<MasterPhase, string> = {
  unknown: 'Starting',
  starting: 'Starting',
  idle: 'Idle',
  busy: 'Busy',
  'needs-input': 'Needs input',
  exited: 'Stopped',
}

export const MASTER_PHASE_HINT: Record<MasterPhase, string> = {
  unknown: 'The Master is starting; tasks wait until it is ready.',
  starting: 'The Master is starting; tasks wait until it is ready.',
  idle: 'The Master is waiting at its prompt and can take a task.',
  busy: 'The Master is working. A new task is typed in when it is idle again.',
  'needs-input': 'The Master is waiting for you in its terminal (a permission or a question).',
  exited: 'The Master Terminal is stopped. Sending a task starts it.',
}

const SOURCE_LABEL: Record<string, string> = {
  master: 'Master',
  'owner-ui': 'you, in Operant',
  'owner-terminal': 'you, in the Master Terminal',
  'owner-discord': 'you, on Discord',
  system: 'Operant',
}

export const sourceLabel = (source: string) => SOURCE_LABEL[source] ?? source

export interface TimelineItem {
  id: number
  at: number
  title: string
  // Free text from the Master or the owner; shown as plain text only.
  detail?: string
  tone: 'neutral' | 'attention' | 'good' | 'bad'
}

// The delivered / retry / giveup / resume bodies are JSON written by Operant ({nonce, line}); they are never shown raw.
const gateLine = (body: string): string => {
  try {
    const line = (JSON.parse(body) as { line?: unknown }).line
    return typeof line === 'string' ? line : ''
  } catch {
    return ''
  }
}

// One readable timeline row per run event.
export function timelineItem(e: RunEvent): TimelineItem {
  const base = { id: e.id, at: e.at }
  const text = e.body.trim()
  switch (e.kind) {
    case 'delivered':
      return { ...base, title: 'Task handed to the Master', tone: 'neutral' }
    case 'retry':
      return { ...base, title: 'The Master had not picked it up, so it was typed again', tone: 'neutral' }
    case 'giveup':
      return { ...base, title: 'Gave up waiting for the Master to pick it up', tone: 'bad' }
    case 'resume':
      return { ...base, title: 'Master resumed', tone: 'neutral' }
    case 'progress':
      return { ...base, title: 'Progress', detail: text, tone: 'neutral' }
    case 'question':
      return { ...base, title: 'The Master asked a question', detail: text, tone: 'attention' }
    case 'reply':
      return { ...base, title: `Answered by ${sourceLabel(e.source)}`, detail: text, tone: 'neutral' }
    case 'review':
      return { ...base, title: 'Master asked for your review', tone: 'attention' }
    case 'approved':
      return { ...base, title: `Approved by ${sourceLabel(e.source)}`, detail: text || undefined, tone: 'good' }
    case 'sent-back':
      return { ...base, title: `Sent back by ${sourceLabel(e.source)}`, detail: text || undefined, tone: 'attention' }
    case 'closeout':
      return { ...base, title: 'Close-out', detail: text, tone: 'neutral' }
    default:
      return { ...base, title: String(e.kind), detail: gateLine(text) || undefined, tone: 'neutral' }
  }
}

export const lastProgress = (events: RunEvent[]): string => {
  for (const e of [...events].reverse()) if (e.kind === 'progress') return e.body.trim().split('\n')[0] ?? ''
  return ''
}

// The delegation guard counts only for the latest review: a guard written after the newest 'review' event.
export const GUARD_PREFIX = 'No seat subagent was used'
export function guardForLatestReview(events: RunEvent[]): boolean {
  let review = -1
  events.forEach((e, i) => {
    if (e.kind === 'review') review = i
  })
  return events.some((e, i) => i > review && e.kind === 'guard' && e.body.startsWith(GUARD_PREFIX))
}
