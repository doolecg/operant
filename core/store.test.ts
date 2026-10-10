import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Store } from './store'

describe('store', () => {
  let store: Store
  beforeEach(() => {
    store = new Store(':memory:')
  })
  afterEach(() => store.close())

  it('keeps projects, their order and the Playground', () => {
    const a = store.createCrew('alpha', '/code/alpha')
    const b = store.createCrew('beta', '/code/beta')
    expect(store.listCrews().map((c) => c.name)).toEqual(['Playground', 'alpha', 'beta'].filter((n) => n !== 'Playground' || store.getPlayground()))
    expect(store.updateCrew(a.id, { name: 'alpha 2' }).name).toBe('alpha 2')
    expect(store.reorderCrews([b.id, a.id]).filter((c) => c.kind === 'project').map((c) => c.id)).toEqual([b.id, a.id])
    expect(() => store.deleteCrew(store.ensurePlayground('/code/pg').id)).toThrow(/Playground cannot be deleted/)
  })

  it('stores presets with guidance text, and built-in presets are seeded once', () => {
    expect(store.listPresets().some((p) => p.builtin !== null)).toBe(true)
    const p = store.createPreset({ name: 'mine', agent: 'claude', model: 'sonnet', permissionMode: 'default', roleText: 'be brief' })
    expect(store.getPreset(p.id)).toMatchObject({ name: 'mine', roleText: 'be brief', builtin: null })
    expect(store.duplicatePreset(p.id).name).toBe('mine copy')
  })

  it('keeps teams as plain text (no seats)', () => {
    const t = store.createTeam({ name: 'Pair', rules: 'Two people, one diff.', description: 'Small.' })
    expect(store.updateTeam(t.id, { rules: 'Changed.' })).toMatchObject({ name: 'Pair', rules: 'Changed.', description: 'Small.' })
    expect(store.listTeams().some((x) => x.builtin !== null)).toBe(true)
  })

  it('records tile spend per project and the event log', () => {
    const crew = store.createCrew('alpha', '/code/alpha')
    const tile = store.createScratch({ crewId: crew.id, title: 'shell', agent: 'claude', cwd: '/code/alpha' })
    store.upsertMessageUsage('m1', { scratchId: tile.id, at: Date.now(), model: 'sonnet', inputTokens: 1, outputTokens: 1, costUsd: 0.5 })
    expect(store.spendSince(0, crew.id)).toBeCloseTo(0.5)
    expect(store.scratchSpend(crew.id, 0)).toEqual([{ scratchId: tile.id, costUsd: 0.5, turns: 1 }])
    store.addEvent('crew', 'Project alpha created', crew.id)
    expect(store.recentEvents(5)[0]).toMatchObject({ kind: 'crew', message: 'Project alpha created', crewId: crew.id })
  })

  it('drops the orchestration tables', () => {
    const names = (store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name)
    for (const gone of ['jobs', 'runs', 'operators', 'squads', 'messages', 'discord_bots']) expect(names).not.toContain(gone)
    for (const kept of ['crews', 'presets', 'teams', 'scratch', 'usage', 'events', 'settings', 'project_groups']) expect(names).toContain(kept)
  })
})
