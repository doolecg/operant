import { describe, expect, it } from 'vitest'
import { DEFAULT_LEARN_SETTINGS } from '../shared/learn'
import { claudeLearnModel } from './learn'
import { learnModelList, resolveLearnAi } from './learn-ai'
import { isLanHost, listLocalModels, localChat, normalizeLocalUrl, testLocal, type LocalFetch } from './localllm'

interface Call {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
}

// A fake server: answers by path with [status, json].
const server = (routes: Record<string, Array<[number, unknown]>>, calls: Call[] = []): LocalFetch => {
  const left = Object.fromEntries(Object.entries(routes).map(([k, v]) => [k, [...v]]))
  return async (url, init) => {
    calls.push({ url, method: init?.method, headers: init?.headers, body: init?.body })
    const path = new URL(url).pathname
    const [status, body] = left[path]?.shift() ?? [404, { error: 'not found' }]
    return { ok: status < 400, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) }
  }
}
const chatOk = (content: string): [number, unknown] => [200, { choices: [{ message: { content } }] }]
const BASE = 'http://127.0.0.1:1234'

describe('local LLM URLs', () => {
  it('allows http on this PC and the LAN, and wants a confirmation elsewhere', () => {
    for (const h of ['localhost', '127.0.0.1', '[::1]', '192.168.1.5', '10.0.0.2', '172.20.1.1', 'box.local']) expect(isLanHost(h)).toBe(true)
    for (const h of ['8.8.8.8', '172.32.0.1', 'example.com']) expect(isLanHost(h)).toBe(false)
    expect(normalizeLocalUrl('http://127.0.0.1:1234/v1/')).toEqual({ url: BASE })
    expect(normalizeLocalUrl('http://example.com:1234')).toMatchObject({ error: expect.stringContaining('unencrypted') })
    expect(normalizeLocalUrl('http://example.com:1234', true)).toEqual({ url: 'http://example.com:1234' })
    expect(normalizeLocalUrl('https://example.com')).toEqual({ url: 'https://example.com' })
    expect(normalizeLocalUrl('ftp://x')).toMatchObject({ error: expect.any(String) })
    expect(normalizeLocalUrl('nope')).toMatchObject({ error: expect.stringContaining('not a URL') })
  })
})

describe('local LLM client', () => {
  it('lists models from /v1/models, falling back to Ollama /api/tags', async () => {
    expect(await listLocalModels(BASE, { fetch: server({ '/v1/models': [[200, { data: [{ id: 'qwen' }, { id: 'qwen' }, { id: 'llama' }] }]] }) })).toEqual({ models: ['qwen', 'llama'] })
    expect(await listLocalModels(BASE, { fetch: server({ '/api/tags': [[200, { models: [{ name: 'llama3:8b' }] }]] }) })).toEqual({ models: ['llama3:8b'] })
    expect(await listLocalModels(BASE, { fetch: server({ '/v1/models': [[200, { data: [] }]] }) })).toMatchObject({ models: [], error: expect.stringContaining('lists no models') })
  })

  it('sends the key as a bearer token and never puts it in an error', async () => {
    const calls: Call[] = []
    const fetch = server({ '/v1/chat/completions': [[401, { error: { message: 'bad key sk-abcdefghijklmnopqrstuvwxyz123456' } }]] }, calls)
    await expect(localChat(BASE, 'm', [{ role: 'user', content: 'hi' }], {}, { fetch, apiKey: () => 'secret-key' })).rejects.toThrow(/answered 401: bad key(?!.*sk-abcdefghijkl)/)
    expect(calls[0]!.headers).toMatchObject({ Authorization: 'Bearer secret-key' })
  })

  it('asks for JSON, retries without response_format when the server refuses it, and tidies think blocks and fences', async () => {
    const calls: Call[] = []
    const fetch = server({ '/v1/chat/completions': [[400, { error: "'response_format.type' must be 'json_schema'" }], chatOk('<think>hmm</think>```json\n[1]\n```')] }, calls)
    expect(await localChat(BASE, 'm', [{ role: 'user', content: 'x' }], { json: true }, { fetch })).toBe('[1]')
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ model: 'm', stream: false, response_format: { type: 'json_object' } })
    expect(JSON.parse(calls[1]!.body!).response_format).toBeUndefined()
  })

  it('aborts a request that hangs and says so', async () => {
    let aborted = false
    const fetch: LocalFetch = (_u, init) => new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => ((aborted = true), reject(new Error('aborted')))))
    await expect(localChat(BASE, 'm', [{ role: 'user', content: 'x' }], {}, { fetch, timeoutMs: 20 })).rejects.toThrow(/timed out after/)
    expect(aborted).toBe(true)
  })

  it('reports an unreachable server and an empty answer honestly', async () => {
    const down: LocalFetch = async () => {
      throw new Error('connect ECONNREFUSED')
    }
    expect(await testLocal(BASE, 'm', { fetch: down })).toMatchObject({ ok: false, error: expect.stringContaining('Could not reach http://127.0.0.1:1234') })
    await expect(localChat(BASE, 'm', [{ role: 'user', content: 'x' }], {}, { fetch: server({ '/v1/chat/completions': [chatOk('  ')] }) })).rejects.toThrow('returned no text')
  })

  it('Test lists the models, then chats once, with the time', async () => {
    const calls: Call[] = []
    const fetch = server({ '/v1/models': [[200, { data: [{ id: 'm' }] }]], '/v1/chat/completions': [chatOk('ok')] }, calls)
    let t = 100
    const r = await testLocal(BASE, 'm', { fetch }, () => (t += 50))
    expect(r).toEqual({ ok: true, ms: 50, error: '', models: 1 })
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/v1/models', '/v1/chat/completions'])
  })
})

describe('local server as the learn AI and as a ChatModel', () => {
  const settings = { ...DEFAULT_LEARN_SETTINGS, cli: 'local' as const, localUrl: BASE }

  it('defaults to the first model the server lists and checks an own choice against the list', async () => {
    const list = learnModelList(() => settings, { fetch: server({ '/v1/models': [[200, { data: [{ id: 'a' }, { id: 'b' }] }]] }) })
    expect(await resolveLearnAi({ ...settings, model: '' }, list)).toMatchObject({ cli: 'local', model: 'a', isDefault: true })
    const list2 = learnModelList(() => settings, { fetch: server({ '/v1/models': [[200, { data: [{ id: 'a' }] }]] }) })
    expect(await resolveLearnAi({ ...settings, model: 'zzz' }, list2)).toMatchObject({ error: 'The local server does not list the model zzz' })
    const refused = learnModelList(() => ({ ...settings, localUrl: 'http://example.com' }), { fetch: server({}) })
    expect(await resolveLearnAi({ ...settings, model: '' }, refused)).toMatchObject({ model: null, error: expect.stringContaining('unencrypted') })
  })

  it('the learn model sends the prompt to the local server and records what it used', async () => {
    const calls: Call[] = []
    const fetch = server({ '/v1/models': [[200, { data: [{ id: 'a' }] }]], '/v1/chat/completions': [chatOk('[]')] }, calls)
    const model = claudeLearnModel(undefined, { settings: () => settings, local: { fetch } })
    const used: unknown[] = []
    expect(await model('the prompt', (u) => used.push(u))).toBe('[]')
    expect(used).toEqual([{ cli: 'local', model: 'a' }])
    expect(JSON.parse(calls.at(-1)!.body!).messages).toEqual([{ role: 'user', content: 'the prompt' }])
  })

})
