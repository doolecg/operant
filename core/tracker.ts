import type { Crew, Run } from '../shared/types'
import type { JobEngine, JobRecord } from './jobs'

export const TRACKER_TITLE = 'Update tracker'
const BODY_MAX = 15_000

const RULE =
  'Rule: tick only what was verified, update the Status of affected requirements, refresh screenshots, keep unverified items listed as gaps.'

// The files a finished run changed, from the write-back tags.
export const filesFromTags = (tags: string[] = []): string[] => tags.filter((t) => t.startsWith('file:')).map((t) => t.slice(5))

const finishedLine = (run: Run, files: string[]) =>
  `- JOB#${run.id} ${run.status}: ${run.outcome || '(no outcome)'}\n  Files changed: ${files.length ? files.join(', ') : 'none'}`

// Creates the project's one open "Update tracker" board job, or appends the finished run to it. It only creates the
// task for the project manager; it never edits the tracker itself.
export function refreshTrackerJob(jobs: JobEngine, crew: Crew, run: Run | null, files: string[]): JobRecord {
  const user = { kind: 'user' } as const
  const open = jobs.list(user, crew.id, { open: true }).find((j) => j.title === TRACKER_TITLE)
  const line = run ? finishedLine(run, files) : '- Requested by hand.'
  if (open) {
    const body = `${open.body}\n${line}`
    return jobs.edit(user, open.id, { body: body.length > BODY_MAX ? `${open.body.slice(0, 600)}\n...\n${body.slice(-(BODY_MAX - 700))}` : body })
  }
  const body = [
    'Role: Project manager',
    `Tracker: ${crew.trackerFile}`,
    RULE,
    '',
    'Finished since the tracker was last updated:',
    line,
  ].join('\n')
  return jobs.create(user, { crewId: crew.id, title: TRACKER_TITLE, body, for: crew.pmId })
}
