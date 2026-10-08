import type { Run, RunStatus } from '../shared/types'

// The moves that need the owner: a run entered needs-you, review or failed.
const NOTIFY_STATUSES: RunStatus[] = ['needs-you', 'review', 'failed']

export function shouldNotify(prev: RunStatus | undefined, status: RunStatus, enabled: boolean, focused: boolean): boolean {
  return enabled && !focused && prev !== status && NOTIFY_STATUSES.includes(status)
}

export function notificationText(run: Pick<Run, 'id' | 'task' | 'status' | 'question'>): { title: string; body: string } {
  const task = run.task.replace(/\s+/g, ' ').trim().slice(0, 120)
  const title =
    run.status === 'needs-you' ? `JOB#${run.id} needs you` : run.status === 'review' ? `JOB#${run.id} is ready for review` : `JOB#${run.id} failed`
  return { title, body: run.status === 'needs-you' && run.question ? run.question.slice(0, 160) : task }
}

export interface NotifierDeps {
  enabled: () => boolean
  focused: () => boolean
  getRun: (runId: number) => Pick<Run, 'id' | 'task' | 'status' | 'question'> | null
  show: (text: { title: string; body: string }, onClick: () => void) => void
  onClick: (runId: number) => void
}

// Fed by the run push event; remembers the last status per run so only a real move notifies.
export function createRunNotifier(deps: NotifierDeps): (runId: number, status: RunStatus) => void {
  const last = new Map<number, RunStatus>()
  return (runId, status) => {
    const prev = last.get(runId)
    last.set(runId, status)
    if (!shouldNotify(prev, status, deps.enabled(), deps.focused())) return
    const run = deps.getRun(runId)
    if (!run) return
    deps.show(notificationText(run), () => deps.onClick(runId))
  }
}
