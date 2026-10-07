import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SubagentReader, type ReaderFs } from './agents'
import { MasterRegistry, type MasterStart } from './master'
import { RunManager } from './runs'
import { RunServices, type RunServicesDeps } from './runservices'
import { Store } from './store'

const tick = () => new Promise((r) => setTimeout(r, 5))
const status = { state: 'running', url: 'u', detail: '', managed: true } as const

describe('run services around a job', () => {
  let store: Store
  let crewId: number
  let starts: MasterStart[]
  let ends: Array<(r: { ok: boolean; text: string }) => void>
  let retained: Array<{ content: string; tags: string[] }>
  let ticks: Array<() => void>
  let cleared: unknown[]
  let reindexed: string[]

  const services = (over: Partial<RunServicesDeps> = {}) =>
    new RunServices({
      store,
      hindsight: { recall: async () => ({ ok: true, items: ['old lesson'] }), retain: async (_b, content, tags) => (retained.push({ content, tags }), { ok: true }), status: async () => status, act: async () => status },
      explorer: { explore: async () => ({ ok: true, text: 'graph' }) },
      git: async (_f, a) => (a[1] === '--name-only' ? 'a.ts\n' : ''),
      indexStatus: () => ({ initialized: true, indexing: false, files: 3, symbols: 9, edges: 4 }),
      reindex: async (f) => void reindexed.push(f),
      reader: new SubagentReader({ store, children: async () => [{ id: 'c1', title: 't', agent: 'explore', directory: '' }] }),
      cliAvailable: () => true,
      setInterval: (fn) => (ticks.push(fn), ticks.length),
      clearInterval: (t) => void cleared.push(t),
      ...over,
    })

  const manager = (svc: RunServices) =>
    new RunManager({
      store,
      adapters: new MasterRegistry().register('opencode', {
        start: async (o) => {
          starts.push(o)
          return { stop: async () => {}, done: new Promise((r) => ends.push(r)) }
        },
      }),
      brief: svc.brief,
      onSession: svc.onSession,
      onFinished: svc.onFinished,
    })

  beforeEach(() => {
    store = new Store(':memory:')
    crewId = store.createCrew('shop', '/code/shop').id
    starts = []
    ends = []
    retained = []
    ticks = []
    cleared = []
    reindexed = []
  })
  afterEach(() => store.close())

  it('gives the Master a first prompt with both parts', async () => {
    manager(services()).submit({ mode: 'background', crewId, task: 'Fix `tierOf`', masterCli: 'opencode' })
    await tick()
    expect(starts[0]!.prompt).toContain('old lesson')
    expect(starts[0]!.prompt).toContain('graph')
  })

  it('runs the job with both services down and says so in the brief', async () => {
    const svc = services({
      hindsight: { recall: async () => { throw new Error('x') }, retain: async () => { throw new Error('x') }, status: async () => status, act: async () => status },
      explorer: { explore: async () => { throw new Error('y') } },
    })
    const m = manager(svc)
    const run = m.submit({ mode: 'background', crewId, task: 'Fix `tierOf`', masterCli: 'opencode' })
    await tick()
    expect(starts[0]!.prompt).toMatch(/could not be reached/)
    ends[0]!({ ok: true, text: 'done anyway' })
    await tick()
    expect(store.getRun(run.id)).toMatchObject({ status: 'done', outcome: 'done anyway' })
  })

  it('reads subagents while the job works, then writes back and re-syncs when it ends', async () => {
    const m = manager(services())
    const run = m.submit({ mode: 'background', crewId, task: 'Fix `tierOf`', masterCli: 'opencode' })
    await tick()
    starts[0]!.onEvent({ kind: 'session', text: 'ses_1' })
    await tick()
    expect(store.listJobAgents(run.id).map((a) => [a.seat, a.status])).toEqual([['explore', 'working']])
    expect(ticks).toHaveLength(1)
    ends[0]!({ ok: true, text: 'Changed tierOf' })
    await tick()
    expect(cleared).toHaveLength(1)
    expect(store.listJobAgents(run.id)[0]!.status).toBe('done')
    expect(retained[0]!.content).toContain('Changed tierOf')
    expect(retained[0]!.tags).toContain('file:a.ts')
    expect(reindexed).toEqual(['/code/shop'])
  })

  it('tells listeners when the agent list changes, and only then', async () => {
    const seen: number[] = []
    const m = manager(services({ onAgents: (r) => void seen.push(r.id) }))
    const run = m.submit({ mode: 'background', crewId, task: 't', masterCli: 'opencode' })
    await tick()
    starts[0]!.onEvent({ kind: 'session', text: 'ses_1' })
    await tick()
    expect(seen).toEqual([run.id])
    ticks[0]!()
    await tick()
    expect(seen).toEqual([run.id])
    ends[0]!({ ok: true, text: 'ok' })
    await tick()
    expect(seen).toEqual([run.id, run.id])
  })

  it('does not write back a job cancelled before it started', async () => {
    const m = manager(services())
    m.setConcurrency(1)
    m.submit({ mode: 'background', crewId, task: 'first', masterCli: 'opencode' })
    const second = m.submit({ mode: 'background', crewId, task: 'second', masterCli: 'opencode' })
    await m.stop(second.id)
    await tick()
    expect(retained).toEqual([])
  })

  it('reports project health for both services', async () => {
    const fs: ReaderFs = { list: () => [], read: () => null, mtime: (f) => (f.endsWith('codegraph.db') ? 100 : 200) }
    const h = await services({ fs }).health(crewId)
    expect(h!.hindsight).toMatchObject({ state: 'running', bank: expect.stringMatching(/^operant-shop-/) })
    expect(h!.codegraph).toMatchObject({ cliAvailable: true, initialized: true, files: 3, symbols: 9, lastIndexedAt: 100, stale: true })
    const fresh = await services({ fs: { ...fs, mtime: () => 100 } }).health(crewId)
    expect(fresh!.codegraph.stale).toBe(false)
    const down = await services({ fs, hindsight: { recall: async () => ({ ok: false, error: '' }), retain: async () => ({ ok: false, error: '' }), status: async () => ({ ...status, state: 'no-uv' }), act: async () => status }, indexStatus: () => ({ initialized: false, indexing: false, files: 0, symbols: 0, edges: 0 }) }).health(crewId)
    expect(down!.hindsight.state).toBe('no-uv')
    expect(down!.codegraph).toMatchObject({ initialized: false, lastIndexedAt: null, stale: false })
    expect(await services().health(999)).toBeNull()
  })
})
