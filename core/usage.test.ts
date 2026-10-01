import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Store } from './store'
import { CapMonitor, computeStats, isColdTurn, UsageTracker, type CapDecision, type StatRow, type UsageConfig } from './usage'

const HOUR = 3_600_000

describe('isColdTurn (ruling R2)', () => {
  const turn = (contextTokens: number, cacheWriteTokens: number) => ({ contextTokens, cacheWriteTokens })

  it('never flags the first turn of a session', () => {
    expect(isColdTurn(turn(100_000, 100_000), null)).toBe(false)
  })

  it('does not flag a compaction (context fell by more than half)', () => {
    expect(isColdTurn(turn(40_000, 30_000), 150_000)).toBe(false)
  })

  it('flags a genuine cold turn: writes over half the context, context not collapsed', () => {
    expect(isColdTurn(turn(150_000, 100_000), 148_000)).toBe(true)
  })

  it('needs writes strictly over the threshold and a drop strictly over half', () => {
    expect(isColdTurn(turn(100_000, 50_000), 100_000)).toBe(false)
    expect(isColdTurn(turn(100_000, 50_001), 100_000)).toBe(true)
    expect(isColdTurn(turn(50_000, 40_000), 100_000)).toBe(true)
    expect(isColdTurn(turn(49_999, 40_000), 100_000)).toBe(false)
  })

  it('honours the configured threshold', () => {
    expect(isColdTurn(turn(100_000, 30_000), 100_000, 25)).toBe(true)
    expect(isColdTurn(turn(100_000, 30_000), 100_000, 50)).toBe(false)
  })
})

describe('computeStats', () => {
  const row = (o: Partial<StatRow>): StatRow => ({
    model: 'claude-opus-5-5',
    jobId: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheW5m: 0,
    cacheW1h: 0,
    costUsd: 0,
    contextTokens: 0,
    cold: false,
    legacy: false,
    ...o,
  })

  it('computes hit ratio, cold count, output share, median context and cost per job', () => {
    const s = computeStats([
      row({ inputTokens: 10, cacheRead: 900, cacheW1h: 90, outputTokens: 50_000, costUsd: 1, contextTokens: 1_000, jobId: 7 }),
      row({ cacheRead: 0, cacheW5m: 1_000, costUsd: 2, contextTokens: 3_000, cold: true, jobId: 7 }),
      row({ cacheRead: 2_000, costUsd: 0.5, contextTokens: 2_000, jobId: 8 }),
      row({ cacheRead: 99_999, costUsd: 4, contextTokens: 99_999, legacy: true }),
    ])
    // read 2900 / (2900 + 1090 + 10)
    expect(s.cacheHitRatio).toBeCloseTo(2_900 / 4_000, 8)
    expect(s.coldCount).toBe(1)
    // 50,000 output tokens at $20/M = $1 of the $3.5 non-legacy cost
    expect(s.outputShare).toBeCloseTo(1 / 3.5, 8)
    expect(s.medianContext).toBe(2_000)
    expect(s.turns).toBe(4)
    expect(s.costPerJob).toEqual([
      { jobId: 7, costUsd: 3, turns: 2 },
      { jobId: 8, costUsd: 0.5, turns: 1 },
    ])
    expect(s.unattributedUsd).toBe(4)
    expect(s.costUsd).toBe(7.5)
  })

  it('has no ratio before an exact turn exists', () => {
    expect(computeStats([]).cacheHitRatio).toBeNull()
    expect(computeStats([row({ legacy: true, costUsd: 1 })])).toMatchObject({ cacheHitRatio: null, coldCount: 0, outputShare: 0 })
  })

  it('averages the two middle contexts when the count is even', () => {
    expect(computeStats([row({ contextTokens: 10 }), row({ contextTokens: 30 })]).medianContext).toBe(20)
  })
})

