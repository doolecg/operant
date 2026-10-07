import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Run, RunEvent, RunInput } from '../shared/types'
import { DiscordManager } from './discord'
import type { DiscordMasterPort } from './discord-commands'
import type { ButtonDef, ChannelCheck, CommandDef, DiscordGateway, GatewayIdentity, GatewayInteraction, GatewayMessage, GatewayReaction, ModalDef } from './discord-gateway'
import { PROGRESS_MS } from './discord-mirror'
import { MemorySecretStore } from './discord-secrets'
import { Store } from './store'

const TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.GxYzAb.abcdefghijklmnopqrstuvwxyz0123456789'
const OWNER = '1000000001'
const HELPER = '1000000003'
const STRANGER = '2000000002'
const CHANNEL = '3000000001'
const HOME = '3000000002'

class Gw implements DiscordGateway {
  sent: Array<{ channelId: string; text: string; id: string }> = []
  rich: Array<{ channelId: string; text: string; buttons: ButtonDef[]; id: string }> = []
  edits: Array<{ channelId: string; messageId: string; text: string }> = []
  threads: Array<{ channelId: string; messageId: string; name: string; id: string }> = []
  registered: CommandDef[][] = []
  checks: ChannelCheck[] = []
  private onMsg: (m: GatewayMessage) => void = () => {}
  private onInter: (i: GatewayInteraction) => void = () => {}
  private n = 100

  async connect(): Promise<GatewayIdentity> {
    return { userId: '9000000009', username: 'operant-bot' }
  }
  async disconnect() {}
  guilds() {
    return [{ id: '1', name: 'Test server' }]
  }
  onMessage(cb: (m: GatewayMessage) => void) {
    this.onMsg = cb
  }
  onReaction(_cb: (r: GatewayReaction) => void) {}
  onClosed() {}
  onRestored() {}
  onInteraction(cb: (i: GatewayInteraction) => void) {
    this.onInter = cb
  }
  async registerCommands(defs: CommandDef[]) {
    this.registered.push(defs)
    return { guilds: 1, failed: [] }
  }
  async inspect() {
    return this.checks
  }
  async send(channelId: string, text: string) {
    const id = String(++this.n)
    this.sent.push({ channelId, text, id })
    return id
  }
  async sendRich(channelId: string, text: string, buttons: ButtonDef[]) {
    const id = String(++this.n)
    this.rich.push({ channelId, text, buttons, id })
    return id
  }
  async edit(channelId: string, messageId: string, text: string) {
    this.edits.push({ channelId, messageId, text })
  }
  async react() {}
  async renameThread() {}
  async createThread(channelId: string, messageId: string, name: string) {
    const id = `thread-${++this.n}`
    this.threads.push({ channelId, messageId, name, id })
    return id
  }
  say(m: Partial<GatewayMessage> & { content: string }) {
    this.onMsg({ id: String(++this.n), channelId: CHANNEL, parentId: null, authorId: OWNER, authorName: 'owner', authorIsBot: false, isDirect: false, mentionsBot: true, ...m })
  }
  // A user action; the replies the bot gave are recorded in `rec`.
  act(over: Partial<GatewayInteraction>) {
    const rec = { replies: [] as Array<{ text: string; buttons?: ButtonDef[] }>, deferred: false, modal: null as ModalDef | null, cleared: false, choices: null as Array<{ name: string; value: string }> | null }
    const i: GatewayInteraction = {
      type: 'command',
      userId: OWNER,
      userName: 'owner',
      channelId: CHANNEL,
      parentId: null,
      guildId: '1',
      name: '',
      options: {},
      focused: null,
      customId: '',
      text: '',
      reply: async (text, buttons) => void rec.replies.push({ text, buttons }),
      defer: async () => void (rec.deferred = true),
      choices: async (list) => void (rec.choices = list),
      modal: async (d) => void (rec.modal = d),
      clearButtons: async () => void (rec.cleared = true),
      ...over,
    }
    this.onInter(i)
    return rec
  }
  to(channelId: string) {
    return this.sent.filter((s) => s.channelId === channelId).map((s) => s.text)
  }
}

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
}

