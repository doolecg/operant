import { describe, expect, it } from 'vitest'
import { DEFAULT_LEARN_SETTINGS } from './learn'
import { DEFAULT_SETTINGS, SETTINGS_SECTIONS, resetSettings, sanitizeSettings } from './settings'

describe('settings reset and the new learn, memory and aux settings', () => {
  const changed = sanitizeSettings({
    ...DEFAULT_SETTINGS,
    dailyBudgetUsd: 12,
    learn: { ...DEFAULT_LEARN_SETTINGS, mode: 'controlled', maxCallsPerReview: 9 },
    memory: { recallMode: 'session-start', topK: 2, maxTokens: 300, includeSoul: false },
  })

  it('puts one section back to its defaults and keeps the others', () => {
    const next = resetSettings(changed, 'learn')
    expect(next.learn).toEqual(DEFAULT_LEARN_SETTINGS)
    expect(next.learn.mode).toBe('suggest')
    expect(next.memory).toEqual(changed.memory)
    expect(next.dailyBudgetUsd).toBe(12)
  })

  it('puts every section back when none is named', () => {
    expect(resetSettings(changed)).toEqual(sanitizeSettings(DEFAULT_SETTINGS))
  })

  it('refuses an unknown section', () => {
    expect(() => resetSettings(changed, 'nope')).toThrow(/No settings section named nope/)
    expect(SETTINGS_SECTIONS).toContain('memory')
    expect(SETTINGS_SECTIONS).toContain('auxModels')
  })

  it('sanitizes the new keys: a bad mode falls back, budgets are clamped, models are checked', () => {
    const s = sanitizeSettings({
      learn: { mode: 'yolo', maxCallsPerReview: -4, minTokens: 'many', onLimit: 'nope' },
      memory: { recallMode: 'always', topK: 0, maxTokens: 1e9 },
      auxModels: { extraction: { cli: 'claude', model: 'bad model;rm', effort: 'high' }, retrieval: { cli: 'local', model: 'qwen', localUrl: 'http://127.0.0.1:1234' } },
      aux: { maxCallsPerDay: -1, retryLimit: 99, onLimit: 'confirm' },
    })
    expect(s.learn).toMatchObject({ mode: 'suggest', maxCallsPerReview: 0, minTokens: DEFAULT_LEARN_SETTINGS.minTokens, onLimit: 'stop' })
    expect(s.memory).toMatchObject({ recallMode: 'on-demand', topK: 1, maxTokens: 20000 })
    expect(s.auxModels.extraction).toEqual({ cli: 'claude', model: '', effort: 'high', localUrl: '' })
    expect(s.auxModels.retrieval).toEqual({ cli: 'local', model: 'qwen', effort: '', localUrl: 'http://127.0.0.1:1234' })
    expect(s.aux).toMatchObject({ maxCallsPerDay: 0, retryLimit: 5, onLimit: 'confirm' })
  })
})
