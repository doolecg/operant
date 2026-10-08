import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS, Store } from './store'

describe('Store', () => {
  let clock = 1_000
  let store: Store

  beforeEach(() => {
    clock = 1_000
    store = new Store(':memory:', () => clock)
  })
  afterEach(() => store.close())

  it('migrates a fresh database to the latest schema', () => {
    expect(store.schemaVersion).toBe(MIGRATIONS.length)
  })

  it('stores JSON settings documents', () => {
    expect(store.getJson('settings')).toBeUndefined()
    store.setJson('settings', { a: 1 })
    store.setJson('settings', { a: 2 })
    expect(store.getJson('settings')).toEqual({ a: 2 })
  })

  it('reopens an existing file without re-running migrations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'operant-store-'))
    try {
      const file = join(dir, 'sub', 'operant.db')
      const a = new Store(file)
      a.createCrew('alpha', '/p')
      a.close()
      const b = new Store(file)
      expect(b.listCrews().map((r) => r.name)).toEqual(['alpha'])
      b.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('builds a crew topology of squads and operators', () => {
    const crew = store.createCrew('shop', '/code/shop')
    const dev = store.createSquad(crew.id, 'dev')
    const qa = store.createSquad(crew.id, 'qa')
    const lead = store.createOperator(dev.id, 'lead', 'claude', 'opus')
    store.createOperator(dev.id, 'impl', 'claude', 'sonnet')
    store.createOperator(qa.id, 'tester', 'codex', 'gpt')

    const topo = store.topology(crew.id)!
    expect(topo.squads.map((p) => [p.name, p.operators.map((s) => s.role)])).toEqual([
      ['dev', ['lead', 'impl']],
      ['qa', ['tester']],
    ])
    expect(topo.squads[0]!.operators[0]!.status).toBe('stopped')
    expect(store.operatorAddress(lead.id)).toBe('lead@shop')
    expect(store.crewIdOfOperator(lead.id)).toBe(crew.id)
    expect(store.crewIdOfOperator(999)).toBeNull()
    expect(store.topology(999)).toBeNull()
  })

  it('updates operator status', () => {
    const crew = store.createCrew('r', '/r')
    const operator = store.createOperator(store.createSquad(crew.id, 'p').id, 'a', 'shell', '-')
    store.setOperatorStatus(operator.id, 'running')
    expect(store.getOperator(operator.id)!.status).toBe('running')
  })

  it('moves jobs and stamps updatedAt', () => {
    const crew = store.createCrew('r', '/r')
    const job = store.createJob({ crewId: crew.id, title: 'Build dashboard' })
    clock = 2_000
    store.updateJob(job.id, { state: 'doing' })
    const [moved] = store.listJobs(crew.id)
    expect(moved).toMatchObject({ state: 'doing', createdAt: 1_000, updatedAt: 2_000, assigneeId: null, review: 'pm', blocked: false })
  })

  it('sums spend since a time, overall and per crew', () => {
    const a = store.createCrew('a', '/a')
    const b = store.createCrew('b', '/b')
    const sa = store.createOperator(store.createSquad(a.id, 'p').id, 'x', 'claude', 'opus')
    const sb = store.createOperator(store.createSquad(b.id, 'p').id, 'y', 'claude', 'haiku')
    const base = { inputTokens: 1, outputTokens: 1, cacheTokens: 0 }
    store.addUsage({ ...base, operatorId: sa.id, at: 500, costUsd: 9 })
    store.addUsage({ ...base, operatorId: sa.id, at: 1_500, costUsd: 1.25 })
    store.addUsage({ ...base, operatorId: sb.id, at: 1_600, costUsd: 0.5 })
    expect(store.spendSince(1_000)).toBeCloseTo(1.75)
    expect(store.spendSince(1_000, a.id)).toBeCloseTo(1.25)
  })

  it('upserts usage per message so re-reads do not double count', () => {
    const crew = store.createCrew('r', '/r')
    const operator = store.createOperator(store.createSquad(crew.id, 'p').id, 'a', 'claude', 'opus')
    const u = { operatorId: operator.id, at: 1_500, inputTokens: 1, outputTokens: 10, cacheTokens: 0, costUsd: 0.5 }
    store.upsertMessageUsage('msg_1', u)
    store.upsertMessageUsage('msg_1', { ...u, outputTokens: 20, costUsd: 0.75 })
    store.upsertMessageUsage('msg_2', { ...u, costUsd: 0.25 })
    expect(store.spendSince(0)).toBeCloseTo(1)
  })

  it('buckets spend per operator for sparklines', () => {
    const crew = store.createCrew('r', '/r')
    const squad = store.createSquad(crew.id, 'p')
    const a = store.createOperator(squad.id, 'a', 'claude', 'opus')
    const b = store.createOperator(squad.id, 'b', 'claude', 'opus')
    const base = { inputTokens: 0, outputTokens: 0, cacheTokens: 0 }
    store.upsertMessageUsage('1', { ...base, operatorId: a.id, at: 1_000, costUsd: 1 })
    store.upsertMessageUsage('2', { ...base, operatorId: a.id, at: 1_050, costUsd: 2 })
    store.upsertMessageUsage('3', { ...base, operatorId: a.id, at: 1_250, costUsd: 4 })
    store.upsertMessageUsage('4', { ...base, operatorId: b.id, at: 1_100, costUsd: 8 })
    store.upsertMessageUsage('5', { ...base, operatorId: b.id, at: 500, costUsd: 99 })
    const series = store.spendSeries(crew.id, 1_000, 100, 3).sort((x, y) => x.operatorId - y.operatorId)
    expect(series).toEqual([
      { operatorId: a.id, buckets: [3, 0, 4], total: 7 },
      { operatorId: b.id, buckets: [0, 8, 0], total: 8 },
    ])
  })

  it('returns recent events newest first', () => {
    store.addEvent('crew', 'first')
    clock = 2_000
    store.addEvent('crew', 'second')
    expect(store.recentEvents(10).map((e) => e.message)).toEqual(['second', 'first'])
    expect(store.recentEvents(1)).toHaveLength(1)
  })

  it('cascades a crew delete to squads, operators and tasks', () => {
    const crew = store.createCrew('r', '/r')
    const operator = store.createOperator(store.createSquad(crew.id, 'p').id, 'a', 'claude', 'opus')
    store.createJob({ crewId: crew.id, title: 't', assigneeId: operator.id })
    store.deleteCrew(crew.id)
    expect(store.getOperator(operator.id)).toBeNull()
    expect(store.listJobs(crew.id)).toEqual([])
  })

  describe('migration 4', () => {
    it('keeps v3 tasks as jobs with defaults', () => {
      const dir = mkdtempSync(join(tmpdir(), 'operant-mig-'))
      try {
        const file = join(dir, 'v3.db')
        const raw = new DatabaseSync(file)
        raw.exec(MIGRATIONS.slice(0, 3).join('\n'))
        raw.exec('PRAGMA user_version = 3')
        raw.exec(`INSERT INTO crews (id, name, folder, created_at) VALUES (1, 'shop', '/s', 5);
          INSERT INTO squads (id, crew_id, name) VALUES (1, 1, 'dev');
          INSERT INTO operators (id, squad_id, role, agent, model) VALUES (7, 1, 'lead', 'claude', 'opus');
          INSERT INTO tasks (id, crew_id, operator_id, title, state, created_at, updated_at) VALUES
            (3, 1, 7, 'one', 'doing', 10, 11), (9, 1, NULL, 'two', 'done', 12, 13)`)
        raw.close()
        const s = new Store(file)
        expect(s.schemaVersion).toBe(MIGRATIONS.length)
        const jobs = s.listJobs(1)
        expect(jobs.map((j) => [j.id, j.state, j.assigneeId, j.title, j.createdAt, j.updatedAt])).toEqual([
          [3, 'doing', 7, 'one', 10, 11],
          [9, 'done', null, 'two', 12, 13],
        ])
        expect(jobs[0]).toMatchObject({
          body: '',
          priority: 0,
          createdBy: null,
          reviewerId: null,
          review: 'none',
          leaseUntil: null,
          rejects: 0,
          note: '',
          blocked: false,
        })
        expect(s.listMessages(1)).toEqual([])
        expect(s.listLinks(1)).toEqual([])
        expect(s.getNodePositions(1)).toEqual([])
        expect(s.getOperator(7)).toMatchObject({ role: 'lead' })
        expect(s.createJob({ crewId: 1, title: 'new' }).review).toBe('pm')
        s.close()
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe('jobs', () => {
    it('creates, updates and deletes with the given fields', () => {
      const crew = store.createCrew('r', '/r')
      const op = store.createOperator(store.createSquad(crew.id, 'p').id, 'a', 'claude', 'opus')
      const job = store.createJob({
        crewId: crew.id,
        title: 't',
        body: 'b',
        priority: 2,
        createdBy: op.id,
        reviewerId: op.id,
        review: 'operator',
      })
      expect(job).toMatchObject({ body: 'b', priority: 2, createdBy: op.id, reviewerId: op.id, review: 'operator', state: 'todo' })
      clock = 2_000
      const upd = store.updateJob(job.id, { title: 'u', note: 'n', leaseUntil: 9, rejects: 1, assigneeId: op.id })
      expect(upd).toMatchObject({ title: 'u', note: 'n', leaseUntil: 9, rejects: 1, assigneeId: op.id, updatedAt: 2_000 })
      expect(store.updateJob(job.id, { assigneeId: null }).assigneeId).toBeNull()
      expect(() => store.updateJob(999, { title: 'x' })).toThrow(/not found/)
      store.deleteJob(job.id)
      expect(store.getJob(job.id)).toBeNull()
    })

    it('derives blocked from unfinished dependencies and rejects cycles', () => {
      const crew = store.createCrew('r', '/r')
      const a = store.createJob({ crewId: crew.id, title: 'a' })
      const b = store.createJob({ crewId: crew.id, title: 'b' })
      const c = store.createJob({ crewId: crew.id, title: 'c' })
      store.addJobDep(b.id, a.id)
      store.addJobDep(c.id, b.id)
      store.addJobDep(c.id, b.id)
      expect(store.jobDeps(c.id)).toEqual([b.id])
      expect(store.getJob(b.id)!.blocked).toBe(true)
      expect(store.getJob(a.id)!.blocked).toBe(false)
      expect(() => store.addJobDep(a.id, c.id)).toThrow(/cycle/)
      expect(() => store.addJobDep(a.id, a.id)).toThrow(/itself/)
      const other = store.createJob({ crewId: store.createCrew('o', '/o').id, title: 'x' })
      expect(() => store.addJobDep(a.id, other.id)).toThrow(/same project/)
      store.updateJob(a.id, { state: 'done' })
      expect(store.getJob(b.id)!.blocked).toBe(false)
      expect(store.getJob(c.id)!.blocked).toBe(true)
      store.removeJobDep(c.id, b.id)
      expect(store.getJob(c.id)!.blocked).toBe(false)
      store.deleteJob(a.id)
      expect(store.jobDeps(b.id)).toEqual([])
    })
  })

  describe('messages', () => {
    it('creates, lists, marks read and deletes', () => {
      const crew = store.createCrew('r', '/r')
      const op = store.createOperator(store.createSquad(crew.id, 'p').id, 'a', 'claude', 'opus')
      const job = store.createJob({ crewId: crew.id, title: 't' })
      const m1 = store.createMessage({
        crewId: crew.id,
        fromKind: 'user',
        toKind: 'operator',
        toId: op.id,
        toLabel: 'a@r',
        body: 'hi',
        jobId: job.id,
      })
      clock = 2_000
      store.createMessage({ crewId: crew.id, fromKind: 'operator', fromId: op.id, fromLabel: 'a@r', toKind: 'user', body: 'yo', kind: 'ask' })
      expect(m1).toMatchObject({ fromLabel: '', toLabel: 'a@r', kind: 'message', readAt: null, jobId: job.id })
      expect(store.listMessages(crew.id)).toHaveLength(2)
      expect(store.listMessages(crew.id, { toKind: 'operator', toId: op.id, unreadOnly: true }).map((m) => m.body)).toEqual(['hi'])
      expect(store.listMessages(crew.id, { toKind: 'user', toId: null }).map((m) => m.body)).toEqual(['yo'])
      expect(store.listMessages(crew.id, { limit: 1 })).toHaveLength(1)
      store.markMessageRead(m1.id)
      clock = 3_000
      store.markMessageRead(m1.id)
      expect(store.getMessage(m1.id)!.readAt).toBe(2_000)
      expect(store.listMessages(crew.id, { toId: op.id, unreadOnly: true })).toEqual([])
      store.deleteMessage(m1.id)
      expect(store.getMessage(m1.id)).toBeNull()
    })

    it('keeps messages and clears the address when an operator row is removed', () => {
      const crew = store.createCrew('r', '/r')
      const op = store.createOperator(store.createSquad(crew.id, 'p').id, 'a', 'claude', 'opus')
      const m = store.createMessage({ crewId: crew.id, fromKind: 'operator', fromId: op.id, fromLabel: 'a@r', toKind: 'user', body: 'x' })
      store.db.prepare('DELETE FROM operators WHERE id = ?').run(op.id)
      expect(store.getMessage(m.id)).toMatchObject({ fromId: null, fromLabel: 'a@r' })
    })
  })

  describe('links and node positions', () => {
    it('does link CRUD between live operators of one crew', () => {
      const crew = store.createCrew('r', '/r')
      const sq = store.createSquad(crew.id, 'p')
      const a = store.createOperator(sq.id, 'a', 'claude', 'opus')
      const b = store.createOperator(sq.id, 'b', 'claude', 'opus')
      const c = store.createOperator(sq.id, 'c', 'claude', 'opus')
      const foreign = store.createOperator(store.createSquad(store.createCrew('o', '/o').id, 'p').id, 'a', 'claude', 'opus')
      const link = store.createLink(crew.id, a.id, b.id, 'reviews')
      expect(store.listLinks(crew.id)).toEqual([link])
      expect(store.updateLink(link.id, { label: 'asks', toId: c.id })).toMatchObject({ label: 'asks', fromId: a.id, toId: c.id })
      expect(() => store.createLink(crew.id, a.id, foreign.id)).toThrow(/same project/)
      expect(() => store.createLink(crew.id, a.id, a.id)).toThrow(/different/)
      store.deleteOperator(c.id)
      expect(store.getLink(link.id)).toBeNull()
      expect(() => store.updateLink(link.id, { label: 'x' })).toThrow(/not found/)
    })

    it('saves, overwrites and clears node positions per crew', () => {
      const a = store.createCrew('a', '/a')
      const b = store.createCrew('b', '/b')
      store.saveNodePositions(a.id, [
        { nodeKey: 'op:1', x: 1, y: 2 },
        { nodeKey: 'crew', x: 0, y: 0 },
      ])
      store.saveNodePositions(a.id, [{ nodeKey: 'op:1', x: 5, y: 6 }])
      store.saveNodePositions(b.id, [{ nodeKey: 'op:1', x: 9, y: 9 }])
      expect(store.getNodePositions(a.id)).toEqual([
        { crewId: a.id, nodeKey: 'crew', x: 0, y: 0 },
        { crewId: a.id, nodeKey: 'op:1', x: 5, y: 6 },
      ])
      store.clearNodePositions(a.id)
      expect(store.getNodePositions(a.id)).toEqual([])
      expect(store.getNodePositions(b.id)).toHaveLength(1)
    })
  })

  describe('editing and deleting crews, squads, operators', () => {
    it('updates a crew and a squad', () => {
      const crew = store.createCrew('r', '/r')
      expect(store.updateCrew(crew.id, { name: 'r2' })).toMatchObject({ name: 'r2', folder: '/r' })
      expect(store.updateCrew(crew.id, { folder: '/z' })).toMatchObject({ name: 'r2', folder: '/z' })
      const sq = store.createSquad(crew.id, 'p')
      expect(store.renameSquad(sq.id, 'q').name).toBe('q')
      expect(() => store.updateCrew(999, {})).toThrow(/not found/)
    })

    it('updates an operator and moves it only within its crew', () => {
      const crew = store.createCrew('r', '/r')
      const s1 = store.createSquad(crew.id, 'one')
      const s2 = store.createSquad(crew.id, 'two')
      const other = store.createSquad(store.createCrew('o', '/o').id, 'x')
      const op = store.createOperator(s1.id, 'a', 'claude', 'opus')
      store.createOperator(s1.id, 'b', 'claude', 'opus')
      expect(store.updateOperator(op.id, { role: 'lead', agent: 'codex', model: 'gpt', squadId: s2.id })).toMatchObject({
        role: 'lead',
        agent: 'codex',
        model: 'gpt',
        squadId: s2.id,
      })
      expect(() => store.updateOperator(op.id, { squadId: other.id })).toThrow(/own project/)
      expect(() => store.updateOperator(op.id, { role: 'b' })).toThrow(/already used/)
      expect(store.updateOperator(op.id, { role: 'lead' }).role).toBe('lead')
    })

    it('hides soft-deleted operators everywhere and frees their role', () => {
      const crew = store.createCrew('r', '/r')
      const sq = store.createSquad(crew.id, 'p')
      const op = store.createOperator(sq.id, 'a', 'claude', 'opus')
      expect(() => store.createOperator(sq.id, 'a', 'claude', 'opus')).toThrow(/already used/)
      store.addUsage({ operatorId: op.id, at: 1_500, inputTokens: 1, outputTokens: 1, cacheTokens: 0, costUsd: 2 })
      clock = 2_000
      store.deleteOperator(op.id)
      expect(store.getOperator(op.id)).toBeNull()
      expect(store.topology(crew.id)!.squads[0]!.operators).toEqual([])
      expect(store.operatorAddress(op.id)).toBeNull()
      expect(store.operatorAddress(op.id, true)).toBe('a@r')
      expect(store.crewIdOfOperator(op.id)).toBeNull()
      expect(store.crewIdOfOperator(op.id, true)).toBe(crew.id)
      expect(store.spendSeries(crew.id, 1_000, 100, 10)).toEqual([])
      expect(store.spendSince(1_000)).toBeCloseTo(2)
      expect(() => store.updateOperator(op.id, { role: 'z' })).toThrow(/not found/)
      expect(store.createOperator(sq.id, 'a', 'claude', 'opus').id).not.toBe(op.id)
      const row = store.db.prepare('SELECT deleted_at FROM operators WHERE id = ?').get(op.id) as { deleted_at: number }
      expect(row.deleted_at).toBe(2_000)
    })

    it('deletes a squad: soft-deletes it and its operators, purges the row only when none reference it', () => {
      const crew = store.createCrew('r', '/r')
      const empty = store.createSquad(crew.id, 'empty')
      expect(store.deleteSquad(empty.id)).toBe(true)
      expect(store.getSquad(empty.id)).toBeNull()
      expect(store.topology(crew.id)!.squads).toEqual([])
      expect(store.purgeSquadIfEmpty(empty.id)).toBe(true)
      expect(store.deleteSquad(empty.id)).toBe(false)
      const sq = store.createSquad(crew.id, 'p')
      const op = store.createOperator(sq.id, 'a', 'claude', 'opus')
      expect(store.purgeSquadIfEmpty(sq.id)).toBe(false)
      expect(store.deleteSquad(sq.id)).toBe(true)
      expect(store.getOperator(op.id)).toBeNull()
      expect(store.operatorAddress(op.id, true)).toBe('a@r')
      expect(store.purgeSquadIfEmpty(sq.id)).toBe(false)
      store.purgeOperator(op.id)
      expect(store.purgeSquadIfEmpty(sq.id)).toBe(true)
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM squads WHERE crew_id = ?').get(crew.id)).toEqual({ n: 0 })
    })

    it('revives a deleted squad when its name is used again', () => {
      const crew = store.createCrew('r', '/r')
      const sq = store.createSquad(crew.id, 'p')
      store.deleteSquad(sq.id)
      const again = store.createSquad(crew.id, 'p')
      expect(again.id).toBe(sq.id)
      expect(store.topology(crew.id)!.squads.map((x) => x.name)).toEqual(['p'])
      expect(() => store.createSquad(crew.id, '__system__')).toThrow(/reserved/)
    })
  })

  describe('migration 5', () => {
    const day1 = new Date(2026, 0, 5, 10).getTime()
    const day2 = new Date(2026, 0, 6, 15).getTime()

    function seed(version: 3 | 4): { dir: string; file: string } {
      const dir = mkdtempSync(join(tmpdir(), 'operant-mig5-'))
      const file = join(dir, `v${version}.db`)
      const raw = new DatabaseSync(file)
      raw.exec(MIGRATIONS.slice(0, version).join('\n'))
      raw.exec(`PRAGMA user_version = ${version}`)
      raw.exec(`INSERT INTO crews (id, name, folder, created_at) VALUES (1, 'shop', '/s', 5), (2, 'other', '/o', 5);
        INSERT INTO squads (id, crew_id, name) VALUES (1, 1, 'dev'), (2, 2, 'dev');
        INSERT INTO operators (id, squad_id, role, agent, model) VALUES (7, 1, 'lead', 'claude', 'opus'), (8, 2, 'x', 'claude', 'haiku');
        INSERT INTO usage (id, operator_id, at, input_tokens, output_tokens, cache_tokens, cost_usd, message_id) VALUES
          (11, 7, ${day1}, 10, 20, 300, 1.5, 'm1'), (12, 7, ${day1 + 1000}, 1, 2, 3, 0.25, 'm2'),
          (13, 7, ${day2}, 5, 5, 5, 2, 'm3'), (14, 8, ${day2}, 1, 1, 1, 4, NULL)`)
      raw.exec(
        version === 3
          ? `INSERT INTO tasks (id, crew_id, operator_id, title, state, created_at, updated_at) VALUES (3, 1, 7, 'one', 'doing', 10, 11)`
          : `INSERT INTO jobs (id, crew_id, assignee_id, title, state, created_at, updated_at) VALUES (3, 1, 7, 'one', 'doing', 10, 11)`,
      )
      raw.close()
      return { dir, file }
    }

    it.each([3, 4] as const)('upgrades a v%i database keeping usage, jobs and totals', (version) => {
      const { dir, file } = seed(version)
      let s: Store | undefined
      try {
        s = new Store(file)
        expect(s.schemaVersion).toBe(MIGRATIONS.length)
        const rows = s.db.prepare('SELECT * FROM usage ORDER BY id').all() as Array<Record<string, number | string | null>>
        expect(rows.map((r) => [r.id, r.operator_id, r.message_id, r.cache_read, r.cache_w5m, r.legacy, r.scratch_id])).toEqual([
          [11, 7, 'm1', 300, 0, 1, null],
          [12, 7, 'm2', 3, 0, 1, null],
          [13, 7, 'm3', 5, 0, 1, null],
          [14, 8, null, 1, 0, 1, null],
        ])
        expect(s.spendSince(0)).toBeCloseTo(7.75)
        expect(s.spendSince(0, 1)).toBeCloseTo(3.75)
        expect(s.spendSince(0, 2)).toBeCloseTo(4)
        expect(s.spendSince(new Date(2026, 0, 6).getTime())).toBeCloseTo(6)
        expect(s.spendSeries(1, day1, 3_600_000, 1)).toEqual([{ operatorId: 7, buckets: [1.75], total: 1.75 }])
        expect(s.listJobs(1).map((j) => [j.id, j.title, j.state])).toEqual([[3, 'one', 'doing']])
        expect(s.getOperator(7)).toMatchObject({ role: 'lead', kind: 'worker', presetId: null, effort: '', permissionMode: 'default', modified: false })
        expect(s.getCrew(1)).toMatchObject({ view: 'cards', pmId: null })
        expect(s.topology(1)!.squads.map((q) => q.name)).toEqual(['dev'])
        // The (operator, message) unique index still drives upserts, and an exact re-read replaces a legacy row.
        s.upsertMessageUsage('m1', { operatorId: 7, at: day1, inputTokens: 10, outputTokens: 20, cacheRead: 100, cacheW1h: 200, costUsd: 1.5, model: 'opus' })
        expect(s.db.prepare('SELECT COUNT(*) AS n FROM usage').get()).toEqual({ n: 4 })
        expect(s.db.prepare('SELECT cache_read, cache_w1h, legacy, model FROM usage WHERE id = 11').get()).toEqual({
          cache_read: 100,
          cache_w1h: 200,
          legacy: 0,
          model: 'opus',
        })
        expect(s.spendSince(0)).toBeCloseTo(7.75)
      } finally {
        s?.close()
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe('migration 6', () => {
    function seedV5(legacyTable: boolean): { dir: string; file: string } {
      const dir = mkdtempSync(join(tmpdir(), 'operant-mig6-'))
      const file = join(dir, 'v5.db')
      const raw = new DatabaseSync(file)
      raw.exec(MIGRATIONS.slice(0, 5).join('\n'))
      raw.exec('PRAGMA user_version = 5')
      raw.exec(`INSERT INTO crews (id, name, folder, created_at) VALUES (1, 'shop', '/s', 5);
        INSERT INTO squads (id, crew_id, name) VALUES (1, 1, 'dev');
        INSERT INTO operators (id, squad_id, role, agent, model) VALUES (7, 1, 'a', 'claude', 'm'), (8, 1, 'b', 'claude', 'm');
        INSERT INTO jobs (id, crew_id, assignee_id, title, state, estimate_minutes, started_at, escalation, created_at, updated_at) VALUES
          (1, 1, 7, 'pre', 'todo', 30, NULL, '', 1, 1), (2, 1, 8, 'claimed', 'doing', NULL, 9, 'why', 1, 1), (3, 1, NULL, 'free', 'todo', NULL, NULL, '', 1, 1)`)
      if (legacyTable) {
        raw.exec(`CREATE TABLE job_preassigned (job_id INTEGER PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE);
          INSERT INTO job_preassigned (job_id) VALUES (1)`)
      }
      raw.close()
      return { dir, file }
    }

    it.each([true, false])('upgrades a v5 database (legacy job_preassigned table: %s)', (legacy) => {
      const { dir, file } = seedV5(legacy)
      let s: Store | undefined
      try {
        s = new Store(file)
        expect(s.schemaVersion).toBe(MIGRATIONS.length)
        expect(s.listJobs(1).map((j) => [j.id, j.assigneeId, j.preassignedId, j.estimateMinutes, j.startedAt, j.escalation])).toEqual([
          [1, 7, legacy ? 7 : null, 30, null, ''],
          [2, 8, null, null, 9, 'why'],
          [3, null, null, null, null, ''],
        ])
        expect(s.db.prepare("SELECT name FROM sqlite_master WHERE name = 'job_preassigned'").get()).toBeUndefined()
        s.db.prepare('DELETE FROM operators WHERE id = 7').run()
        expect(s.getJob(1)!.preassignedId).toBeNull()
      } finally {
        s?.close()
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe('presets', () => {
    it('seeds the built-ins with the spec values', () => {
      const presets = store.listPresets()
      expect(presets.map((p) => p.builtin)).toEqual([
        'pm', 'researcher', 'designer', 'implementor', 'senior', 'tester', 'reviewer',
        'pm-opencode', 'researcher-opencode', 'designer-opencode', 'implementor-opencode', 'senior-opencode', 'tester-opencode', 'reviewer-opencode',
      ])
      const by = (b: string) => presets.find((p) => p.builtin === b)!
      // The OpenCode twins share their Claude twin's spec, but carry no model or effort of their own.
      for (const b of ['pm', 'researcher', 'designer', 'implementor', 'senior', 'tester', 'reviewer']) {
        expect(by(`${b}-opencode`)).toMatchObject({ name: `${by(b).name} (OpenCode)`, agent: 'opencode', model: '', effort: '', tools: by(b).tools, roleText: null })
      }
      expect(by('pm')).toMatchObject({
        name: 'project manager',
        model: 'claude-sonnet-5-5',
        effort: 'medium',
        permissionMode: 'dontAsk',
        tools: 'Read,Grep,Glob,Bash',
        allow: ['Bash(operant *)', 'Bash(git log*)', 'Bash(git diff*)'],
        cacheTtl: '1h',
        contextCap: 150_000,
        clearBetweenJobs: false,
        mcp: 'codegraph',
        roleText: null,
      })
      expect(by('researcher')).toMatchObject({ model: 'claude-haiku-4-5', effort: '', cacheTtl: '5m', contextCap: 100_000 })
      expect(by('researcher').allow).toContain('WebSearch')
      expect(by('designer').allow).toEqual(['Edit(docs/design/**)', 'Write(docs/design/**)', 'Bash(operant *)'])
      expect(by('implementor')).toMatchObject({ permissionMode: 'acceptEdits', contextCap: 200_000, deny: ['Bash(git push*)', 'Bash(git commit*)'] })
      expect(by('senior')).toMatchObject({ model: 'claude-opus-5-5', cacheTtl: '1h', contextCap: 300_000, allow: by('implementor').allow })
      expect(by('tester').allow).toEqual([
        'Bash(operant *)', 'Bash(npm *)', 'Bash(npx *)', 'Bash(node *)', 'Bash(git diff*)',
        'Edit(**/test/**)', 'Edit(**/*.test.*)', 'Edit(e2e/**)', 'Write(**/test/**)', 'Write(**/*.test.*)', 'Write(e2e/**)',
      ])
      expect(by('tester').contextCap).toBe(120_000)
      expect(by('reviewer')).toMatchObject({ effort: 'high', cacheTtl: '1h', allow: ['Bash(operant *)', 'Bash(git diff*)', 'Bash(git log*)', 'Bash(git show*)'] })
    })

    it('does not re-add a deleted built-in at startup, but restoreBuiltins does', () => {
      const dir = mkdtempSync(join(tmpdir(), 'operant-presets-'))
      try {
        const file = join(dir, 'p.db')
        const a = new Store(file)
        a.deletePreset(a.getPresetByBuiltin('tester')!.id)
        a.close()
        const b = new Store(file)
        expect(b.listPresets()).toHaveLength(13)
        expect(b.restoreBuiltins().map((p) => p.builtin)).toEqual(['tester'])
        expect(b.restoreBuiltins()).toEqual([])
        expect(b.listPresets()).toHaveLength(14)
        b.close()
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('creates, edits, duplicates, resets and deletes presets', () => {
      clock = 5_000
      const mine = store.createPreset({ name: 'mine', agent: 'claude', model: 'm1', permissionMode: 'plan', allow: ['X'] })
      expect(mine).toMatchObject({ builtin: null, effort: '', clearBetweenJobs: true, mcp: 'codegraph', roleText: null, updatedAt: 5_000 })
      clock = 6_000
      const upd = store.updatePreset(mine.id, { model: 'm2', roleText: 'be brief', clearBetweenJobs: false, deny: ['Y'] })
      expect(upd).toMatchObject({ model: 'm2', roleText: 'be brief', clearBetweenJobs: false, deny: ['Y'], allow: ['X'], updatedAt: 6_000 })
      expect(() => store.createPreset({ name: 'mine', agent: 'claude', model: 'm', permissionMode: 'plan' })).toThrow()
      const copy = store.duplicatePreset(mine.id)
      expect(copy).toMatchObject({ name: 'mine copy', builtin: null, roleText: 'be brief', model: 'm2' })
      expect(store.duplicatePreset(mine.id).name).toBe('mine copy (2)')
      const pm = store.getPresetByBuiltin('pm')!
      expect(store.duplicatePreset(pm.id, 'pm2', 'shipped text')).toMatchObject({ builtin: null, roleText: 'shipped text' })
      store.updatePreset(pm.id, { name: 'boss', model: 'x', roleText: 'own' })
      expect(store.resetPreset(pm.id)).toMatchObject({ name: 'project manager', model: 'claude-sonnet-5-5', roleText: null })
      expect(() => store.resetPreset(mine.id)).toThrow(/built-in/)
      store.deletePreset(mine.id)
      expect(store.getPreset(mine.id)).toBeNull()
      store.deletePreset(pm.id)
      expect(store.getPresetByBuiltin('pm')).toBeNull()
      expect(store.restoreBuiltins().map((p) => p.builtin)).toEqual(['pm'])
    })

    it('restores a built-in under a free name when a user preset took it', () => {
      store.deletePreset(store.getPresetByBuiltin('reviewer')!.id)
      store.createPreset({ name: 'reviewer', agent: 'claude', model: 'm', permissionMode: 'plan' })
      expect(store.restoreBuiltins()[0]!.name).toBe('reviewer (2)')
    })
  })

  describe('operator launch settings', () => {
    function setup() {
      const crew = store.createCrew('r', '/r')
      const squad = store.createSquad(crew.id, 'dev')
      return { crew, squad, impl: store.getPresetByBuiltin('implementor')! }
    }

    it('copies a preset into the operator and derives "modified"', () => {
      const { squad, impl } = setup()
      const op = store.createOperator(squad.id, 'plain', 'shell', 'none')
      expect(op).toMatchObject({ kind: 'worker', presetId: null, effort: '', permissionMode: 'default', allow: [], contextCap: 0, dailyCapUsd: null, sessionId: null, modified: false })
      const w = store.createOperatorFromPreset(squad.id, 'w', impl.id)
      expect(w).toMatchObject({ presetId: impl.id, model: impl.model, effort: 'medium', permissionMode: 'acceptEdits', allow: impl.allow, deny: impl.deny, cacheTtl: 'auto', contextCap: 200_000, modified: false })
      expect(store.createOperatorFromPreset(squad.id, 'x', impl.id, { model: 'other' }).model).toBe('other')
      expect(store.setOperatorLaunch(w.id, { effort: 'high' }).modified).toBe(true)
      expect(store.applyPresetToOperator(w.id).modified).toBe(false)
      expect(store.setOperatorLaunch(w.id, { allow: [...impl.allow, 'Bash(ls)'] }).modified).toBe(true)
      expect(store.applyPresetToOperator(w.id)).toMatchObject({ allow: impl.allow, modified: false })
      expect(store.setOperatorLaunch(w.id, { roleText: 'custom' }).modified).toBe(true)
      expect(store.applyPresetToOperator(w.id)).toMatchObject({ roleText: null, modified: false })
      expect(store.setOperatorLaunch(w.id, { clearBetweenJobs: false, dailyCapUsd: 3 })).toMatchObject({ clearBetweenJobs: false, dailyCapUsd: 3, modified: true })
      expect(store.setOperatorLaunch(w.id, { dailyCapUsd: null }).dailyCapUsd).toBeNull()
      store.setOperatorSession(w.id, 'sess-1')
      expect(store.getOperator(w.id)!.sessionId).toBe('sess-1')
      expect(() => store.setOperatorLaunch(w.id, { presetId: 999 })).toThrow(/not found/)
      expect(() => store.applyPresetToOperator(op.id)).toThrow(/no preset/)
    })

    it('saves an operator as a new preset and keeps operators when their preset goes', () => {
      const { crew, squad, impl } = setup()
      const op = store.createOperatorFromPreset(squad.id, 'w', impl.id)
      store.setOperatorLaunch(op.id, { model: 'custom-model' })
      const saved = store.presetFromOperator(op.id, 'my impl')
      expect(saved).toMatchObject({ builtin: null, model: 'custom-model', allow: impl.allow })
      expect(store.getOperator(op.id)).toMatchObject({ presetId: saved.id, modified: false })
      expect(store.operatorsOfPreset(saved.id).map((o) => o.id)).toEqual([op.id])
      store.updatePreset(saved.id, { roleText: 'preset text' })
      store.deletePreset(saved.id)
      expect(store.getOperator(op.id)).toMatchObject({ presetId: null, modified: false, roleText: 'preset text', model: 'custom-model' })
      expect(store.topology(crew.id)!.squads[0]!.operators.find((o) => o.id === op.id)!.presetId).toBeNull()
    })
  })

  describe('Master Terminal slot', () => {
    it('is created lazily in a hidden system squad, once per crew', () => {
      const crew = store.createCrew('r', '/r')
      expect(store.getMaster(crew.id)).toBeNull()
      const m = store.ensureMaster(crew.id)
      expect(m).toMatchObject({ role: 'master', kind: 'master', agent: 'claude', presetId: null, modified: false })
      expect(store.ensureMaster(crew.id).id).toBe(m.id)
      expect(store.getMaster(crew.id)!.id).toBe(m.id)
      expect(store.operatorAddress(m.id)).toBe('master@r')
      expect(store.crewIdOfOperator(m.id)).toBe(crew.id)
      expect(store.topology(crew.id)!.squads).toEqual([])
      const sys = store.db.prepare('SELECT * FROM squads WHERE crew_id = ?').all(crew.id) as Array<{ id: number; system: number }>
      expect(sys).toHaveLength(1)
      expect(sys[0]!.system).toBe(1)
      expect(() => store.deleteSquad(sys[0]!.id)).toThrow(/system squad/)
      expect(() => store.renameSquad(sys[0]!.id, 'x')).toThrow(/system squad/)
      expect(() => store.createOperator(sys[0]!.id, 'a', 'claude', 'm')).toThrow(/system squad/)
      expect(() => store.deleteOperator(m.id)).toThrow(/cannot be deleted/)
      const other = store.createSquad(crew.id, 'dev')
      expect(() => store.updateOperator(m.id, { squadId: other.id })).toThrow(/system squad|Master/)
      expect(store.setOperatorLaunch(m.id, { model: 'claude-opus-5-5', permissionMode: 'plan' })).toMatchObject({ model: 'claude-opus-5-5', permissionMode: 'plan' })
      expect(() => store.createOperator(other.id, 'master', 'claude', 'm')).toThrow(/reserved/)
      expect(() => store.ensureMaster(999)).toThrow(/not found/)
    })

    it('can be recreated if its row is gone, and its spend counts for the crew', () => {
      const crew = store.createCrew('r', '/r')
      const m = store.ensureMaster(crew.id)
      store.addUsage({ operatorId: m.id, at: 1_500, inputTokens: 1, outputTokens: 1, costUsd: 2 })
      expect(store.spendSince(0, crew.id)).toBeCloseTo(2)
      store.db.prepare('UPDATE operators SET deleted_at = 1 WHERE id = ?').run(m.id)
      const again = store.ensureMaster(crew.id)
      expect(again.id).not.toBe(m.id)
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM squads WHERE crew_id = ?').get(crew.id)).toEqual({ n: 1 })
    })
  })

  describe('crew view, PM and tile layout', () => {
    it('saves the view per crew and validates the PM', () => {
      const crew = store.createCrew('r', '/r')
      const other = store.createCrew('o', '/o')
      expect(store.getCrewView(crew.id)).toBe('cards')
      expect(store.setCrewView(crew.id, 'tiles').view).toBe('tiles')
      expect(store.getCrewView(other.id)).toBe('cards')
      const pm = store.createOperator(store.createSquad(crew.id, 'dev').id, 'pm', 'claude', 'm')
      expect(store.updateCrew(crew.id, { pmId: pm.id })).toMatchObject({ pmId: pm.id, view: 'tiles' })
      expect(() => store.updateCrew(other.id, { pmId: pm.id })).toThrow(/PM/)
      store.deleteOperator(pm.id)
      expect(store.getCrew(crew.id)!.pmId).toBeNull()
      expect(() => store.getCrewView(999)).toThrow(/not found/)
    })

    it('stores the tile layout as JSON', () => {
      const crew = store.createCrew('r', '/r')
      expect(store.getTileLayout(crew.id)).toEqual({})
      store.setTileLayout(crew.id, { dir: 'row', children: [1, 2], ratios: [0.4, 0.6] })
      expect(store.getTileLayout(crew.id)).toEqual({ dir: 'row', children: [1, 2], ratios: [0.4, 0.6] })
    })
  })

  describe('scratch terminals', () => {
    it('does CRUD and keeps spend after delete', () => {
      const crew = store.createCrew('r', '/r')
      const t = store.createScratch({ crewId: crew.id, title: 'sh', agent: 'shell', cwd: '/r' })
      expect(t).toMatchObject({ title: 'sh', agent: 'shell', model: '', effort: '', presetId: null, sessionId: null, createdAt: 1_000 })
      const c = store.createScratch({ crewId: crew.id, title: 'cl', agent: 'claude', model: 'm', effort: 'low', presetId: store.getPresetByBuiltin('pm')!.id, cwd: '/r/x' })
      expect(store.listScratch(crew.id).map((x) => x.id)).toEqual([t.id, c.id])
      expect(store.updateScratch(c.id, { title: 'cl2', model: 'n', cwd: '/z', sessionId: 'abc', presetId: null })).toMatchObject({ title: 'cl2', model: 'n', cwd: '/z', sessionId: 'abc', presetId: null })
      expect(() => store.updateScratch(999, {})).toThrow(/not found/)
      store.upsertMessageUsage('s1', { scratchId: c.id, at: 1_500, inputTokens: 1, outputTokens: 1, costUsd: 1.5, model: 'n' })
      store.upsertMessageUsage('s1', { scratchId: c.id, at: 1_500, inputTokens: 1, outputTokens: 2, costUsd: 2, model: 'n' })
      expect(store.spendSince(0, crew.id)).toBeCloseTo(2)
      store.deleteScratch(c.id)
      expect(store.getScratch(c.id)).toBeNull()
      expect(store.spendSince(0)).toBeCloseTo(2)
      expect(store.db.prepare('SELECT scratch_id FROM usage').get()).toEqual({ scratch_id: null })
      store.deleteCrew(crew.id)
      expect(store.listScratch(crew.id)).toEqual([])
    })

    it('rejects usage that is not for exactly one owner', () => {
      const base = { at: 1, inputTokens: 0, outputTokens: 0, costUsd: 0 }
      expect(() => store.upsertMessageUsage('x', base)).toThrow(/exactly one/)
      expect(() => store.upsertMessageUsage('x', { ...base, operatorId: 1, scratchId: 1 })).toThrow(/exactly one/)
    })
  })

  describe('usage rows and breakdown', () => {
    it('stores the kind split, model and attribution, and groups by kind and model', () => {
      const crew = store.createCrew('r', '/r')
      const sq = store.createSquad(crew.id, 'p')
      const a = store.createOperator(sq.id, 'a', 'claude', 'opus')
      const b = store.createOperator(sq.id, 'b', 'claude', 'sonnet')
      const job = store.createJob({ crewId: crew.id, title: 'j' })
      const t = store.createScratch({ crewId: crew.id, title: 's', agent: 'claude', cwd: '/r' })
      const base = { inputTokens: 1, outputTokens: 10, cacheRead: 100, cacheW5m: 20, cacheW1h: 30 }
      store.upsertMessageUsage('1', { ...base, operatorId: a.id, at: 1_000, costUsd: 1, model: 'opus', jobId: job.id, sessionId: 'S', contextTokens: 150, cold: true, toolUse: true })
      store.upsertMessageUsage('2', { ...base, operatorId: a.id, at: 1_100, costUsd: 2, model: 'opus' })
      store.upsertMessageUsage('3', { ...base, operatorId: a.id, at: 1_200, costUsd: 4, model: 'haiku' })
      store.upsertMessageUsage('4', { ...base, operatorId: b.id, at: 1_300, costUsd: 8, model: 'opus' })
      store.upsertMessageUsage('1', { ...base, scratchId: t.id, at: 1_400, costUsd: 16, model: 'opus' })
      store.upsertMessageUsage('5', { ...base, operatorId: a.id, at: 500, costUsd: 99, model: 'opus' })
      const first = store.db.prepare('SELECT * FROM usage WHERE message_id = ? AND operator_id = ?').get('1', a.id) as Record<string, unknown>
      expect(first).toMatchObject({ job_id: job.id, session_id: 'S', context_tokens: 150, cold: 1, tool_use: 1, cache_w5m: 20, cache_w1h: 30, legacy: 0 })
      const byKey = (rows: ReturnType<Store['usageBreakdown']>) => rows.map((r) => `${r.group}/${r.model}:${r.costUsd}:${r.turns}`).sort()
      expect(byKey(store.usageBreakdown({ crewId: crew.id }, 1_000))).toEqual(['operator/haiku:4:1', 'operator/opus:11:3', 'scratch/opus:16:1'])
      expect(store.usageBreakdown({ crewId: crew.id }, 1_000)[0]).toMatchObject({ group: 'scratch', costUsd: 16 })
      expect(store.usageBreakdown({ operatorId: a.id }, 1_000).find((r) => r.model === 'opus')).toEqual({
        group: 'operator', model: 'opus', inputTokens: 2, outputTokens: 20, cacheRead: 200, cacheW5m: 40, cacheW1h: 60, costUsd: 3, turns: 2,
      })
      expect(store.spendSince(0, crew.id)).toBeCloseTo(130)
      expect(store.spendSince(0)).toBeCloseTo(130)
    })

    it('treats a lone cacheTokens total as cache reads', () => {
      const crew = store.createCrew('r', '/r')
      const op = store.createOperator(store.createSquad(crew.id, 'p').id, 'a', 'claude', 'opus')
      const u = store.addUsage({ operatorId: op.id, at: 1, inputTokens: 1, outputTokens: 1, cacheTokens: 9, costUsd: 1 })
      expect(u).toMatchObject({ cacheRead: 9, cacheTokens: 9, scratchId: null, legacy: false, cold: false })
    })
  })

  describe('spend archive and purge', () => {
    const d1 = new Date(2026, 0, 5, 10).getTime()
    const d2 = new Date(2026, 0, 6, 11).getTime()

    it('folds usage into the archive without changing totals, then purges the operator', () => {
      const crew = store.createCrew('r', '/r')
      const sq = store.createSquad(crew.id, 'p')
      const op = store.createOperator(sq.id, 'a', 'claude', 'opus')
      const keep = store.createOperator(sq.id, 'k', 'claude', 'opus')
      const base = { inputTokens: 1, outputTokens: 2, cacheRead: 3, cacheW5m: 4, cacheW1h: 5 }
      store.upsertMessageUsage('1', { ...base, operatorId: op.id, at: d1, costUsd: 1, model: 'opus' })
      store.upsertMessageUsage('2', { ...base, operatorId: op.id, at: d1 + 1000, costUsd: 2, model: 'opus' })
      store.upsertMessageUsage('3', { ...base, operatorId: op.id, at: d1 + 2000, costUsd: 4, model: 'haiku' })
      store.upsertMessageUsage('4', { ...base, operatorId: op.id, at: d2, costUsd: 8, model: 'opus' })
      store.upsertMessageUsage('5', { ...base, operatorId: keep.id, at: d2, costUsd: 16, model: 'opus' })
      const job = store.createJob({ crewId: crew.id, title: 'j', assigneeId: op.id, createdBy: op.id, reviewerId: op.id })
      const msg = store.createMessage({ crewId: crew.id, fromKind: 'operator', fromId: op.id, fromLabel: 'a@r', toKind: 'user', body: 'hi' })
      store.createLink(crew.id, op.id, keep.id, 'x')
      store.saveNodePositions(crew.id, [{ nodeKey: `op:${op.id}`, x: 1, y: 1 }, { nodeKey: `op:${keep.id}`, x: 2, y: 2 }])
      store.addEvent('x', 'a@r did a thing', crew.id, op.id)
      expect(() => store.purgeOperator(op.id)).toThrow(/deleted operator/)
      const before = { all: store.spendSince(0), crew: store.spendSince(0, crew.id), day2: store.spendSince(new Date(2026, 0, 6).getTime()) }
      store.deleteOperator(op.id)
      store.purgeOperator(op.id)
      expect(store.spendSince(0)).toBeCloseTo(before.all)
      expect(store.spendSince(0, crew.id)).toBeCloseTo(before.crew)
      expect(store.spendSince(new Date(2026, 0, 6).getTime())).toBeCloseTo(before.day2)
      expect(store.spendSince(new Date(2026, 0, 6).getTime(), crew.id)).toBeCloseTo(24)
      expect(store.listSpendArchive(crew.id)).toEqual([
        { crewId: crew.id, day: new Date(2026, 0, 5).getTime(), label: 'a@r', model: 'haiku', inputTokens: 1, outputTokens: 2, cacheRead: 3, cacheW5m: 4, cacheW1h: 5, costUsd: 4 },
        { crewId: crew.id, day: new Date(2026, 0, 5).getTime(), label: 'a@r', model: 'opus', inputTokens: 2, outputTokens: 4, cacheRead: 6, cacheW5m: 8, cacheW1h: 10, costUsd: 3 },
        { crewId: crew.id, day: new Date(2026, 0, 6).getTime(), label: 'a@r', model: 'opus', inputTokens: 1, outputTokens: 2, cacheRead: 3, cacheW5m: 4, cacheW1h: 5, costUsd: 8 },
      ])
      expect(store.usageBreakdown({ crewId: crew.id }, 0).find((r) => r.model === 'opus')).toMatchObject({ costUsd: 27 })
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM operators WHERE id = ?').get(op.id)).toEqual({ n: 0 })
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM usage WHERE operator_id = ?').get(op.id)).toEqual({ n: 0 })
      expect(store.getNodePositions(crew.id).map((p) => p.nodeKey)).toEqual([`op:${keep.id}`])
      expect(store.getMessage(msg.id)).toMatchObject({ fromId: null, fromLabel: 'a@r', body: 'hi' })
      expect(store.getJob(job.id)).toMatchObject({ assigneeId: null, createdBy: null, reviewerId: null })
      expect(store.listLinks(crew.id)).toEqual([])
      expect(store.recentEvents(5)[0]).toMatchObject({ operatorId: null, message: 'a@r did a thing' })
    })

    it('adds to an existing archive row when folded again, and drops the archive with its crew', () => {
      const crew = store.createCrew('r', '/r')
      const sq = store.createSquad(crew.id, 'p')
      const a = store.createOperator(sq.id, 'a', 'claude', 'opus')
      store.addUsage({ operatorId: a.id, at: d1, inputTokens: 0, outputTokens: 0, costUsd: 1, model: 'm' })
      expect(() => store.foldOperatorSpend(a.id)).toThrow(/deleted operator/)
      store.deleteOperator(a.id)
      store.foldOperatorSpend(a.id)
      store.foldOperatorSpend(a.id)
      store.addUsage({ operatorId: a.id, at: d1 + 5, inputTokens: 0, outputTokens: 0, costUsd: 2, model: 'm' })
      store.foldOperatorSpend(a.id)
      expect(store.listSpendArchive(crew.id).map((r) => r.costUsd)).toEqual([3])
      expect(store.spendSince(0)).toBeCloseTo(3)
      expect(store.spendSince(d1 + 24 * 3_600_000)).toBe(0)
      store.deleteCrew(crew.id)
      expect(store.spendSince(0)).toBe(0)
    })
  })

  describe('review fixes', () => {
    it('drops links when an operator or squad is deleted and lists only live-ended links', () => {
      const crew = store.createCrew('r', '/r')
      const sq = store.createSquad(crew.id, 'p')
      const a = store.createOperator(sq.id, 'a', 'claude', 'm')
      const b = store.createOperator(sq.id, 'b', 'claude', 'm')
      const c = store.createOperator(store.createSquad(crew.id, 'q').id, 'c', 'claude', 'm')
      store.createLink(crew.id, a.id, b.id)
      store.createLink(crew.id, b.id, c.id)
      store.deleteOperator(a.id)
      expect(store.listLinks(crew.id).map((l) => [l.fromId, l.toId])).toEqual([[b.id, c.id]])
      store.db.prepare('INSERT INTO links (crew_id, from_id, to_id) VALUES (?, ?, ?)').run(crew.id, a.id, c.id)
      expect(store.listLinks(crew.id)).toHaveLength(1)
      store.deleteSquad(sq.id)
      expect(store.listLinks(crew.id)).toEqual([])
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM links').get()).toEqual({ n: 0 })
    })

    it('addUsage needs exactly one owner', () => {
      expect(() => store.addUsage({ at: 1, inputTokens: 0, outputTokens: 0, costUsd: 0 })).toThrow(/exactly one/)
    })
  })
})
