import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { Crew, Job, JobReview, JobState } from '../shared/types'
import type { Store } from './store'

// Who is asking. Operator and master ids come from the CLI token; the user is the dashboard.
export type JobActor = { kind: 'operator'; id: number } | { kind: 'master'; id: number } | { kind: 'user' }

// Step 4 maps these to CLI exit codes (3, 4, 5, 2).
export type JobErrorCode = 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN' | 'BAD_ARGS'

export class JobError extends Error {
  constructor(
    readonly code: JobErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'JobError'
  }
}

export interface JobSettings {
  leaseMinutes: number
  maxRejects: number
  longJobEstimateMinutes: number
  longJobElapsedMinutes: number
}

export const DEFAULT_JOB_SETTINGS: JobSettings = {
  leaseMinutes: 60,
  maxRejects: 1,
  longJobEstimateMinutes: 120,
  longJobElapsedMinutes: 240,
}

export interface JobRecord extends Job {
  deps: number[]
}

export type NoticeTo = { kind: 'operator'; id: number } | { kind: 'master' } | { kind: 'user' }

export type JobNoticeKind =
  | 'created'
  | 'edited'
  | 'deleted'
  | 'claimed'
  | 'released'
  | 'handoff'
  | 'reassigned'
  | 'review'
  | 'done'
  | 'approved'
  | 'rejected'
  | 'to-pm'
  | 'held'
  | 'escalated'
  | 'started'
  | 'override'
  | 'expired'
  | 'unblocked'
  | 'deps'

// One activity event; `to` lists who should also get a system message about it (empty = activity only).
export interface JobNotice {
  kind: JobNoticeKind
  crewId: number
  jobId: number
  actorId: number | null
  by: string
  text: string
  to: NoticeTo[]
}

export interface NewJobInput {
  crewId: number
  title: string
  body?: string
  priority?: number
  // Pre-assign to this operator.
  for?: number | null
  deps?: number[]
  estimateMinutes?: number | null
  review?: JobReview
  reviewerId?: number | null
}

export interface JobEdit {
  title?: string
  body?: string
  priority?: number
  estimateMinutes?: number | null
  review?: JobReview
  reviewerId?: number | null
  note?: string
}

export interface JobOverride {
  state?: JobState
  assigneeId?: number | null
}

export interface SweepResult {
  expired: JobRecord[]
  escalated: JobRecord[]
}

const STATES: JobState[] = ['todo', 'doing', 'review', 'done', 'held']
const REVIEWS: JobReview[] = ['none', 'pm', 'operator', 'user']
const LONG_START = 'long job: approve to start'
const MINUTE = 60_000
const TITLE_MAX = 200
const TEXT_MAX = 16_000

type Row = Record<string, unknown>

interface Caller {
  kind: JobActor['kind']
  id: number | null
  crewId: number | null
  label: string
}

const nullable = (v: unknown): number | null => (v == null ? null : Number(v))

const toRecord = (r: Row): JobRecord => ({
  id: Number(r.id),
  crewId: Number(r.crew_id),
  assigneeId: nullable(r.assignee_id),
  title: String(r.title),
  body: String(r.body),
  state: r.state as JobState,
  priority: Number(r.priority),
  createdBy: nullable(r.created_by),
  reviewerId: nullable(r.reviewer_id),
  review: r.review as JobReview,
  leaseUntil: nullable(r.lease_until),
  rejects: Number(r.rejects),
  note: String(r.note),
  blocked: Number(r.blocked) === 1,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
  estimateMinutes: nullable(r.estimate_minutes),
  startedAt: nullable(r.started_at),
  escalation: String(r.escalation),
  preassignedId: nullable(r.preassigned_id),
  deps: r.deps == null ? [] : String(r.deps).split(',').map(Number).sort((a, b) => a - b),
})

const RECORD_SELECT = `SELECT j.*,
    EXISTS (SELECT 1 FROM job_deps d JOIN jobs p ON p.id = d.depends_on_id WHERE d.job_id = j.id AND p.state <> 'done') AS blocked,
    (SELECT group_concat(depends_on_id) FROM job_deps WHERE job_id = j.id) AS deps
  FROM jobs j`

// One statement, so two callers can never both win: the row is re-checked under SQLite's write lock.
const CLAIM_SQL = `UPDATE jobs SET state = 'doing', assignee_id = ?, lease_until = ?, started_at = COALESCE(started_at, ?), updated_at = ?
  WHERE state = 'todo' AND id = (
    SELECT j.id FROM jobs j
    WHERE j.crew_id = ? AND j.state = 'todo' AND (j.assignee_id IS NULL OR j.assignee_id = ?) AND (? IS NULL OR j.id = ?)
      AND NOT EXISTS (SELECT 1 FROM job_deps d JOIN jobs p ON p.id = d.depends_on_id WHERE d.job_id = j.id AND p.state <> 'done')
    ORDER BY j.priority DESC, j.id LIMIT 1)
  RETURNING id`

