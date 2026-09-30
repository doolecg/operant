import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Store } from './store'

describe('Store', () => {
  let clock = 1_000
  let store: Store

  beforeEach(() => {
    clock = 1_000
    store = new Store(':memory:', () => clock)
  })
  afterEach(() => store.close())

  it('migrates a fresh database to the latest schema', () => {
    expect(store.schemaVersion).toBe(3)
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

  it('moves tasks and stamps updatedAt', () => {
    const crew = store.createCrew('r', '/r')
    const task = store.createTask(crew.id, 'Build dashboard')
    clock = 2_000
    store.moveTask(task.id, 'doing')
    const [moved] = store.listTasks(crew.id)
    expect(moved).toMatchObject({ state: 'doing', createdAt: 1_000, updatedAt: 2_000, operatorId: null })
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
    store.createTask(crew.id, 't', operator.id)
    store.deleteCrew(crew.id)
    expect(store.getOperator(operator.id)).toBeNull()
    expect(store.listTasks(crew.id)).toEqual([])
  })
})
