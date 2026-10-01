import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Purger, type PurgeEvent, type PurgeSettings } from './purge'
import { Store } from './store'

const DAY = 86_400_000

describe('Purger', () => {
  let clock: number
  let store: Store
  let settings: PurgeSettings
  let events: PurgeEvent[]
  let purger: Purger

  beforeEach(() => {
    clock = new Date(2026, 5, 1, 12).getTime()
    store = new Store(':memory:', () => clock)
    settings = { purgeRetentionDays: 30, purgeEnabled: true }
    events = []
    purger = new Purger({ store, now: () => clock, settings: () => settings, emit: (e) => events.push(e) })
  })
  afterEach(() => store.close())

  const setup = () => {
    const crew = store.createCrew('shop', '/p')
    const squad = store.createSquad(crew.id, 'dev')
    const op = store.createOperator(squad.id, 'impl', 'claude', 'opus')
    const keep = store.createOperator(squad.id, 'lead', 'claude', 'opus')
    return { crew, squad, op, keep }
  }
  const spend = (operatorId: number, at: number, cost: number, model = 'claude-opus-5-5') =>
    store.addUsage({ operatorId, at, model, inputTokens: 10, outputTokens: 5, costUsd: cost })
  const totals = (crewId: number) => ({
    all: store.spendSince(0),
    crew: store.spendSince(0, crewId),
    recent: store.spendSince(new Date(2026, 3, 1).getTime()),
    breakdown: store.usageBreakdown({ crewId }, 0).reduce((a, r) => a + r.costUsd, 0),
  })
  const rowCount = (table: string, id: number) => store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE id = ?`).get(id)

  it('refuses live and unknown operators', () => {
    const { op } = setup()
    expect(purger.eligible(op.id)).toEqual({ ok: false, blockers: ['operator is live, not deleted'] })
    expect(purger.eligible(999).ok).toBe(false)
    expect(purger.purgeNow(op.id)[0]!.purged).toBe(false)
    expect(purger.sweep().purged).toEqual([])
    expect(store.getOperator(op.id)).not.toBeNull()
  })

  it('blocks until retention has elapsed since deletion and the newest usage', () => {
    const { op } = setup()
    spend(op.id, clock - 5 * DAY, 1)
    store.deleteOperator(op.id)
    expect(purger.eligible(op.id).blockers[0]).toMatch(/retention: 30 day/)
    clock += 29 * DAY
    expect(purger.eligible(op.id).ok).toBe(false)
    clock += DAY
    expect(purger.eligible(op.id)).toEqual({ ok: true, blockers: [] })
  })

  it('blocks on doing, review and held jobs it assigns or reviews, not on todo or done', () => {
    const { crew, op, keep } = setup()
    const mk = (state: 'todo' | 'doing' | 'review' | 'done' | 'held', o: { assigneeId?: number; reviewerId?: number }) => {
      const j = store.createJob({ crewId: crew.id, title: state, ...o })
      return store.updateJob(j.id, { state })
    }
    mk('todo', { assigneeId: op.id })
    mk('done', { assigneeId: op.id })
    store.deleteOperator(op.id)
    clock += 31 * DAY
    expect(purger.eligible(op.id).ok).toBe(true)
    const held = mk('held', { assigneeId: op.id })
    expect(purger.eligible(op.id).blockers).toEqual(['1 job in doing, review or held'])
    store.updateJob(held.id, { state: 'done' })
    mk('review', { assigneeId: keep.id, reviewerId: op.id })
    expect(purger.eligible(op.id).ok).toBe(false)
  })

  it('blocks on unread messages to or from it', () => {
    const { crew, op, keep } = setup()
    store.deleteOperator(op.id)
    clock += 31 * DAY
    const m = store.createMessage({ crewId: crew.id, fromKind: 'operator', fromId: op.id, toKind: 'operator', toId: keep.id, body: 'hi' })
    expect(purger.eligible(op.id).blockers).toEqual(['1 unread message'])
    store.markMessageRead(m.id)
    expect(purger.eligible(op.id).ok).toBe(true)
    store.createMessage({ crewId: crew.id, fromKind: 'operator', fromId: keep.id, toKind: 'operator', toId: op.id, body: 'yo' })
    expect(purger.eligible(op.id).ok).toBe(false)
  })

  it('sweeps eligible operators, keeping every total identical', () => {
    const { crew, op, keep } = setup()
    spend(op.id, clock - 40 * DAY, 2.5)
    spend(op.id, clock - 40 * DAY + 1000, 1.25, 'claude-haiku-4-5')
    spend(op.id, clock - 35 * DAY, 4)
    spend(keep.id, clock - DAY, 7)
    store.deleteOperator(op.id)
    clock += 31 * DAY
    const before = totals(crew.id)
    expect(before.crew).toBeCloseTo(14.75)
    expect(purger.sweep().purged).toEqual([op.id])
    expect(totals(crew.id)).toEqual(before)
    expect(rowCount('operators', op.id)).toEqual({ n: 0 })
    expect(store.listSpendArchive(crew.id).map((a) => a.label)).toEqual(['impl@shop', 'impl@shop', 'impl@shop'])
    expect(store.getOperator(keep.id)).not.toBeNull()
  })

  it('is idempotent and skips a disabled sweep', () => {
    const { op } = setup()
    store.deleteOperator(op.id)
    clock += 31 * DAY
    settings.purgeEnabled = false
    expect(purger.sweep().purged).toEqual([])
    settings.purgeEnabled = true
    expect(purger.sweep().purged).toEqual([op.id])
    expect(purger.sweep()).toEqual({ purged: [], squadsPurged: [], skipped: [] })
    expect(events.filter((e) => e.kind === 'operator-purged')).toHaveLength(1)
  })

  it('removes a soft-deleted squad once its last operator is purged', () => {
    const { crew, squad, op, keep } = setup()
    spend(op.id, clock - 40 * DAY, 3)
    store.deleteSquad(squad.id)
    clock += 31 * DAY
    const before = totals(crew.id)
    const s = purger.sweep()
    expect([...s.purged].sort()).toEqual([op.id, keep.id].sort())
    expect(s.squadsPurged).toEqual([squad.id])
    expect(rowCount('squads', squad.id)).toEqual({ n: 0 })
    expect(totals(crew.id)).toEqual(before)
    expect(events.map((e) => e.kind)).toEqual(['operator-purged', 'operator-purged', 'squad-purged'])
    expect(store.recentEvents(10).filter((e) => e.kind === 'purge')).toHaveLength(3)
  })

  it('keeps a live squad when its operator is purged', () => {
    const { squad, op } = setup()
    store.deleteOperator(op.id)
    clock += 31 * DAY
    expect(purger.sweep().squadsPurged).toEqual([])
    expect(rowCount('squads', squad.id)).toEqual({ n: 1 })
  })

  it('purgeNow ignores retention and the enabled flag but not data-safety blockers, force included', () => {
    const { crew, op, keep } = setup()
    spend(op.id, clock - 40 * DAY, 6)
    spend(keep.id, clock, 1)
    store.deleteOperator(op.id)
    const before = totals(crew.id)
    settings.purgeEnabled = false
    expect(purger.eligible(op.id).ok).toBe(false)
    const job = store.createJob({ crewId: crew.id, title: 't', assigneeId: op.id })
    store.updateJob(job.id, { state: 'doing' })
    expect(purger.purgeNow(op.id, { force: true })[0]).toMatchObject({ purged: false, blockers: ['1 job in doing, review or held'] })
    expect(rowCount('operators', op.id)).toEqual({ n: 1 })
    store.updateJob(job.id, { state: 'done' })
    expect(purger.purgeNow(op.id)[0]!.purged).toBe(true)
    expect(totals(crew.id)).toEqual(before)
    expect(purger.purgeNow(op.id)[0]!.blockers).toEqual(['operator not found'])
  })

  it('purgeNow all purges each unblocked deleted operator and leaves live ones', () => {
    const { crew, op, keep } = setup()
    const third = store.createOperator(store.createSquad(crew.id, 'qa').id, 'tester', 'claude', 'opus')
    store.deleteOperator(op.id)
    store.deleteOperator(third.id)
    store.createMessage({ crewId: crew.id, fromKind: 'operator', fromId: third.id, toKind: 'operator', toId: keep.id, body: 'x' })
    const res = purger.purgeNow('all')
    expect(res.map((r) => [r.operatorId, r.purged])).toEqual([[op.id, true], [third.id, false]])
    expect(res[1]!.blockers).toEqual(['1 unread message'])
    expect(store.getOperator(keep.id)).not.toBeNull()
    expect(events).toHaveLength(1)
    expect(purger.eligibleIds()).toEqual([])
  })
})
