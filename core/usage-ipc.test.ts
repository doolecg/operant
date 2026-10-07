import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CapEvent } from '../shared/types'
import type { CrewIndexes } from './codegraph'
import { MasterRegistry } from './master'
import { Operant, type FileDialogs } from './operant'
import { ProviderMonitor } from './providers'
import { RunServices } from './runservices'
import { SubagentReader } from './agents'
import { SessionManager } from './sessions'
import { Store } from './store'
import { UsageIngest } from './usage-ingest'
import { encodeProjectDir } from './transcripts'

const indexes = { status: () => ({ initialized: false }), index: async () => ({}) } as unknown as CrewIndexes
const tick = () => new Promise((r) => setTimeout(r, 30))

describe('usage, budgets, export, import and providers over IPC', () => {
  let store: Store
  let op: Operant
  let dir: string
  let crewId: number
  let caps: CapEvent[]
  let saveTo: string | null
  let started: number
  let stopped: number

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'operant-uipc-'))
    store = new Store(':memory:')
    started = 0
    stopped = 0
    saveTo = join(dir, 'out.csv')
    const dialogs: FileDialogs = { save: async () => saveTo, open: async () => join(dir, 'in.json') }
    op = new Operant({
      store,
      sessions: new SessionManager(() => {
        throw new Error('no pty')
      }),
      indexes,
      pluginDir: '/plugin',
      masters: new MasterRegistry().register('claude', {
        start: async () => {
          started++
          return { stop: async () => void stopped++, done: new Promise(() => undefined) }
        },
      }),
      runServices: new RunServices({
        store,
        hindsight: { recall: async () => ({ ok: true, items: [] }), retain: async () => ({ ok: true }), status: async () => ({ state: 'stopped', url: '', detail: '', managed: true }), act: async () => ({ state: 'stopped', url: '', detail: '', managed: true }) },
        explorer: { explore: async () => ({ ok: false, error: 'off' }) },
        git: async () => '',
        indexStatus: () => ({ initialized: false, indexing: false, files: 0, symbols: 0, edges: 0 }),
        reindex: async () => undefined,
        reader: new SubagentReader({ store, children: async () => [] }),
        cliAvailable: () => false,
      }),
      ingest: new UsageIngest({ store, projectsDir: () => join(dir, 'projects'), frontDeskCwd: join(dir, 'fd') }),
      providers: new ProviderMonitor({ store, fetch: async () => { throw new Error('offline') }, readFile: () => null, seatEnvs: () => [], openCodeDb: () => join(dir, 'none.db'), openCodeStats: async () => null }),
      fileDialogs: dialogs,
    })
    caps = []
    op.on('caps', (c) => caps.push(c))
    mkdirSync(join(dir, 'proj'))
    crewId = (await op.handlers['crews:create']({ name: 'shop', folder: join(dir, 'proj') })).id
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  const spend = (key: string, cost: number, extra: { runId?: number } = {}) =>
    store.upsertKeyedUsage({ extKey: key, at: Date.now(), crewId, model: 'claude-sonnet-5-5', source: 'agent', seat: 'fix', inputTokens: 10, outputTokens: 5, costUsd: cost, ...extra }, false)

  it('holds a project queue at its daily cap and starts the run on resume', async () => {
    await op.handlers['budgets:set']({ projectDailyUsd: { [String(crewId)]: 1 } })
    spend('a', 0.85)
    op.pollRunUsage()
    expect(caps).toMatchObject([{ action: 'warn', scope: 'project', crewId }])
    spend('b', 0.2)
    op.pollRunUsage()
    expect(caps.at(-1)).toMatchObject({ action: 'pause', scope: 'project', crewId })
    const run = await op.handlers['runs:create']({ mode: 'background', crewId, task: 'go', masterCli: 'claude' })
    await tick()
    expect(started).toBe(0)
    expect((await op.handlers['runs:get'](run.id)).status).toBe('queued')
    const status = await op.handlers['budgets:get']()
    expect(status.held).toEqual([{ crewId, reason: expect.stringMatching(/daily budget/) }])
    expect(status.projects[0]).toMatchObject({ crewId, capUsd: 1, paused: true })
    // Raising the cap lets it start.
    await op.handlers['budgets:set']({ projectDailyUsd: { [String(crewId)]: 5 } })
    await tick()
    expect(started).toBe(1)
    expect((await op.handlers['runs:get'](run.id)).status).toBe('working')
  })

  it('resumes a held project without raising the cap', async () => {
    await op.handlers['budgets:set']({ projectDailyUsd: { [String(crewId)]: 1 } })
    spend('a', 1.5)
    op.pollRunUsage()
    const run = await op.handlers['runs:create']({ mode: 'background', crewId, task: 'go', masterCli: 'claude' })
    await tick()
    expect(started).toBe(0)
    await op.handlers['budgets:resume']({ scope: 'project', crewId })
    await tick()
    expect((await op.handlers['runs:get'](run.id)).status).toBe('working')
    await expect(async () => op.handlers['budgets:resume']({ scope: 'project', crewId: 999 })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(async () => op.handlers['budgets:resume']({ scope: 'x' } as never)).rejects.toMatchObject({ code: 'BAD_ARGS' })
  })

  it('stops a job that passes its own cap when asked to, and the daily budget holds every queue', async () => {
    await op.handlers['budgets:set']({ jobDefaultUsd: 0.5, stopJobAtCap: true })
    const run = await op.handlers['runs:create']({ mode: 'background', crewId, task: 'go', masterCli: 'claude' })
    await tick()
    expect((await op.handlers['runs:get'](run.id)).status).toBe('working')
    spend('j1', 0.6, { runId: run.id })
    op.pollRunUsage()
    await tick()
    expect(await op.handlers['runs:get'](run.id)).toMatchObject({ status: 'failed', outcome: 'Stopped: the job reached its budget' })
    expect(stopped).toBe(1)
    expect(caps.at(-1)).toMatchObject({ action: 'pause', scope: 'job', runId: run.id })

    await op.handlers['settings:set']({ dailyBudgetUsd: 1 })
    spend('j2', 1, {})
    op.usage.checkCaps()
    op.pollRunUsage()
    const next = await op.handlers['runs:create']({ mode: 'background', crewId, task: 'again', masterCli: 'claude' })
    await tick()
    expect((await op.handlers['runs:get'](next.id)).status).toBe('queued')
    expect((await op.handlers['budgets:get']()).held[0]).toEqual({ crewId: null, reason: expect.stringMatching(/daily budget/) })
    await op.handlers['budgets:set']({ pauseQueue: false })
    await tick()
    expect((await op.handlers['runs:get'](next.id)).status).toBe('working')
  })

  it('reports, series, job breakdown and export through the handlers', async () => {
    const run = await op.handlers['runs:create']({ mode: 'background', crewId, task: 'go', masterCli: 'claude' })
    spend('r1', 0.5, { runId: run.id })
    spend('r2', 0.25, { runId: run.id })
    const report = await op.handlers['usage:report']({ groupBy: ['run'], filter: { crewId, bogus: 1 } as never })
    expect(report.rows[0]).toMatchObject({ labels: [`JOB#${run.id}`], turns: 2 })
    expect(report.totals.costUsd).toBeCloseTo(0.75, 9)
    expect((await op.handlers['usage:timeseries']({ bucket: 'day' })).points).toHaveLength(1)
    expect((await op.handlers['usage:job'](run.id)).totals.costUsd).toBeCloseTo(0.75, 9)
    await expect(async () => op.handlers['usage:job'](1)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(async () => op.handlers['usage:report']({ groupBy: ['nope' as never] })).rejects.toMatchObject({ code: 'BAD_ARGS' })

    const text = await op.handlers['usage:exportText']({ kind: 'report', query: { groupBy: ['run'] } }, 'csv')
    expect(text.text).toContain(`JOB#${run.id}`)
    const saved = await op.handlers['usage:export']({ kind: 'job', runId: run.id }, 'csv')
    expect(saved.saved).toBe(saveTo)
    expect(readFileSync(saveTo!, 'utf8')).toContain('TOTAL')
    saveTo = null
    expect(await op.handlers['usage:export']({ kind: 'job', runId: run.id }, 'json')).toEqual({ saved: null })
  })

  it('previews and applies an import, and moves data between machines', async () => {
    const legacy = join(dir, 'Operant')
    mkdirSync(join(legacy, 'store'), { recursive: true })
    mkdirSync(join(dir, 'repo-a'))
    writeFileSync(join(legacy, 'config.json'), JSON.stringify({ projectGroups: [{ name: 'g', projects: [join(dir, 'repo-a')] }] }))
    writeFileSync(join(legacy, 'store', 'tokenEvents.jsonl'), JSON.stringify({ id: 't1', t: 5, corr: 'c', project: 'repo-a', model: 'claude-haiku-4-5', input: 10, output: 1, cacheRead: 0, cacheWrite: 0 }) + '\n')
    const preview = await op.handlers['import:preview']({ kind: 'legacy', dir: legacy })
    expect(preview).toMatchObject({ projects: { add: 1 }, usage: { add: 1 } })
    expect((await op.handlers['crews:list']()).map((c) => c.name)).toEqual(['shop'])
    const applied = await op.handlers['import:apply']({ kind: 'legacy', dir: legacy })
    expect(applied.applied).toBe(true)
    expect((await op.handlers['import:apply']({ kind: 'legacy', dir: legacy })).usage).toMatchObject({ add: 0, existing: 1 })
    await expect(async () => op.handlers['import:apply']({ kind: 'nope' } as never)).rejects.toMatchObject({ code: 'BAD_ARGS' })

    const out = await op.handlers['data:export']()
    expect(JSON.parse(out.text)).toMatchObject({ format: 'operant-export', projects: expect.any(Array) })
    saveTo = join(dir, 'export.json')
    expect(await op.handlers['data:exportFile']()).toEqual({ saved: saveTo })
    expect(await op.handlers['import:pickFile']()).toBe(join(dir, 'in.json'))
    expect((await op.handlers['import:preview']({ kind: 'file', path: saveTo })).usage).toMatchObject({ add: 0 })
  })

  it('feeds a job transcript into usage while it works, and reads it once more when it ends', async () => {
    const projects = join(dir, 'projects')
    const cwd = join(dir, 'proj')
    mkdirSync(join(projects, encodeProjectDir(cwd)), { recursive: true })
    const file = join(projects, encodeProjectDir(cwd), 'sess9.jsonl')
    const m = (id: string, n: number) => JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { id, model: 'claude-haiku-4-5', usage: { input_tokens: n, output_tokens: 1 }, content: [] } })
    writeFileSync(file, m('m1', 100) + '\n')
    const run = await op.handlers['runs:create']({ mode: 'background', crewId, task: 'go', masterCli: 'claude' })
    await tick()
    ;(op as unknown as { noteRunSession(r: unknown, s: string): void }).noteRunSession(store.getRun(run.id), 'sess9')
    op.pollRunUsage()
    expect((await op.handlers['usage:job'](run.id)).totals.turns).toBe(1)
    writeFileSync(file, m('m1', 100) + '\n' + m('m2', 200) + '\n')
    op.pollRunUsage()
    expect((await op.handlers['usage:job'](run.id)).totals.turns).toBe(2)
  })

  it('answers providers:status without any network', async () => {
    const s = await op.handlers['providers:refresh']()
    expect(s.providers.map((p) => p.id)).toEqual(['claude', 'zai', 'opencode'])
    expect(s.providers.find((p) => p.id === 'zai')!.state).toBe('off')
    expect(await op.handlers['providers:status']()).toMatchObject({ alerts: [] })
  })
})
