import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CrewIndexes } from './codegraph'
import { MasterRegistry } from './master'
import { Operant, OperantError } from './operant'
import { RunServices } from './runservices'
import { SubagentReader } from './agents'
import { SessionManager } from './sessions'
import { Store } from './store'

const indexes = { status: () => ({ initialized: false }), index: async () => ({}) } as unknown as CrewIndexes

describe('teams, jobs and presets over IPC', () => {
  let store: Store
  let op: Operant
  let started: string[]
  let crewId: number

  beforeEach(async () => {
    store = new Store(':memory:')
    started = []
    const masters = new MasterRegistry().register('claude', {
      start: async (o) => {
        started.push(o.prompt)
        return { stop: async () => {}, done: new Promise(() => {}) }
      },
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
        git: async () => '',
        indexStatus: () => ({ initialized: false, indexing: false, files: 0, symbols: 0, edges: 0 }),
        reindex: async () => undefined,
        reader: new SubagentReader({ store, children: async () => [] }),
        cliAvailable: () => false,
      }),
    })
    crewId = (await op.handlers['crews:create']({ name: 'shop', folder: '/shop' })).id
  })
  afterEach(() => store.close())

  it('creates, edits and deletes a team', async () => {
    const preset = (await op.handlers['presets:list']())[0]!
    const team = await op.handlers['teams:create']({ name: 'duo', seats: [{ presetId: preset.id, count: 2, model: 'claude-sonnet-5-5' }], limits: { maxWorkers: 2, topTier: '', tokenBudget: 0 } })
    expect(team.seats).toHaveLength(1)
    const edited = await op.handlers['teams:update'](team.id, { rules: 'check twice', limits: { maxWorkers: 1, topTier: 'sonnet', tokenBudget: 0 } })
    expect(edited).toMatchObject({ rules: 'check twice', limits: { maxWorkers: 1, topTier: 'sonnet' } })
    await op.handlers['teams:delete'](team.id)
    expect((await op.handlers['teams:list']()).filter((t) => !t.builtin)).toEqual([])
  })

  it('refuses bad team input', async () => {
    await expect(async () => op.handlers['teams:create']({ name: ' ' })).rejects.toBeInstanceOf(OperantError)
    await expect(async () => op.handlers['teams:create']({ name: 'x', seats: [{ presetId: 999, count: 1, model: 'sonnet' }] })).rejects.toThrow(/not found/)
    await expect(async () => op.handlers['teams:create']({ name: 'x', limits: { maxWorkers: -1, topTier: '', tokenBudget: 0 } })).rejects.toThrow(/Max workers/)
  })

  it('refuses a job over its team limits and starts one within them', async () => {
    const preset = (await op.handlers['presets:list']())[0]!
    const team = await op.handlers['teams:create']({ name: 'duo', seats: [{ presetId: preset.id, count: 3, model: 'claude-sonnet-5-5' }], limits: { maxWorkers: 2, topTier: '', tokenBudget: 0 } })
    await expect(async () => op.handlers['runs:create']({ crewId, task: 'go', masterCli: 'claude', teamId: team.id })).rejects.toMatchObject({ code: 'CONFLICT', message: /allows 2 workers and the run asks for 3/ })
    expect(await op.handlers['runs:list'](crewId)).toEqual([])
    const run = await op.handlers['runs:create']({ crewId, task: 'go', masterCli: 'claude', teamId: team.id, seats: [{ presetId: preset.id, count: 2, model: 'claude-sonnet-5-5' }] })
    expect(run.id).toBe(20001)
    await new Promise((r) => setTimeout(r, 0))
    expect(started).toHaveLength(1)
    expect((await op.handlers['runs:get'](run.id)).status).toBe('working')
    const stopped = await op.handlers['runs:stop'](run.id)
    expect(stopped.status).toBe('failed')
    await expect(async () => op.handlers['runs:stop'](run.id)).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('edits a queued job, deletes a finished one and refuses the rest', async () => {
    const a = await op.handlers['runs:create']({ crewId, task: 'one', masterCli: 'claude' })
    const b = await op.handlers['runs:create']({ crewId, task: 'two', masterCli: 'claude' })
    await new Promise((r) => setTimeout(r, 0))
    expect((await op.handlers['runs:update'](b.id, { task: 'two v2' })).task).toBe('two v2')
    await expect(async () => op.handlers['runs:update'](a.id, { task: 'x' })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(async () => op.handlers['runs:delete'](a.id)).rejects.toMatchObject({ code: 'CONFLICT', message: /stop it/ })
    await op.handlers['runs:stop'](a.id)
    await op.handlers['runs:delete'](a.id)
    await expect(async () => op.handlers['runs:get'](a.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(async () => op.handlers['runs:delete'](a.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('returns an agent log, and [] for an unknown agent', async () => {
    const run = await op.handlers['runs:create']({ crewId, task: 'one', masterCli: 'claude' })
    expect(await op.handlers['runs:agentLog'](run.id, 12345)).toEqual([])
    await expect(async () => op.handlers['runs:agentLog'](99999, 1)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('stores the queue limit and rejects an invalid one', async () => {
    expect(await op.handlers['runs:getLimit']()).toBe(1)
    expect(await op.handlers['runs:setLimit'](3)).toBe(3)
    expect(await op.handlers['runs:getLimit']()).toBe(3)
    await expect(async () => op.handlers['runs:setLimit'](0)).rejects.toBeInstanceOf(OperantError)
  })

  it('validates and saves the new preset fields, accepting opencode', async () => {
    const preset = await op.handlers['presets:create']({ name: 'oc', agent: 'opencode', model: 'm', permissionMode: 'dontAsk', skills: ['x'], hindsight: false })
    expect(preset).toMatchObject({ agent: 'opencode', skills: ['x'], hindsight: false, codegraph: true })
    await expect(async () => op.handlers['presets:update'](preset.id, { skills: [1] as never })).rejects.toThrow(/Skills/)
    await expect(async () => op.handlers['presets:update'](preset.id, { codegraph: 'yes' as never })).rejects.toThrow(/on or off/)
    await expect(async () => op.handlers['presets:update'](preset.id, { agent: 'gemini' as never })).rejects.toThrow(/claude, opencode/)
    expect((await op.handlers['presets:update'](preset.id, { codegraph: false })).codegraph).toBe(false)
  })

  it('reorders projects and saves Discord channels', async () => {
    const b = await op.handlers['crews:create']({ name: 'b', folder: '/b' })
    const order = await op.handlers['crews:reorder']([b.id, crewId])
    expect(order.sort((x, y) => x.sortOrder - y.sortOrder).map((c) => c.name)).toEqual(['b', 'shop'])
    const crew = await op.handlers['crews:update'](crewId, { discordChannels: ['1234567890', ' 1234567890 '] })
    expect(crew.discordChannels).toEqual(['1234567890'])
    await expect(async () => op.handlers['crews:update'](crewId, { discordChannels: ['abc'] })).rejects.toThrow(/Discord channel ids/)
  })
})
