import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Run, RunInput } from '../shared/types'
import { DiscordManager } from './discord'
import { discordAiModel } from './discord-ai'
import { askFrontDesk, type FrontDeskModel } from './discord-frontdesk'
import type { DiscordGateway, GatewayIdentity, GatewayMessage, GatewayReaction } from './discord-gateway'
import { aiThreadTitle, threadTitle, uniqueThreadName } from './discord-threads'
import { MemorySecretStore } from './discord-secrets'
import { Store } from './store'

const TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.GxYzAb.abcdefghijklmnopqrstuvwxyz0123456789'
const OWNER = '1000000001'
const STRANGER = '2000000002'
const PROJECT_CHANNEL = '3000000001'
const HOME = '3000000002'
const BOT_ID = '9000000009'

class Gw implements DiscordGateway {
  sent: Array<{ channelId: string; text: string }> = []
  threads: Array<{ channelId: string; messageId: string; name: string; id: string; archive?: number }> = []
  renames: Array<{ threadId: string; name: string }> = []
  threadError: (Error & { permission?: boolean }) | null = null
  onReact: (r: GatewayReaction) => void = () => {}
  n = 100
  private onMsg: (m: GatewayMessage) => void = () => {}
  async connect(): Promise<GatewayIdentity> {
    return { userId: BOT_ID, username: 'operant-bot' }
  }
  async disconnect() {}
  guilds() {
    return [{ id: '1', name: 'Test server' }]
  }
  onMessage(cb: (m: GatewayMessage) => void) {
    this.onMsg = cb
  }
  onReaction(cb: (r: GatewayReaction) => void) {
    this.onReact = cb
  }
  onClosed() {}
  onRestored() {}
  async send(channelId: string, text: string) {
    this.sent.push({ channelId, text })
    return String(++this.n)
  }
  async react() {}
  async createThread(channelId: string, messageId: string, name: string, archive?: number) {
    if (this.threadError) throw this.threadError
    const id = `thread-${++this.n}`
    this.threads.push({ channelId, messageId, name, id, archive })
    return id
  }
  async renameThread(threadId: string, name: string) {
    this.renames.push({ threadId, name })
  }
  say(m: Partial<GatewayMessage> & { content: string }) {
    this.onMsg({ id: String(++this.n), channelId: PROJECT_CHANNEL, parentId: null, authorId: OWNER, authorName: 'owner', authorIsBot: false, isDirect: false, mentionsBot: true, ...m })
  }
  textTo(channelId: string) {
    return this.sent.filter((s) => s.channelId === channelId).map((s) => s.text)
  }
}

const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0))
}

describe('thread names', () => {
  it('cleans mentions, urls and markdown, takes the first sentence and Title Cases it', () => {
    expect(threadTitle('<@123> please **fix** https://x.io/a the login bug. Then more words')).toBe('Please Fix the Login Bug')
    expect(threadTitle('```js\ncode\n```\nhello there')).toBe('Hello There')
    expect(threadTitle('one two three four five six seven eight nine ten')).toBe('One Two Three Four Five Six Seven Eight')
    expect(threadTitle('<@123> https://x.io')).toBe('Request')
    expect(threadTitle('x'.repeat(300)).length).toBeLessThanOrEqual(88)
  })
  it('makes names unique with a counter and keeps them within 100 characters', () => {
    expect(uniqueThreadName('Fix Bug', ['fix bug'])).toBe('Fix Bug (2)')
    expect(uniqueThreadName('Fix Bug', ['Fix Bug', 'Fix Bug (2)'])).toBe('Fix Bug (3)')
    expect(uniqueThreadName('y'.repeat(100), ['y'.repeat(100)])).toHaveLength(100)
  })
  it('asks the model for an AI title, falling back to code on failure or a slow answer', async () => {
    expect(await aiThreadTitle(async () => '"Login Bug Fix"\nextra', 'fix the login bug please')).toBe('Login Bug Fix')
    expect(await aiThreadTitle(async () => Promise.reject(new Error('down')), 'fix the login bug')).toBe('Fix the Login Bug')
    expect(await aiThreadTitle(() => new Promise(() => {}), 'fix the login bug', 20)).toBe('Fix the Login Bug')
  })
})