describe('CapMonitor', () => {
  let clock = new Date(2026, 9, 1, 10).getTime()
  let operatorSpend = 0
  let totalSpend = 0
  let operatorCap: number | null = null
  let cfg: UsageConfig
  let caps: CapMonitor
  const since: number[] = []

  beforeEach(() => {
    clock = new Date(2026, 9, 1, 10).getTime()
    operatorSpend = 0
    totalSpend = 0
    operatorCap = null
    since.length = 0
    cfg = { dailyBudgetUsd: 100, operatorDailyCapUsd: 10, capWarnPct: 80, coldThresholdPct: 50 }
    caps = new CapMonitor({
      now: () => clock,
      config: () => cfg,
      operatorSpend: (_id, s) => (since.push(s), operatorSpend),
      totalSpend: () => totalSpend,
      operatorCap: () => operatorCap,
    })
  })

  it('stays quiet under the warn threshold', () => {
    operatorSpend = 7.9
    expect(caps.check(1)).toEqual([])
    expect(caps.isPaused(1)).toBe(false)
  })

  it('warns once at 80% and pauses once at 100%', () => {
    operatorSpend = 8
    expect(caps.check(1)).toMatchObject([{ action: 'warn', scope: 'operator', operatorId: 1, capUsd: 10, pct: 80 }])
    expect(caps.check(1)).toEqual([])
    expect(caps.isPaused(1)).toBe(false)
    operatorSpend = 10
    expect(caps.check(1)).toMatchObject([{ action: 'pause', scope: 'operator', operatorId: 1, spentUsd: 10 }])
    expect(caps.check(1)).toEqual([])
    expect(caps.isPaused(1)).toBe(true)
    expect(caps.isPaused(2)).toBe(false)
    expect(caps.pausedOperators()).toEqual([1])
  })

  it('goes straight to pause when one turn jumps past the cap', () => {
    operatorSpend = 15
    expect(caps.check(1).map((d) => d.action)).toEqual(['pause'])
    expect(caps.check(1)).toEqual([])
  })

  it('uses the operator override over the default, and 0 or off disables', () => {
    operatorCap = 2
    operatorSpend = 2
    expect(caps.check(1).map((d) => d.action)).toEqual(['pause'])
    caps.resetOperator(1)
    operatorCap = 0
    expect(caps.check(1)).toEqual([])
    operatorCap = null
    cfg.operatorDailyCapUsd = 0
    expect(caps.check(1)).toEqual([])
  })

  it('pauses every operator when the daily budget is reached', () => {
    totalSpend = 80
    expect(caps.check(1)).toMatchObject([{ action: 'warn', scope: 'daily', operatorId: null }])
    totalSpend = 100
    expect(caps.check(2)).toMatchObject([{ action: 'pause', scope: 'daily', operatorId: null, capUsd: 100 }])
    expect(caps.dailyPaused()).toBe(true)
    expect(caps.isPaused(1)).toBe(true)
    expect(caps.isPaused(99)).toBe(true)
    expect(caps.check(1)).toEqual([])
  })

  it('rolls over at midnight: state clears and the window restarts', () => {
    operatorSpend = 10
    caps.check(1)
    expect(caps.isPaused(1)).toBe(true)
    clock += 24 * HOUR
    operatorSpend = 0
    caps.check(1)
    expect(caps.isPaused(1)).toBe(false)
    operatorSpend = 8
    expect(caps.check(1).map((d) => d.action)).toEqual(['warn'])
    expect(since.at(-1)).toBe(new Date(2026, 9, 2).getTime())
  })

  it('resumes when the cap is raised and fires again at the new cap', () => {
    operatorSpend = 10
    caps.check(1)
    cfg.operatorDailyCapUsd = 20
    expect(caps.check(1)).toEqual([])
    expect(caps.isPaused(1)).toBe(false)
    operatorSpend = 20
    expect(caps.check(1).map((d) => d.action)).toEqual(['pause'])
  })

  it('resets an operator cap by counting spend from the reset on', () => {
    operatorSpend = 10
    caps.check(1)
    caps.resetOperator(1)
    expect(caps.isPaused(1)).toBe(false)
    operatorSpend = 0
    caps.check(1)
    expect(since.at(-1)).toBe(clock)
    expect(caps.check(1)).toEqual([])
    operatorSpend = 8
    expect(caps.check(1).map((d) => d.action)).toEqual(['warn'])
  })

  it('a pause does not survive midnight even when nothing re-checks', () => {
    operatorSpend = 10
    totalSpend = 100
    caps.check(1)
    expect(caps.isPaused(1)).toBe(true)
    clock += 24 * HOUR
    expect(caps.isPaused(1)).toBe(false)
    expect(caps.pausedOperators()).toEqual([])
    expect(caps.dailyPaused()).toBe(false)
  })

  it('treats float sums within an epsilon of the cap as reaching it', () => {
    cfg.operatorDailyCapUsd = 0.7
    operatorSpend = 0.6999999999999999
    expect(operatorSpend).toBeLessThan(0.7)
    expect(caps.check(1).map((d) => d.action)).toEqual(['pause'])
    caps.resetOperator(1)
    operatorSpend = 0.7 - 1e-6
    expect(caps.check(1).map((d) => d.action)).toEqual(['warn'])
  })

  it('resets the daily cap', () => {
    totalSpend = 100
    caps.check()
    expect(caps.dailyPaused()).toBe(true)
    caps.resetDaily()
    expect(caps.dailyPaused()).toBe(false)
    totalSpend = 0
    expect(caps.check()).toEqual([])
    totalSpend = 100
    expect(caps.check().map((d) => d.action)).toEqual(['pause'])
  })
})

