import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DiscordPairing, Run, RunInput } from '../shared/types'
import { DiscordError, DiscordManager, chunkMessage, scrubSecrets } from './discord'
import { claudeFrontDeskModel, type FrontDeskModel } from './discord-frontdesk'
import type { DiscordGateway, GatewayIdentity, GatewayMessage, GatewayReaction } from './discord-gateway'
import { FileSecretStore, MemorySecretStore } from './discord-secrets'
import { Store } from './store'

const TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.GxYzAb.abcdefghijklmnopqrstuvwxyz0123456789'
const OWNER = '1000000001'
const STRANGER = '2000000002'
const PROJECT_CHANNEL = '3000000001'
const HOME = '3000000002'
const BOT_ID = '9000000009'

class FakeGateway implements DiscordGateway {
  sent: Array<{ channelId: string; text: string; id: string }> = []
  reactions: Array<{ channelId: string; messageId: string; emoji: string }> = []
  threads: Array<{ channelId: string; messageId: string; name: string; id: string }> = []
  connectedWith: string | null = null
  disconnected = false
  failWith: string | null = null
  serverList = [{ id: '1', name: 'Test server' }]
  private onMsg: (m: GatewayMessage) => void = () => {}
  private onReact: (r: GatewayReaction) => void = () => {}
  private onClose: (reason: string) => void = () => {}
  private onBack: () => void = () => {}
  private n = 100

  async connect(token: string): Promise<GatewayIdentity> {
    if (this.failWith) throw new Error(this.failWith.replace('%TOKEN%', token))
    this.connectedWith = token
    return { userId: BOT_ID, username: 'operant-bot' }
  }
  async disconnect() {
    this.disconnected = true
  }
  guilds() {
    return this.serverList
  }
  onMessage(cb: (m: GatewayMessage) => void) {
    this.onMsg = cb
  }
  onReaction(cb: (r: GatewayReaction) => void) {
    this.onReact = cb
  }
  onClosed(cb: (reason: string) => void) {
    this.onClose = cb
  }
  onRestored(cb: () => void) {
    this.onBack = cb
  }
  async send(channelId: string, text: string) {
    const id = String(++this.n)
    this.sent.push({ channelId, text, id })
    return id
  }
  async react(channelId: string, messageId: string, emoji: string) {
    this.reactions.push({ channelId, messageId, emoji })
  }
  async createThread(channelId: string, messageId: string, name: string) {
    const id = `thread-${++this.n}`
    this.threads.push({ channelId, messageId, name, id })
    return id
  }

  say(m: Partial<GatewayMessage> & { content: string }) {
    this.onMsg({ id: String(++this.n), channelId: PROJECT_CHANNEL, parentId: null, authorId: OWNER, authorName: 'owner', authorIsBot: false, isDirect: false, mentionsBot: true, ...m })
  }
  react2(r: Partial<GatewayReaction> & { messageId: string }) {
    this.onReact({ channelId: PROJECT_CHANNEL, userId: OWNER, emoji: '✅', ...r })
  }
  drop(reason: string) {
    this.onClose(reason)
  }
  restore() {
    this.onBack()
  }
  textTo(channelId: string) {
    return this.sent.filter((s) => s.channelId === channelId).map((s) => s.text)
  }
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))
}