// A write lock still held by another connection after busy_timeout.
function busyError(err: unknown): JobError | null {
  if (err instanceof JobError) return null
  const e = err as { code?: unknown; errstr?: unknown; message?: unknown }
  const msg = `${String(e.errstr ?? '')} ${String(e.message ?? '')}`
  if (e.code === 'ERR_SQLITE_ERROR' && /database is locked|database table is locked|SQLITE_BUSY/i.test(msg)) {
    return new JobError('CONFLICT', 'The job database is busy; try again')
  }
  return null
}

function text(v: unknown, name: string, max: number, required: boolean): string {
  if (typeof v !== 'string') throw new JobError('BAD_ARGS', `${name} must be text`)
  const s = v.trim()
  if (required && !s) throw new JobError('BAD_ARGS', `${name} is required`)
  if (s.length > max) throw new JobError('BAD_ARGS', `${name} is longer than ${max} characters`)
  return s
}

function int(v: unknown, name: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new JobError('BAD_ARGS', `${name} must be a whole number from ${min} to ${max}`)
  }
  return v
}

// The job board's rules: atomic claim, leases, dependencies, review, long-job escalation and who may
// do what. Notices are handed to `emit` after the change commits; messaging them is the caller's job.
export class JobEngine {
  private readonly db: DatabaseSync
  private pending: JobNotice[] = []
  private depth = 0

  constructor(
    private readonly store: Store,
    private readonly now: () => number = Date.now,
    private readonly settings: () => JobSettings = () => DEFAULT_JOB_SETTINGS,
    private readonly emit: (notice: JobNotice) => void = () => {},
  ) {
    this.db = store.db
  }

  // Reads

  get(actor: JobActor, id: number): JobRecord {
    return this.jobFor(this.caller(actor), id)
  }

  list(actor: JobActor, crewId: number, opts: { open?: boolean } = {}): JobRecord[] {
    this.crewFor(this.caller(actor), crewId)
    const where = opts.open ? " AND j.state <> 'done'" : ''
    return (this.db.prepare(`${RECORD_SELECT} WHERE j.crew_id = ?${where} ORDER BY j.id`).all(crewId) as Row[]).map(toRecord)
  }

  // Create and edit

