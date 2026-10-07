import { beforeEach, describe, expect, it } from 'vitest'
import { buildProviders, listEfforts, listModels, parseAuthList, parseOpencodeModels, parseServiceModels, parseServiceVariants, resetModelsCache } from './models'
import { modelName, providerName } from '../shared/models'
import { validateLaunchSettings, validateModel } from './launch'

const service = {
  data: [
    { providerID: 'opencode', modelID: 'fledge-alpha-free', name: 'Fledge Alpha Free', variants: [{ id: 'low', settings: {} }, { id: 'high' }, { id: 'bad name' }], cost: [{ input: 0, output: 0 }], limit: { context: 1048576 } },
    { providerID: 'opencode', modelID: 'big-pickle', name: 'Big Pickle', variants: [] },
    { providerID: 'ollama', modelID: 'gemma4:e4b', variants: [], cost: [{ input: 0, output: 0 }] },
    { providerID: 'x', modelID: 'off', enabled: false },
    { providerID: 'x', modelID: 'y' },
  ],
}
const auth = 'Z.AI Coding Plan  Z.AI Coding Plan            stored\r\n'
const cliOut = 'opencode/big-pickle\r\nopencode/fledge-alpha-free\r\nzai-coding-plan/glm-4.7\r\nopenai/gpt-5\r\nollama/gemma4:e4b\r\n'
const runner = (calls: string[][] = [], models = cliOut, authOut: string | Error = auth) => async (_f: string, a: string[]) => {
  calls.push(a)
  if (a[0] === 'auth') {
    if (authOut instanceof Error) throw authOut
    return authOut
  }
  return models
}
const svc = async () => parseServiceModels(service)
const count = (calls: string[][]) => calls.filter((c) => c[0] === 'models').length

describe('models', () => {
  beforeEach(resetModelsCache)

  it('parses the one-id-per-line output, the service rows and the auth list', () => {
    expect(parseOpencodeModels('\u001b[1ma/b\u001b[0m\r\n\r\nnoise\r\nc/d.e\r\na/b\r\nollama/gemma4:e4b\r\nbad/id#hash\r\nhttps://x.y\r\n')).toEqual(['a/b', 'c/d.e', 'ollama/gemma4:e4b'])
    expect(parseOpencodeModels('openrouter/anthropic/claude-3.5:beta\n')).toEqual(['openrouter/anthropic/claude-3.5:beta'])
    expect(parseServiceVariants(service)).toEqual({ 'opencode/fledge-alpha-free': ['low', 'high'] })
    expect(parseServiceVariants(null)).toEqual({})
    const m = parseServiceModels(service)
    expect(m['opencode/fledge-alpha-free']).toMatchObject({ name: 'Fledge Alpha Free', free: true, context: 1048576 })
    expect(m['x/off']).toBeUndefined()
    expect(m['x/y']?.name).toBe('Y')
    expect([...parseAuthList(auth)!]).toContain('zaicodingplan')
    expect(parseAuthList('  \r\n')).toBeNull()
  })

  it('names providers and models', () => {
    expect(providerName('opencode')).toBe('OpenCode Zen')
    expect(providerName('zai-coding-plan')).toBe('Z.AI Coding Plan')
    expect(providerName('openai')).toBe('OpenAI (ChatGPT)')
    expect(providerName('ollama')).toBe('Ollama (local)')
    expect(providerName('my-custom_ai')).toBe('My Custom AI')
    expect(modelName('zai-coding-plan/glm-5.2-highspeed')).toBe('GLM 5.2 Highspeed')
  })

  it('groups every provider, flags the unconnected one and keeps the flat shape', async () => {
    const calls: string[][] = []
    const r = await listModels('opencode', { run: runner(calls), service: svc, now: () => 0 })
    expect(calls).toEqual(expect.arrayContaining([['models'], ['auth', 'list']]))
    expect(r.providers!.map((p) => [p.providerId, p.providerName, p.connected])).toEqual([
      ['opencode', 'OpenCode Zen', true],
      ['ollama', 'Ollama (local)', true],
      ['x', 'X', true],
      ['zai-coding-plan', 'Z.AI Coding Plan', true],
      ['openai', 'OpenAI (ChatGPT)', false],
    ])
    const zen = r.providers![0]!.models
    expect(zen.find((m) => m.id === 'opencode/big-pickle')).toMatchObject({ name: 'Big Pickle', free: true })
    expect(zen.find((m) => m.id === 'opencode/fledge-alpha-free')).toMatchObject({ efforts: ['low', 'high'], free: true, context: 1048576 })
    expect(r.providers![1]!.models[0]?.free).toBe(false)
    expect(r.providers![3]!.models[0]).toMatchObject({ id: 'zai-coding-plan/glm-4.7', name: 'GLM 4.7', free: false })
    expect(r.models).toHaveLength(6)
    expect(r.efforts).toEqual({ 'opencode/fledge-alpha-free': ['low', 'high'] })
  })

  it('works from the CLI alone when the service and auth list fail', async () => {
    const r = await listModels('opencode', { run: runner([], cliOut, new Error('boom')), service: async () => { throw new Error('down') } })
    expect(r.models).toHaveLength(5)
    expect(r.providers!.every((p) => p.connected)).toBe(true)
    expect(r.efforts).toEqual({})
  })

  it('works from the service alone when the CLI is missing', async () => {
    const run = async () => {
      throw Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' })
    }
    const r = await listModels('opencode', { run, service: svc })
    expect(r.models).toContain('opencode/big-pickle')
    expect(r.error).toBeUndefined()
  })

  it('caches for five minutes, a refresh skips it and a degraded list is kept briefly', async () => {
    const calls: string[][] = []
    const run = runner(calls)
    await listModels('opencode', { run, service: svc, now: () => 0 })
    await listModels('opencode', { run, service: svc, now: () => 1000 })
    expect(count(calls)).toBe(1)
    await listModels('opencode', { run, service: svc, now: () => 2000, refresh: true })
    expect(count(calls)).toBe(2)
    await listModels('opencode', { run, service: svc, now: () => 6 * 60 * 1000 })
    expect(count(calls)).toBe(3)
    resetModelsCache()
    const none = async () => ({})
    await listModels('opencode', { run, service: none, now: () => 0 })
    await listModels('opencode', { run, service: none, now: () => 10_000 })
    expect(count(calls)).toBe(4)
    await listModels('opencode', { run, service: none, now: () => 40_000 })
    expect(count(calls)).toBe(5)
  })

  it('handles no providers, odd providers and a huge list', async () => {
    const empty = await listModels('opencode', { run: runner([], '\r\n'), service: async () => ({}) })
    expect(empty).toMatchObject({ models: [], providers: [], error: 'opencode listed no models' })
    resetModelsCache()
    const big = Array.from({ length: 300 }, (_, i) => `p${i % 7}/model-${i}:v${i}`).join('\n')
    const r = await listModels('opencode', { run: runner([], big), service: async () => ({}) })
    expect(r.models).toHaveLength(300)
    expect(r.providers).toHaveLength(7)
    const odd = buildProviders(['weird.prov_1/a@b+c:d', 'zz/m'], {}, new Set(['somethingelse']))
    expect(odd.map((p) => [p.providerName, p.connected])).toEqual([['Weird Prov 1', false], ['Zz', false]])
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
