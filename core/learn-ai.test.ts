import { describe, expect, it } from 'vitest'
import { DEFAULT_LEARN_SETTINGS } from '../shared/learn'
import { cheapOpencodeModel, resolveLearnAi } from './learn-ai'
import { claudeLearnModel, LearnService } from './learn'
import { LessonsDb } from './lessons-store'
import { assertFakeClaude, type MasterAdapter, type MasterStart } from './master'
import type { ModelList } from './models'
import { Store } from './store'

const LIST: ModelList = {
  models: ['anthropic/claude-sonnet-5-5', 'google/gemini-3-pro-preview', 'google/gemini-3-flash', 'openai/gpt-5-mini', 'openai/gpt-5'],
  efforts: { 'openai/gpt-5-mini': ['low', 'high'] },
}
const list = async (): Promise<ModelList> => LIST

describe('learn AI choice', () => {
  it('picks the cheapest suitable OpenCode model, never a preview', () => {
    expect(cheapOpencodeModel(LIST.models)).toBe('openai/gpt-5-mini')
    expect(cheapOpencodeModel(['x/model-flash-lite', 'x/model-mini'])).toBe('x/model-flash-lite')
    expect(cheapOpencodeModel(['x/model-flash-preview', 'x/big-instruct'])).toBeNull()
  })

  it('Claude: an empty model is Haiku, effort is dropped where the model has none', async () => {
    expect(await resolveLearnAi({ cli: 'claude', model: '', effort: 'high' }, list)).toEqual({ cli: 'claude', model: 'claude-haiku-4-5', effort: '', isDefault: true })
    expect(await resolveLearnAi({ cli: 'claude', model: 'claude-sonnet-5-5', effort: 'high' }, list)).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high', isDefault: false })
  })

  it('OpenCode: resolves the default at run time, checks an own model against the list and keeps only offered efforts', async () => {
    expect(await resolveLearnAi({ cli: 'opencode', model: '', effort: 'low' }, list)).toEqual({ cli: 'opencode', model: 'openai/gpt-5-mini', effort: 'low', isDefault: true })
    expect(await resolveLearnAi({ cli: 'opencode', model: 'openai/gpt-5#high', effort: 'high' }, list)).toMatchObject({ model: 'openai/gpt-5#high', effort: '' })
    expect(await resolveLearnAi({ cli: 'opencode', model: 'nope/none', effort: '' }, list)).toMatchObject({ error: 'OpenCode does not list the model nope/none' })
    const down = async (): Promise<ModelList> => ({ models: [], efforts: {}, error: 'opencode is not installed or not on PATH' })
    expect(await resolveLearnAi({ cli: 'opencode', model: '', effort: '' }, down)).toMatchObject({ model: null, error: 'opencode is not installed or not on PATH' })
    const dull = async (): Promise<ModelList> => ({ models: ['a/b-instruct'], efforts: {} })
    expect(await resolveLearnAi({ cli: 'opencode', model: '', effort: '' }, dull)).toMatchObject({ model: null, error: expect.stringContaining('pick one') })
  })
})

