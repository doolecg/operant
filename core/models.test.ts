import { beforeEach, describe, expect, it } from 'vitest'
import { listEfforts, listModels, parseOpencodeModels, parseServiceVariants, resetModelsCache } from './models'
import { validateLaunchSettings, validateModel } from './launch'

const service = {
  data: [
    { providerID: 'opencode', modelID: 'fledge-alpha-free', variants: [{ id: 'low', settings: {} }, { id: 'high' }, { id: 'bad name' }] },
    { providerID: 'ollama', modelID: 'gemma4:e4b', variants: [] },
    { providerID: 'x', modelID: 'y' },
  ],
}

describe('models', () => {
  beforeEach(resetModelsCache)

  it('parses the one-id-per-line output and the service variants', () => {
    expect(parseOpencodeModels('\u001b[1ma/b\u001b[0m\r\n\r\nnoise\r\nc/d.e\r\na/b\r\nollama/gemma4:e4b\r\n')).toEqual(['a/b', 'c/d.e', 'ollama/gemma4:e4b'])
    expect(parseServiceVariants(service)).toEqual({ 'opencode/fledge-alpha-free': ['low', 'high'] })
    expect(parseServiceVariants(null)).toEqual({})
  })

  it('lists opencode models once per cache window and adds the variants of listed ones', async () => {
    const calls: string[][] = []
    const run = async (_f: string, a: string[]) => {
      calls.push(a)
      return 'opencode/fledge-alpha-free\r\nc/d\r\n'
    }
    const variants = async () => ({ ...parseServiceVariants(service), 'gone/model': ['high'] })
    const r = await listModels('opencode', { run, variants, now: () => 0 })
    expect(r).toEqual({ models: ['opencode/fledge-alpha-free', 'c/d'], efforts: { 'opencode/fledge-alpha-free': ['low', 'high'] } })
    await listModels('opencode', { run, variants, now: () => 1000 })
    expect(calls).toEqual([['models']])
    await listModels('opencode', { run, variants, now: () => 6 * 60 * 1000 })
    expect(calls).toHaveLength(2)
  })

  it('still lists models when the service gives no variants', async () => {
    const r = await listModels('opencode', { run: async () => 'a/b\r\n', variants: async () => { throw new Error('down') } })
    expect(r).toEqual({ models: ['a/b'], efforts: {} })
  })

  it('reports a missing opencode', async () => {
    const run = async () => {
      throw Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' })
    }
    const r = await listModels('opencode', { run })
    expect(r.models).toEqual([])
    expect(r.error).toMatch(/not installed/)
  })

  it('lists claude models and efforts', async () => {
    const r = await listModels('claude')
    expect(r.models).toContain('claude-fable-5-1')
    expect(r.efforts['claude-haiku-4-5']).toEqual([])
    expect(listEfforts('claude', 'claude-opus-5-5')).toContain('xhigh')
    expect(listEfforts('opencode', 'a/b')).toEqual([])
  })

  it('validates opencode ids and variants without loosening claude', () => {
    expect(validateModel('openai/gpt-5.1:free', 'opencode')).toBe('openai/gpt-5.1:free')
    expect(() => validateModel('openai/gpt-5')).toThrow()
    expect(() => validateModel('a/../b', 'opencode')).toThrow()
    expect(() => validateModel('a b/c', 'opencode')).toThrow()
    expect(() => validateLaunchSettings({ agent: 'opencode', model: 'a/b:c', effort: 'minimal' })).not.toThrow()
    expect(() => validateLaunchSettings({ agent: 'claude', effort: 'minimal' })).toThrow()
  })
})