describe('UsageTracker', () => {
  let dir = ''
  let store: Store
  let file = ''
  let clock = new Date(2026, 9, 1, 12).getTime()
  let job: number | null = null
  let opId = 0
  let jobIds: number[] = []
  let tracker: UsageTracker
  let n = 0

  const line = (usage: object, content: unknown[] = [{ type: 'text', text: 'x' }], id = `msg_${++n}`, model = 'claude-opus-5-5') =>
    JSON.stringify({ type: 'assistant', timestamp: new Date(clock).toISOString(), message: { id, model, usage, content } }) + '\n'

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'operant-usage-'))
    file = join(dir, 's.jsonl')
    clock = new Date(2026, 9, 1, 12).getTime()
    job = null
    n = 0
    store = new Store(':memory:', () => clock)
    const crew = store.createCrew('c', '/p')
    const squad = store.createSquad(crew.id, 'dev')
    opId = store.createOperator(squad.id, 'impl', 'claude', 'claude-opus-5-5').id
    jobIds = [1, 2, 3].map((i) => store.createJob({ crewId: crew.id, title: `j${i}` }).id)
    tracker = new UsageTracker({
      store,
      now: () => clock,
      config: { operatorDailyCapUsd: 0.01, dailyBudgetUsd: 0, capWarnPct: 80 },
      currentJob: () => job,
    })
    writeFileSync(file, '')
    tracker.attach(opId, file, 'sess-1')
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const rows = () =>
    store.db.prepare('SELECT * FROM usage WHERE operator_id = ? ORDER BY id').all(opId) as Array<Record<string, number | string | null>>

  it('stores the five kinds, session, model, context, tool use and the current job', () => {
    job = jobIds[0]!
    appendFileSync(
      file,
      line(
        {
          input_tokens: 3,
          output_tokens: 20,
          cache_read_input_tokens: 5_000,
          cache_creation_input_tokens: 300,
          cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
        },
        [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }],
      ),
    )
    tracker.poll()
    expect(rows()).toMatchObject([
      {
        session_id: 'sess-1',
        model: 'claude-opus-5-5',
        job_id: jobIds[0],
        input_tokens: 3,
        output_tokens: 20,
        cache_read: 5_000,
        cache_w5m: 100,
        cache_w1h: 200,
        context_tokens: 5_303,
        cold: 0,
        tool_use: 1,
        legacy: 0,
      },
    ])
  })

  it('merges the content blocks of one message into one row with tool use set', () => {
    const usage = { input_tokens: 1, output_tokens: 5, cache_read_input_tokens: 100 }
    appendFileSync(file, line(usage, [{ type: 'text', text: 'a' }], 'm1') + line(usage, [{ type: 'tool_use', name: 'X' }], 'm1') + line(usage, [{ type: 'text', text: 'b' }], 'm1'))
    tracker.poll()
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toMatchObject({ tool_use: 1 })
  })

  it('applies the cold rule across turns: first turn, genuine cold, compaction', () => {
    const big = { input_tokens: 1, cache_read_input_tokens: 99_000, cache_creation_input_tokens: 1_000 }
    appendFileSync(file, line({ input_tokens: 1, cache_creation_input_tokens: 90_000 })) // first turn, all writes
    appendFileSync(file, line(big))
    appendFileSync(file, line({ input_tokens: 1, cache_creation_input_tokens: 100_000, cache_creation: { ephemeral_1h_input_tokens: 100_000 } })) // genuine cold
    appendFileSync(file, line({ input_tokens: 1, cache_creation_input_tokens: 30_000 })) // context fell from 100K to 30K: compaction
    tracker.poll()
    expect(rows().map((r) => r.cold)).toEqual([0, 0, 1, 0])
    const s = tracker.stats(opId, 0)
    expect(s.coldCount).toBe(1)
    expect(s.turns).toBe(4)
  })

  it('starts a new session with no previous turn', () => {
    appendFileSync(file, line({ input_tokens: 1, cache_read_input_tokens: 100_000 }))
    tracker.poll()
    const second = join(dir, 's2.jsonl')
    writeFileSync(second, line({ input_tokens: 1, cache_creation_input_tokens: 100_000 }))
    tracker.attach(opId, second, 'sess-2')
    tracker.poll()
    expect(rows().map((r) => r.cold)).toEqual([0, 0])
    expect(rows()[1]).toMatchObject({ session_id: 'sess-2' })
  })

  it('does not re-attribute old messages to a later job when re-read', () => {
    job = jobIds[0]!
    appendFileSync(file, line({ input_tokens: 1 }, undefined, 'a'))
    tracker.poll()
    job = jobIds[1]!
    tracker.attach(opId, file, 'sess-1')
    appendFileSync(file, line({ input_tokens: 1 }, undefined, 'b'))
    tracker.poll()
    expect(rows().map((r) => [r.message_id, r.job_id])).toEqual([
      ['a', jobIds[0]],
      ['b', jobIds[1]],
    ])
  })

  it('tracks cost per job and per-operator live stats', () => {
    tracker.setConfig({ operatorDailyCapUsd: 0 })
    job = jobIds[0]!
    appendFileSync(file, line({ input_tokens: 1_000_000 })) // $4
    tracker.poll()
    job = jobIds[1]!
    appendFileSync(file, line({ input_tokens: 500_000 })) // $2
    tracker.poll()
    job = null
    appendFileSync(file, line({ cache_read_input_tokens: 1_000_000 })) // $0.2
    tracker.poll()
    const s = tracker.stats(opId, 0)
    expect(s.costPerJob.map((j) => [j.jobId, j.costUsd])).toEqual([
      [jobIds[0], 4],
      [jobIds[1], 2],
    ])
    expect(s.unattributedUsd).toBeCloseTo(0.2, 8)
    expect(s.cacheHitRatio).toBeCloseTo(1_000_000 / 2_500_000, 8)
    expect(s.medianContext).toBe(1_000_000)
    expect(tracker.stats(opId, clock + HOUR).turns).toBe(0)
  })

  it('emits usage, cost and cap events and never touches a session', () => {
    const events: string[] = []
    const caps: CapDecision[] = []
    tracker.on('usage', (e) => events.push(`usage:${e.context.contextTokens}`))
    tracker.on('cost', (e) => events.push(`cost:${e.costUsd.toFixed(4)}:${e.operatorSpendToday.toFixed(4)}`))
    tracker.on('cap', (d) => caps.push(d))
    appendFileSync(file, line({ input_tokens: 2_000 })) // $0.008 = 80% of the 0.01 cap
    tracker.poll()
    expect(events).toEqual(['usage:2000', 'cost:0.0080:0.0080'])
    expect(caps.map((d) => d.action)).toEqual(['warn'])
    appendFileSync(file, line({ input_tokens: 1_000 })) // total 0.012
    tracker.poll()
    expect(caps.map((d) => d.action)).toEqual(['warn', 'pause'])
    expect(caps[1]).toMatchObject({ scope: 'operator', operatorId: opId })
    expect(tracker.caps.isPaused(opId)).toBe(true)
    appendFileSync(file, line({ input_tokens: 1_000 }))
    tracker.poll()
    expect(caps).toHaveLength(2)
  })

  it('rebuilds pause state from stored spend after a restart', () => {
    appendFileSync(file, line({ input_tokens: 5_000 })) // $0.02, over the 0.01 cap
    tracker.setConfig({ operatorDailyCapUsd: 0 })
    tracker.poll()
    tracker.setConfig({ operatorDailyCapUsd: 0.01 })
    const fresh = new UsageTracker({ store, now: () => clock, config: { operatorDailyCapUsd: 0.01 } })
    expect(fresh.caps.isPaused(opId)).toBe(false)
    const got: CapDecision[] = []
    fresh.on('cap', (d) => got.push(d))
    expect(fresh.checkCaps().map((d) => d.action)).toEqual(['pause'])
    expect(got).toHaveLength(1)
    expect(fresh.caps.isPaused(opId)).toBe(true)
    clock += 24 * HOUR
    expect(fresh.caps.isPaused(opId)).toBe(false)
  })

  it('costs an unpriced model at the fallback rate and flags it', () => {
    tracker.setConfig({ operatorDailyCapUsd: 0 })
    appendFileSync(file, line({ input_tokens: 1_000_000 }, undefined, 'u1', 'acme-9'))
    tracker.poll()
    const s = tracker.stats(opId, 0)
    expect(s.costUsd).toBeCloseTo(10)
    expect(s.unpriced).toBe(true)
    expect(computeStats([]).unpriced).toBe(false)
  })

  it('pauses on the daily budget counting every operator and scratch usage', () => {
    tracker.setConfig({ operatorDailyCapUsd: 0, dailyBudgetUsd: 1 })
    const scratch = store.db
      .prepare("INSERT INTO scratch (crew_id, title, agent, cwd, created_at) VALUES (1, 't', 'shell', '/p', 1) RETURNING id")
      .get() as { id: number }
    store.addUsage({ scratchId: scratch.id, at: clock, inputTokens: 0, outputTokens: 0, costUsd: 0.9 })
    const caps: CapDecision[] = []
    tracker.on('cap', (d) => caps.push(d))
    appendFileSync(file, line({ input_tokens: 25_000 })) // $0.1
    tracker.poll()
    expect(caps).toMatchObject([{ action: 'pause', scope: 'daily', operatorId: null }])
    expect(tracker.caps.isPaused(opId)).toBe(true)
  })
})
