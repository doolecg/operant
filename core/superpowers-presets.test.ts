import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectSuperpowers } from './superpowers'
import { PRESET_TEXT } from './preset-text'
import { exportPresets, parsePresetFile } from './preset-files'
import { Store } from './store'

describe('superpowers detection', () => {
  let claude: string
  beforeEach(() => (claude = mkdtempSync(join(tmpdir(), 'operant-claude-'))))
  afterEach(() => rmSync(claude, { recursive: true, force: true }))

  it('reports not installed for an empty Claude folder', () => {
    expect(detectSuperpowers(claude)).toEqual({ installed: false })
  })

  it('finds the plugin under plugins/ and reads its version', () => {
    const dir = join(claude, 'plugins', 'cache', 'market', 'superpowers', '5.1.0')
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'superpowers', version: '5.1.0' }))
    expect(detectSuperpowers(claude)).toEqual({ installed: true, path: dir, version: '5.1.0' })
  })

  it('finds a skill folder under skills/ with a SKILL.md', () => {
    mkdirSync(join(claude, 'skills', 'superpowers-debugging'), { recursive: true })
    writeFileSync(join(claude, 'skills', 'superpowers-debugging', 'SKILL.md'), '---\nname: x\n---\n')
    expect(detectSuperpowers(claude)).toMatchObject({ installed: true, path: join(claude, 'skills', 'superpowers-debugging') })
  })
})

describe('built-in preset guidance', () => {
  it('has text for every shipped preset and no brainstorm step', () => {
    const names = ['research', 'plan', 'design', 'implement', 'test', 'review', 'release', 'learn']
    for (const n of names) expect(PRESET_TEXT[n], n).toBeTruthy()
    expect(Object.keys(PRESET_TEXT).length).toBe(names.length)
    expect(Object.values(PRESET_TEXT).join(' ').toLowerCase()).not.toContain('brainstorm')
  })

  it('the store seeds the text onto built-in presets, OpenCode copies included', () => {
    const store = new Store(':memory:')
    try {
      const byKey = Object.fromEntries(store.listPresets().filter((p) => p.builtin).map((p) => [p.builtin, p]))
      expect(byKey['research']?.roleText).toBe(PRESET_TEXT.research)
      expect(byKey['design']?.roleText).toBe(PRESET_TEXT.design)
      expect(byKey['implement-opencode']?.roleText).toBe(PRESET_TEXT.implement)
    } finally {
      store.close()
    }
  })
})

describe('preset files', () => {
  it('exports a preset and reads it back, skipping a name that is already here', () => {
    const store = new Store(':memory:')
    try {
      const mine = store.createPreset({ name: 'my reviewer', agent: 'claude', model: 'sonnet', permissionMode: 'default', roleText: 'Review hard.' })
      const file = exportPresets([mine])
      expect(file.filename).toBe('operant-preset-my-reviewer.json')
      expect(parsePresetFile(file.text, ['other'])).toEqual([expect.objectContaining({ name: 'my reviewer', action: 'add', input: expect.objectContaining({ roleText: 'Review hard.', model: 'sonnet' }) })])
      expect(parsePresetFile(file.text, ['my reviewer'])[0]).toMatchObject({ action: 'skip' })
    } finally {
      store.close()
    }
  })

  it('refuses a file that is not a preset file, and an unknown agent', () => {
    expect(() => parsePresetFile('{"format":"operant-teams","teams":[]}', [])).toThrow(/not an Operant preset file/)
    const doc = { format: 'operant-presets', version: 1, presets: [{ name: 'x', agent: 'robot' }] }
    expect(parsePresetFile(JSON.stringify(doc), [])[0]).toMatchObject({ action: 'invalid', reason: 'Unknown agent robot' })
  })
})