describe('DiscordManager', () => {
  let store: Store
  let gw: FakeGateway
  let secrets: MemorySecretStore
  let logs: string[]
  let submitted: RunInput[]
  let prompts: string[]
  let modelReply: string
  let mgr: DiscordManager
  let crewId: number

  beforeEach(() => {
    store = new Store(':memory:')
    const crew = store.createCrew('alpha', '/p')
    crewId = crew.id
    store.updateCrew(crewId, { discordChannels: [PROJECT_CHANNEL] })
    gw = new FakeGateway()
    secrets = new MemorySecretStore()
    logs = []
    submitted = []
    prompts = []
    modelReply = JSON.stringify({ reply: 'Hello there', action: null })
    const runs = {
      submit: (input: RunInput): Run => {
        submitted.push(input)
        return store.setRunStatus(store.createRun({ crewId: input.crewId, task: input.task, masterCli: input.masterCli }).id, 'working')
      },
    }
    const frontDesk: FrontDeskModel = async (p) => {
      prompts.push(p)
      return modelReply
    }
    mgr = new DiscordManager({ store, runs, secrets, gateway: () => gw, frontDesk, log: (m) => logs.push(m) })
  })
  afterEach(() => store.close())

  const makeBot = async (extra: Record<string, unknown> = {}) => {
    const bot = await mgr.create({ name: 'desk', token: TOKEN, allowlist: [OWNER], homeChannel: HOME, mentionOnly: false, confirmStart: false, ...extra })
    await mgr.connect(bot.id)
    return bot
  }

  describe('bots', () => {
    it('creates, edits and deletes a bot, keeping only a key in the database', async () => {
      const bot = await mgr.create({ name: 'desk', token: TOKEN })
      expect(bot.hasToken).toBe(true)
      expect(bot.tokenRef).toBe(`discord-bot-${bot.id}`)
      expect(secrets.get(bot.tokenRef)).toBe(TOKEN)

      const edited = await mgr.update(bot.id, { name: 'front', rules: 'Be brief', allowlist: [OWNER], homeChannel: HOME, confirmStart: false })
      expect(edited).toMatchObject({ name: 'front', rules: 'Be brief', allowlist: [OWNER], homeChannel: HOME, confirmStart: false })

      await mgr.delete(bot.id)
      expect(mgr.list()).toEqual([])
      expect(secrets.get(bot.tokenRef)).toBeNull()
    })

    it('refuses bad input', async () => {
      await expect(mgr.create({ name: ' ' })).rejects.toBeInstanceOf(DiscordError)
      await expect(mgr.create({ name: 'a', allowlist: ['abc'] })).rejects.toMatchObject({ code: 'BAD_ARGS' })
      await expect(mgr.create({ name: 'a', homeChannel: 'x' })).rejects.toMatchObject({ code: 'BAD_ARGS' })
      await expect(mgr.create({ name: 'a', token: 'short' })).rejects.toMatchObject({ code: 'BAD_ARGS' })
      await mgr.create({ name: 'a' })
      await expect(mgr.create({ name: 'A' })).rejects.toMatchObject({ code: 'CONFLICT' })
      await expect(mgr.update(999, { name: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })

    it('connects, reports health and disconnects', async () => {
      const bot = await mgr.create({ name: 'desk', token: TOKEN })
      expect(mgr.get(bot.id).health.state).toBe('disconnected')
      const on = await mgr.connect(bot.id)
      expect(on.enabled).toBe(true)
      expect(on.health).toMatchObject({ state: 'connected', username: 'operant-bot', guilds: 1 })
      gw.drop('Disconnected (code 1006)')
      expect(mgr.get(bot.id).health).toMatchObject({ state: 'error', error: 'Disconnected (code 1006)' })
      gw.restore()
      expect(mgr.get(bot.id).health.state).toBe('connected')
      const off = await mgr.disconnect(bot.id)
      expect(off.enabled).toBe(false)
      expect(off.health.state).toBe('disconnected')
      expect(gw.disconnected).toBe(true)
    })

    it('connects enabled bots on start and records a failure instead of throwing', async () => {
      const bot = await mgr.create({ name: 'desk', token: TOKEN, enabled: true })
      await mgr.stop()
      gw.failWith = 'Invalid token %TOKEN%'
      await mgr.start()
      const h = mgr.get(bot.id).health
      expect(h.state).toBe('error')
      expect(h.error).not.toContain(TOKEN)
    })

    it('test reports token validity and server membership', async () => {
      const bot = await mgr.create({ name: 'desk' })
      expect(await mgr.test(bot.id)).toMatchObject({ tokenValid: false, error: 'No token is saved for this bot' })
      await mgr.setToken(bot.id, TOKEN)
      expect(await mgr.test(bot.id)).toEqual({ tokenValid: true, username: 'operant-bot', guilds: [{ id: '1', name: 'Test server' }], error: '' })
      expect(gw.disconnected).toBe(true)
      gw.failWith = 'An invalid token was provided: %TOKEN%'
      const bad = await mgr.test(bot.id)
      expect(bad.tokenValid).toBe(false)
      expect(bad.error).not.toContain(TOKEN)
    })
  })

  describe('inbound', () => {
    it("starts the job on the bot's configured Master CLI when it has one", async () => {
      const bot = await makeBot()
      const get = store.getDiscordBot.bind(store)
      store.getDiscordBot = (id) => {
        const b = get(id)
        return b && { ...b, masterCli: 'opencode' }
      }
      gw.say({ id: 'm9', content: 'fix it' })
      await settle()
      expect(submitted).toEqual([{ crewId, task: 'fix it', masterCli: 'opencode' }])
      expect(bot.id).toBeGreaterThan(0)
    })

    it('an allowlisted user starts a job from a project channel, with an ack and a thread', async () => {
      await makeBot()
      gw.say({ id: 'm1', content: 'fix the login bug' })
      await settle()
      expect(submitted).toEqual([{ crewId, task: 'fix the login bug', masterCli: 'claude' }])
      expect(gw.reactions).toContainEqual({ channelId: PROJECT_CHANNEL, messageId: 'm1', emoji: '\u{1F440}' })
      expect(gw.threads).toHaveLength(1)
      expect(gw.threads[0]).toMatchObject({ channelId: PROJECT_CHANNEL, messageId: 'm1' })
      expect(gw.threads[0]!.name).toMatch(/^JOB#20001 fix the login bug/)
      expect(gw.textTo(gw.threads[0]!.id)).toEqual(['JOB#20001 working'])
    })

    it('a user outside the allowlist cannot start a job and only gets a chat reply', async () => {
      await makeBot()
      store.createRun({ crewId, task: 'secret work', masterCli: 'claude' })
      modelReply = JSON.stringify({ reply: 'Sure, starting', action: { type: 'start', project: String(store.getCrew(crewId)!.prjNumber), task: 'delete everything' } })
      gw.say({ authorId: STRANGER, content: 'run: delete everything' })
      await settle()
      expect(submitted).toEqual([])
      expect(gw.threads).toEqual([])
      expect(prompts[0]).toContain('may only chat')
      expect(prompts[0]).not.toContain('secret work')
      expect(gw.textTo(PROJECT_CHANNEL)).toEqual(['Sure, starting'])
    })

    it('hands out a pairing code in a direct message and the allowlist grows on approval', async () => {
      const bot = await makeBot()
      gw.say({ authorId: STRANGER, authorName: 'newbie', channelId: 'dm-1', isDirect: true, content: 'hi' })
      await settle()
      const [pairing] = mgr.pairingsOf(bot.id) as [DiscordPairing]
      expect(pairing).toMatchObject({ userId: STRANGER, username: 'newbie' })
      expect(gw.textTo('dm-1')[0]).toContain(pairing.code)
      expect(submitted).toEqual([])

      gw.say({ authorId: STRANGER, channelId: 'dm-1', isDirect: true, content: 'hi again' })
      await settle()
      expect(mgr.pairingsOf(bot.id)).toHaveLength(1)

      const approved = mgr.approvePairing(bot.id, pairing.code.toLowerCase())
      expect(approved.allowlist).toContain(STRANGER)
      expect(mgr.pairingsOf(bot.id)).toEqual([])
      await settle()
      expect(gw.textTo('dm-1').at(-1)).toContain('approved')

      gw.say({ authorId: STRANGER, channelId: PROJECT_CHANNEL, content: 'do the thing' })
      await settle()
      expect(submitted).toHaveLength(1)
    })

    it('announces a new pairing request once, not a repeat from the same person', async () => {
      const seen: number[] = []
      const watched = new DiscordManager({ store, runs: { submit: () => store.createRun({ crewId, task: 't', masterCli: 'claude' }) }, secrets, gateway: () => gw, frontDesk: async () => modelReply, onPairing: (id) => seen.push(id) })
      const bot = await watched.create({ name: 'desk', token: TOKEN, allowlist: [OWNER], homeChannel: HOME, mentionOnly: false })
      await watched.connect(bot.id)
      gw.say({ authorId: STRANGER, authorName: 'newbie', channelId: 'dm-1', isDirect: true, content: 'hi' })
      await settle()
      gw.say({ authorId: STRANGER, channelId: 'dm-1', isDirect: true, content: 'hi again' })
      await settle()
      expect(seen).toEqual([bot.id])
      await watched.stop()
    })

    it('limits pairing codes per user per hour and lets a new user in when all slots are full', async () => {
      let now = 7_000_000
      const m2 = new DiscordManager({ store, runs: { submit: () => store.createRun({ crewId, task: 't', masterCli: 'claude' }) }, secrets, gateway: () => gw, frontDesk: async () => modelReply, now: () => now })
      const bot = await m2.create({ name: 'desk', token: TOKEN, allowlist: [OWNER], homeChannel: HOME, mentionOnly: false })
      await m2.connect(bot.id)
      const dm = async (authorId: string) => {
        gw.say({ authorId, authorName: `u${authorId}`, channelId: `dm-${authorId}`, isDirect: true, content: 'hi' })
        await settle()
      }
      for (let i = 0; i < 3; i++) {
        await dm(STRANGER)
        m2.denyPairing(bot.id, (m2.pairingsOf(bot.id)[0] as DiscordPairing).code)
      }
      await dm(STRANGER)
      expect(m2.pairingsOf(bot.id)).toEqual([])
      expect(gw.textTo(`dm-${STRANGER}`).at(-1)).toContain('too many pairing codes')
      for (let i = 0; i < 20; i++) {
        now += 1000
        await dm(`50000000${String(i).padStart(2, '0')}`)
      }
      expect(m2.pairingsOf(bot.id)).toHaveLength(20)
      now += 1000
      await dm('6000000001')
      const list = m2.pairingsOf(bot.id)
      expect(list).toHaveLength(20)
      expect(list.some((p) => p.userId === '6000000001')).toBe(true)
      expect(list.some((p) => p.userId === '5000000000')).toBe(false)
      await m2.stop()
    }, 60_000)

    it('denies a pairing and expires it', async () => {
      const bot = await makeBot()
      gw.say({ authorId: STRANGER, channelId: 'dm-1', isDirect: true, content: 'hi' })
      await settle()
      const [p] = mgr.pairingsOf(bot.id) as [DiscordPairing]
      mgr.denyPairing(bot.id, p.code)
      expect(() => mgr.approvePairing(bot.id, p.code)).toThrow(/unknown or has expired/)
    })

    it('keeps a pending pairing across a restart and drops it once expired', async () => {
      let now = 1_000_000
      const mk = () => new DiscordManager({ store, runs: { submit: () => store.createRun({ crewId, task: 't', masterCli: 'claude' }) }, secrets, gateway: () => gw, frontDesk: async () => modelReply, now: () => now })
      const first = mk()
      const bot = await first.create({ name: 'desk', token: TOKEN, allowlist: [OWNER], homeChannel: HOME, mentionOnly: false })
      await first.connect(bot.id)
      gw.say({ authorId: STRANGER, authorName: 'newbie', channelId: 'dm-1', isDirect: true, content: 'hi' })
      await settle()
      const [p] = first.pairingsOf(bot.id) as [DiscordPairing]
      await first.stop()
      const second = mk()
      expect(second.pairingsOf(bot.id)).toEqual([p])
      expect(JSON.stringify(store.db.prepare('SELECT * FROM discord_pairings').all())).not.toContain(TOKEN)
      expect(second.approvePairing(bot.id, p.code).allowlist).toContain(STRANGER)
      expect(second.pairingsOf(bot.id)).toEqual([])
      store.addDiscordPairing(bot.id, { ...p, code: 'OLDONE', createdAt: now - 2 * 60 * 60 * 1000 })
      expect(second.pairingsOf(bot.id)).toEqual([])
    })

    it('respects mention-only and every-message', async () => {
      const bot = await makeBot({ mentionOnly: true })
      gw.say({ content: 'no mention here', mentionsBot: false })
      await settle()
      expect(submitted).toEqual([])
      gw.say({ content: `<@${BOT_ID}> with mention`, mentionsBot: true })
      await settle()
      expect(submitted.map((s) => s.task)).toEqual(['with mention'])
      await mgr.update(bot.id, { mentionOnly: false })
      gw.say({ content: 'now anything goes', mentionsBot: false })
      await settle()
      expect(submitted).toHaveLength(2)
    })

    it('ignores other bots and unknown channels', async () => {
      await makeBot()
      gw.say({ authorIsBot: true, content: 'beep' })
      gw.say({ channelId: '5555555555', content: 'elsewhere' })
      await settle()
      expect(submitted).toEqual([])
      expect(gw.sent).toEqual([])
    })

    it('routes a message in a job thread through its parent project channel', async () => {
      await makeBot()
      gw.say({ channelId: 'thread-1', parentId: PROJECT_CHANNEL, content: 'follow up task' })
      await settle()
      expect(submitted.map((s) => s.crewId)).toEqual([crewId])
    })
  })

  describe('front desk', () => {
    it('answers "what is running" in the home channel from the job list without the model', async () => {
      await makeBot()
      store.setRunStatus(store.createRun({ crewId, task: 'build the thing', masterCli: 'claude' }).id, 'working')
      gw.say({ channelId: HOME, content: 'what is running?' })
      await settle()
      expect(prompts).toEqual([])
      const reply = gw.textTo(HOME)[0]
      expect(reply).toContain('JOB#20001 [working]')
      expect(reply).toContain('build the thing')
    })

    it('starts a job only after the confirmation reaction from the same user', async () => {
      await makeBot({ confirmStart: true })
      const prj = store.getCrew(crewId)!.prjNumber
      modelReply = JSON.stringify({ reply: 'On it.', action: { type: 'start', project: `PRJ${prj}`, task: 'add dark mode' } })
      gw.say({ id: 'm9', channelId: HOME, content: 'please add dark mode to alpha' })
      await settle()
      expect(submitted).toEqual([])
      const ask = gw.sent.find((s) => s.text.includes('React'))!
      expect(gw.reactions).toContainEqual({ channelId: HOME, messageId: ask.id, emoji: '✅' })

      gw.react2({ channelId: HOME, messageId: ask.id, userId: STRANGER })
      await settle()
      expect(submitted).toEqual([])

      gw.react2({ channelId: HOME, messageId: ask.id })
      await settle()
      expect(submitted).toEqual([{ crewId, task: 'add dark mode', masterCli: 'claude' }])

      gw.react2({ channelId: HOME, messageId: ask.id })
      await settle()
      expect(submitted).toHaveLength(1)
    })

    it('asks for confirmation before an allowlisted message in a project channel starts a job, and prunes expired asks', async () => {
      let now = 5_000_000
      const m2 = new DiscordManager({ store, runs: { submit: (i: RunInput) => (submitted.push(i), store.createRun({ crewId, task: i.task, masterCli: 'claude' })) }, secrets, gateway: () => gw, frontDesk: async () => modelReply, now: () => now })
      const bot = await m2.create({ name: 'desk', token: TOKEN, allowlist: [OWNER], homeChannel: HOME, mentionOnly: false, confirmStart: true })
      await m2.connect(bot.id)
      gw.say({ id: 'p1', channelId: PROJECT_CHANNEL, content: 'add dark mode' })
      await settle()
      expect(submitted).toEqual([])
      const ask = gw.sent.find((s) => s.text.includes('React'))!
      expect(ask.text).toContain('add dark mode')
      gw.react2({ channelId: PROJECT_CHANNEL, messageId: ask.id })
      await settle()
      expect(submitted).toHaveLength(1)
      gw.say({ id: 'p2', channelId: PROJECT_CHANNEL, content: 'second task' })
      await settle()
      expect((m2 as unknown as { pending: Map<string, unknown> }).pending.size).toBe(1)
      now += 60 * 60 * 1000
      gw.say({ id: 'p3', channelId: PROJECT_CHANNEL, content: 'third task' })
      await settle()
      expect((m2 as unknown as { pending: Map<string, unknown> }).pending.size).toBe(1)
      await m2.stop()
    })

    it('starts straight away when confirmation is switched off', async () => {
      await makeBot({ confirmStart: false })
      modelReply = JSON.stringify({ reply: 'Starting.', action: { type: 'start', project: 'alpha', task: 'do it' } })
      gw.say({ channelId: HOME, content: 'do it on alpha' })
      await settle()
      expect(submitted.map((s) => s.task)).toEqual(['do it'])
    })

    it('asks which project when it cannot tell, and puts the bot rules in the prompt', async () => {
      await makeBot({ rules: 'Always answer in pirate speak' })
      modelReply = JSON.stringify({ reply: '', action: { type: 'start', project: 'nope', task: 'x' } })
      gw.say({ channelId: HOME, content: 'start x' })
      await settle()
      expect(submitted).toEqual([])
      expect(gw.textTo(HOME)[0]).toContain('which project')
      expect(prompts[0]).toContain('Always answer in pirate speak')
    })

    it('treats a plain-text model answer as a reply', async () => {
      await makeBot()
      modelReply = 'Just text, no JSON'
      gw.say({ channelId: HOME, content: 'hello' })
      await settle()
      expect(gw.textTo(HOME)).toEqual(['Just text, no JSON'])
    })
  })

  describe('front desk model deadline', () => {
    it('stops the run and fails when the model never answers', async () => {
      let stopped = 0
      const adapter = { start: async () => ({ done: new Promise<{ ok: boolean; text: string }>(() => undefined), stop: async () => void stopped++ }) }
      const model = claudeFrontDeskModel(undefined, { adapter, timeoutMs: 20 })
      await expect(model('hi')).rejects.toThrow(/timed out/)
      expect(stopped).toBe(1)
    })
  })

  describe('outbound', () => {
    it('chunks text at 2000 characters', () => {
      const text = `${'a'.repeat(1500)}\n${'b'.repeat(1500)}\n${'c'.repeat(5000)}`
      const parts = chunkMessage(text)
      expect(parts.every((p) => p.length <= 2000)).toBe(true)
      expect(parts.join('').replace(/\n/g, '')).toBe(text.replace(/\n/g, ''))
      expect(chunkMessage('short')).toEqual(['short'])
      expect(chunkMessage('x'.repeat(2000))).toHaveLength(1)
      expect(chunkMessage('x'.repeat(2001))).toHaveLength(2)
    })

    it('posts progress and a chunked outcome in the job thread', async () => {
      await makeBot()
      gw.say({ id: 'm1', content: 'big job' })
      await settle()
      const thread = gw.threads[0]!.id
      const runId = submitted.length ? store.listRuns(crewId)[0]!.id : 0

      store.setRunStatus(runId, 'needs-you', 'Need a decision')
      mgr.onRunChange({ runId })
      await settle()
      store.setRunStatus(runId, 'working')
      mgr.onRunChange({ runId })
      mgr.onRunChange({ runId })
      await settle()
      store.setRunStatus(runId, 'done', 'z'.repeat(4500))
      mgr.onRunChange({ runId })
      await settle()

      const posts = gw.sent.filter((s) => s.channelId === thread)
      expect(posts.every((p) => p.text.length <= 2000)).toBe(true)
      expect(posts.map((p) => p.text.split('\n')[0])).toEqual(['JOB#20001 working', 'JOB#20001 needs-you', 'JOB#20001 working', 'JOB#20001 done', expect.any(String), expect.any(String)])
      expect(posts.map((p) => p.text).join('')).toContain('z'.repeat(2000))
      expect(gw.threads).toHaveLength(1)

      // A finished job no longer reports.
      const before = gw.sent.length
      mgr.onRunChange({ runId })
      await settle()
      expect(gw.sent.length).toBe(before)
    })

    it('ignores jobs that did not start on Discord', async () => {
      await makeBot()
      const run = store.createRun({ crewId, task: 'from the app', masterCli: 'claude' })
      store.setRunStatus(run.id, 'working')
      mgr.onRunChange({ runId: run.id })
      await settle()
      expect(gw.sent).toEqual([])
    })

    it('reports a refused job back to the channel', async () => {
      const bot = await makeBot()
      const refusing = new DiscordManager({
        store,
        runs: {
          submit: () => {
            throw new Error('This team allows 1 worker')
          },
        },
        secrets,
        gateway: () => gw,
        frontDesk: async () => '',
      })
      await refusing.connect(bot.id)
      gw.say({ content: 'too big' })
      await settle()
      expect(gw.textTo(PROJECT_CHANNEL)).toEqual(['Could not start the job: This team allows 1 worker'])
    })
  })

  describe('secrets', () => {
    let dir: string
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'operant-discord-'))
    })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    it('never puts the token in the database, the logs, health or events', async () => {
      const file = join(dir, 'operant.db')
      const fileStore = new Store(file)
      const crew = fileStore.createCrew('beta', '/q')
      const logged: string[] = []
      const m = new DiscordManager({
        store: fileStore,
        runs: { submit: () => store.createRun({ crewId, task: 't', masterCli: 'claude' }) },
        secrets: new FileSecretStore(join(dir, 'secrets'), {
          isAvailable: () => true,
          encrypt: (s) => Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ 0x5a)),
          decrypt: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString('utf8'),
        }),
        gateway: () => gw,
        frontDesk: async () => '',
        log: (msg) => {
          logged.push(msg)
          fileStore.addEvent('discord', scrubSecrets(msg), crew.id, null)
        },
      })
      const bot = await m.create({ name: 'desk', token: TOKEN })
      await m.connect(bot.id)
      await m.test(bot.id)
      await m.disconnect(bot.id)
      gw.failWith = `Login failed with ${TOKEN}`
      await m.connect(bot.id).catch((e: Error) => logged.push(e.message))
      logged.push(JSON.stringify(m.list()), JSON.stringify(m.health()), JSON.stringify(await m.test(bot.id)))
      fileStore.close()

      const raw = readdirSync(dir).filter((f) => f.startsWith('operant.db'))
      for (const f of raw) expect(readFileSync(join(dir, f)).includes(Buffer.from(TOKEN))).toBe(false)
      expect(logged.join('\n')).not.toContain(TOKEN)
      expect(logged.join('\n')).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789')
      const blob = readFileSync(join(dir, 'secrets', `discord-bot-${bot.id}.bin`))
      expect(blob.includes(Buffer.from(TOKEN))).toBe(false)
      expect(blob.length).toBeGreaterThan(0)
    })

    it('FileSecretStore round-trips, deletes, rejects bad keys and never stores in the clear', () => {
      const cipher = { isAvailable: () => true, encrypt: (s: string) => Buffer.from(s).reverse(), decrypt: (b: Buffer) => Buffer.from(b).reverse().toString() }
      const s = new FileSecretStore(join(dir, 's'), cipher)
      expect(s.get('k1')).toBeNull()
      s.set('k1', 'hunter2-hunter2-hunter2')
      expect(s.get('k1')).toBe('hunter2-hunter2-hunter2')
      s.delete('k1')
      expect(s.get('k1')).toBeNull()
      expect(() => s.set('../evil', 'x')).toThrow()

      const locked = new FileSecretStore(join(dir, 's2'), { ...cipher, isAvailable: () => false })
      expect(() => locked.set('k', 'secret-secret-secret')).toThrow(/keychain/)
      expect(readdirSync(dir)).not.toContain('s2')
    })

    it('scrubs tokens from text', () => {
      expect(scrubSecrets(`bad ${TOKEN} here`, TOKEN)).toBe('bad [token] here')
      expect(scrubSecrets(`found ${TOKEN}`)).toBe('found [token]')
    })
  })
})