  create(actor: JobActor, input: NewJobInput): JobRecord {
    return this.run(() => {
      const c = this.caller(actor)
      const crew = this.crewFor(c, input.crewId)
      const title = text(input.title, 'Title', TITLE_MAX, true)
      const body = text(input.body ?? '', 'Body', TEXT_MAX, false)
      const priority = int(input.priority ?? 0, 'Priority', -1000, 1000)
      const estimate = input.estimateMinutes == null ? null : int(input.estimateMinutes, 'Estimate', 1, 100_000)
      const assignee = input.for ?? null
      if (assignee != null) {
        this.assertMember(crew.id, assignee, 'Assignee')
        if (c.kind === 'operator' && assignee !== c.id && !this.isPm(c, crew)) {
          throw new JobError('FORBIDDEN', 'Only the PM, the Master Terminal or the user can assign a job to another operator')
        }
      }
      let { review, reviewerId } = this.reviewFor(crew, input.review, input.reviewerId)
      const long = estimate != null && estimate >= this.settings().longJobEstimateMinutes
      if (long) {
        review = 'user'
        reviewerId = null
      }
      const deps = [...new Set(input.deps ?? [])]
      for (const d of deps) {
        const dep = this.row(d)
        if (!dep || dep.crewId !== crew.id) throw new JobError('BAD_ARGS', `Job ${d} is not a job of this project`)
      }
      const t = this.now()
      const row = this.db
        .prepare(
          `INSERT INTO jobs (crew_id, assignee_id, title, body, state, priority, created_by, reviewer_id, review, estimate_minutes, escalation, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        )
        .get(crew.id, assignee, title, body, long ? 'held' : 'todo', priority, c.id, reviewerId, review, estimate, long ? LONG_START : '', t, t) as Row
      const id = Number(row.id)
      if (assignee != null) this.setPreassigned(id, true)
      const insertDep = this.db.prepare('INSERT INTO job_deps (job_id, depends_on_id) VALUES (?, ?)')
      for (const d of deps) insertDep.run(id, d)
      const job = this.row(id)!
      this.notify(c, job, 'created', `${this.name(job)} created by ${c.label}`, assignee != null && assignee !== c.id ? [this.op(assignee)] : [])
      if (long) this.notify(c, job, 'held', `${this.name(job)} is held: ${LONG_START} (estimate ${estimate} min)`, [{ kind: 'user' }, { kind: 'master' }])
      return job
    })
  }

  edit(actor: JobActor, id: number, patch: JobEdit): JobRecord {
    return this.run(() => {
      const c = this.caller(actor)
      const job = this.jobFor(c, id)
      this.assertCanEdit(c, job)
      const crew = this.store.getCrew(job.crewId)!
      const set: Record<string, SQLInputValue> = {}
      if (patch.title !== undefined) set.title = text(patch.title, 'Title', TITLE_MAX, true)
      if (patch.body !== undefined) set.body = text(patch.body, 'Body', TEXT_MAX, false)
      if (patch.note !== undefined) set.note = text(patch.note, 'Note', TEXT_MAX, false)
      if (patch.priority !== undefined) set.priority = int(patch.priority, 'Priority', -1000, 1000)
      if (patch.review !== undefined || patch.reviewerId !== undefined) {
        const wanted = patch.review ?? (patch.reviewerId != null ? 'operator' : job.review)
        const r = this.reviewFor(crew, wanted, patch.reviewerId !== undefined ? patch.reviewerId : job.reviewerId)
        if (job.review === 'user' && r.review !== 'user' && c.kind !== 'user' && c.kind !== 'master') {
          throw new JobError('FORBIDDEN', 'Only the user or the Master Terminal can take a job out of user review')
        }
        set.review = r.review
        set.reviewer_id = r.reviewerId
      }
      if (patch.estimateMinutes !== undefined) {
        const estimate = patch.estimateMinutes == null ? null : int(patch.estimateMinutes, 'Estimate', 1, 100_000)
        set.estimate_minutes = estimate
        if (estimate != null && estimate >= this.settings().longJobEstimateMinutes && c.kind !== 'user' && job.state === 'todo') {
          Object.assign(set, { state: 'held', review: 'user', reviewer_id: null, escalation: LONG_START })
        }
      }
      this.write(id, set)
      const next = this.row(id)!
      this.notify(c, next, 'edited', `${this.name(next)} edited by ${c.label}`)
      if (next.state === 'held' && job.state !== 'held') {
        this.notify(c, next, 'held', `${this.name(next)} is held: ${LONG_START} (estimate ${next.estimateMinutes} min)`, [
          { kind: 'user' },
          { kind: 'master' },
        ])
      }
      return next
    })
  }

  // Dashboard only.
  delete(actor: JobActor, id: number): void {
    this.run(() => {
      const c = this.caller(actor)
      if (c.kind !== 'user') throw new JobError('FORBIDDEN', 'Only the user can delete jobs')
      const job = this.jobFor(c, id)
      const dependents = this.dependents(id)
      this.db.prepare('DELETE FROM jobs WHERE id = ?').run(id)
      const to = job.assigneeId != null && job.state !== 'done' && this.isLive(job.assigneeId) ? [this.op(job.assigneeId)] : []
      this.notify(c, job, 'deleted', `${this.name(job)} deleted by the user`, to)
      this.unblockNotices(c, dependents, job)
    })
  }

  // Dependencies

  addDep(actor: JobActor, jobId: number, dependsOnId: number): JobRecord {
    return this.run(() => {
      const c = this.caller(actor)
      const job = this.jobFor(c, jobId)
      this.assertCanEdit(c, job)
      const dep = this.row(dependsOnId)
      if (!dep || dep.crewId !== job.crewId) throw new JobError('NOT_FOUND', `Job ${dependsOnId} not found`)
      if (jobId === dependsOnId) throw new JobError('BAD_ARGS', 'A job cannot depend on itself')
      const cycle = this.db
        .prepare(
          `WITH RECURSIVE up(id) AS (
             SELECT depends_on_id FROM job_deps WHERE job_id = ?
             UNION SELECT d.depends_on_id FROM job_deps d JOIN up ON d.job_id = up.id
           ) SELECT 1 FROM up WHERE id = ?`,
        )
        .get(dependsOnId, jobId)
      if (cycle) throw new JobError('CONFLICT', `Job ${jobId} cannot wait for job ${dependsOnId}: that would make a cycle`)
      this.db.prepare('INSERT OR IGNORE INTO job_deps (job_id, depends_on_id) VALUES (?, ?)').run(jobId, dependsOnId)
      const next = this.row(jobId)!
      this.notify(c, next, 'deps', `${this.name(next)} now waits for job ${dependsOnId}`)
      return next
    })
  }

  removeDep(actor: JobActor, jobId: number, dependsOnId: number): JobRecord {
    return this.run(() => {
      const c = this.caller(actor)
      const job = this.jobFor(c, jobId)
      this.assertCanEdit(c, job)
      const res = this.db.prepare('DELETE FROM job_deps WHERE job_id = ? AND depends_on_id = ?').run(jobId, dependsOnId)
      if (Number(res.changes) === 0) throw new JobError('NOT_FOUND', `Job ${jobId} does not wait for job ${dependsOnId}`)
      const next = this.row(jobId)!
      this.notify(c, next, 'deps', `${this.name(next)} no longer waits for job ${dependsOnId}`)
      if (job.blocked && !next.blocked && next.state === 'todo') this.unblockNotice(c, next, `job ${dependsOnId} removed`)
      return next
    })
  }

  // Work

  // Claims `jobId`, or the next claimable job of the caller's crew by priority (highest first), then id.
  claim(actor: JobActor, jobId?: number): JobRecord {
    return this.run(() => {
      const c = this.caller(actor)
      if (c.id == null) throw new JobError('FORBIDDEN', 'The user does not claim jobs; use an override')
      const t = this.now()
      const target = jobId ?? null
      const row = this.db
        .prepare(CLAIM_SQL)
        .get(c.id, t + this.leaseMs(), t, t, c.crewId, c.id, target, target) as Row | undefined
      if (!row) throw this.claimFailure(c, target)
      const job = this.row(Number(row.id))!
      this.notify(c, job, 'claimed', `${this.name(job)} claimed by ${c.label}`)
      return job
    })
  }

  release(actor: JobActor, id: number, note?: string): JobRecord {
    return this.run(() => {
      const c = this.caller(actor)
      const job = this.holderJob(c, id)
      const set: Record<string, SQLInputValue> = { state: 'todo', assignee_id: null, lease_until: null }
      if (note !== undefined) set.note = text(note, 'Note', TEXT_MAX, false)
      this.write(id, set)
      this.setPreassigned(id, false)
      const next = this.row(id)!
      const pm = this.store.getCrew(job.crewId)?.pmId
      this.notify(c, next, 'released', `${this.name(next)} released by ${c.label}`, pm != null && pm !== c.id ? [this.op(pm)] : [])
      return next
    })
  }

  handoff(actor: JobActor, id: number, toOperatorId: number, note?: string): JobRecord {
    return this.run(() => {
      const c = this.caller(actor)
      const job = this.holderJob(c, id)
      this.assertMember(job.crewId, toOperatorId, 'Handoff target')
      if (toOperatorId === c.id) throw new JobError('BAD_ARGS', 'Hand the job to another operator')
      const set: Record<string, SQLInputValue> = { state: 'todo', assignee_id: toOperatorId, lease_until: null }
      if (note !== undefined) set.note = text(note, 'Note', TEXT_MAX, false)
      this.write(id, set)
      this.setPreassigned(id, true)
      const next = this.row(id)!
      this.notify(c, next, 'handoff', `${this.name(next)} handed off by ${c.label} to ${this.label(toOperatorId)}`, [this.op(toOperatorId)])
      return next
    })
  }

  // The holder finishes: straight to done with no review, else to review (and to the user once it ran long).
  done(actor: JobActor, id: number, note?: string): JobRecord {
    return this.run(() => {
      const c = this.caller(actor)
      const job = this.holderJob(c, id)
      const set: Record<string, SQLInputValue> = { lease_until: null }
      if (note !== undefined) set.note = text(note, 'Note', TEXT_MAX, false)
      let review = job.review
      if (review !== 'user' && this.ranLong(job, this.now())) {
        review = 'user'
        Object.assign(set, { review, escalation: this.elapsedText() })
      }
      set.state = review === 'none' ? 'done' : 'review'
      this.write(id, set)
      const next = this.row(id)!
      if (next.state === 'done') {
        this.notify(c, next, 'done', `${this.name(next)} done by ${c.label}`)
        this.unblockNotices(c, this.dependents(id), next)
      } else {
        this.notify(c, next, 'review', `${this.name(next)} is ready for review (${next.review})`, this.reviewersOf(next))
      }
      return next
    })
  }

  // Review

  approve(actor: JobActor, id: number, note?: string): JobRecord {
    return this.run(() => {
      const c = this.caller(actor)
      const job = this.jobFor(c, id)
      this.assertCanReview(c, job)
      if (job.state !== 'review') throw new JobError('CONFLICT', `Job ${id} is ${job.state}, not in review`)
      const set: Record<string, SQLInputValue> = { state: 'done', lease_until: null }
      if (note !== undefined) set.note = text(note, 'Note', TEXT_MAX, false)
      this.write(id, set)
      const next = this.row(id)!
      this.notify(c, next, 'approved', `${this.name(next)} approved by ${c.label}`, this.assigneeTo(next))
      this.unblockNotices(c, this.dependents(id), next)
      return next
    })
  }

  // Back to `doing` with the reason in the note. Past `maxRejects` the PM decides, or it is held for the
  // user when it was in user review, the PM was the reviewer or there is none. The user's own rejects
  // are never capped.
  reject(actor: JobActor, id: number, reason: string): JobRecord {
    return this.run(() => {
      const c = this.caller(actor)
      const job = this.jobFor(c, id)
      this.assertCanReview(c, job)
      if (job.state !== 'review') throw new JobError('CONFLICT', `Job ${id} is ${job.state}, not in review`)
      const why = text(reason, 'Reason', TEXT_MAX, true)
      const rejects = job.rejects + 1
      const set: Record<string, SQLInputValue> = { rejects, note: why }
      const pm = this.store.getCrew(job.crewId)?.pmId ?? null
      if (c.kind !== 'user' && rejects > this.settings().maxRejects) {
        if (job.review !== 'pm' && job.review !== 'user' && pm != null && pm !== job.assigneeId) {
          this.write(id, { ...set, review: 'pm' })
          const next = this.row(id)!
          this.notify(c, next, 'to-pm', `${this.name(next)} rejected ${rejects} times; the PM decides`, [this.op(pm)])
          return next
        }
        this.write(id, { ...set, state: 'held', lease_until: null, escalation: `rejected ${rejects} times` })
        const next = this.row(id)!
        this.notify(c, next, 'held', `${this.name(next)} is held: rejected ${rejects} times`, [{ kind: 'user' }, { kind: 'master' }])
        return next
      }
      const holder = job.assigneeId != null && this.isLive(job.assigneeId)
      this.write(id, {
        ...set,
        state: holder ? 'doing' : 'todo',
        assignee_id: holder ? job.assigneeId : null,
        lease_until: holder ? this.now() + this.leaseMs() : null,
      })
      if (!holder) this.setPreassigned(id, false)
      const next = this.row(id)!
      this.notify(c, next, 'rejected', `${this.name(next)} rejected by ${c.label}: ${why}`, this.assigneeTo(next))
      return next
    })
  }

  // Sends a job to the user's review with a reason. PM, master or user.
  escalate(actor: JobActor, id: number, reason: string): JobRecord {
    return this.run(() => {
      const c = this.caller(actor)
      const job = this.jobFor(c, id)
      const crew = this.store.getCrew(job.crewId)!
      if (c.kind === 'operator' && !this.isPm(c, crew)) throw new JobError('FORBIDDEN', 'Only the PM, the Master Terminal or the user can escalate')
      if (job.state === 'done') throw new JobError('CONFLICT', `Job ${id} is already done`)
      const why = text(reason, 'Reason', TEXT_MAX, true)
      this.write(id, { review: 'user', escalation: why })
      const next = this.row(id)!
      this.notify(c, next, 'escalated', `${this.name(next)} escalated by ${c.label}: ${why}`, [{ kind: 'user' }, { kind: 'master' }])
      return next
    })
  }

  // Approve-to-start: a held job goes back to `todo`. The user's call only.
  approveStart(actor: JobActor, id: number): JobRecord {
    return this.run(() => {
      const c = this.caller(actor)
      if (c.kind !== 'user') throw new JobError('FORBIDDEN', 'Only the user can approve a held job to start')
      const job = this.jobFor(c, id)
      if (job.state !== 'held') throw new JobError('CONFLICT', `Job ${id} is ${job.state}, not held`)
      this.write(id, { state: 'todo', escalation: '', rejects: 0, lease_until: null })
      const next = this.row(id)!
      this.notify(c, next, 'started', `${this.name(next)} approved to start by the user`, this.assigneeTo(next))
      return next
    })
  }

  // Assigning: PM (open jobs), master, user. A job being worked on goes back to `todo` for the new assignee.
  reassign(actor: JobActor, id: number, assigneeId: number | null): JobRecord {
    return this.run(() => {
      const c = this.caller(actor)
      const job = this.jobFor(c, id)
      const crew = this.store.getCrew(job.crewId)!
      if (c.kind === 'operator' && !this.isPm(c, crew)) throw new JobError('FORBIDDEN', 'Only the PM, the Master Terminal or the user can reassign jobs')
      if (job.state === 'done' && c.kind !== 'user') throw new JobError('CONFLICT', `Job ${id} is already done`)
      if (job.state === 'review' && c.kind !== 'user') throw new JobError('CONFLICT', `Job ${id} is in review; only the user can reassign it`)
      if (assigneeId != null) this.assertMember(job.crewId, assigneeId, 'Assignee')
      const set: Record<string, SQLInputValue> = { assignee_id: assigneeId }
      if (job.state === 'doing' && assigneeId !== job.assigneeId) Object.assign(set, { state: 'todo', lease_until: null })
      this.write(id, set)
      this.setPreassigned(id, assigneeId != null)
      const next = this.row(id)!
      const to: NoticeTo[] = assigneeId != null ? [this.op(assigneeId)] : []
      if (job.assigneeId != null && job.assigneeId !== assigneeId && this.isLive(job.assigneeId)) to.push(this.op(job.assigneeId))
      this.notify(c, next, 'reassigned', `${this.name(next)} assigned to ${assigneeId == null ? 'nobody' : this.label(assigneeId)} by ${c.label}`, to)
      return next
    })
  }

  // The user moves any job to any state and/or assignee.
  override(actor: JobActor, id: number, patch: JobOverride): JobRecord {
    return this.run(() => {
      const c = this.caller(actor)
      if (c.kind !== 'user') throw new JobError('FORBIDDEN', 'Only the user can override a job')
      const job = this.jobFor(c, id)
      const state = patch.state ?? job.state
      if (!STATES.includes(state)) throw new JobError('BAD_ARGS', `Unknown state "${String(state)}"`)
      const assignee = patch.assigneeId !== undefined ? patch.assigneeId : job.assigneeId
      if (patch.assigneeId != null) this.assertMember(job.crewId, patch.assigneeId, 'Assignee')
      if (state === 'doing' && assignee == null) throw new JobError('BAD_ARGS', 'A job being worked on needs an assignee')
      const t = this.now()
      const set: Record<string, SQLInputValue> = {
        state,
        assignee_id: assignee,
        lease_until: state === 'doing' ? (job.state === 'doing' && assignee === job.assigneeId ? job.leaseUntil : t + this.leaseMs()) : null,
        started_at: state === 'doing' ? (job.startedAt ?? t) : job.startedAt,
      }
      if (job.state === 'held' && state !== 'held') set.escalation = ''
      this.write(id, set)
      if (patch.assigneeId !== undefined) this.setPreassigned(id, assignee != null)
      const next = this.row(id)!
      const to = assignee !== job.assigneeId && assignee != null ? [this.op(assignee)] : []
      this.notify(c, next, 'override', `${this.name(next)} set to ${state}${assignee != null ? ` for ${this.label(assignee)}` : ''} by the user`, to)
      if (state === 'done' && job.state !== 'done') this.unblockNotices(c, this.dependents(id), next)
      return next
    })
  }

  // Leases

  // Renews every lease the operator holds; called on each of its CLI calls. Returns how many.
  touch(operatorId: number): number {
    try {
      const res = this.db
        .prepare(
          `UPDATE jobs SET lease_until = ? WHERE assignee_id = ? AND state = 'doing'
             AND EXISTS (SELECT 1 FROM operators WHERE id = ? AND deleted_at IS NULL)`,
        )
        .run(this.now() + this.leaseMs(), operatorId, operatorId)
      return Number(res.changes)
    } catch (err) {
      throw busyError(err) ?? err
    }
  }

  // Run every 30 s: expired leases go back to `todo` (a pre-assigned job keeps its live assignee), and
  // `doing` jobs running past the long-job threshold go to the user's review.
  sweep(): SweepResult {
    return this.run(() => {
      const t = this.now()
      const system: Caller = { kind: 'user', id: null, crewId: null, label: 'Operant' }
      const expired = (
        this.db.prepare(`${RECORD_SELECT} WHERE j.state = 'doing' AND j.lease_until IS NOT NULL AND j.lease_until < ? ORDER BY j.id`).all(t) as Row[]
      ).map((r) => {
        const job = toRecord(r)
        const keep = job.preassignedId != null && job.assigneeId != null && this.isLive(job.assigneeId)
        this.write(job.id, { state: 'todo', lease_until: null, assignee_id: keep ? job.assigneeId : null })
        if (!keep) this.setPreassigned(job.id, false)
        const next = this.row(job.id)!
        const to = job.assigneeId != null && this.isLive(job.assigneeId) ? [this.op(job.assigneeId)] : []
        this.notify(system, next, 'expired', `${this.name(next)}: the lease of ${this.label(job.assigneeId)} expired; back to todo`, to)
        return next
      })
      const escalated = (
        this.db
          .prepare(`${RECORD_SELECT} WHERE j.state = 'doing' AND j.review <> 'user' AND j.started_at IS NOT NULL AND j.started_at <= ? ORDER BY j.id`)
          .all(t - this.settings().longJobElapsedMinutes * MINUTE) as Row[]
      ).map((r) => {
        const job = toRecord(r)
        this.write(job.id, { review: 'user', escalation: this.elapsedText() })
        const next = this.row(job.id)!
        const pm = this.store.getCrew(job.crewId)?.pmId
        const to: NoticeTo[] = pm != null && pm !== job.assigneeId ? [this.op(pm), { kind: 'master' }] : [{ kind: 'master' }]
        this.notify(system, next, 'escalated', `${this.name(next)}: ${this.elapsedText()}; it will go to the user for review`, to)
        return next
      })
      return { expired, escalated }
    })
  }

  // Session exit (`onExit`, not during a restart): its `doing` jobs go back to `todo`, pre-assigned ones
  // keeping it as assignee. Operator delete (`onExit: false`): every job it holds is unassigned and the
  // reviews it held move to the PM, or to the user.
  releaseOperatorJobs(operatorId: number, opts: { onExit: boolean }): JobRecord[] {
    return this.run(() => {
      const crewId = this.store.crewIdOfOperator(operatorId, true)
      if (crewId == null) return []
      const system: Caller = { kind: 'user', id: null, crewId: null, label: 'Operant' }
      const who = this.label(operatorId)
      const states = opts.onExit ? "('doing')" : "('doing', 'todo')"
      const released = (
        this.db.prepare(`${RECORD_SELECT} WHERE j.assignee_id = ? AND j.state IN ${states} ORDER BY j.id`).all(operatorId) as Row[]
      ).map((r) => {
        const job = toRecord(r)
        const keep = opts.onExit && job.preassignedId != null
        this.write(job.id, { state: 'todo', lease_until: null, assignee_id: keep ? operatorId : null })
        if (!keep) this.setPreassigned(job.id, false)
        const next = this.row(job.id)!
        this.notify(system, next, 'released', `${this.name(next)} released: ${who} ${opts.onExit ? 'exited' : 'was deleted'}`)
        return next
      })
      if (!opts.onExit) {
        // Works before or after store.deleteOperator, which clears crews.pm_id for a deleted PM.
        const crew = this.store.getCrew(crewId)!
        const pm = crew.pmId != null && crew.pmId !== operatorId && this.isLive(crew.pmId) ? crew.pmId : null
        const moved = this.db
          .prepare(`UPDATE jobs SET review = ?, reviewer_id = NULL, updated_at = ? WHERE review = 'operator' AND reviewer_id = ? AND state <> 'done' RETURNING id`)
          .all(pm != null ? 'pm' : 'user', this.now(), operatorId) as Row[]
        if (pm == null) {
          moved.push(
            ...(this.db
              .prepare(`UPDATE jobs SET review = 'user', updated_at = ? WHERE crew_id = ? AND review = 'pm' AND state = 'review' RETURNING id`)
              .all(this.now(), crewId) as Row[]),
          )
        }
        for (const r of moved) {
          const next = this.row(Number(r.id))!
          const to = next.state === 'review' ? this.reviewersOf(next) : []
          this.notify(system, next, 'review', `${this.name(next)}: reviewer ${who} was deleted; review moves to ${next.review === 'pm' ? 'the PM' : 'the user'}`, to)
        }
      }
      return released
    })
  }

  // Internals

  // Only the outermost engine call commits and emits. Inside a caller's own transaction the change runs
  // in a savepoint and its notices are emitted when the savepoint is released.
  private run<T>(fn: () => T): T {
    if (this.depth > 0) return fn()
    const foreign = this.db.isTransaction
    try {
      this.db.exec(foreign ? 'SAVEPOINT job_engine' : 'BEGIN IMMEDIATE')
    } catch (err) {
      throw busyError(err) ?? err
    }
    let result: T
    this.depth++
    try {
      result = fn()
      this.db.exec(foreign ? 'RELEASE job_engine' : 'COMMIT')
    } catch (err) {
      if (foreign) this.db.exec('ROLLBACK TO job_engine; RELEASE job_engine')
      else if (this.db.isTransaction) this.db.exec('ROLLBACK')
      this.pending = []
      throw busyError(err) ?? err
    } finally {
      this.depth--
    }
    const out = this.pending
    this.pending = []
    for (const n of out) {
      try {
        this.emit(n)
      } catch {
        // The change is committed; a failing sink must not turn it into an error or drop later notices.
      }
    }
    return result
  }

  private caller(actor: JobActor): Caller {
    if (actor.kind === 'user') return { kind: 'user', id: null, crewId: null, label: 'the user' }
    const op = this.store.getOperator(actor.id)
    if (!op) throw new JobError('FORBIDDEN', `Operator ${actor.id} is not a live operator`)
    if ((op.kind === 'master') !== (actor.kind === 'master')) throw new JobError('FORBIDDEN', `Operator ${actor.id} is not a ${actor.kind}`)
    return { kind: actor.kind, id: op.id, crewId: this.store.crewIdOfOperator(op.id), label: this.label(op.id) }
  }

  private crewFor(c: Caller, crewId: number): Crew {
    const crew = this.store.getCrew(crewId)
    if (!crew || (c.kind !== 'user' && c.crewId !== crewId)) throw new JobError('NOT_FOUND', `Project ${crewId} not found`)
    return crew
  }

  private jobFor(c: Caller, id: number): JobRecord {
    const job = this.row(id)
    if (!job || (c.kind !== 'user' && c.crewId !== job.crewId)) throw new JobError('NOT_FOUND', `Job ${id} not found`)
    return job
  }

  // The caller must hold the job and be working on it.
  private holderJob(c: Caller, id: number): JobRecord {
    const job = this.jobFor(c, id)
    if (c.id == null || job.assigneeId !== c.id) throw new JobError('FORBIDDEN', `Job ${id} is not yours`)
    if (job.state !== 'doing') throw new JobError('CONFLICT', `Job ${id} is ${job.state}, not doing`)
    return job
  }

  private isPm(c: Caller, crew: Crew): boolean {
    return c.kind === 'operator' && c.id != null && crew.pmId === c.id
  }

  private assertCanEdit(c: Caller, job: JobRecord): void {
    if (c.kind === 'user') return
    if ((c.kind === 'master' || this.isPm(c, this.store.getCrew(job.crewId)!)) && job.state !== 'done') return
    if (job.createdBy === c.id && job.state === 'todo') return
    throw new JobError('FORBIDDEN', `You cannot edit job ${job.id}`)
  }

  // The assignee never approves its own job, not even as PM or master; the user always can. In review
  // the assignee is whoever finished the work: `done` requires the holder and only the user may
  // reassign a job in review.
  private assertCanReview(c: Caller, job: JobRecord): void {
    if (c.kind === 'user') return
    if (job.assigneeId != null && job.assigneeId === c.id) throw new JobError('FORBIDDEN', 'You cannot review your own job')
    if (c.kind === 'master') return
    const crew = this.store.getCrew(job.crewId)!
    if (job.review === 'pm' && this.isPm(c, crew)) return
    if (job.review === 'operator' && job.reviewerId === c.id) return
    throw new JobError('FORBIDDEN', `You are not the reviewer of job ${job.id}`)
  }

  private assertMember(crewId: number, operatorId: number, what: string): void {
    if (!Number.isInteger(operatorId) || this.store.crewIdOfOperator(operatorId) !== crewId) {
      throw new JobError('BAD_ARGS', `${what} must be a live operator of this project`)
    }
  }

  // Review defaults to the PM when the crew has one; naming a reviewer means `operator` review.
  private reviewFor(crew: Crew, review: JobReview | undefined, reviewerId: number | null | undefined): { review: JobReview; reviewerId: number | null } {
    const mode = review ?? (reviewerId != null ? 'operator' : crew.pmId != null ? 'pm' : 'none')
    if (!REVIEWS.includes(mode)) throw new JobError('BAD_ARGS', `Unknown review mode "${String(mode)}"`)
    if (mode === 'operator') {
      if (reviewerId == null) throw new JobError('BAD_ARGS', 'Operator review needs a reviewer')
      this.assertMember(crew.id, reviewerId, 'Reviewer')
      return { review: mode, reviewerId }
    }
    if (mode === 'pm' && crew.pmId == null) throw new JobError('BAD_ARGS', 'This project has no PM')
    return { review: mode, reviewerId: null }
  }

  private reviewersOf(job: JobRecord): NoticeTo[] {
    const fallback: NoticeTo[] = [{ kind: 'user' }, { kind: 'master' }]
    if (job.review === 'pm') {
      const pm = this.store.getCrew(job.crewId)?.pmId
      return pm != null && pm !== job.assigneeId ? [this.op(pm)] : fallback
    }
    if (job.review === 'operator') {
      return job.reviewerId != null && job.reviewerId !== job.assigneeId && this.isLive(job.reviewerId) ? [this.op(job.reviewerId)] : fallback
    }
    return job.review === 'user' ? fallback : []
  }

  private claimFailure(c: Caller, jobId: number | null): JobError {
    if (jobId == null) return new JobError('NOT_FOUND', 'Nothing to claim')
    const job = this.jobFor(c, jobId)
    if (job.state !== 'todo') return new JobError('CONFLICT', `Job ${jobId} is ${job.state}`)
    if (job.assigneeId != null && job.assigneeId !== c.id) return new JobError('CONFLICT', `Job ${jobId} is assigned to ${this.label(job.assigneeId)}`)
    if (job.blocked) {
      const open = job.deps.filter((d) => this.row(d)?.state !== 'done')
      return new JobError('CONFLICT', `Job ${jobId} is waiting for job${open.length === 1 ? '' : 's'} ${open.join(', ')}`)
    }
    return new JobError('CONFLICT', `Job ${jobId} could not be claimed`)
  }

  private ranLong(job: JobRecord, t: number): boolean {
    return job.startedAt != null && t - job.startedAt >= this.settings().longJobElapsedMinutes * MINUTE
  }

  private elapsedText(): string {
    return `long job: running over ${this.settings().longJobElapsedMinutes} min`
  }

  private dependents(id: number): number[] {
    return (this.db.prepare('SELECT job_id FROM job_deps WHERE depends_on_id = ?').all(id) as Row[]).map((r) => Number(r.job_id))
  }

  private unblockNotices(c: Caller, dependents: number[], cause: Job): void {
    for (const d of dependents) {
      const job = this.row(d)
      if (job && job.state === 'todo' && !job.blocked) this.unblockNotice(c, job, `job ${cause.id} ${this.row(cause.id) ? 'done' : 'deleted'}`)
    }
  }

  private unblockNotice(c: Caller, job: JobRecord, why: string): void {
    const pm = this.store.getCrew(job.crewId)?.pmId
    const target = job.assigneeId != null && this.isLive(job.assigneeId) ? job.assigneeId : (pm ?? null)
    this.notify(c, job, 'unblocked', `${this.name(job)} is unblocked (${why})`, target != null ? [this.op(target)] : [])
  }

  private assigneeTo(job: JobRecord): NoticeTo[] {
    return job.assigneeId != null && this.isLive(job.assigneeId) ? [this.op(job.assigneeId)] : []
  }

  private row(id: number): JobRecord | null {
    const r = this.db.prepare(`${RECORD_SELECT} WHERE j.id = ?`).get(id) as Row | undefined
    return r ? toRecord(r) : null
  }

  private write(id: number, set: Record<string, SQLInputValue>): void {
    const keys = Object.keys(set)
    this.db
      .prepare(`UPDATE jobs SET ${[...keys.map((k) => `${k} = ?`), 'updated_at = ?'].join(', ')} WHERE id = ?`)
      .run(...keys.map((k) => set[k]!), this.now(), id)
  }

  private setPreassigned(id: number, on: boolean): void {
    this.db.prepare(`UPDATE jobs SET preassigned_id = ${on ? 'assignee_id' : 'NULL'} WHERE id = ?`).run(id)
  }

  private isLive(operatorId: number): boolean {
    return this.store.getOperator(operatorId) != null
  }

  private leaseMs(): number {
    return this.settings().leaseMinutes * MINUTE
  }

  private label(operatorId: number | null): string {
    return operatorId == null ? 'nobody' : (this.store.operatorAddress(operatorId, true) ?? `operator ${operatorId}`)
  }

  private name(job: Job): string {
    return `job ${job.id} "${job.title}"`
  }

  private op(id: number): NoticeTo {
    return { kind: 'operator', id }
  }

  private notify(c: Caller, job: Job, kind: JobNoticeKind, text: string, to: NoticeTo[] = []): void {
    this.pending.push({ kind, crewId: job.crewId, jobId: job.id, actorId: c.id, by: c.label, text, to })
  }
}
