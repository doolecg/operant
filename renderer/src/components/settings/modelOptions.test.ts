import { describe, expect, it } from 'vitest'
import type { ModelList } from '@shared/models'
import { DEFAULT_OPTION, modelOptions, NOT_LISTED_GROUP } from './modelOptions'

const LIST: ModelList = {
  models: ['openai/gpt-5', 'opencode/big-pickle'],
  efforts: {},
  providers: [
    { providerId: 'openai', providerName: 'OpenAI', connected: true, models: [{ id: 'openai/gpt-5', name: 'GPT 5', free: false, efforts: [] }] },
    { providerId: 'opencode', providerName: 'OpenCode Zen', connected: true, models: [{ id: 'opencode/big-pickle', name: 'Big Pickle', free: true, efforts: [] }] },
  ],
}

describe('OpenCode model options', () => {
  it('offers only listed models and the default, never a custom id', () => {
    const opts = modelOptions(LIST, '')
    expect(opts.map((o) => o.value)).toEqual([DEFAULT_OPTION, 'openai/gpt-5', 'opencode/big-pickle'])
    expect(opts.some((o) => o.label === 'Custom id…')).toBe(false)
    expect(opts.find((o) => o.value === 'opencode/big-pickle')).toMatchObject({ badge: 'free', group: 'OpenCode Zen' })
  })

  it('puts a saved model the catalogue lacks at the top, marked as not available', () => {
    const opts = modelOptions(LIST, 'old/gone')
    expect(opts[1]).toMatchObject({ value: 'old/gone', group: NOT_LISTED_GROUP })
    expect(NOT_LISTED_GROUP).toBe('Not available in opencode models')
  })

  it('keeps the saved model unmarked group-wise when the catalogue is unavailable', () => {
    const opts = modelOptions({ models: [], efforts: {}, error: 'opencode is not installed or not on PATH' }, 'openai/gpt-5')
    expect(opts.map((o) => o.value)).toEqual([DEFAULT_OPTION, 'openai/gpt-5'])
    expect(opts[1]!.group).not.toBe(NOT_LISTED_GROUP)
  })

  it('builds the flat list when there are no provider groups, still without a custom entry', () => {
    expect(modelOptions({ models: ['a/b'], efforts: {} }, '').map((o) => o.value)).toEqual([DEFAULT_OPTION, 'a/b'])
  })

  it('a selected listed model is not duplicated at the top', () => {
    expect(modelOptions(LIST, 'openai/gpt-5').filter((o) => o.value === 'openai/gpt-5')).toHaveLength(1)
  })
})
