import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LearnRunInfo } from '../shared/learn'
import type { Run } from '../shared/types'
import { Closeout, windowTranscript, type CloseoutDeps } from './closeout'
import { MasterRuns } from './master-runs'
import { ApprovalMarker } from './runs'
import { Store } from './store'

const info = (o: Partial<LearnRunInfo> = {}): LearnRunInfo =>
  ({ id: 1, crewId: 1, runId: null, source: 'job', extracted: 3, written: 0, merged: 1, staled: 0, queued: 2, skipped: [], error: '', cli: 'claude', model: 'haiku', at: 0, ...o }) as LearnRunInfo

describe('close-out of an approved master-mode run', () => {
  let clock: number
  let store: Store
  let runs: MasterRuns
  let crewId: number
  let retained: Array<{ text: string; tags: string[] }>
  let learned: Array<{ id: number; transcript: string }>
  let reindexed: number
  let overrides: Partial<CloseoutDeps>
  let closeout: Closeout

  const approvedRun = (): Run => {
    const id = store.createRun({ crewId, task: 'Add a health check', masterCli: 'claude', mode: 'master' }).id
    store.setRunStatus(id, 'working')
    runs.review(id, 'Added /health and a test.', crewId)
    return runs.approve(id, 'owner-ui')
  }
  const build = () => {
    closeout = new Closeout({
      store,
      hindsight: {
        retain: async (_bank: string, text: string, tags: string[]) => {
          retained.push({ text, tags })
          return { ok: true } as never
        },
      },
      git: async (_f, args) => (args.includes('--name-only') ? 'core/health.ts\n' : ''),
      reindex: async () => {
        reindexed++
      },
      indexed: () => true,
      learnOn: () => true,
      learn: async (run, transcript) => {
        learned.push({ id: run.id, transcript })
        return info()
      },
      transcript: async () => 'assistant: did the work',
      now: () => clock,
      ...overrides,
    })
  }

  beforeEach(() => {
    clock = 1_700_000_000_000
    retained = []
    learned = []
    reindexed = 0
    overrides = {}
    store = new Store(':memory:', () => clock)
    runs = new MasterRuns({ store, approvals: new ApprovalMarker({ now: () => clock, inReview: () => [] }) }, () => clock)
    crewId = store.createCrew('shop', '/code/shop').id
    build()
  })
  afterEach(() => store.close())

  it('writes back, syncs CodeGraph and learns, then stores per-step results as run events', async () => {
    const run = approvedRun()
    expect(run.closeoutState).toBe('pending')
    const text = await closeout.request(run.id, { wait: true })
    expect(text).toBe('Close-out JOB#' + run.id + ' done: Hindsight written, CodeGraph synced, 3 lessons (2 pending your review, 1 merged)')
    expect(retained[0]!.tags).toContain('file:core/health.ts')
    expect(retained[0]!.text).toContain('Review summary: Added /health and a test.')
    expect(reindexed).toBe(1)
    expect(learned).toEqual([{ id: run.id, transcript: 'assistant: did the work' }])
    expect(store.getRun(run.id)!.closeoutState).toBe('done')
    const bodies = store.listRunEvents(run.id, { kind: 'closeout' }).map((e) => JSON.parse(e.body))
    expect(bodies.map((b) => `${b.step}:${b.result ?? b.state}`)).toEqual(['hindsight:ok', 'codegraph:ok', 'learn:ok', 'summary:done'])
    expect(bodies[2]).toMatchObject({ extracted: 3, queued: 2, merged: 1, written: 0 })
  })

  it('is refused for a run that is not approved, and running it twice does nothing', async () => {
    const id = store.createRun({ crewId, task: 'x', masterCli: 'claude', mode: 'master' }).id
    await expect(closeout.request(id)).rejects.toThrow(/not approved/)
    const run = approvedRun()
    const [a, b] = await Promise.all([closeout.request(run.id, { wait: true }), closeout.request(run.id, { wait: true })])
    expect(a).toBe(b)
    expect(await closeout.request(run.id, { wait: true })).toBe(a)
    expect(learned).toHaveLength(1)
    expect(retained).toHaveLength(1)
    expect(await closeout.request(run.id, { wait: true, force: true })).toContain('done')
    expect(learned).toHaveLength(2)
  })

  it('never throws on a failing step: it is recorded and the state is partial or failed', async () => {
    overrides = {
      hindsight: { retain: async () => ({ ok: false, error: 'Hindsight is not running' }) as never },
      indexed: () => false,
      learn: async () => {
        throw new Error('no model')
      },
    }
    build()
    const run = approvedRun()
    const text = await closeout.request(run.id, { wait: true })
    expect(text).toContain('failed')
    expect(text).toContain('skipped: Hindsight (Hindsight is not running), CodeGraph (this project has no CodeGraph index)')
    expect(store.getRun(run.id)!.closeoutState).toBe('failed')

    overrides = { learn: async () => info({ error: 'bad json', extracted: 0, queued: 0, merged: 0 }) }
    build()
    const second = approvedRun()
    await closeout.request(second.id, { wait: true })
    expect(store.getRun(second.id)!.closeoutState).toBe('partial')
  })

  it('learns nothing when learning is off, and the state is still done', async () => {
    overrides = { learnOn: () => false }
    build()
    const run = approvedRun()
    expect(await closeout.request(run.id, { wait: true })).toContain('skipped: Learning (learning is turned off)')
    expect(learned).toHaveLength(0)
    expect(store.getRun(run.id)!.closeoutState).toBe('done')
  })

  it('the fallback starts a pending close-out 120 s after the approval, at once if the Master is down, and recover restarts an interrupted one', async () => {
    const run = approvedRun()
    closeout.tick()
    await Promise.resolve()
    expect(store.getRun(run.id)!.closeoutState).toBe('pending')
    clock += 119_000
    closeout.tick()
    expect(store.getRun(run.id)!.closeoutState).toBe('pending')
    clock += 2_000
    closeout.tick()
    expect(store.getRun(run.id)!.closeoutState).toBe('running')
    await closeout.request(run.id, { wait: true })
    expect(store.getRun(run.id)!.closeoutState).toBe('done')
    expect(learned).toHaveLength(1)

    overrides = { masterLive: () => false }
    build()
    const down = approvedRun()
    closeout.tick()
    expect(store.getRun(down.id)!.closeoutState).toBe('running')
    await closeout.request(down.id, { wait: true })

    const stuck = approvedRun()
    store.updateRun(stuck.id, { closeoutState: 'running' })
    closeout.recover()
    expect(store.getRun(stuck.id)!.closeoutState).toBe('pending')
  })

  it('builds the run window of the Master session, with the review summary last', async () => {
    const id = store.createRun({ crewId, task: 'Add a health check', masterCli: 'claude', mode: 'master' }).id
    const t0 = clock
    store.setRunStatus(id, 'working')
    store.addRunEvent(id, { kind: 'delivered', source: 'system', body: '{}' })
    clock += 20_000
    runs.review(id, 'Added /health and a test.', crewId)
    clock += 20_000
    const run = runs.approve(id, 'owner-ui')
    const at = (ms: number) => new Date(t0 + ms).toISOString()
    const say = (ms: number, text: string) => ({ type: 'assistant', timestamp: at(ms), message: { role: 'assistant', content: [{ type: 'text', text }] } })
    const lines = [say(-5_000_000, 'before the run'), say(5_000, 'inside the run'), say(90_000, 'after the approval')]
    const text = await windowTranscript(
      { store, sessions: () => [{ cli: 'claude', sessionId: 's1' }], transcriptFile: () => 'f.jsonl', read: () => lines.map((l) => JSON.stringify(l)).join(String.fromCharCode(10)), now: () => clock },
      run,
    )
    expect(text).toContain('inside the run')
    expect(text).not.toContain('before the run')
    expect(text).not.toContain('after the approval')
    expect(text.endsWith('Review summary:\nAdded /health and a test.')).toBe(true)
  })
})