describe('Discord as the Master channel', () => {
  let store: Store
  let gw: Gw
  let mgr: DiscordManager
  let crewId: number
  let botId: number
  let calls: string[]
  let submitted: RunInput[]
  let prompts: string[]
  let clock: number
  let laters: Array<{ fn: () => void; ms: number }>

  const port = (): DiscordMasterPort => ({
    ownerMessage: (c, t, l) => (calls.push(`owner:${c}:${l}:${t}`), null),
    command: (c, line) => (calls.push(`cmd:${c}:${line}`), null),
    reply: (r, t, by) => void calls.push(`reply:${r}:${by}:${t}`),
    approve: (r, by, n) => void calls.push(`approve:${r}:${by}:${n ?? ''}`),
    sendBack: (r, n, by) => void calls.push(`sendback:${r}:${by}:${n}`),
    stop: async (r) => void calls.push(`stop:${r}`),
    resume: (r) => void calls.push(`resume:${r}`),
    phase: () => 'idle',
    models: async () => ({ models: ['sonnet', 'haiku'], efforts: { sonnet: ['low', 'high'] } }),
  })

  const setup = async (extra: Record<string, unknown> = {}) => {
    const bot = await mgr.create({ name: 'desk', token: TOKEN, allowlist: [OWNER, HELPER], admins: [OWNER], homeChannel: HOME, mentionOnly: false, confirmStart: false, threadPerRequest: true, ...extra })
    await mgr.connect(bot.id)
    botId = bot.id
    await settle()
  }

  // A master-mode run waiting on the owner, with the event the Master's call would have written.
  const asked = (options: string[] = ['SQLite', 'Postgres']): { run: Run; ev: RunEvent } => {
    const run = store.createRun({ crewId, task: 'Add a login page', masterCli: 'claude' })
    store.transitionRun(run.id, 'working')
    store.transitionRun(run.id, 'needs-you', { waiting: 'question', question: 'Which database?', questionOptions: options })
    const ev = store.addRunEvent(run.id, { kind: 'question', source: 'master', body: 'Which database?', options })
    return { run: store.getRun(run.id)!, ev }
  }
  const inReview = (): { run: Run; ev: RunEvent } => {
    const run = store.createRun({ crewId, task: 'Add a login page', masterCli: 'claude' })
    store.transitionRun(run.id, 'working')
    store.transitionRun(run.id, 'review', { reviewSummary: 'Done: **login** page added.' })
    const ev = store.addRunEvent(run.id, { kind: 'review', source: 'master', body: 'Done: **login** page added.' })
    return { run: store.getRun(run.id)!, ev }
  }

  beforeEach(() => {
    store = new Store(':memory:')
    crewId = store.createCrew('alpha', '/p').id
    store.updateCrew(crewId, { discordChannels: [CHANNEL] })
    gw = new Gw()
    calls = []
    submitted = []
    prompts = []
    clock = 1_000_000
    laters = []
    mgr = new DiscordManager({
      store,
      runs: {
        submit: (input) => {
          submitted.push(input)
          return store.createRun({ crewId: input.crewId, task: input.task, masterCli: input.masterCli })
        },
      },
      secrets: new MemorySecretStore(),
      gateway: () => gw,
      frontDesk: async (p) => (prompts.push(p), JSON.stringify({ reply: 'desk', action: null })),
      master: port(),
      now: () => clock,
      later: (fn, ms) => void laters.push({ fn, ms }),
    })
  })
  afterEach(() => store.close())

  it('turns a project channel message into an owner message for the Master, with no model and no job', async () => {
    await setup()
    gw.say({ content: 'what is the state of the build?' })
    await settle()
    expect(calls).toEqual(['owner:' + crewId + ':Discord: owner:what is the state of the build?'])
    expect(prompts).toEqual([])
    expect(submitted).toEqual([])
    gw.say({ content: 'hello', authorId: STRANGER })
    await settle()
    expect(calls).toHaveLength(1)
    expect(gw.to(CHANNEL)).toEqual([])
    gw.say({ channelId: HOME, content: 'tell me a joke' })
    await settle()
    expect(prompts).toHaveLength(1)
  })

  it('starts a master-mode run only for a message that clearly asks for a task, and answers a waiting question in its thread', async () => {
    await setup()
    gw.say({ content: 'task: add a dark mode' })
    await settle()
    expect(submitted).toMatchObject([{ crewId, task: 'add a dark mode' }])
    expect(calls).toEqual([])

    const { run } = asked()
    store.addDiscordThread({ botId, threadId: 'thread-q', parentId: CHANNEL, userId: OWNER, crewId, runId: run.id, title: 'Login', name: `JOB#${run.id} Login`, createdAt: clock })
    gw.say({ channelId: 'thread-q', parentId: CHANNEL, content: 'Use SQLite' })
    await settle()
    expect(calls).toEqual([`reply:${run.id}:owner-discord:Use SQLite`])
  })

  it('registers the commands on connect and again on /restart, and keeps /restart for admins', async () => {
    await setup()
    expect(gw.registered).toHaveLength(1)
    expect(gw.registered[0]!.map((c) => c.name)).toEqual(expect.arrayContaining(['newsolo', 'newteam', 'stop', 'restart', 'status', 'queue', 'approve', 'sendback', 'answer', 'resume', 'master']))
    const stranger = gw.act({ name: 'status', userId: STRANGER })
    await settle()
    expect(stranger.replies[0]!.text).toMatch(/not on this bot's allowlist/)
    const helper = gw.act({ name: 'restart', userId: HELPER })
    await settle()
    expect(helper.replies[0]!.text).toMatch(/Only the bot owner/)
    expect(gw.registered).toHaveLength(1)
    const owner = gw.act({ name: 'restart' })
    await settle()
    expect(owner.replies[0]!.text).toMatch(/Restarting/)
    expect(gw.registered).toHaveLength(2)
  })

  it('starts runs from /newsolo and /newteam with built-in teams offered, and gates /master and /stop to admins', async () => {
    await setup()
    const preset = store.listPresets()[0]!
    const solo = gw.act({ name: 'newsolo', options: { task: 'fix the bug', preset: String(preset.id), cli: 'opencode', model: 'x/y' } })
    await settle()
    expect(solo.deferred).toBe(true)
    expect(submitted[0]).toMatchObject({ crewId, task: 'fix the bug', masterCli: 'opencode', masterModel: 'x/y', seats: [{ presetId: preset.id, count: 1 }] })
    expect(solo.replies.at(-1)!.text).toMatch(/Started JOB#/)

    const teams = gw.act({ type: 'autocomplete', name: 'newteam', focused: { name: 'team', value: '' } })
    await settle()
    const builtin = store.listTeams().find((t) => t.builtin)
    expect(builtin).toBeTruthy()
    expect(teams.choices!.some((c) => c.value === String(builtin!.id) && c.name.includes('built-in'))).toBe(true)
    gw.act({ name: 'newteam', options: { task: 'big job', team: String(builtin!.id) } })
    await settle()
    expect(submitted[1]).toMatchObject({ task: 'big job', teamId: builtin!.id })

    const helper = gw.act({ name: 'master', userId: HELPER, options: { command: 'compact' } })
    const owner = gw.act({ name: 'master', options: { command: 'compact' } })
    await settle()
    expect(helper.replies[0]!.text).toMatch(/Only the bot owner/)
    expect(owner.replies[0]!.text).toMatch(/Queued \/compact/)
    expect(calls).toEqual([`cmd:${crewId}:/compact`])

    const { run } = asked()
    const stop = gw.act({ name: 'stop', options: { job: run.id } })
    await settle()
    expect(calls).toContain(`stop:${run.id}`)
    expect(stop.replies.at(-1)!.text).toBe(`Stopped JOB#${run.id}.`)
  })

  it('mirrors a question with one button per option plus Other, and treats a second click as stale', async () => {
    await setup()
    const { run, ev } = asked()
    mgr.onRunEvent(run, ev)
    await settle()
    expect(gw.threads[0]!.name).toMatch(new RegExp(`^JOB#${run.id} `))
    const q = gw.rich[0]!
    expect(q.channelId).toBe(gw.threads[0]!.id)
    expect(q.text).toContain('Which database?')
    expect(q.buttons.map((b) => b.label)).toEqual(['SQLite', 'Postgres', 'Other...'])

    const click = gw.act({ type: 'button', customId: q.buttons[1]!.id, channelId: q.channelId })
    await settle()
    expect(calls).toEqual([`reply:${run.id}:owner-discord:Postgres`])
    expect(click.cleared).toBe(true)
    store.transitionRun(run.id, 'working', { question: '', questionOptions: [] })
    const stale = gw.act({ type: 'button', customId: q.buttons[0]!.id, channelId: q.channelId })
    await settle()
    expect(stale.replies[0]!.text).toMatch(/already answered/)
    expect(calls).toHaveLength(1)

    const other = asked()
    mgr.onRunEvent(other.run, other.ev)
    await settle()
    const otherBtn = gw.rich.at(-1)!.buttons.at(-1)!
    const modal = gw.act({ type: 'button', customId: otherBtn.id })
    await settle()
    expect(modal.modal).toMatchObject({ id: `qm:${other.run.id}:${other.ev.id}` })
    gw.act({ type: 'modal', customId: modal.modal!.id, text: 'MySQL please' })
    await settle()
    expect(calls.at(-1)).toBe(`reply:${other.run.id}:owner-discord:MySQL please`)
  })

  it('mirrors a review with Approve and Send back, asks a note in a modal, and refuses non-admins and stale clicks', async () => {
    await setup()
    const { run, ev } = inReview()
    mgr.onRunEvent(run, ev)
    await settle()
    const r = gw.rich[0]!
    expect(r.text).toContain('ready for review')
    expect(r.text).toContain('**login**')
    expect(r.buttons.map((b) => b.label)).toEqual(['Approve', 'Send back'])

    const noAdmin = gw.act({ type: 'button', customId: r.buttons[1]!.id, userId: HELPER })
    await settle()
    expect(noAdmin.replies[0]!.text).toMatch(/Only the bot owner/)
    const ask = gw.act({ type: 'button', customId: r.buttons[1]!.id })
    await settle()
    expect(ask.modal).toMatchObject({ id: `sbm:${run.id}:${ev.id}` })
    gw.act({ type: 'modal', customId: ask.modal!.id, text: 'Add tests' })
    await settle()
    expect(calls).toEqual([`sendback:${run.id}:owner-discord:Add tests`])

    const helper = gw.act({ type: 'button', customId: r.buttons[0]!.id, userId: HELPER })
    await settle()
    expect(calls.at(-1)).toBe(`approve:${run.id}:owner-discord:`)
    expect(helper.cleared).toBe(true)
    store.transitionRun(run.id, 'queued')
    const stale = gw.act({ type: 'button', customId: r.buttons[0]!.id })
    await settle()
    expect(stale.replies[0]!.text).toMatch(/not waiting for this review/)
  })

  it('batches progress to one message per 10 s, edits it in place, scrubs secrets and never posts tool output', async () => {
    await setup()
    const run = store.createRun({ crewId, task: 'Add a login page', masterCli: 'claude' })
    store.transitionRun(run.id, 'working')
    const progress = (body: string) => mgr.onRunEvent(store.getRun(run.id)!, store.addRunEvent(run.id, { kind: 'progress', source: 'master', body }))
    progress('step one')
    await settle()
    const thread = gw.threads[0]!.id
    expect(gw.to(thread)).toEqual(['- step one'])
    clock += 1000
    progress(`step two with ${TOKEN}`)
    progress('step three')
    await settle()
    expect(gw.to(thread)).toHaveLength(1)
    expect(laters).toHaveLength(1)
    expect(laters[0]!.ms).toBeLessThanOrEqual(PROGRESS_MS)
    laters[0]!.fn()
    await settle()
    expect(gw.to(thread)).toHaveLength(1)
    expect(gw.edits).toHaveLength(1)
    expect(gw.edits[0]!.text).toContain('step three')
    expect(gw.edits[0]!.text).toContain('[token]')
    expect(gw.edits[0]!.text).not.toContain(TOKEN)
  })

  it('mirrors results at the results level without progress, and nothing when off', async () => {
    await setup({ mirror: 'results' })
    const run = store.createRun({ crewId, task: 'Add a login page', masterCli: 'claude' })
    store.transitionRun(run.id, 'working')
    mgr.onRunEvent(store.getRun(run.id)!, store.addRunEvent(run.id, { kind: 'progress', source: 'master', body: 'quiet step' }))
    mgr.onRunChange({ runId: run.id })
    await settle()
    expect(gw.sent.filter((s) => s.text.includes('quiet step') || s.text.includes('with the Master'))).toEqual([])
    store.transitionRun(run.id, 'failed', {}, 'The Master crashed')
    mgr.onRunChange({ runId: run.id })
    await settle()
    expect(gw.sent.some((s) => s.text.includes('failed') && s.text.includes('The Master crashed'))).toBe(true)

    await mgr.update(botId, { mirror: 'off' })
    const { run: q, ev } = asked()
    const before = gw.sent.length + gw.rich.length
    mgr.onRunEvent(q, ev)
    await settle()
    expect(gw.sent.length + gw.rich.length).toBe(before)
  })

  it('reports a missing permission once in the channel, with the exact permission', async () => {
    gw.checks = [{ id: CHANNEL, found: true, name: 'dev', guild: 'Test server', missing: ['Manage Threads', 'Add Reactions', 'Use Slash Commands'] }]
    await setup()
    const notes = gw.to(CHANNEL).filter((t) => t.includes('missing permissions'))
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('Manage Threads')
    expect(notes[0]).toContain('Use Application Commands')
    expect(notes[0]).not.toContain('Add Reactions')
    gw.act({ name: 'restart' })
    await settle()
    expect(gw.to(CHANNEL).filter((t) => t.includes('missing permissions'))).toHaveLength(1)
  })
})
