import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CrewIndexes } from './codegraph'
import { MasterRegistry } from './master'
import { Operant, type FileDialogs } from './operant'
import { RunServices } from './runservices'
import { SubagentReader } from './agents'
import { SessionManager } from './sessions'
import { MIGRATIONS, Store } from './store'
import { BUILTIN_TEAMS, exportTeams, parseTeamFile } from './team-presets'

const indexes = { status: () => ({ initialized: false }), index: async () => ({}) } as unknown as CrewIndexes

describe('built-in teams in the store', () => {
  let store: Store
  beforeEach(() => {
    store = new Store(':memory:')
  })
  afterEach(() => store.close())

  it('seeds the shipped teams first, once, with seats from the built-in presets', () => {
    const teams = store.listTeams()
    expect(teams.map((t) => t.name)).toEqual(BUILTIN_TEAMS.map((t) => t.name))
    expect(teams.every((t) => t.builtin != null && !t.modified && !t.hidden && t.description)).toBe(true)
    const full = teams.find((t) => t.builtin === 'full-crew')!
    expect(full.seats.map((s) => store.getPreset(s.presetId)!.builtin)).toEqual(['pm', 'researcher', 'designer', 'implementor', 'tester', 'reviewer'])
    expect(full.seats[1]).toMatchObject({ model: 'claude-haiku-4-5' })
    store.seedBuiltinTeams()
    store.seedBuiltinTeams()
    expect(store.listTeams()).toHaveLength(BUILTIN_TEAMS.length)
    store.createTeam({ name: 'mine' })
    expect(store.listTeams().map((t) => t.name).slice(-1)).toEqual(['mine'])
  })

  it('upgrades an old database without touching existing teams and seeds beside them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'operant-teamsmig-'))
    try {
      const file = join(dir, 'old.db')
      const raw = new DatabaseSync(file)
      const before = MIGRATIONS.length - 1
      raw.exec(MIGRATIONS.slice(0, before).join('\n'))
      raw.exec(`PRAGMA user_version = ${before}`)
      raw.exec(`INSERT INTO teams (id, name, seats, limits, rules, updated_at) VALUES (5, 'Bug fix', '[]', '{}', 'old', 1)`)
      raw.close()
      const s = new Store(file)
      try {
        expect(s.schemaVersion).toBe(MIGRATIONS.length)
        expect(s.getTeam(5)).toMatchObject({ name: 'Bug fix', rules: 'old', builtin: null, description: '', modified: false })
        expect(s.listTeams().find((t) => t.builtin === 'bug-fix')!.name).toBe('Bug fix (2)')
        expect(s.listTeams()).toHaveLength(BUILTIN_TEAMS.length + 1)
      } finally {
        s.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps an edit, flags it modified, and resets to the shipped values', () => {
    const t = store.listTeams()[0]!
    const edited = store.updateTeam(t.id, { name: 'My build', rules: 'x', limits: { maxWorkers: 9, topTier: '', tokenBudget: 1 } })
    expect(edited).toMatchObject({ modified: true, builtin: t.builtin })
    store.seedBuiltinTeams()
    expect(store.getTeam(t.id)).toMatchObject({ name: 'My build', modified: true })
    expect(store.listTeams()).toHaveLength(BUILTIN_TEAMS.length)
    const back = store.resetTeam(t.id)
    expect(back).toMatchObject({ name: t.name, rules: t.rules, modified: false, seats: t.seats })
    expect(back.limits).toEqual(t.limits)
  })

  it('refuses to delete a built-in, hides it and shows it again, and duplicates it as a user team', () => {
    const t = store.listTeams()[1]!
    expect(() => store.deleteTeam(t.id)).toThrow(/Built-in/)
    expect(store.setTeamHidden(t.id, true).hidden).toBe(true)
    expect(store.getTeam(t.id)!.hidden).toBe(true)
    store.seedBuiltinTeams()
    expect(store.listTeams()).toHaveLength(BUILTIN_TEAMS.length)
    expect(store.setTeamHidden(t.id, false).hidden).toBe(false)
    const copy = store.duplicateTeam(t.id)
    expect(copy).toMatchObject({ name: `${t.name} copy`, builtin: null, modified: false, seats: t.seats, description: t.description })
    expect(store.duplicateTeam(t.id).name).toBe(`${t.name} copy (2)`)
    store.deleteTeam(copy.id)
    expect(() => store.setTeamHidden(copy.id, true)).toThrow()
  })

  it('cannot reset a team whose seat preset was deleted until the presets are restored', () => {
    const team = store.listTeams().find((t) => t.builtin === 'build-review')!
    store.deletePreset(store.getPresetByBuiltin('reviewer')!.id)
    expect(() => store.resetTeam(team.id)).toThrow(/restore the built-in presets/)
    store.restoreBuiltins()
    expect(store.resetTeam(team.id).seats).toHaveLength(2)
  })

  it('round-trips through a team file, skips what is already there and reports invalid teams', () => {
    const first = store.listTeams()[0]!
    const mine = store.createTeam({ name: 'mine', description: 'd', rules: 'r', seats: first.seats, limits: { maxWorkers: 2, topTier: 'sonnet', tokenBudget: 5 } })
    const file = exportTeams(store, [mine, first])
    expect(file.filename).toBe('operant-teams.json')
    expect(exportTeams(store, [mine]).filename).toBe('operant-mine.json')
    expect(parseTeamFile(store, file.text).map((i) => i.entry.action)).toEqual(['skip', 'skip'])
    const other = new Store(':memory:')
    try {
      const items = parseTeamFile(other, file.text)
      expect(items.map((i) => i.entry.action)).toEqual(['add', 'skip'])
      expect(items[0]!.input).toMatchObject({ name: 'mine', description: 'd', rules: 'r', limits: { maxWorkers: 2, topTier: 'sonnet', tokenBudget: 5 } })
      expect(items[0]!.input!.seats).toHaveLength(mine.seats.length)
    } finally {
      other.close()
    }
    const bad = JSON.stringify({
      format: 'operant-teams',
      version: 1,
      teams: [
        { name: 'ok', seats: [{ preset: 'implementor', count: 1, model: '', effort: '' }], limits: {} },
        { name: 'nopreset', seats: [{ preset: 'ghost', count: 1 }] },
        { name: 'badcount', seats: [{ preset: 'tester', count: 0 }] },
        { name: 'badlimit', seats: [], limits: { maxWorkers: -4 } },
        { name: '', seats: [] },
        { name: 'ok', seats: [] },
      ],
    })
    expect(parseTeamFile(store, bad).map((i) => [i.entry.name, i.entry.action])).toEqual([
      ['ok', 'add'],
      ['nopreset', 'invalid'],
      ['badcount', 'invalid'],
      ['badlimit', 'invalid'],
      ['Team 5', 'invalid'],
      ['ok', 'skip'],
    ])
    expect(() => parseTeamFile(store, 'nope')).toThrow(/JSON/)
    expect(() => parseTeamFile(store, '{"format":"x"}')).toThrow(/team file/)
  })
})

describe('built-in teams over IPC', () => {
  let store: Store
  let op: Operant
  let dir: string
  let saveTo: string | null
  let openFrom: string | null

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'operant-teamsipc-'))
    store = new Store(':memory:')
    saveTo = join(dir, 'out.json')
    openFrom = join(dir, 'in.json')
    const dialogs: FileDialogs = { save: async () => saveTo, open: async () => openFrom }
    op = new Operant({
      store,
      sessions: new SessionManager(() => {
        throw new Error('no pty')
      }),
      indexes,
      pluginDir: '/plugin',
      masters: new MasterRegistry(),
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
      fileDialogs: dialogs,
    })
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses to delete a built-in, resets, hides and duplicates', async () => {
    const [first] = await op.handlers['teams:list']()
    await expect(async () => op.handlers['teams:delete'](first!.id)).rejects.toThrow(/built-in team and cannot be deleted/)
    await op.handlers['teams:update'](first!.id, { rules: 'changed', description: 'mine' })
    expect((await op.handlers['teams:reset'](first!.id)).modified).toBe(false)
    expect((await op.handlers['teams:setHidden'](first!.id, true)).hidden).toBe(true)
    const copy = await op.handlers['teams:duplicate'](first!.id)
    expect(copy.builtin).toBeNull()
    await expect(async () => op.handlers['teams:reset'](copy.id)).rejects.toThrow(/built-in/)
    await expect(async () => op.handlers['teams:setHidden'](copy.id, true)).rejects.toThrow(/built-in/)
    await op.handlers['teams:delete'](copy.id)
  })

  it('exports one team or all, then imports with a preview and no duplicates', async () => {
    const mine = await op.handlers['teams:create']({ name: 'mine', seats: (await op.handlers['teams:list']())[0]!.seats })
    expect(await op.handlers['teams:export'](mine.id)).toEqual({ saved: saveTo })
    expect(JSON.parse(readFileSync(saveTo!, 'utf8')).teams.map((t: { name: string }) => t.name)).toEqual(['mine'])
    await op.handlers['teams:export']()
    expect(JSON.parse(readFileSync(saveTo!, 'utf8')).teams).toHaveLength(BUILTIN_TEAMS.length + 1)
    saveTo = null
    expect(await op.handlers['teams:export'](mine.id)).toEqual({ saved: null })

    writeFileSync(
      openFrom!,
      JSON.stringify({
        format: 'operant-teams',
        version: 1,
        teams: [{ name: 'fresh', seats: [{ preset: 'tester', count: 1 }] }, { name: 'mine', seats: [] }, { name: 'bad', seats: [{ preset: 'nobody', count: 1 }] }],
      }),
    )
    const preview = (await op.handlers['teams:importPreview']())!
    expect(preview.entries.map((e) => e.action)).toEqual(['add', 'skip', 'invalid'])
    await expect(async () => op.handlers['teams:import'](join(dir, 'other.json'))).rejects.toThrow(/again/)
    expect((await op.handlers['teams:import'](preview.path)).map((t) => t.name)).toEqual(['fresh'])
    const again = (await op.handlers['teams:importPreview']())!
    expect(again.entries.map((e) => e.action)).toEqual(['skip', 'skip', 'invalid'])
    openFrom = null
    expect(await op.handlers['teams:importPreview']()).toBeNull()
  })
})
