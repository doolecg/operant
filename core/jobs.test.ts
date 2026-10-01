import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_JOB_SETTINGS, JobEngine, JobError, type JobActor, type JobNotice, type JobSettings } from './jobs'
import { Store } from './store'

const MIN = 60_000
const USER: JobActor = { kind: 'user' }
const op = (id: number): JobActor => ({ kind: 'operator', id })

// The error code a call throws, or 'ok'.
function code(fn: () => unknown): string {
  try {
    fn()
    return 'ok'
  } catch (err) {
    if (err instanceof JobError) return err.code
    throw err
  }
}

describe('JobEngine', () => {
  let clock: number
  let settings: JobSettings
  let notices: JobNotice[]
  let store: Store
  let jobs: JobEngine
  let crewId: number
  let pm: number
  let a: number
  let b: number
  let rev: number
  let M: JobActor

  const engine = (s: Store) => new JobEngine(s, () => clock, () => settings, (n) => notices.push(n))
  const noticesOf = (kind: JobNotice['kind']) => notices.filter((n) => n.kind === kind)
  // A job `a` has claimed (review none unless given).
  const claimed = (review: 'none' | 'pm' = 'none', by = a) => {
    const j = jobs.create(USER, { crewId, title: 't', review, for: by })
    return jobs.claim(op(by), j.id)
  }

  beforeEach(() => {
    clock = 1_000_000
    settings = { ...DEFAULT_JOB_SETTINGS }
    notices = []
    store = new Store(':memory:', () => clock)
    jobs = engine(store)
    const crew = store.createCrew('shop', '/code/shop')
    crewId = crew.id
    const squad = store.createSquad(crewId, 'dev')
    pm = store.createOperator(squad.id, 'pm', 'claude', 'sonnet').id
    a = store.createOperator(squad.id, 'builder', 'claude', 'sonnet').id
    b = store.createOperator(squad.id, 'fixer', 'claude', 'sonnet').id
    rev = store.createOperator(squad.id, 'reviewer', 'claude', 'sonnet').id
    store.updateCrew(crewId, { pmId: pm })
    M = { kind: 'master', id: store.ensureMaster(crewId).id }
  })
  afterEach(() => store.close())

  describe('claim', () => {
    it('lets exactly one of two claims on the same job win', () => {
      const j = jobs.create(op(a), { crewId, title: 'one' })
      const won = jobs.claim(op(a), j.id)
      expect(won).toMatchObject({ state: 'doing', assigneeId: a, leaseUntil: clock + 60 * MIN, startedAt: clock })
      expect(code(() => jobs.claim(op(b), j.id))).toBe('CONFLICT')
      expect(code(() => jobs.claim(op(b)))).toBe('NOT_FOUND')
      expect(jobs.get(USER, j.id).assigneeId).toBe(a)
    })

    it('lets exactly one win across two engines on one database file', () => {
      const dir = mkdtempSync(join(tmpdir(), 'operant-jobs-'))
      const file = join(dir, 'operant.db')
      const s1 = new Store(file, () => clock)
      const crew = s1.createCrew('race', '/r')
      const squad = s1.createSquad(crew.id, 'dev')
      const x = s1.createOperator(squad.id, 'x', 'claude', 'm').id
      const y = s1.createOperator(squad.id, 'y', 'claude', 'm').id
      const s2 = new Store(file, () => clock)
      try {
        const e1 = engine(s1)
        const e2 = engine(s2)
        const j = e1.create(USER, { crewId: crew.id, title: 'contested', review: 'none' })
        const results = [() => e1.claim(op(x)), () => e2.claim(op(y))].map(code)
        expect(results.sort()).toEqual(['NOT_FOUND', 'ok'])
        expect(e2.get(USER, j.id)).toMatchObject({ state: 'doing', assigneeId: x })
        expect(code(() => e2.claim(op(y), j.id))).toBe('CONFLICT')
      } finally {
        s1.close()
        s2.close()
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('turns a write lock held by another connection into CONFLICT', () => {
      const dir = mkdtempSync(join(tmpdir(), 'operant-busy-'))
      const file = join(dir, 'operant.db')
      const s1 = new Store(file, () => clock)
      const crew = s1.createCrew('busy', '/b')
      const squad = s1.createSquad(crew.id, 'dev')
      const x = s1.createOperator(squad.id, 'x', 'claude', 'm').id
      const s2 = new Store(file, () => clock)
      try {
        expect(s1.db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 })
        s2.db.exec('PRAGMA busy_timeout = 0')
        const e2 = engine(s2)
        const j = e2.create(USER, { crewId: crew.id, title: 'locked', review: 'none' })
        s1.db.exec('BEGIN IMMEDIATE')
        expect(code(() => e2.claim(op(x), j.id))).toBe('CONFLICT')
        expect(code(() => e2.create(USER, { crewId: crew.id, title: 'more' }))).toBe('CONFLICT')
        expect(code(() => e2.touch(x))).toBe('CONFLICT')
        s1.db.exec('ROLLBACK')
        expect(e2.claim(op(x), j.id).state).toBe('doing')
      } finally {
        s1.close()
        s2.close()
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('takes the next job by priority, then id, and keeps started_at on a second claim', () => {
      const low = jobs.create(USER, { crewId, title: 'low' })
      const high = jobs.create(USER, { crewId, title: 'high', priority: 5 })
      const low2 = jobs.create(USER, { crewId, title: 'low2' })
      expect(jobs.claim(op(a)).id).toBe(high.id)
      expect(jobs.claim(op(a)).id).toBe(low.id)
      jobs.release(op(a), low.id)
      clock += MIN
      expect(jobs.claim(op(b)).id).toBe(low.id)
      expect(jobs.get(USER, low.id).startedAt).toBe(clock - MIN)
      expect(jobs.claim(op(b)).id).toBe(low2.id)
    })

    it('reserves a pre-assigned job for its operator', () => {
      const j = jobs.create(op(pm), { crewId, title: 'for b', for: b })
      expect(j.preassignedId).toBe(b)
      expect(code(() => jobs.claim(op(a)))).toBe('NOT_FOUND')
      expect(code(() => jobs.claim(op(a), j.id))).toBe('CONFLICT')
      expect(jobs.claim(op(b)).id).toBe(j.id)
      expect(noticesOf('created')[0]!.to).toEqual([{ kind: 'operator', id: b }])
    })

    it('lets a worker pre-assign only itself', () => {
      expect(code(() => jobs.create(op(a), { crewId, title: 'x', for: b }))).toBe('FORBIDDEN')
      expect(jobs.create(op(a), { crewId, title: 'x', for: a }).assigneeId).toBe(a)
      expect(code(() => jobs.create(op(a), { crewId, title: 'x', for: 999 }))).toBe('BAD_ARGS')
    })

    it('hands a job off to another operator, who then claims it', () => {
      const j = claimed()
      const h = jobs.handoff(op(a), j.id, b, 'half done')
      expect(h).toMatchObject({ state: 'todo', assigneeId: b, note: 'half done', leaseUntil: null, preassignedId: b })
      expect(noticesOf('handoff')[0]!.to).toEqual([{ kind: 'operator', id: b }])
      expect(code(() => jobs.claim(op(a), j.id))).toBe('CONFLICT')
      expect(jobs.claim(op(b), j.id).state).toBe('doing')
    })
  })

  describe('dependencies', () => {
    it('blocks a job until its dependency is done, then sends an unblock notice', () => {
      const first = jobs.create(USER, { crewId, title: 'first', review: 'none' })
      const second = jobs.create(USER, { crewId, title: 'second', deps: [first.id], for: b })
      expect(second).toMatchObject({ blocked: true, deps: [first.id] })
      expect(code(() => jobs.claim(op(b), second.id))).toBe('CONFLICT')
      expect(jobs.claim(op(a)).id).toBe(first.id)
      notices = []
      jobs.done(op(a), first.id, 'built')
      expect(jobs.get(USER, first.id).state).toBe('done')
      expect(noticesOf('unblocked')).toEqual([expect.objectContaining({ jobId: second.id, to: [{ kind: 'operator', id: b }] })])
      expect(jobs.claim(op(b), second.id).state).toBe('doing')
    })

    it('rejects cycles, self-dependencies and jobs of another crew', () => {
      const [j1, j2, j3] = ['1', '2', '3'].map((title) => jobs.create(USER, { crewId, title }))
      jobs.addDep(USER, j2!.id, j1!.id)
      jobs.addDep(USER, j3!.id, j2!.id)
      expect(code(() => jobs.addDep(USER, j1!.id, j3!.id))).toBe('CONFLICT')
      expect(code(() => jobs.addDep(USER, j1!.id, j1!.id))).toBe('BAD_ARGS')
      const other = store.createCrew('other', '/o')
      const foreign = jobs.create(USER, { crewId: other.id, title: 'f' })
      expect(code(() => jobs.addDep(USER, j1!.id, foreign.id))).toBe('NOT_FOUND')
      expect(code(() => jobs.create(USER, { crewId, title: 'x', deps: [foreign.id] }))).toBe('BAD_ARGS')
      expect(jobs.get(USER, j1!.id).deps).toEqual([])
      expect(code(() => jobs.removeDep(USER, j1!.id, j3!.id))).toBe('NOT_FOUND')
    })

    it('sends an unblock notice when the last open dependency is removed or deleted', () => {
      const d1 = jobs.create(USER, { crewId, title: 'd1' })
      const d2 = jobs.create(USER, { crewId, title: 'd2' })
      const j = jobs.create(USER, { crewId, title: 'j', deps: [d1.id, d2.id] })
      jobs.removeDep(USER, j.id, d1.id)
      expect(noticesOf('unblocked')).toEqual([])
      jobs.delete(USER, d2.id)
      expect(noticesOf('unblocked').map((n) => n.jobId)).toEqual([j.id])
      expect(jobs.get(USER, j.id).blocked).toBe(false)
    })
  })

  describe('leases', () => {
    it('expires a lease on sweep unless renewed', () => {
      const j = jobs.create(USER, { crewId, title: 'j' })
      jobs.claim(op(a), j.id)
      clock += 59 * MIN
      expect(jobs.touch(a)).toBe(1)
      clock += 30 * MIN
      expect(jobs.sweep().expired).toEqual([])
      clock += 31 * MIN
      const { expired } = jobs.sweep()
      expect(expired.map((x) => x.id)).toEqual([j.id])
      expect(jobs.get(USER, j.id)).toMatchObject({ state: 'todo', assigneeId: null, leaseUntil: null })
      expect(noticesOf('expired')[0]!.to).toEqual([{ kind: 'operator', id: a }])
    })

    it('keeps the assignee of a pre-assigned job when its lease expires', () => {
      const j = claimed()
      clock += 61 * MIN
      jobs.sweep()
      expect(jobs.get(USER, j.id)).toMatchObject({ state: 'todo', assigneeId: a, preassignedId: a })
    })

    it('uses the lease length from the live settings', () => {
      settings.leaseMinutes = 5
      const j = jobs.create(USER, { crewId, title: 'j' })
      expect(jobs.claim(op(a), j.id).leaseUntil).toBe(clock + 5 * MIN)
    })
  })

  describe('release on exit and delete', () => {
    it('returns doing jobs to todo on session exit, keeping pre-assigned ones', () => {
      const free = jobs.claim(op(a), jobs.create(USER, { crewId, title: 'free' }).id)
      const mine = claimed()
      const later = jobs.create(USER, { crewId, title: 'later', for: a })
      const released = jobs.releaseOperatorJobs(a, { onExit: true })
      expect(released.map((x) => x.id)).toEqual([free.id, mine.id])
      expect(jobs.get(USER, free.id)).toMatchObject({ state: 'todo', assigneeId: null })
      expect(jobs.get(USER, mine.id)).toMatchObject({ state: 'todo', assigneeId: a })
      expect(jobs.get(USER, later.id).assigneeId).toBe(a)
    })

    it('unassigns everything and moves held reviews when the operator is deleted', () => {
      const mine = claimed()
      const later = jobs.create(USER, { crewId, title: 'later', for: a })
      const reviewing = jobs.create(USER, { crewId, title: 'r', reviewerId: a, for: b })
      jobs.claim(op(b), reviewing.id)
      jobs.done(op(b), reviewing.id)
      store.deleteOperator(a)
      notices = []
      jobs.releaseOperatorJobs(a, { onExit: false })
      expect(jobs.get(USER, mine.id)).toMatchObject({ state: 'todo', assigneeId: null, preassignedId: null })
      expect(jobs.get(USER, later.id).assigneeId).toBeNull()
      expect(jobs.get(USER, reviewing.id)).toMatchObject({ review: 'pm', reviewerId: null })
      expect(noticesOf('review')[0]!.to).toEqual([{ kind: 'operator', id: pm }])
    })

    it.each(['release then delete', 'delete then release'])('moves PM reviews to the user when the PM is deleted (%s)', (order) => {
      const j = claimed('pm')
      jobs.done(op(a), j.id)
      const r = jobs.create(USER, { crewId, title: 'r', reviewerId: pm, for: b })
      jobs.claim(op(b), r.id)
      jobs.done(op(b), r.id)
      notices = []
      if (order === 'release then delete') {
        jobs.releaseOperatorJobs(pm, { onExit: false })
        store.deleteOperator(pm)
      } else {
        store.deleteOperator(pm)
        jobs.releaseOperatorJobs(pm, { onExit: false })
      }
      expect(jobs.get(USER, j.id)).toMatchObject({ state: 'review', review: 'user' })
      expect(jobs.get(USER, r.id)).toMatchObject({ state: 'review', review: 'user', reviewerId: null })
      expect(noticesOf('review').map((n) => [n.jobId, n.to])).toEqual([
        [r.id, [{ kind: 'user' }, { kind: 'master' }]],
        [j.id, [{ kind: 'user' }, { kind: 'master' }]],
      ])
    })
  })

  describe('review', () => {
    it('defaults to PM review when the crew has a PM, none otherwise', () => {
      expect(jobs.create(op(a), { crewId, title: 'x' }).review).toBe('pm')
      store.updateCrew(crewId, { pmId: null })
      expect(jobs.create(op(a), { crewId, title: 'x' }).review).toBe('none')
      expect(code(() => jobs.create(op(a), { crewId, title: 'x', review: 'pm' }))).toBe('BAD_ARGS')
      expect(code(() => jobs.create(op(a), { crewId, title: 'x', review: 'operator' }))).toBe('BAD_ARGS')
    })

    it('goes to review on done; only the PM approves a pm review, never the assignee', () => {
      const j = claimed('pm')
      notices = []
      expect(jobs.done(op(a), j.id, 'report')).toMatchObject({ state: 'review', leaseUntil: null, note: 'report' })
      expect(noticesOf('review')[0]!.to).toEqual([{ kind: 'operator', id: pm }])
      expect(code(() => jobs.approve(op(a), j.id))).toBe('FORBIDDEN')
      expect(code(() => jobs.approve(op(b), j.id))).toBe('FORBIDDEN')
      expect(code(() => jobs.approve(op(rev), j.id))).toBe('FORBIDDEN')
      expect(jobs.approve(op(pm), j.id).state).toBe('done')
      expect(noticesOf('approved')[0]!.to).toEqual([{ kind: 'operator', id: a }])
      expect(code(() => jobs.approve(op(pm), j.id))).toBe('CONFLICT')
    })

    it('lets only the named reviewer approve an operator review', () => {
      const j = jobs.create(USER, { crewId, title: 'x', reviewerId: rev, for: a })
      expect(j).toMatchObject({ review: 'operator', reviewerId: rev })
      jobs.claim(op(a), j.id)
      jobs.done(op(a), j.id)
      expect(code(() => jobs.approve(op(pm), j.id))).toBe('FORBIDDEN')
      expect(jobs.approve(op(rev), j.id).state).toBe('done')
    })

    it('forbids self-approval even for the PM and the master, but not the user', () => {
      const j = claimed('pm', pm)
      jobs.done(op(pm), j.id)
      expect(noticesOf('review').at(-1)!.to).toEqual([{ kind: 'user' }, { kind: 'master' }])
      expect(code(() => jobs.approve(op(pm), j.id))).toBe('FORBIDDEN')
      expect(jobs.approve(USER, j.id).state).toBe('done')

      const mj = jobs.create(M, { crewId, title: 'm', review: 'user' })
      jobs.claim(M, mj.id)
      jobs.done(M, mj.id)
      expect(code(() => jobs.approve(M, mj.id))).toBe('FORBIDDEN')
      expect(jobs.reject(USER, mj.id, 'no').state).toBe('doing')
    })

    it('closes the approve-own-work loophole: no reassigning a job in review except by the user', () => {
      const j = claimed('pm', pm)
      jobs.done(op(pm), j.id)
      expect(code(() => jobs.reassign(op(pm), j.id, b))).toBe('CONFLICT')
      expect(code(() => jobs.reassign(op(pm), j.id, null))).toBe('CONFLICT')
      expect(code(() => jobs.approve(op(pm), j.id))).toBe('FORBIDDEN')
      expect(jobs.get(USER, j.id).assigneeId).toBe(pm)

      const mj = jobs.create(M, { crewId, title: 'm', review: 'user' })
      jobs.claim(M, mj.id)
      jobs.done(M, mj.id)
      expect(code(() => jobs.reassign(M, mj.id, a))).toBe('CONFLICT')
      expect(code(() => jobs.approve(M, mj.id))).toBe('FORBIDDEN')
      expect(jobs.reassign(USER, mj.id, a).assigneeId).toBe(a)
    })

    it('finishes straight to done with no review', () => {
      const j = claimed('none')
      expect(jobs.done(op(a), j.id).state).toBe('done')
    })

    it('returns a rejected job to doing, then hands it to the PM, then holds it', () => {
      const j = jobs.create(USER, { crewId, title: 'x', reviewerId: rev, for: a })
      jobs.claim(op(a), j.id)
      jobs.done(op(a), j.id)
      expect(code(() => jobs.reject(op(rev), j.id, '  '))).toBe('BAD_ARGS')
      clock += MIN
      expect(jobs.reject(op(rev), j.id, 'tests fail')).toMatchObject({
        state: 'doing',
        rejects: 1,
        note: 'tests fail',
        assigneeId: a,
        leaseUntil: clock + 60 * MIN,
      })
      jobs.done(op(a), j.id)
      expect(jobs.reject(op(rev), j.id, 'still failing')).toMatchObject({ state: 'review', review: 'pm', rejects: 2 })
      expect(noticesOf('to-pm')[0]!.to).toEqual([{ kind: 'operator', id: pm }])
      expect(code(() => jobs.approve(op(rev), j.id))).toBe('FORBIDDEN')
      expect(jobs.reject(op(pm), j.id, 'no')).toMatchObject({ state: 'held', rejects: 3, escalation: 'rejected 3 times' })
      expect(noticesOf('held')[0]!.to).toEqual([{ kind: 'user' }, { kind: 'master' }])
    })

    it('holds a pm-reviewed job past the reject cap and honours maxRejects', () => {
      settings.maxRejects = 0
      const j = claimed('pm')
      jobs.done(op(a), j.id)
      expect(jobs.reject(op(pm), j.id, 'no').state).toBe('held')
    })

    it('holds a user-review job past the reject cap instead of handing it to the PM', () => {
      const j = claimed('pm')
      jobs.escalate(op(pm), j.id, 'risky')
      jobs.done(op(a), j.id)
      expect(jobs.reject(M, j.id, 'redo').state).toBe('doing')
      jobs.done(op(a), j.id)
      expect(jobs.reject(M, j.id, 'still wrong')).toMatchObject({ state: 'held', review: 'user', rejects: 2 })
      expect(noticesOf('to-pm')).toEqual([])
      expect(code(() => jobs.approve(op(pm), j.id))).toBe('FORBIDDEN')
    })

    it('never caps the user’s own rejects', () => {
      settings.maxRejects = 0
      const j = claimed('pm')
      jobs.done(op(a), j.id)
      expect(jobs.reject(USER, j.id, 'redo').state).toBe('doing')
    })

    it('escalates to the user: PM, master and user only', () => {
      const j = claimed('pm')
      expect(code(() => jobs.escalate(op(b), j.id, 'risky'))).toBe('FORBIDDEN')
      expect(code(() => jobs.escalate(op(pm), j.id, ''))).toBe('BAD_ARGS')
      expect(jobs.escalate(op(pm), j.id, 'touches billing')).toMatchObject({ review: 'user', escalation: 'touches billing', state: 'doing' })
      expect(noticesOf('escalated')[0]!.to).toEqual([{ kind: 'user' }, { kind: 'master' }])
      jobs.done(op(a), j.id)
      expect(code(() => jobs.approve(op(pm), j.id))).toBe('FORBIDDEN')
      expect(jobs.approve(M, j.id).state).toBe('done')
      expect(code(() => jobs.escalate(M, j.id, 'late'))).toBe('CONFLICT')
    })
  })

  describe('long jobs', () => {
    it('holds a job estimated at the threshold until the user approves its start', () => {
      expect(jobs.create(op(a), { crewId, title: 'short', estimateMinutes: 119 }).state).toBe('todo')
      const j = jobs.create(op(a), { crewId, title: 'big', estimateMinutes: 120 })
      expect(j).toMatchObject({ state: 'held', review: 'user', escalation: 'long job: approve to start', estimateMinutes: 120 })
      expect(noticesOf('held')[0]!.to).toEqual([{ kind: 'user' }, { kind: 'master' }])
      expect(code(() => jobs.claim(op(b)))).toBe('ok')
      expect(code(() => jobs.claim(op(b), j.id))).toBe('CONFLICT')
      for (const who of [op(a), op(pm), M]) expect(code(() => jobs.approveStart(who, j.id))).toBe('FORBIDDEN')
      expect(jobs.approveStart(USER, j.id)).toMatchObject({ state: 'todo', escalation: '', review: 'user' })
      expect(code(() => jobs.approveStart(USER, j.id))).toBe('CONFLICT')
      expect(jobs.claim(op(b), j.id).state).toBe('doing')
    })

    it('holds a todo job when a worker raises its estimate past the threshold', () => {
      const j = jobs.create(op(a), { crewId, title: 'x', estimateMinutes: 30 })
      expect(jobs.edit(op(a), j.id, { estimateMinutes: 200 })).toMatchObject({ state: 'held', review: 'user' })
      expect(jobs.edit(USER, jobs.create(USER, { crewId, title: 'y' }).id, { estimateMinutes: 500 }).state).toBe('todo')
    })

    it('sends a job running past the elapsed threshold to the user, once, while work continues', () => {
      settings.leaseMinutes = 1000
      const j = claimed('pm')
      clock += 239 * MIN
      expect(jobs.sweep().escalated).toEqual([])
      clock += MIN
      const { escalated } = jobs.sweep()
      expect(escalated.map((x) => x.id)).toEqual([j.id])
      expect(jobs.get(USER, j.id)).toMatchObject({ state: 'doing', review: 'user', escalation: 'long job: running over 240 min' })
      expect(noticesOf('escalated')[0]!.to).toEqual([{ kind: 'operator', id: pm }, { kind: 'master' }])
      expect(jobs.sweep().escalated).toEqual([])
      jobs.done(op(a), j.id)
      expect(code(() => jobs.approve(op(pm), j.id))).toBe('FORBIDDEN')
    })

    it('applies the elapsed rule at done time too', () => {
      settings.leaseMinutes = 1000
      const j = claimed('none')
      clock += 300 * MIN
      expect(jobs.done(op(a), j.id)).toMatchObject({ state: 'review', review: 'user' })
    })
  })

  describe('permissions', () => {
    it('denies every operator action on someone else’s job', () => {
      const j = claimed('pm')
      const theirs = jobs.create(op(a), { crewId, title: 'a todo' })
      const held = jobs.create(USER, { crewId, title: 'h', estimateMinutes: 999 })
      const checks: Array<() => unknown> = [
        () => jobs.release(op(b), j.id),
        () => jobs.handoff(op(b), j.id, b),
        () => jobs.done(op(b), j.id),
        () => jobs.edit(op(b), theirs.id, { title: 'mine now' }),
        () => jobs.addDep(op(b), theirs.id, j.id),
        () => jobs.removeDep(op(b), theirs.id, j.id),
        () => jobs.reassign(op(b), j.id, b),
        () => jobs.escalate(op(b), j.id, 'x'),
        () => jobs.override(op(b), j.id, { state: 'done' }),
        () => jobs.approveStart(op(b), held.id),
        () => jobs.delete(op(b), theirs.id),
      ]
      expect(checks.map(code)).toEqual(checks.map(() => 'FORBIDDEN'))
      jobs.done(op(a), j.id)
      expect(code(() => jobs.approve(op(b), j.id))).toBe('FORBIDDEN')
      expect(code(() => jobs.reject(op(b), j.id, 'x'))).toBe('FORBIDDEN')
    })

    it('lets a creator edit its job only while todo', () => {
      const j = jobs.create(op(a), { crewId, title: 'mine' })
      expect(jobs.edit(op(a), j.id, { title: 'renamed', priority: 3 })).toMatchObject({ title: 'renamed', priority: 3 })
      jobs.claim(op(a), j.id)
      expect(code(() => jobs.edit(op(a), j.id, { title: 'again' }))).toBe('FORBIDDEN')
      expect(jobs.edit(op(pm), j.id, { title: 'pm edit' }).title).toBe('pm edit')
      expect(code(() => jobs.edit(op(a), j.id, { title: '' }))).toBe('FORBIDDEN')
      expect(code(() => jobs.edit(USER, j.id, { title: '' }))).toBe('BAD_ARGS')
    })

    it('keeps a job in user review unless the user or master changes it', () => {
      const j = jobs.create(op(a), { crewId, title: 'x', review: 'user' })
      expect(code(() => jobs.edit(op(a), j.id, { review: 'none' }))).toBe('FORBIDDEN')
      expect(code(() => jobs.edit(op(pm), j.id, { review: 'pm' }))).toBe('FORBIDDEN')
      expect(jobs.edit(M, j.id, { review: 'none' }).review).toBe('none')
    })

    it('lets the PM assign, edit open jobs and escalate, but not edit done jobs or delete', () => {
      const j = jobs.create(op(pm), { crewId, title: 'x', for: a })
      expect(jobs.reassign(op(pm), j.id, b)).toMatchObject({ assigneeId: b, preassignedId: b })
      jobs.claim(op(b), j.id)
      expect(jobs.reassign(op(pm), j.id, a)).toMatchObject({ state: 'todo', assigneeId: a, leaseUntil: null })
      expect(noticesOf('reassigned').at(-1)!.to).toEqual([
        { kind: 'operator', id: a },
        { kind: 'operator', id: b },
      ])
      jobs.claim(op(a), j.id)
      jobs.done(op(a), j.id)
      jobs.approve(op(pm), j.id)
      expect(code(() => jobs.edit(op(pm), j.id, { title: 'late' }))).toBe('FORBIDDEN')
      expect(code(() => jobs.delete(op(pm), j.id))).toBe('FORBIDDEN')
    })

    it('gives the master its rights: create, edit, reassign, approve any review, escalate; no delete or override', () => {
      const j = jobs.create(M, { crewId, title: 'from master', for: a, review: 'user' })
      expect(j.createdBy).toBe((M as { id: number }).id)
      expect(jobs.edit(M, j.id, { body: 'details' }).body).toBe('details')
      expect(jobs.reassign(M, j.id, b).assigneeId).toBe(b)
      jobs.claim(op(b), j.id)
      expect(jobs.escalate(M, j.id, 'look at this').escalation).toBe('look at this')
      jobs.done(op(b), j.id)
      expect(jobs.approve(M, j.id).state).toBe('done')
      expect(code(() => jobs.delete(M, j.id))).toBe('FORBIDDEN')
      expect(code(() => jobs.override(M, j.id, { state: 'todo' }))).toBe('FORBIDDEN')
      expect(code(() => jobs.edit(M, j.id, { title: 'late' }))).toBe('FORBIDDEN')
      expect(code(() => jobs.addDep(M, j.id, jobs.create(USER, { crewId, title: 'd' }).id))).toBe('FORBIDDEN')
      const r = claimed('pm')
      jobs.done(op(a), r.id)
      expect(jobs.reject(M, r.id, 'redo').state).toBe('doing')
    })

    it('rejects a deleted operator, a mismatched actor kind and another crew', () => {
      const j = jobs.create(USER, { crewId, title: 'x' })
      store.deleteOperator(b)
      for (const fn of [
        () => jobs.claim(op(b)),
        () => jobs.create(op(b), { crewId, title: 'y' }),
        () => jobs.get(op(b), j.id),
        () => jobs.edit(op(b), j.id, { title: 'z' }),
      ]) {
        expect(code(fn)).toBe('FORBIDDEN')
      }
      expect(jobs.touch(b)).toBe(0)
      expect(code(() => jobs.claim({ kind: 'master', id: a }))).toBe('FORBIDDEN')
      expect(code(() => jobs.claim(op((M as { id: number }).id)))).toBe('FORBIDDEN')
      const other = store.createCrew('other', '/o')
      const foreign = jobs.create(USER, { crewId: other.id, title: 'f' })
      expect(code(() => jobs.get(op(a), foreign.id))).toBe('NOT_FOUND')
      expect(code(() => jobs.claim(op(a), foreign.id))).toBe('NOT_FOUND')
      expect(code(() => jobs.create(op(a), { crewId: other.id, title: 'x' }))).toBe('NOT_FOUND')
      expect(code(() => jobs.list(op(a), other.id))).toBe('NOT_FOUND')
    })
  })

  describe('user', () => {
    it('overrides any state and assignee', () => {
      const j = jobs.create(USER, { crewId, title: 'x' })
      expect(code(() => jobs.override(USER, j.id, { state: 'doing' }))).toBe('BAD_ARGS')
      expect(jobs.override(USER, j.id, { state: 'doing', assigneeId: a })).toMatchObject({
        state: 'doing',
        assigneeId: a,
        leaseUntil: clock + 60 * MIN,
        startedAt: clock,
        preassignedId: a,
      })
      expect(jobs.override(USER, j.id, { state: 'held' }).state).toBe('held')
      expect(jobs.override(USER, j.id, { state: 'done', assigneeId: null })).toMatchObject({ state: 'done', assigneeId: null, leaseUntil: null })
      expect(code(() => jobs.override(USER, j.id, { state: 'bogus' as never }))).toBe('BAD_ARGS')
    })

    it('deletes any job, messaging its holder', () => {
      const j = claimed()
      jobs.delete(USER, j.id)
      expect(code(() => jobs.get(USER, j.id))).toBe('NOT_FOUND')
      expect(noticesOf('deleted')[0]!.to).toEqual([{ kind: 'operator', id: a }])
    })

    it('lists a crew’s jobs, optionally only open ones', () => {
      const j = claimed('none')
      jobs.create(USER, { crewId, title: 'open' })
      jobs.done(op(a), j.id)
      expect(jobs.list(op(b), crewId).length).toBe(2)
      expect(jobs.list(op(b), crewId, { open: true }).map((x) => x.title)).toEqual(['open'])
    })
  })

  it('emits notices only after a change commits', () => {
    const j = jobs.create(USER, { crewId, title: 'x', for: a })
    notices = []
    expect(code(() => jobs.create(USER, { crewId, title: 'y', deps: [j.id, 999] }))).toBe('BAD_ARGS')
    expect(code(() => jobs.claim(op(b), j.id))).toBe('CONFLICT')
    expect(notices).toEqual([])
    expect(jobs.list(USER, crewId).length).toBe(1)
    jobs.claim(op(a), j.id)
    expect(notices).toEqual([expect.objectContaining({ kind: 'claimed', crewId, jobId: j.id, actorId: a, by: 'builder@shop', to: [] })])
  })

  it('keeps a committed change and later notices when the sink throws', () => {
    let calls = 0
    const throwing = new JobEngine(store, () => clock, () => settings, () => {
      calls++
      throw new Error('sink down')
    })
    const j = throwing.create(USER, { crewId, title: 'x', estimateMinutes: 500 })
    expect(calls).toBe(2)
    expect(jobs.get(USER, j.id).state).toBe('held')
  })

  it('runs inside a caller’s transaction as a savepoint and emits when it is released', () => {
    const j = jobs.create(USER, { crewId, title: 'x' })
    notices = []
    store.db.exec('BEGIN')
    expect(code(() => jobs.claim(op(a), 999))).toBe('NOT_FOUND')
    jobs.claim(op(a), j.id)
    expect(notices.map((n) => n.kind)).toEqual(['claimed'])
    store.db.exec('COMMIT')
    expect(jobs.get(USER, j.id).state).toBe('doing')
  })
})
