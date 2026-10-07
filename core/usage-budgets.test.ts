import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MasterRegistry, type MasterAdapter, type MasterStart } from './master'
import { RunManager } from './runs'
import { Store } from './store'
import { BudgetMonitor, DEFAULT_BUDGETS, mergeBudgets, sanitizeBudgets } from './usage-budgets'
import type { BudgetConfig } from '../shared/types'

const NOW = new Date(2026, 9, 7, 12, 0, 0).getTime()
const DAY = 86_400_000

describe('budget config', () => {
  it('drops malformed values and merges map patches key by key', () => {
    expect(sanitizeBudgets({ projectDailyUsd: { '1': 5, x: 3, '2': -1 }, jobDefaultUsd: 'no', pauseQueue: 'yes', jobUsd: [] })).toEqual({
      projectDailyUsd: { '1': 5 },
      jobDefaultUsd: 0,
      jobUsd: {},
      pauseQueue: true,
      stopJobAtCap: false,
    })
    const a = mergeBudgets(DEFAULT_BUDGETS, { projectDailyUsd: { '1': 5, '2': 6 }, jobDefaultUsd: 2 })
    const b = mergeBudgets(a, { projectDailyUsd: { '1': 0, '3': 1 }, pauseQueue: false })
    expect(b).toMatchObject({ projectDailyUsd: { '2': 6, '3': 1 }, jobDefaultUsd: 2, pauseQueue: false })
  })
})

describe('BudgetMonitor', () => {
  let now = NOW
  let config: BudgetConfig
  const projectSpend = new Map<number, number>()
  const jobSpend = new Map<number, number>()
  let live: Array<{ id: number; crewId: number }>
  const monitor = () =>
    new BudgetMonitor({
      now: () => now,
      config: () => config,
      warnPct: () => 80,
      crewIds: () => [1, 2],
      projectSpend: (id) => projectSpend.get(id) ?? 0,
      liveRuns: () => live,
      jobSpend: (id) => jobSpend.get(id) ?? 0,
    })
  beforeEach(() => {
    now = NOW
    config = { ...DEFAULT_BUDGETS, projectDailyUsd: { '1': 10 }, jobDefaultUsd: 4 }
    projectSpend.clear()
    jobSpend.clear()
    live = [{ id: 20001, crewId: 1 }]
  })

  it('warns once at the warn percent and pauses once at the cap, then holds the project queue', () => {
    const m = monitor()
    expect(m.check()).toEqual([])
    projectSpend.set(1, 8)
    expect(m.check()).toMatchObject([{ action: 'warn', scope: 'project', crewId: 1, capUsd: 10 }])
    expect(m.check()).toEqual([])
    projectSpend.set(1, 10)
    expect(m.check()).toMatchObject([{ action: 'pause', scope: 'project', crewId: 1, spentUsd: 10 }])
    expect(m.check()).toEqual([])
    expect(m.projectHeld(1)).toMatch(/daily budget/)
    expect(m.projectHeld(2)).toBe('')
    // The day rolls over: the count restarts and the hold lifts.
    now += DAY
    projectSpend.set(1, 0)
    expect(m.check()).toEqual([])
    expect(m.projectHeld(1)).toBe('')
  })

  it('caps a job over its whole run and holds its project while it is over', () => {
    const m = monitor()
    jobSpend.set(20001, 3.5)
    expect(m.check()).toMatchObject([{ action: 'warn', scope: 'job', runId: 20001, crewId: 1 }])
    jobSpend.set(20001, 4.2)
    expect(m.check()).toMatchObject([{ action: 'pause', scope: 'job', runId: 20001 }])
    expect(m.jobOver(20001)).toBe(true)
    expect(m.projectHeld(1)).toMatch(/JOB#20001/)
    // A cap of its own wins over the default; the job ending clears the hold.
    config = { ...config, jobUsd: { '20001': 50 } }
    expect(m.progress().jobs[0]).toMatchObject({ runId: 20001, capUsd: 50 })
    live = []
    m.check()
    expect(m.projectHeld(1)).toBe('')
  })

  it('does not hold the queue when pausing is off, and resume counts spend from now', () => {
    config = { ...config, pauseQueue: false }
    const m = monitor()
    projectSpend.set(1, 12)
    // At the cap without queue pausing it is a warning, once.
    expect(m.check()).toMatchObject([{ action: 'warn', pct: 120 }])
    expect(m.projectHeld(1)).toBe('')
    config = { ...config, pauseQueue: true }
    m.resume({ scope: 'project', crewId: 1 })
    expect(m.progress().projects[0]!.spentUsd).toBe(12)
    projectSpend.set(1, 0)
    jobSpend.set(20001, 6)
    m.check()
    m.resume({ scope: 'job', runId: 20001 })
    expect(m.progress().jobs[0]!.spentUsd).toBe(0)
    expect(m.projectHeld(1)).toBe('')
  })
})

describe('the queue hold', () => {
  class Adapter implements MasterAdapter {
    starts: MasterStart[] = []
    async start(o: MasterStart) {
      this.starts.push(o)
      return { done: new Promise<{ ok: boolean; text: string }>(() => undefined), stop: async () => undefined }
    }
  }
  let store: Store
  let adapter: Adapter
  let reason = ''
  let mgr: RunManager
  let crewId: number
  const tick = () => new Promise((r) => setTimeout(r, 0))
  beforeEach(() => {
    store = new Store(':memory:')
    adapter = new Adapter()
    reason = 'The project reached its daily budget'
    mgr = new RunManager({ store, adapters: new MasterRegistry().register('claude', adapter), brief: (r) => r.task, hold: () => reason })
    crewId = store.createCrew('a', '/a').id
  })
  afterEach(() => store.close())

  it('keeps a held run queued until the hold lifts and pumpAll runs', async () => {
    const run = mgr.submit({ mode: 'background', crewId, task: 'one', masterCli: 'claude' })
    await tick()
    expect(adapter.starts).toHaveLength(0)
    expect(store.getRun(run.id)!.status).toBe('queued')
    reason = ''
    mgr.pumpAll()
    await tick()
    expect(adapter.starts).toHaveLength(1)
    expect(store.getRun(run.id)!.status).toBe('working')
  })

  it('stops a working run with the reason given', async () => {
    reason = ''
    const run = mgr.submit({ mode: 'background', crewId, task: 'one', masterCli: 'claude' })
    await tick()
    const ended = await mgr.stop(run.id, 'Stopped: the job reached its budget')
    expect(ended).toMatchObject({ status: 'failed', outcome: 'Stopped: the job reached its budget' })
  })
})
