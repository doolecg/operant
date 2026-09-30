import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings, sanitizeSettings } from './settings'

describe('settings', () => {
  it('fills defaults for missing or malformed values', () => {
    expect(sanitizeSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    const s = sanitizeSettings({
      dailyBudgetUsd: -5,
      defaultModels: { claude: '  opus ', codex: 42 },
      updates: { channel: 'nightly', checkHours: 99.4, installOnQuit: 'yes' },
      keybinds: { newCrew: 'Mod+Shift+N', bogus: 'X' },
    })
    expect(s.dailyBudgetUsd).toBe(0)
    expect(s.defaultModels).toEqual({ claude: 'opus', codex: 'gpt-5' })
    expect(s.updates).toEqual({ channel: 'stable', checkHours: 24, installOnQuit: true })
    expect(s.keybinds.newCrew).toBe('Mod+Shift+N')
    expect(s.keybinds.addSquad).toBe('Mod+Shift+P')
    expect('bogus' in s.keybinds).toBe(false)
  })

  it('merges nested patches without dropping sibling values', () => {
    const s = mergeSettings(DEFAULT_SETTINGS, { updates: { channel: 'beta' }, keybinds: { tabCost: '' }, dailyBudgetUsd: 25 })
    expect(s.updates).toEqual({ channel: 'beta', checkHours: 3, installOnQuit: true })
    expect(s.keybinds.tabCost).toBe('')
    expect(s.keybinds.tabTasks).toBe('Mod+2')
    expect(s.dailyBudgetUsd).toBe(25)
  })
})
