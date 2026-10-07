import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildBrief, cliExplorer, extractSymbols, type Explorer } from './brief'
import { bankFor } from './hindsight'
import { Store } from './store'

describe('extractSymbols', () => {
  it('finds backticked names, paths, camelCase, CamelCase and snake_case, and nothing unsafe', () => {
    const s = extractSymbols('Fix `parseLine` in core/transcripts.ts so RunManager and job_agents work; also the thing & $(rm -rf)')
    expect(s).toEqual(expect.arrayContaining(['parseLine', 'core/transcripts.ts', 'RunManager', 'job_agents']))
    expect(s.every((x) => /^[A-Za-z0-9_./-]+$/.test(x))).toBe(true)
  })
  it('returns nothing for plain prose', () => {
    expect(extractSymbols('make the app faster')).toEqual([])
  })
})

describe('brief builder', () => {
  let store: Store
  let crewId: number
  beforeEach(() => {
    store = new Store(':memory:')
    crewId = store.createCrew('shop', '/code/shop').id
  })
  afterEach(() => store.close())

  const run = (task: string) => {
    const r = store.createRun({ crewId, task, masterCli: 'claude', teamId: null, seats: [], limits: { maxWorkers: 0, topTier: '', tokenBudget: 0 }, rules: 'be careful' })
    return r
  }
  const up = (): { explorer: Explorer; hindsight: any; calls: { q: string[]; r: Array<[string, string]> } } => {
    const calls = { q: [] as string[], r: [] as Array<[string, string]> }
    return {
      calls,
      explorer: { explore: async (_f, q) => (calls.q.push(q), { ok: true, text: 'SRC of parseLine' }) },
      hindsight: { recall: async (b: string, q: string) => (calls.r.push([b, q]), { ok: true, items: ['parseLine was changed in JOB#1'] }) },
    }
  }

  it('contains both parts, the rules, and recalls from the project bank on the same symbols', async () => {
    const d = up()
    const b = await buildBrief({ store, ...d }, run('Fix `parseLine` bug'))
    expect(b.missing).toEqual([])
    expect(b.text).toContain('Fix `parseLine` bug')
    expect(b.text).toContain('Team rules: be careful')
    expect(b.text).toContain('SRC of parseLine')
    expect(b.text).toContain('parseLine was changed in JOB#1')
    expect(b.text).toMatch(/Hindsight before you act/)
    expect(b.text).toMatch(/CodeGraph.*before grep/)
    expect(b.text).toMatch(/trust the code/)
    expect(d.calls.q).toEqual(['parseLine'])
    expect(d.calls.r[0]![0]).toBe(bankFor('/code/shop'))
    expect(d.calls.r[0]![1]).toContain('parseLine')
  })

  it('still builds with CodeGraph down and names it', async () => {
    const d = up()
    const b = await buildBrief({ store, hindsight: d.hindsight, explorer: { explore: async () => ({ ok: false, error: 'codegraph not found' }) } }, run('Fix `parseLine`'))
    expect(b.missing).toEqual(['codegraph'])
    expect(b.text).toMatch(/CodeGraph could not be reached/)
    expect(b.text).toContain('parseLine was changed')
  })

  it('still builds with Hindsight down, and when a service throws', async () => {
    const d = up()
    const b = await buildBrief({ store, explorer: d.explorer, hindsight: { recall: async () => ({ ok: false, error: 'uv missing' }) } }, run('Fix `parseLine`'))
    expect(b.missing).toEqual(['hindsight'])
    expect(b.text).toContain('Hindsight: MISSING (uv missing)')
    const both = await buildBrief(
      { store, explorer: { explore: async () => { throw new Error('boom') } }, hindsight: { recall: async () => { throw new Error('bang') } } },
      run('Fix `parseLine`'),
    )
    expect(both.missing.sort()).toEqual(['codegraph', 'hindsight'])
    expect(both.text).toMatch(/Hindsight and CodeGraph|CodeGraph and Hindsight/)
    expect(both.text).toContain('Fix `parseLine`')
  })

  it('lists seats with names, role text and skills', async () => {
    const d = up()
    const preset = store.createPreset({ name: 'Reviewer', agent: 'claude', model: 'claude-sonnet-5-5', permissionMode: 'default', roleText: 'check diffs', skills: ['simplify'] })
    const r = store.createRun({ crewId, task: 'x', masterCli: 'claude', teamId: null, seats: [{ presetId: preset.id, count: 2, model: 'claude-sonnet-5-5' }], limits: { maxWorkers: 0, topTier: '', tokenBudget: 0 }, rules: '' })
    const b = await buildBrief({ store, ...d }, r)
    expect(b.text).toContain('2 x Reviewer on claude-sonnet-5-5 (role: check diffs; skills: simplify)')
  })
})

describe('cli explorer', () => {
  it('returns the CLI output, capped, or the first error line', async () => {
    const ok = cliExplorer(async () => ({ code: 0, stdout: 'x'.repeat(20_000), stderr: '' }))
    const r = await ok.explore('/p', 'Foo')
    expect(r.ok && r.text.length).toBe(12_000)
    const bad = cliExplorer(async () => ({ code: null, stdout: '', stderr: 'spawn codegraph ENOENT' }))
    expect(await bad.explore('/p', 'Foo')).toEqual({ ok: false, error: 'spawn codegraph ENOENT' })
  })
})
