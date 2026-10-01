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
    expect('defaultReview' in s).toBe(false)
  })

  it('clamps and defaults the tokens and collaboration groups', () => {
    const s = sanitizeSettings({
      tokens: { operatorDailyCapUsd: -3, capWarnPct: 500, coldThresholdPct: 'x', outputShareWarnPct: 0, defaultCacheTtl: '2h', subagentCacheTtl: '1h', pinClaudeVersion: 'no' },
      collab: { nudgeIdleSeconds: 0, leaseMinutes: 90.6, maxRejects: -1, purgeRetentionDays: 7.2, purgeEnabled: 'no', longJobElapsedMinutes: NaN },
    })
    expect(s.tokens).toEqual({
      operatorDailyCapUsd: 0,
      capWarnPct: 100,
      coldThresholdPct: 50,
      outputShareWarnPct: 1,
      defaultCacheTtl: 'auto',
      subagentCacheTtl: '1h',
      pinClaudeVersion: true,
    })
    expect(s.collab).toEqual({
      ...DEFAULT_SETTINGS.collab,
      nudgeIdleSeconds: 1,
      leaseMinutes: 91,
      maxRejects: 0,
      purgeRetentionDays: 7,
    })
    expect(DEFAULT_SETTINGS.collab.purgeRetentionDays).toBe(30)
    expect(DEFAULT_SETTINGS.collab.purgeEnabled).toBe(true)
    expect(DEFAULT_SETTINGS.tokens.capWarnPct).toBe(80)
    expect(DEFAULT_SETTINGS.tokens).toMatchObject({ defaultCacheTtl: 'auto', subagentCacheTtl: '5m', pinClaudeVersion: true })
  })

  it('merges nested patches without dropping sibling values', () => {
    const s = mergeSettings(DEFAULT_SETTINGS, { updates: { channel: 'beta' }, keybinds: { tabCost: '' }, dailyBudgetUsd: 25 })
    expect(s.updates).toEqual({ channel: 'beta', checkHours: 3, installOnQuit: true })
    expect(s.keybinds.tabCost).toBe('')
    expect(s.keybinds.tabJobs).toBe('Mod+2')
    expect(s.dailyBudgetUsd).toBe(25)
  })

  it('merges collaboration and token patches field by field', () => {
    const s = mergeSettings(DEFAULT_SETTINGS, { collab: { leaseMinutes: 10, purgeEnabled: false }, tokens: { operatorDailyCapUsd: 5 } })
    expect(s.collab).toEqual({ ...DEFAULT_SETTINGS.collab, leaseMinutes: 10, purgeEnabled: false })
    expect(s.tokens).toEqual({ ...DEFAULT_SETTINGS.tokens, operatorDailyCapUsd: 5 })
    expect(s.keybinds.tabMessages).toBe('Mod+4')
  })
})
