import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CrewIndexes } from './codegraph'
import { MasterRegistry } from './master'
import { Operant } from './operant'
import { RunServices } from './runservices'
import { SubagentReader } from './agents'
import { SessionManager } from './sessions'
import { Store } from './store'
import { TRACKER_TITLE, filesFromTags } from './tracker'

const indexes = { status: () => ({ initialized: false }), index: async () => ({}) } as unknown as CrewIndexes

describe('Update tracker job', () => {
  let store: Store
  let op: Operant
  let crewId: number

  beforeEach(async () => {
    store = new Store(':memory:')
    const masters = new MasterRegistry().register('claude', {
      start: async () => ({ stop: async () => {}, done: new Promise(() => {}) }),
    })
    op = new Operant({
      store,
      sessions: new SessionManager(() => {
        throw new Error('no pty')
      }),
      indexes,
      pluginDir: '/plugin',
      masters,
      runServices: new RunServices({
        store,
        hindsight: { recall: async () => ({ ok: true, items: [] }), retain: async () => ({ ok: true }), status: async () => ({ state: 'stopped', url: '', detail: '', managed: true }), act: async () => ({ state: 'stopped', url: '', detail: '', managed: true }) },
        explorer: { explore: async () => ({ ok: false, error: 'off' }) },
        git: async (_f, args) => (args[0] === 'diff' && args[1] === '--name-only' ? 'src/a.ts\n' : ''),
        indexStatus: () => ({ initialized: false, indexing: false, files: 0, symbols: 0, edges: 0 }),
        reindex: async () => undefined,
        reader: new SubagentReader({ store, children: async () => [] }),
        cliAvailable: () => false,
      }),
    })
    crewId = (await op.handlers['crews:create']({ name: 'shop', folder: '/shop' })).id
  })
  afterEach(() => store.close())

  const trackerJobs = async () => (await op.handlers['jobs:list'](crewId)).filter((j) => j.title === TRACKER_TITLE)

  // Starts a run and ends it (a stop fails it), then waits for the finish hook to settle.
  const finishRun = async (): Promise<number> => {
    const run = await op.handlers['runs:create']({ crewId, task: 'go', masterCli: 'claude' })
    await new Promise((r) => setTimeout(r, 0))
    await op.handlers['runs:stop'](run.id)
    await new Promise((r) => setTimeout(r, 30))
    return run.id
  }

  it('does nothing without a tracker file', async () => {
    await finishRun()
    expect(await trackerJobs()).toEqual([])
  })

  it('creates one job with the tracker, outcome, files and rule, then appends to it', async () => {
    await op.handlers['crews:update'](crewId, { trackerFile: 'docs/specs/tracker.html' })
    const first = await finishRun()
    await vi.waitFor(async () => expect(await trackerJobs()).toHaveLength(1))
    const second = await finishRun()
    await vi.waitFor(async () => expect((await trackerJobs())[0]!.body).toContain(`JOB#${second}`))
    const jobs = await trackerJobs()
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.body).toContain('Tracker: docs/specs/tracker.html')
    expect(jobs[0]!.body).toContain(`JOB#${first} failed`)
    expect(jobs[0]!.body).toContain('src/a.ts')
    expect(jobs[0]!.body).toContain('Role: Project manager')
    expect(jobs[0]!.body).toContain('tick only what was verified')
  })

  it('stays off per project and globally', async () => {
    await op.handlers['crews:update'](crewId, { trackerFile: 't.md', trackerJobs: false })
    await finishRun()
    expect(await trackerJobs()).toEqual([])
    await op.handlers['crews:update'](crewId, { trackerJobs: true })
    await op.handlers['settings:set']({ collab: { trackerJobs: false } })
    await finishRun()
    expect(await trackerJobs()).toEqual([])
  })

  it('creates it by hand, refuses without a tracker file and rejects paths outside the folder', async () => {
    await expect(async () => op.handlers['crews:trackerNow'](crewId)).rejects.toThrow(/tracker file/)
    await expect(async () => op.handlers['crews:update'](crewId, { trackerFile: '../x.md' })).rejects.toThrow(/inside the project folder/)
    await op.handlers['crews:update'](crewId, { trackerFile: 't.md' })
    await op.handlers['crews:trackerNow'](crewId)
    await op.handlers['crews:trackerNow'](crewId)
    expect(await trackerJobs()).toHaveLength(1)
    await op.handlers['crews:update'](crewId, { trackerFile: '' })
    expect((await op.handlers['crews:list']())[0]!.trackerFile).toBe('')
  })

  it('reads files from write-back tags', () => {
    expect(filesFromTags(['operant', 'file:a.ts', 'symbol:x'])).toEqual(['a.ts'])
  })
})
