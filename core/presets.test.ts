import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BUILTIN_PRESETS, Store } from './store'
import { PRESET_TEXT } from './preset-text'
import { BUILTIN_TEAMS, exportTeams, parseTeamFile } from './team-presets'
import { STAGES, STAGE_KEYS, canEditFiles, presetInfo } from '../shared/presets'
import { CLAUDE_MODELS } from '../shared/models'

const KEYS = ['research', 'plan', 'design', 'implement', 'test', 'review', 'release', 'learn']
const MODES = ['acceptEdits', 'dontAsk', 'plan', 'manual', 'bypassPermissions', 'default']
const BUILTIN_KEYS = [...KEYS, ...KEYS.map((k) => `${k}-opencode`)].sort()

// The set shipped before the stages: fifteen Claude Code seats and their OpenCode copies.
const PREVIOUS = ['implement', 'fix', 'quick-fix', 'feature-development', 'debug', 'test', 'refactoring', 'performance', 'explore', 'plan', 'design', 'review', 'security-review', 'docs', 'release-prep']

describe('built-in presets', () => {
  let store: Store
  beforeEach(() => (store = new Store(':memory:')))
  afterEach(() => store.close())

  it('ships the eight stages, each for Claude Code and for OpenCode, and nothing else', () => {
    expect(STAGE_KEYS).toEqual(KEYS)
    expect(BUILTIN_PRESETS.map((p) => p.builtin).sort()).toEqual(BUILTIN_KEYS)
    expect(BUILTIN_PRESETS.filter((p) => p.agent === 'claude').map((p) => p.builtin).sort()).toEqual([...KEYS].sort())
    expect(BUILTIN_PRESETS.filter((p) => p.agent === 'opencode').map((p) => p.builtin).sort()).toEqual(KEYS.map((k) => `${k}-opencode`).sort())
  })

  it('numbers the stages in lifecycle order', () => {
    expect(KEYS.map((k) => STAGES[k]!.stage)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(KEYS.map((k) => STAGES[k]!.name)).toEqual(['Research', 'Plan', 'Design', 'Implement', 'Test', 'Review', 'Release', 'Learn'])
  })

  it('gives every built-in guidance text, a one-line description and a when-to-use hint', () => {
    expect(Object.keys(PRESET_TEXT).sort()).toEqual([...KEYS].sort())
    for (const k of KEYS) {
      expect(PRESET_TEXT[k], k).toMatch(/Purpose: .+\nRules: .+\n/)
      expect(PRESET_TEXT[k], k).toContain('Status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT')
      expect(STAGES[k]!.description.includes('\n'), k).toBe(false)
      expect(STAGES[k]!.description, k).toBeTruthy()
      expect(STAGES[k]!.whenToUse, k).toBeTruthy()
    }
    for (const p of store.listPresets().filter((x) => x.builtin)) {
      expect(p.roleText, p.builtin!).toBeTruthy()
      expect(p.description, p.builtin!).toBeTruthy()
      expect(p.whenToUse, p.builtin!).toBeTruthy()
      expect(p.stage, p.builtin!).toBe(STAGES[p.builtin!.replace(/-opencode$/, '')]!.stage)
    }
  })

  it('has valid launch fields on every built-in', () => {
    for (const p of BUILTIN_PRESETS) {
      expect(MODES, p.builtin!).toContain(p.permissionMode)
      expect(['', 'low', 'medium', 'high', 'xhigh', 'max'], p.builtin!).toContain(p.effort)
      expect(['auto', '5m', '1h'], p.builtin!).toContain(p.cacheTtl)
      expect(p.contextCap, p.builtin!).toBeGreaterThanOrEqual(0)
      if (p.agent === 'claude') expect(CLAUDE_MODELS, p.builtin!).toContain(p.model)
    }
    expect(BUILTIN_PRESETS.find((p) => p.builtin === 'design')).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
    expect(BUILTIN_PRESETS.find((p) => p.builtin === 'research')?.model).toBe('claude-haiku-5-5')
    expect(BUILTIN_PRESETS.find((p) => p.builtin === 'review')).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' })
  })

  it('ships only current Claude models: each is in CLAUDE_MODELS, and none is a 4.x id', () => {
    for (const p of BUILTIN_PRESETS.filter((x) => x.agent === 'claude')) {
      expect(CLAUDE_MODELS, p.builtin!).toContain(p.model)
      expect(p.model, p.builtin!).not.toContain('4-')
    }
  })

  it('keeps the OpenCode copies on an empty model, so the model comes from OpenCode', () => {
    const copies = BUILTIN_PRESETS.filter((p) => p.agent === 'opencode')
    expect(copies.length).toBe(KEYS.length)
    for (const p of copies) {
      expect(p.model, p.builtin!).toBe('')
      expect(p.effort, p.builtin!).toBe('')
    }
    expect(store.listPresets().filter((p) => p.agent === 'opencode').every((p) => p.model === '')).toBe(true)
  })

  it('matches each stage read-only flag to whether its Claude Code copy can edit files, in both agents', () => {
    for (const k of KEYS) {
      for (const key of [k, `${k}-opencode`]) {
        const p = BUILTIN_PRESETS.find((b) => b.builtin === key)!
        expect(canEditFiles(p), key).toBe(!STAGES[k]!.readOnly)
      }
    }
  })

  it('makes the read-only stages unable to edit files, in both agents', () => {
    for (const k of KEYS.filter((x) => STAGES[x]!.readOnly)) {
      for (const key of [k, `${k}-opencode`]) {
        const p = BUILTIN_PRESETS.find((b) => b.builtin === key)!
        expect(canEditFiles(p), key).toBe(false)
        expect(p.tools.split(',').some((t) => /^(Edit|Write|NotebookEdit)$/.test(t)), key).toBe(false)
        expect(p.deny, key).toEqual(expect.arrayContaining(['Edit', 'Write']))
        expect(p.permissionMode, key).toBe('dontAsk')
      }
    }
  })

  it('lets Implement, Test and Release edit files, and Test and Release only in their own paths', () => {
    for (const k of ['implement', 'test', 'release']) {
      expect(canEditFiles(BUILTIN_PRESETS.find((b) => b.builtin === k)!), k).toBe(true)
    }
    const test = BUILTIN_PRESETS.find((b) => b.builtin === 'test')!
    expect(test.allow).toEqual(expect.arrayContaining(['Edit(**/*.test.*)', 'Write(e2e/**)']))
    expect(test.allow).not.toContain('Edit(**)')
    const release = BUILTIN_PRESETS.find((b) => b.builtin === 'release')!
    expect(release.allow).toEqual(expect.arrayContaining(['Edit(RELEASE_NOTES.md)', 'Edit(**/package.json)']))
    expect(release.deny).toEqual(expect.arrayContaining(['Bash(git tag*)', 'Bash(npm publish*)']))
    expect(canEditFiles({ tools: '', deny: [] })).toBe(true)
    expect(canEditFiles({ tools: 'Read,Grep', deny: [] })).toBe(false)
    expect(canEditFiles({ tools: 'Read,Edit', deny: ['Write'] })).toBe(true)
    expect(canEditFiles({ tools: 'Read,Edit,Write', deny: ['Edit', 'Write'] })).toBe(false)
  })

  it('keeps commands that no longer exist out of the shipped text', () => {
    const text = [...Object.values(PRESET_TEXT), ...BUILTIN_TEAMS.flatMap((t) => [t.description, t.rules])].join('\n')
    expect(text).not.toMatch(/operant (task|test|wait|agent|read|run|build)|\bboard\b|\bworker|\bMaster\b/i)
    expect(text.toLowerCase()).not.toContain('brainstorm')
  })

  it('returns no stage info for a user preset and the stage entry for an OpenCode copy', () => {
    const mine = store.createPreset({ name: 'mine', agent: 'claude', model: 'sonnet', permissionMode: 'default' })
    expect(store.getPreset(mine.id)).toMatchObject({ builtin: null })
    expect(store.getPreset(mine.id)!.description).toBeUndefined()
    expect(presetInfo('implement-opencode')).toEqual({ stage: 4, description: STAGES.implement!.description, whenToUse: STAGES.implement!.whenToUse })
  })

  it('resets a built-in to its shipped values', () => {
    const cur = store.getPresetByBuiltin('design')!
    store.updatePreset(cur.id, { model: 'claude-haiku-5-5', roleText: 'changed' })
    const back = store.resetPreset(cur.id)
    expect(back).toMatchObject({ builtin: 'design', model: 'claude-opus-5-5', name: 'Design' })
    expect(back.roleText).toBe(PRESET_TEXT.design)
  })
})

describe('upgrade to the stage set', () => {
  let store: Store
  let backups: string
  beforeEach(() => {
    backups = mkdtempSync(join(tmpdir(), 'operant-presets-'))
    store = new Store(':memory:', Date.now, backups)
    // Put the database back into the previous state: fifteen seats and their OpenCode copies, one of them edited
    // (a "researcher" with its own model), plus a preset the user made from scratch.
    store.db.exec('DELETE FROM presets')
    for (const key of PREVIOUS) {
      for (const agent of ['claude', 'opencode'] as const) {
        const p = store.createPreset({ name: agent === 'claude' ? key : `${key} (OpenCode)`, agent, model: agent === 'claude' ? 'claude-sonnet-5-5' : '', permissionMode: 'acceptEdits', roleText: 'old text' })
        store.db.prepare('UPDATE presets SET builtin = ? WHERE id = ?').run(agent === 'claude' ? key : `${key}-opencode`, p.id)
      }
    }
    const r = store.createPreset({ name: 'researcher', agent: 'claude', model: 'claude-haiku-4-5', permissionMode: 'dontAsk', roleText: 'my own research rules' })
    store.db.prepare('UPDATE presets SET builtin = ? WHERE id = ?').run('researcher', r.id)
    store.createPreset({ name: 'my reviewer', agent: 'claude', model: 'sonnet', permissionMode: 'default', roleText: 'Review hard.' })
    store.db.exec('DELETE FROM teams')
    store.setJson('presets.seededVersion', 4)
    store.seedBuiltinPresets()
  })
  afterEach(() => {
    store.close()
    rmSync(backups, { recursive: true, force: true })
  })

  const builtinKeys = () => store.listPresets().filter((p) => p.builtin != null).map((p) => p.builtin!).sort()

  it('ends with exactly the eight stages for each CLI, and no other built-in', () => {
    expect(builtinKeys()).toEqual(BUILTIN_KEYS)
    expect(new Set(builtinKeys()).size).toBe(BUILTIN_KEYS.length)
    expect(store.getPresetByBuiltin('researcher')).toBeNull()
    expect(store.getPresetByBuiltin('quick-fix')).toBeNull()
    expect(store.getPresetByBuiltin('docs-opencode')).toBeNull()
  })

  it('resets the stages to the shipped text and launch settings', () => {
    expect(store.getPresetByBuiltin('implement')).toMatchObject({ name: 'Implement', model: 'claude-sonnet-5-5', permissionMode: 'acceptEdits' })
    expect(store.getPresetByBuiltin('implement')!.roleText).toBe(PRESET_TEXT.implement)
    expect(store.getPresetByBuiltin('plan-opencode')).toMatchObject({ name: 'Plan (OpenCode)', model: '', agent: 'opencode' })
    expect(store.getPresetByBuiltin('learn')).toMatchObject({ model: 'claude-haiku-5-5', name: 'Learn' })
  })

  it('keeps a preset the user made from scratch, untouched', () => {
    expect(store.listPresets().find((p) => p.name === 'my reviewer')).toMatchObject({ builtin: null, roleText: 'Review hard.', model: 'sonnet' })
  })

  it('copies the built-ins to a pre-presets-cleanup backup before deleting anything', () => {
    const files = readdirSync(backups).filter((n) => n.startsWith('pre-presets-cleanup-'))
    expect(files.length).toBe(1)
    const bundle = JSON.parse(readFileSync(join(backups, files[0]!), 'utf8'))
    const saved = JSON.parse(bundle.files['presets.json'])
    expect(saved.find((p: { builtin: string }) => p.builtin === 'researcher')).toMatchObject({ roleText: 'my own research rules', model: 'claude-haiku-4-5' })
    expect(saved.length).toBe(PREVIOUS.length * 2 + 1)
  })

  it('runs the cleanup once: a second seed leaves the rows alone', () => {
    const before = store.listPresets().map((p) => `${p.id}:${p.builtin}:${p.name}`)
    store.seedBuiltinPresets()
    expect(store.listPresets().map((p) => `${p.id}:${p.builtin}:${p.name}`)).toEqual(before)
    expect(readdirSync(backups).filter((n) => n.startsWith('pre-presets-cleanup-')).length).toBe(1)
  })

  it('restores only the eight stages, for each CLI, when a built-in is missing', () => {
    store.deletePreset(store.getPresetByBuiltin('research')!.id)
    store.deletePreset(store.getPresetByBuiltin('research-opencode')!.id)
    const added = store.restoreBuiltins()
    expect(added.map((p) => p.builtin).sort()).toEqual(['research', 'research-opencode'])
    expect(builtinKeys()).toEqual(BUILTIN_KEYS)
  })
})

describe('preset files', () => {
  it('exports a shipped stage and reads it back as already here', () => {
    const store = new Store(':memory:')
    try {
      const file = exportTeams(store, store.listTeams())
      expect(parseTeamFile(store, file.text).every((i) => i.entry.action === 'skip')).toBe(true)
    } finally {
      store.close()
    }
  })
})

describe('team guidance', () => {
  it('ships four teams with unique keys, a one-line description and rules', () => {
    expect(BUILTIN_TEAMS.map((t) => t.builtin)).toEqual(['solo', 'plan-build', 'feature-squad', 'release'])
    for (const t of BUILTIN_TEAMS) {
      expect(t.name.trim(), t.builtin).toBeTruthy()
      expect(t.description.includes('\n'), t.builtin).toBe(false)
      expect(t.rules.length, t.builtin).toBeGreaterThan(60)
    }
  })

  it('names only stages in the team text', () => {
    const names = ['Research', 'Plan', 'Design', 'Implement', 'Test', 'Review', 'Release', 'Learn']
    for (const t of BUILTIN_TEAMS) {
      expect(names.some((n) => t.description.includes(n) || t.rules.includes(n)), t.builtin).toBe(true)
    }
  })

  it('exports and reads back shipped teams as already here', () => {
    const store = new Store(':memory:')
    try {
      const file = exportTeams(store, store.listTeams())
      const items = parseTeamFile(store, file.text)
      expect(items.length).toBe(store.listTeams().length)
      expect(items.every((i) => i.entry.action === 'skip')).toBe(true)
    } finally {
      store.close()
    }
  })

  it('hides a retired team that was never edited, and keeps an edited one as the user\'s own', () => {
    const store = new Store(':memory:')
    try {
      store.db.exec('DELETE FROM teams')
      const team = (name: string, builtin: string, rules: string, modified: number) =>
        store.db.prepare('INSERT INTO teams (name, seats, limits, rules, description, builtin, modified, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(name, '[]', '{}', rules, '', builtin, modified, 1)
      team('Bug fix', 'bug-fix', 'old bug text', 0)
      team('Build and review', 'build-review', 'my own build rules', 1)
      store.setJson('presets.seededVersion', 4)
      store.seedBuiltinPresets()
      const teams = store.listTeams()
      expect(teams.find((t) => t.builtin === 'bug-hunt')).toMatchObject({ hidden: true })
      expect(teams.find((t) => t.name === 'Build and review')).toMatchObject({ builtin: null, rules: 'my own build rules' })
      expect(teams.find((t) => t.builtin === 'release')).toBeTruthy()
    } finally {
      store.close()
    }
  })
})