describe('learn model per CLI', () => {
  const adapter = (started: MasterStart[], result: { ok: boolean; text: string } = { ok: true, text: '[]' }): MasterAdapter => ({
    start: async (o) => (started.push(o), { done: Promise.resolve(result), stop: async () => undefined }),
  })

  it('asks Claude by default and OpenCode when chosen, with the model and effort', async () => {
    const claude: MasterStart[] = []
    const opencode: MasterStart[] = []
    const settings = { ...DEFAULT_LEARN_SETTINGS }
    const model = claudeLearnModel(undefined, { adapter: adapter(claude), opencode: adapter(opencode), settings: () => settings, models: list })
    const used: unknown[] = []
    await model('p1', (u) => used.push(u))
    Object.assign(settings, { cli: 'opencode', model: '', effort: 'low' })
    await model('p2', (u) => used.push(u))
    expect(claude.map((s) => [s.model, s.effort])).toEqual([['claude-haiku-4-5', undefined]])
    expect(opencode.map((s) => [s.model, s.effort, s.permissionMode])).toEqual([['openai/gpt-5-mini', 'low', undefined]])
    expect(used).toEqual([
      { cli: 'claude', model: 'claude-haiku-4-5' },
      { cli: 'opencode', model: 'openai/gpt-5-mini' },
    ])
  })

  it('an OpenCode call that hangs is stopped at the timeout', async () => {
    const stopped: number[] = []
    const hung: MasterAdapter = { start: async () => ({ done: new Promise(() => undefined), stop: async () => void stopped.push(1) }) }
    const model = claudeLearnModel(undefined, { opencode: hung, timeoutMs: 20, settings: () => ({ ...DEFAULT_LEARN_SETTINGS, cli: 'opencode', model: 'openai/gpt-5' }), models: list })
    await expect(model('p')).rejects.toThrow(/timed out/)
    expect(stopped).toEqual([1])
  })

  it('a model OpenCode does not list, or a failed run, fails honestly without starting anything', async () => {
    const opencode: MasterStart[] = []
    const settings = { ...DEFAULT_LEARN_SETTINGS, cli: 'opencode' as const, model: 'nope/none' }
    const model = claudeLearnModel(undefined, { opencode: adapter(opencode), settings: () => settings, models: list })
    await expect(model('p')).rejects.toThrow('OpenCode does not list the model nope/none')
    expect(opencode).toEqual([])
    settings.model = 'openai/gpt-5'
    const failing = claudeLearnModel(undefined, { opencode: adapter([], { ok: false, text: 'auth failed' }), settings: () => settings, models: list })
    await expect(failing('p')).rejects.toThrow('auth failed')
  })

  it('never starts the real OpenCode under test, and the guard names the CLI', async () => {
    const model = claudeLearnModel(undefined, { settings: () => ({ ...DEFAULT_LEARN_SETTINGS, cli: 'opencode', model: 'openai/gpt-5' }), models: list })
    await expect(model('p')).rejects.toThrow('A test tried to start the real opencode')
    expect(() => assertFakeClaude({ OPERANT_E2E: '1', PATH: '' }, 'linux', 'opencode')).toThrow('real opencode')
  })

  it('a missing opencode shows up in the Test result and the learn run records the AI used', async () => {
    const store = new Store(':memory:')
    const crewId = store.createCrew('shop', '/code/shop').id
    const settings = { ...DEFAULT_LEARN_SETTINGS, cli: 'opencode' as const, model: 'openai/gpt-5', review: 'auto' as const }
    let missing = true
    const svc = new LearnService({
      store,
      db: new LessonsDb(store.db),
      hindsight: { retain: async () => ({ ok: true }), recall: async () => ({ ok: true, items: [] }), status: async () => ({ url: '', managed: true, state: 'running', detail: '' }) },
      git: async () => '',
      model: async (_p, onUsed) => {
        onUsed?.({ cli: 'opencode', model: 'openai/gpt-5' })
        if (missing) throw new Error('OpenCode is not installed or not on PATH (the `opencode` command was not found)')
        return '[]'
      },
      settings: () => settings,
      transcript: () => '',
    })
    const bad = await svc.testAi()
    expect(bad).toMatchObject({ ok: false, cli: 'opencode', model: 'openai/gpt-5', error: expect.stringContaining('not installed') })
    expect(bad.ms).toBeGreaterThanOrEqual(0)
    missing = false
    expect(await svc.testAi()).toMatchObject({ ok: true, error: '' })
    const info = await svc.onConversationEnd(crewId, null)
    expect(info).toMatchObject({ cli: 'opencode', model: 'openai/gpt-5', error: '' })
    expect(new LessonsDb(store.db).lastLearnRun(crewId)).toMatchObject({ cli: 'opencode', model: 'openai/gpt-5' })
    store.close()
  })
})