describe('threads per request', () => {
  let store: Store
  let gw: Gw
  let submitted: RunInput[]
  let modelReply: string
  let titled: string[]
  let mgr: DiscordManager
  let crewId: number
  const runs = () => ({
    submit: (input: RunInput): Run => {
      submitted.push(input)
      return store.setRunStatus(store.createRun({ crewId: input.crewId, task: input.task, masterCli: input.masterCli }).id, 'working')
    },
  })
  const frontDesk: FrontDeskModel = async (p) => {
    if (p.startsWith('Give a title')) {
      titled.push(p)
      return 'Smart Title'
    }
    return modelReply
  }
  const secrets = new MemorySecretStore()
  const manager = () => new DiscordManager({ store, runs: runs(), secrets, gateway: () => gw, frontDesk })

  beforeEach(() => {
    store = new Store(':memory:')
    crewId = store.createCrew('alpha', '/p').id
    store.updateCrew(crewId, { discordChannels: [PROJECT_CHANNEL] })
    gw = new Gw()
    submitted = []
    titled = []
    modelReply = JSON.stringify({ reply: 'Hello there', action: null })
    mgr = manager()
  })
  afterEach(() => store.close())

  const makeBot = async (extra: Record<string, unknown> = {}) => {
    const bot = await mgr.create({ name: 'desk', token: TOKEN, allowlist: [OWNER], homeChannel: HOME, mentionOnly: false, confirmStart: false, ...extra })
    await mgr.connect(bot.id)
    return bot
  }

  it('defaults to a thread per request, archived after a day, with the settings validated', async () => {
    const bot = await makeBot()
    expect(bot).toMatchObject({ threadPerRequest: true, threadNames: 'auto', threadArchive: 1440, ai: { cli: 'claude', model: '', effort: '', localUrl: 'http://127.0.0.1:1234' } })
    await expect(mgr.update(bot.id, { threadArchive: 5 as never })).rejects.toThrow(/threadArchive/)
    await expect(mgr.update(bot.id, { ai: { cli: 'x' as never } })).rejects.toThrow(/ai.cli/)
  })

  it('creates one named thread for the request and replies only inside it', async () => {
    await makeBot({ threadArchive: 4320 })
    gw.say({ id: 'req1', channelId: HOME, content: 'hello **there** friend' })
    await settle()
    expect(gw.threads).toHaveLength(1)
    expect(gw.threads[0]).toMatchObject({ channelId: HOME, messageId: 'req1', name: 'Hello There Friend', archive: 4320 })
    expect(gw.textTo(HOME)).toEqual([])
    expect(gw.textTo(gw.threads[0]!.id)).toEqual(['Hello there'])
  })

  it('asks for confirmation inside the thread and starts the job there', async () => {
    await makeBot({ confirmStart: true })
    gw.say({ id: 'req1', content: 'fix the login bug' })
    await settle()
    const thread = gw.threads[0]!.id
    expect(gw.textTo(thread)[0]).toContain('React')
    expect(gw.textTo(PROJECT_CHANNEL)).toEqual([])
    expect(submitted).toHaveLength(0)
    gw.onReact({ channelId: thread, messageId: String(gw.n), userId: OWNER, emoji: '✅' })
    await settle()
    expect(submitted).toHaveLength(1)
    expect(gw.threads).toHaveLength(1)
    expect(gw.textTo(thread).join('\n')).toContain('JOB#20001 working')
    expect(gw.renames[0]).toMatchObject({ threadId: thread, name: 'JOB#20001 Fix the Login Bug' })
  })

  it('names the thread with the JOB number when a job starts, and sends progress inside the thread', async () => {
    await makeBot()
    gw.say({ id: 'req1', content: 'fix the login bug' })
    await settle()
    expect(submitted).toHaveLength(1)
    const thread = gw.threads[0]!.id
    expect(gw.threads).toHaveLength(1)
    expect(gw.renames).toEqual([{ threadId: thread, name: 'JOB#20001 Fix the Login Bug' }])
    expect(gw.textTo(thread).join('\n')).toContain('JOB#20001 working')
    expect(gw.textTo(PROJECT_CHANNEL)).toEqual([])
    expect(store.getDiscordThread(1, thread)).toMatchObject({ runId: 20001, crewId, name: 'JOB#20001 Fix the Login Bug' })
  })

  it('keeps a follow-up in the thread: no second thread, and no mention needed', async () => {
    await makeBot({ mentionOnly: true })
    gw.say({ id: 'req1', channelId: HOME, content: 'hello' })
    await settle()
    const thread = gw.threads[0]!.id
    gw.say({ id: 'req2', channelId: thread, parentId: HOME, content: 'and what about now', mentionsBot: false })
    await settle()
    expect(gw.threads).toHaveLength(1)
    expect(gw.textTo(thread)).toEqual(['Hello there', 'Hello there'])
    // A thread the bot does not own still needs the mention.
    gw.say({ channelId: 'someone-elses', parentId: HOME, content: 'chatter', mentionsBot: false })
    await settle()
    expect(gw.textTo('someone-elses')).toEqual([])
  })

  it('routes a follow-up in the thread to the same project after a restart', async () => {
    const bot = await makeBot()
    gw.say({ id: 'req1', channelId: HOME, content: 'hello' })
    await settle()
    const thread = gw.threads[0]!.id
    await mgr.stop()
    mgr = manager()
    await mgr.connect(bot.id)
    // The thread is in no configured channel, only in the bookkeeping.
    store.updateCrew(crewId, { discordChannels: [] })
    modelReply = JSON.stringify({ reply: 'Back again', action: null })
    gw.say({ channelId: thread, parentId: '999999999', content: 'still there?', mentionsBot: false })
    await settle()
    expect(gw.threads).toHaveLength(1)
    expect(gw.textTo(thread)).toEqual(['Hello there', 'Back again'])
    expect(store.getDiscordThread(bot.id, thread)?.parentId).toBe(HOME)
  })

  it('names unique threads in the same channel with a counter', async () => {
    await makeBot()
    gw.say({ channelId: HOME, content: 'hello' })
    await settle()
    gw.say({ channelId: HOME, content: 'hello' })
    await settle()
    expect(gw.threads.map((t) => t.name)).toEqual(['Hello', 'Hello (2)'])
  })

  it('titles with the AI when asked, and costs one short prompt', async () => {
    await makeBot({ threadNames: 'ai' })
    gw.say({ channelId: HOME, content: 'hello' })
    await settle()
    expect(titled).toHaveLength(1)
    expect(gw.threads[0]!.name).toBe('Smart Title')
  })

  it('replies in the channel when threads are turned off', async () => {
    await makeBot({ threadPerRequest: false })
    gw.say({ channelId: HOME, content: 'hello' })
    await settle()
    expect(gw.threads).toHaveLength(0)
    expect(gw.textTo(HOME)).toEqual(['Hello there'])
  })

  it('replies in place in a direct message', async () => {
    await makeBot()
    gw.say({ channelId: 'dm-1', isDirect: true, content: 'hello' })
    await settle()
    expect(gw.threads).toHaveLength(0)
    expect(gw.textTo('dm-1')).toEqual(['Hello there'])
  })

  it('reports a missing permission once in the channel and falls back to replying there', async () => {
    await makeBot()
    gw.threadError = Object.assign(new Error('Missing Permissions'), { permission: true })
    gw.say({ channelId: HOME, content: 'hello' })
    await settle()
    gw.say({ channelId: HOME, content: 'hello again' })
    await settle()
    const said = gw.textTo(HOME)
    expect(said.filter((t) => t.includes('Create Public Threads') && t.includes('Send Messages in Threads'))).toHaveLength(1)
    expect(said.filter((t) => t === 'Hello there')).toHaveLength(2)
    expect(store.listDiscordThreads(1)).toEqual([])
  })

  it('falls back quietly for any other thread error', async () => {
    await makeBot()
    gw.threadError = new Error('boom')
    gw.say({ channelId: HOME, content: 'hello' })
    await settle()
    expect(gw.textTo(HOME)).toEqual(['Hello there'])
  })

  it('gives non-allowlisted users no thread and no job', async () => {
    await makeBot()
    modelReply = JSON.stringify({ reply: 'chat', action: { type: 'start', project: 'alpha', task: 'rm' } })
    gw.say({ channelId: HOME, authorId: STRANGER, content: 'start a job' })
    await settle()
    expect(gw.threads).toHaveLength(0)
    expect(submitted).toHaveLength(0)
    expect(gw.textTo(HOME)).toEqual(['chat'])
  })

  it('ignores a channel the bot does not serve', async () => {
    await makeBot()
    gw.say({ channelId: 'elsewhere', content: 'hello' })
    await settle()
    expect(gw.threads).toHaveLength(0)
    expect(gw.sent).toEqual([])
  })
})

describe('the bot AI', () => {
  const ctx = { bot: { rules: '' } as never, crews: [], runs: [], text: 'hi', chatOnly: false }
  it('reads JSON wrapped in prose or code fences from a small model', async () => {
    const a = await askFrontDesk(async () => 'Sure! Here you go:\n```json\n{"reply": "Hi {there}", "action": null}\n```\nHope that helps', ctx)
    expect(a).toEqual({ reply: 'Hi {there}', action: null })
    const b = await askFrontDesk(async () => 'I will do it {"reply":"On it","action":{"type":"start","project":"PRJ1","task":" go "}}', ctx)
    expect(b).toEqual({ reply: 'On it', action: { type: 'start', project: 'PRJ1', task: 'go' } })
  })
  it('answers with plain text when there is no JSON', async () => {
    expect(await askFrontDesk(async () => '```\njust words\n```', ctx)).toEqual({ reply: 'just words', action: null })
  })

  it('builds a model for local, OpenCode and Claude paths', async () => {
    const calls: string[] = []
    const fetch = async (url: string) => {
      calls.push(url)
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'ready' } }] }) }
    }
    const local = discordAiModel({ cli: 'local', model: 'qwen', effort: '', localUrl: 'http://127.0.0.1:1234' }, { opencode: () => undefined, local: { fetch } })
    expect(await local('hi')).toBe('ready')
    expect(calls[0]).toBe('http://127.0.0.1:1234/v1/chat/completions')
    const missing = discordAiModel({ cli: 'opencode', model: '', effort: '', localUrl: '' }, { opencode: () => undefined })
    await expect(missing('hi')).rejects.toThrow(/OpenCode/)
    const seen: Array<{ model?: string; effort?: string }> = []
    const adapter = { start: async (o: { model?: string; effort?: string }) => (seen.push({ model: o.model, effort: o.effort }), { stop: async () => {}, done: Promise.resolve({ ok: true, text: 'ok' }) }) }
    const oc = discordAiModel({ cli: 'opencode', model: 'p/m', effort: 'high', localUrl: '' }, { opencode: () => adapter as never })
    expect(await oc('hi')).toBe('ok')
    expect(seen).toEqual([{ model: 'p/m', effort: 'high' }])
  })

  it('tests a bot AI and reports an honest error with the time', async () => {
    const store = new Store(':memory:')
    const used: string[] = []
    const mgr = new DiscordManager({
      store,
      runs: { submit: () => ({}) as Run },
      secrets: new MemorySecretStore(),
      gateway: () => new Gw(),
      frontDesk: async () => 'default answer',
      frontDeskFor: (ai) => async () => {
        used.push(ai.cli)
        if (ai.cli === 'local') throw new Error('Could not reach http://127.0.0.1:1234: refused')
        return 'ready'
      },
    })
    const bot = await mgr.create({ name: 'desk', ai: { cli: 'opencode', model: 'p/m' } })
    expect(await mgr.testAi(bot.id)).toMatchObject({ ok: true, answer: 'ready', error: '' })
    const bad = await mgr.testAi(bot.id, { cli: 'local', localUrl: 'http://127.0.0.1:1234/' })
    expect(bad).toMatchObject({ ok: false, error: expect.stringContaining('refused') })
    expect(bad.ms).toBeGreaterThanOrEqual(0)
    expect(used).toEqual(['opencode', 'local'])
    expect((await mgr.update(bot.id, { ai: { cli: 'claude', model: '' } })).ai.cli).toBe('claude')
    expect(await mgr.testAi(bot.id)).toMatchObject({ ok: true, answer: 'default answer' })
    store.close()
  })
})
