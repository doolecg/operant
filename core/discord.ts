import { randomBytes, randomInt } from 'node:crypto'
import { DISCORD_MIRRORS, DISCORD_THREAD_ARCHIVES } from '../shared/types'
import type { Crew, DiscordAiTestResult, DiscordBot, DiscordBotAi, DiscordBotInput, DiscordBotPatch, DiscordBotView, DiscordChannelCheck, DiscordHealth, DiscordPairing, DiscordTestResult, Run, RunEvent, RunInput } from '../shared/types'
import { commandDefs, handleInteraction, type CommandHost, type DiscordMasterPort } from './discord-commands'
import { isIntentsError, type DiscordGateway, type GatewayFactory, type GatewayInteraction, type GatewayMessage, type GatewayReaction } from './discord-gateway'
import { discordOutcome } from './discord-format'
import { DiscordMirrorService } from './discord-mirror'
import { askFrontDesk, findProject, projectLabel, type FrontDeskModel } from './discord-frontdesk'
import { aiThreadTitle, jobThreadName, threadTitle, uniqueThreadName } from './discord-threads'
import type { SecretStore } from './discord-secrets'
import type { Store } from './store'

export type DiscordErrorCode = 'BAD_ARGS' | 'NOT_FOUND' | 'CONFLICT'

export class DiscordError extends Error {
  constructor(
    readonly code: DiscordErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'DiscordError'
  }
}

export const DISCORD_LIMIT = 2000
const ACK = '\u{1F440}'
const CONFIRM = '✅'
const ID_RE = /^\d{5,25}$/
const NAME_MAX = 60
const RULES_MAX = 4000
const PAIRING_TTL = 60 * 60 * 1000
const PAIRING_MAX = 20
// New codes one Discord user may ask for per hour; past it they get no new code (an existing one still answers).
const PAIRING_PER_USER = 3
const CONFIRM_TTL = 10 * 60 * 1000
// A message that clearly asks for a new task starts with one of these words and a colon ("task: add a login page").
const NEW_TASK_RE = /^(?:please\s+)?(?:new\s+(?:task|job)|task|job|todo)\s*:\s*([\s\S]+)$/i
// The permissions whose absence stops commands, threads or mirroring, with the words Discord's own UI uses.
const GAP_LABELS: Record<string, string> = {
  'Use Slash Commands': 'Use Application Commands',
  'Create Public Threads': 'Create Public Threads',
  'Send Messages in Threads': 'Send Messages in Threads',
  'Manage Threads': 'Manage Threads',
  'Send Messages': 'Send Messages',
}
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

// Splits text into pieces of at most `max` characters, breaking at a line, then a space, then anywhere.
export function chunkMessage(text: string, max = DISCORD_LIMIT): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max)
    if (cut < max / 2) cut = rest.lastIndexOf(' ', max)
    if (cut < max / 2) cut = max
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^[\n ]/, '')
  }
  if (rest.length > 0 || out.length === 0) out.push(rest)
  return out
}

// Removes a token (and anything shaped like one) from text that may be logged or shown.
export function scrubSecrets(text: string, ...secrets: Array<string | null | undefined>): string {
  let out = text
  for (const s of secrets) if (s) out = out.split(s).join('[token]')
  return out.replace(/[\w-]{23,28}\.[\w-]{6,7}\.[\w-]{27,}/g, '[token]')
}

export const tokenRef = (id: number): string => `discord-bot-${id}`

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export interface DiscordManagerOptions {
  store: Store
  runs: { submit(input: RunInput): Run }
  secrets: SecretStore
  gateway: GatewayFactory
  frontDesk: FrontDeskModel
  // The model for a bot that chose its own AI (OpenCode, a local server or a named Claude model).
  frontDeskFor?: (ai: DiscordBotAi) => FrontDeskModel
  localModels?: (url: string) => Promise<string[]>
  now?: () => number
  log?: (message: string, crewId?: number | null) => void
  onHealth?: (h: DiscordHealth) => void
  // A new pairing request arrived for the bot (the settings page lists it without a refresh).
  onPairing?: (botId: number) => void
  // How Discord reaches a project's Master. Without it, project channels start headless jobs and there are no commands.
  master?: DiscordMasterPort
  // Runs `fn` after `ms`; the mirror's progress batching uses it (tests pass their own clock).
  later?: (fn: () => void, ms: number) => void
}

interface Live {
  gateway: DiscordGateway
  selfId: string
}

interface Pending {
  botId: number
  userId: string
  crewId: number
  task: string
  channelId: string
  originMessageId: string
  // The reply goes where it was asked (a thread or a direct message), so no further thread is made.
  inPlace: boolean
  at: number
}

// Where a job started from Discord reports to: a thread on the message that started it.
interface Origin {
  botId: number
  channelId: string
  messageId: string
  last: string
  chain: Promise<void>
  target: string | null
}

export class DiscordManager {
  private readonly live = new Map<number, Live>()
  private readonly healthOf = new Map<number, DiscordHealth>()
  private readonly pending = new Map<string, Pending>()
  private readonly pairingAsks = new Map<string, number[]>()
  private readonly threadWarned = new Set<string>()
  private readonly origins = new Map<number, Origin>()
  private readonly gapsReported = new Set<string>()
  private readonly starts = new Map<string, { input: RunInput; userId: string; at: number }>()
  private readonly mirror: DiscordMirrorService
  private readonly now: () => number

  constructor(private readonly o: DiscordManagerOptions) {
    this.now = o.now ?? Date.now
    this.mirror = new DiscordMirrorService({
      store: o.store,
      now: this.now,
      later: o.later ?? ((fn, ms) => void setTimeout(fn, ms).unref?.()),
      scrub: (t) => scrubSecrets(t),
      bots: () => [...this.live].flatMap(([id, l]) => { const bot = o.store.getDiscordBot(id); return bot ? [{ bot, gateway: l.gateway }] : [] }),
      log: (m) => o.log?.(m),
      gap: (botId, channelId, text) => void this.reportGap(botId, channelId, text),
    })
  }

  // Lifecycle

  // Connects every enabled bot that has a token. A failure is recorded in that bot's health, never thrown.
  async start(): Promise<void> {
    await Promise.all(
      this.o.store
        .listDiscordBots()
        .filter((b) => b.enabled && b.tokenRef && this.o.secrets.get(b.tokenRef))
        .map((b) => this.connectBot(b.id).catch(() => undefined)),
    )
  }

  async stop(): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.dropConnection(id)))
  }

  list(): DiscordBotView[] {
    return this.o.store.listDiscordBots().map((b) => this.view(b))
  }

  get(id: number): DiscordBotView {
    return this.view(this.require(id))
  }

  health(): DiscordHealth[] {
    return this.o.store.listDiscordBots().map((b) => this.healthFor(b.id))
  }

  async create(input: DiscordBotInput): Promise<DiscordBotView> {
    const name = this.cleanName(input?.name)
    const fields = this.cleanFields(input)
    if (this.o.store.listDiscordBots().some((b) => b.name.toLowerCase() === name.toLowerCase())) throw new DiscordError('CONFLICT', 'A bot with that name already exists')
    const token = input.token === undefined ? null : this.cleanToken(input.token)
    const bot = this.o.store.createDiscordBot({ ...fields, name })
    if (token) this.storeToken(bot, token)
    this.o.log?.(`Discord bot ${bot.name} created`)
    if (input.enabled) return this.setEnabled(bot.id, true)
    return this.get(bot.id)
  }

  async update(id: number, patch: DiscordBotPatch): Promise<DiscordBotView> {
    const cur = this.require(id)
    const next: DiscordBotPatch = { ...this.cleanFields(patch) }
    if (patch.name !== undefined) {
      const name = this.cleanName(patch.name)
      if (this.o.store.listDiscordBots().some((b) => b.id !== id && b.name.toLowerCase() === name.toLowerCase())) throw new DiscordError('CONFLICT', 'A bot with that name already exists')
      next.name = name
    }
    delete next.enabled
    this.o.store.updateDiscordBot(id, next)
    this.o.log?.(`Discord bot ${next.name ?? cur.name} updated`)
    if (patch.enabled !== undefined && patch.enabled !== cur.enabled) return this.setEnabled(id, patch.enabled)
    return this.get(id)
  }

  async delete(id: number): Promise<void> {
    const bot = this.require(id)
    await this.dropConnection(id)
    this.o.secrets.delete(bot.tokenRef || tokenRef(id))
    this.o.store.deleteDiscordBot(id)
    this.healthOf.delete(id)
    for (const [k, p] of this.pending) if (p.botId === id) this.pending.delete(k)
    this.o.log?.(`Discord bot ${bot.name} deleted`)
  }

  async setToken(id: number, token: string): Promise<DiscordBotView> {
    const bot = this.require(id)
    this.storeToken(bot, this.cleanToken(token))
    if (this.live.has(id)) {
      await this.dropConnection(id)
      await this.connectBot(id).catch(() => undefined)
    }
    this.o.log?.(`Discord bot ${bot.name} token replaced`)
    return this.get(id)
  }

  async clearToken(id: number): Promise<DiscordBotView> {
    const bot = this.require(id)
    await this.dropConnection(id)
    this.o.secrets.delete(bot.tokenRef || tokenRef(id))
    this.o.store.updateDiscordBot(id, { tokenRef: '', enabled: false })
    return this.get(id)
  }

  // Connects now and keeps the bot enabled across restarts. A refused token throws.
  connect(id: number): Promise<DiscordBotView> {
    return this.setEnabled(id, true)
  }

  disconnect(id: number): Promise<DiscordBotView> {
    return this.setEnabled(id, false)
  }

  private async setEnabled(id: number, enabled: boolean): Promise<DiscordBotView> {
    this.require(id)
    this.o.store.updateDiscordBot(id, { enabled })
    if (enabled) {
      try {
        await this.connectBot(id)
      } catch (err) {
        throw err instanceof DiscordError ? err : new DiscordError('BAD_ARGS', errText(err))
      }
    } else await this.dropConnection(id)
    return this.get(id)
  }

  // Checks the saved token and which servers the bot is in, without keeping a connection.
  async test(id: number): Promise<DiscordTestResult> {
    const bot = this.require(id)
    const live = this.live.get(id)
    if (live) return { tokenValid: true, username: this.healthFor(id).username, guilds: live.gateway.guilds(), intents: 'ok', channels: await this.checkChannels(bot, live.gateway), error: '' }
    const token = bot.tokenRef ? this.o.secrets.get(bot.tokenRef) : null
    const none: DiscordTestResult = { tokenValid: false, username: '', guilds: [], intents: 'unknown', channels: [], error: '' }
    if (!token) return { ...none, error: this.o.secrets.problem?.(bot.tokenRef || tokenRef(id)) ?? 'No token is saved for this bot' }
    const gateway = this.o.gateway()
    gateway.onLog?.((line) => this.o.log?.(`Discord test ${bot.name}: ${scrubSecrets(line, token)}`))
    try {
      const me = await gateway.connect(token)
      return { tokenValid: true, username: me.username, guilds: gateway.guilds(), intents: 'ok', channels: await this.checkChannels(bot, gateway), error: '' }
    } catch (err) {
      const message = scrubSecrets(errText(err), token)
      if (!isIntentsError(message)) return { ...none, error: message }
      // The token works but the Message Content intent is off: log in without it to read the servers.
      const bare = this.o.gateway()
      try {
        const me = await bare.connect(token, { messageContent: false })
        return { tokenValid: true, username: me.username, guilds: bare.guilds(), intents: 'missing', channels: await this.checkChannels(bot, bare), error: message }
      } catch (err2) {
        return { ...none, error: scrubSecrets(errText(err2), token) }
      } finally {
        await bare.disconnect().catch(() => undefined)
      }
    } finally {
      await gateway.disconnect().catch(() => undefined)
    }
  }

  // Permission gaps in the channels this bot uses (its home and general channels and every project channel).
  private async checkChannels(bot: DiscordBot, gateway: DiscordGateway): Promise<DiscordChannelCheck[]> {
    const ids = [...new Set([bot.homeChannel, bot.generalChannel, ...this.o.store.listCrews().flatMap((c) => c.discordChannels)].filter(Boolean))]
    if (ids.length === 0 || !gateway.inspect) return []
    try {
      return await gateway.inspect(ids)
    } catch {
      return []
    }
  }

  // Sends one tiny message to the bot's AI and reports the answer or the honest error, with the time it took.
  async testAi(id: number, ai?: Partial<DiscordBotAi>): Promise<DiscordAiTestResult> {
    const bot = this.require(id)
    const at = Date.now()
    try {
      const answer = await this.modelFor(ai ? { ...bot, ai: { ...bot.ai, ...this.cleanFields({ ai }).ai } } : bot)('Reply with the single word: ready')
      return { ok: true, answer: answer.trim().slice(0, 300), error: '', ms: Date.now() - at }
    } catch (err) {
      return { ok: false, answer: '', error: scrubSecrets(errText(err)), ms: Date.now() - at }
    }
  }

  // The models a local OpenAI-compatible server offers.
  async localModels(url: string): Promise<string[]> {
    if (!this.o.localModels) return []
    return this.o.localModels(String(url).trim().replace(/\/+$/, ''))
  }

  // Pairing

  pairingsOf(id: number): DiscordPairing[] {
    this.require(id)
    return this.activePairings(id)
  }

  approvePairing(id: number, code: string): DiscordBotView {
    const bot = this.require(id)
    const key = String(code).trim().toUpperCase()
    const p = this.activePairings(id).find((x) => x.code === key)
    if (!p) throw new DiscordError('NOT_FOUND', 'That pairing code is unknown or has expired')
    this.o.store.updateDiscordBot(id, { allowlist: [...new Set([...bot.allowlist, p.userId])] })
    this.o.store.deleteDiscordPairing(id, key)
    this.o.log?.(`Discord bot ${bot.name}: user ${p.username} approved`)
    void this.say(id, p.channelId, 'You are approved. You can now start jobs.').catch(() => undefined)
    return this.get(id)
  }

  denyPairing(id: number, code: string): void {
    this.require(id)
    this.activePairings(id)
    if (!this.o.store.deleteDiscordPairing(id, String(code).trim().toUpperCase())) throw new DiscordError('NOT_FOUND', 'That pairing code is unknown or has expired')
  }

  // Inbound

  private async onMessage(botId: number, m: GatewayMessage): Promise<void> {
    const bot = this.o.store.getDiscordBot(botId)
    const live = this.live.get(botId)
    if (!bot || !live || m.authorIsBot || m.authorId === live.selfId) return
    const allowed = bot.allowlist.includes(m.authorId)
    const text = m.content.replace(new RegExp(`<@!?${live.selfId}>`, 'g'), '').trim()

    if (m.isDirect) {
      if (!text) return
      if (!allowed) return this.pair(bot, m)
      return this.deskReply(bot, m, text, true)
    }
    // A thread this bot made keeps the conversation going without a mention.
    const owned = m.parentId ? this.o.store.getDiscordThread(botId, m.channelId) : null
    if (bot.mentionOnly && !m.mentionsBot && !owned) return
    if (!text) return
    const channels = [m.channelId, m.parentId].filter((c): c is string => !!c)
    const crews = this.o.store.listCrews()
    const crew = (owned?.crewId != null ? crews.find((c) => c.id === owned.crewId) : undefined) ?? crews.find((c) => c.discordChannels.some((ch) => channels.includes(ch)))
    if (!crew && !owned && !channels.some((c) => c === bot.homeChannel || c === bot.generalChannel)) return
    // A project channel (or a thread of one) is the project's Master: no front desk model there. Only allowlisted users
    // talk to it; a message that clearly asks for a new task goes through the request flow below.
    let request = text
    if (crew && this.o.master) {
      if (!allowed) return
      const task = NEW_TASK_RE.exec(text)?.[1]?.trim()
      if (!task) {
        void this.react(botId, m, ACK)
        return this.toMaster(bot, m, text, crew, owned)
      }
      request = task
    }
    void this.react(botId, m, ACK)
    let at = m
    // Inside any thread the reply stays there; otherwise an allowlisted request gets its own thread.
    let inPlace = m.parentId != null
    if (!inPlace && allowed && bot.threadPerRequest) {
      const thread = await this.openThread(bot, m, request, crew ?? null)
      if (thread) {
        at = { ...m, channelId: thread, parentId: m.channelId }
        inPlace = true
      }
    }
    const asked = owned?.runId != null ? `${text}

(This thread is about JOB#${owned.runId}.)` : text
    if (crew && allowed) return this.startOrConfirm(bot, at, crew, request, inPlace)
    return this.deskReply(bot, at, asked, inPlace)
  }

  // A message to the project's Master. In the thread of a run that is working or waiting for an answer it is the answer
  // (or a note); otherwise it is stored as an owner message and the gate types one fixed line to make the Master read it.
  private async toMaster(bot: DiscordBot, m: GatewayMessage, text: string, crew: Crew, owned: ReturnType<Store['getDiscordThread']>): Promise<void> {
    const port = this.o.master!
    const run = owned?.runId != null ? this.o.store.getRun(owned.runId) : null
    if (run && (run.status === 'working' || run.status === 'needs-you') && run.mode === 'master') {
      try {
        port.reply(run.id, text, 'owner-discord')
      } catch (err) {
        return this.say(bot.id, m.channelId, `Could not send that to JOB#${run.id}: ${scrubSecrets(errText(err))}`)
      }
      return this.react(bot.id, m, CONFIRM)
    }
    const err = port.ownerMessage(crew.id, run ? `(In the thread of JOB#${run.id}, which is ${run.status}.) ${text}` : text, `Discord: ${m.authorName}`)
    if (err) await this.say(bot.id, m.channelId, scrubSecrets(err))
    else void this.react(bot.id, m, CONFIRM)
  }

  // Makes the request's thread and remembers it; null means reply in the channel (off, or Discord refused).
  private async openThread(bot: DiscordBot, m: GatewayMessage, text: string, crew: Crew | null): Promise<string | null> {
    const gateway = this.live.get(bot.id)?.gateway
    if (!gateway) return null
    const store = this.o.store
    const title = bot.threadNames === 'ai' ? await aiThreadTitle(this.modelFor(bot), text) : threadTitle(text)
    const name = uniqueThreadName(title, store.listDiscordThreads(bot.id).filter((t) => t.parentId === m.channelId).map((t) => t.name))
    try {
      const id = await gateway.createThread(m.channelId, m.id, name, bot.threadArchive)
      store.addDiscordThread({ botId: bot.id, threadId: id, parentId: m.channelId, userId: m.authorId, crewId: crew?.id ?? null, runId: null, title, name, createdAt: this.now() })
      return id
    } catch (err) {
      this.o.log?.(`Discord bot ${bot.name}: could not start a thread: ${scrubSecrets(errText(err))}`)
      const key = `${bot.id}:${m.channelId}`
      if ((err as { permission?: boolean }).permission && !this.threadWarned.has(key)) {
        this.threadWarned.add(key)
        await this.say(bot.id, m.channelId, 'I could not start a thread here. Give me the Create Public Threads and Send Messages in Threads permissions in this channel. I will reply in the channel instead.').catch(() => undefined)
      }
      return null
    }
  }

  // A direct message from someone not on the allowlist: hand out a code to approve in the app.
  private async pair(bot: DiscordBot, m: GatewayMessage): Promise<void> {
    const list = this.activePairings(bot.id)
    let p = list.find((x) => x.userId === m.authorId)
    if (!p) {
      const key = `${bot.id}:${m.authorId}`
      const asks = (this.pairingAsks.get(key) ?? []).filter((t) => this.now() - t < PAIRING_TTL)
      if (asks.length >= PAIRING_PER_USER) {
        this.pairingAsks.set(key, asks)
        return this.say(bot.id, m.channelId, 'You have asked for too many pairing codes. Try again later.')
      }
      this.pairingAsks.set(key, [...asks, this.now()])
      // Expired codes are already gone; when still full the oldest waiting one makes room, so a flood cannot lock out the next person.
      if (list.length >= PAIRING_MAX) {
        const oldest = [...list].sort((a, b) => a.createdAt - b.createdAt)[0]!
        this.o.store.deleteDiscordPairing(bot.id, oldest.code)
        list.splice(list.indexOf(oldest), 1)
      }
      p = { code: this.newCode(new Set(list.map((x) => x.code))), userId: m.authorId, username: m.authorName, channelId: m.channelId, createdAt: this.now() }
      this.o.store.addDiscordPairing(bot.id, p)
      this.o.log?.(`Discord bot ${bot.name}: pairing requested by ${m.authorName}`)
      this.o.onPairing?.(bot.id)
    }
    await this.say(bot.id, m.channelId, `You are not on this bot's allowlist yet. Ask its owner to approve pairing code ${p.code} in Operant. Until then I can only chat.`)
  }

  // The front desk: status and chat, and job starts only for the allowlisted.
  private async deskReply(bot: DiscordBot, m: GatewayMessage, text: string, direct: boolean): Promise<void> {
    const allowed = bot.allowlist.includes(m.authorId)
    const store = this.o.store
    const crews = store.listCrews()
    let out
    try {
      out = await askFrontDesk(this.modelFor(bot), { bot, crews, runs: allowed ? store.listRuns() : [], text, chatOnly: !allowed })
    } catch (err) {
      this.o.log?.(`Discord bot ${bot.name}: front desk failed: ${scrubSecrets(errText(err))}`)
      return this.say(bot.id, m.channelId, 'The front desk could not answer just now.')
    }
    if (out.reply) await this.say(bot.id, m.channelId, out.reply)
    if (!out.action || !allowed) return
    const crew = findProject(crews, out.action.project)
    if (!crew) return this.say(bot.id, m.channelId, `I could not tell which project you mean (${out.action.project}). Name it by its PRJ number.`)
    return this.startOrConfirm(bot, m, crew, out.action.task, direct)
  }

  // Starts the job, or with confirmStart asks for a reaction from the same user first.
  private async startOrConfirm(bot: DiscordBot, m: GatewayMessage, crew: Crew, task: string, direct: boolean): Promise<void> {
    if (!bot.confirmStart) return this.startJob(bot, m, crew.id, task, direct)
    const sentId = await this.live.get(bot.id)?.gateway.send(m.channelId, `Start this on ${projectLabel(crew)}? React ${CONFIRM} to confirm.\n${task.slice(0, 1500)}`)
    if (!sentId) return
    for (const [k, p] of this.pending) if (this.now() - p.at > CONFIRM_TTL) this.pending.delete(k)
    this.pending.set(sentId, { botId: bot.id, userId: m.authorId, crewId: crew.id, task, channelId: m.channelId, originMessageId: m.id, inPlace: direct, at: this.now() })
    void this.react(bot.id, { channelId: m.channelId, id: sentId }, CONFIRM)
  }

  private async onReaction(botId: number, r: GatewayReaction): Promise<void> {
    const p = this.pending.get(r.messageId)
    const bot = this.o.store.getDiscordBot(botId)
    if (!p || !bot || p.botId !== botId || r.emoji !== CONFIRM || r.userId !== p.userId) return
    this.pending.delete(r.messageId)
    if (this.now() - p.at > CONFIRM_TTL) return this.say(botId, p.channelId, 'That confirmation expired. Ask again.')
    if (!bot.allowlist.includes(p.userId)) return
    await this.startJob(bot, { channelId: p.channelId, id: p.originMessageId }, p.crewId, p.task, p.inPlace)
  }

  // The runs:create path, then a thread for progress and the outcome.
  private async startJob(bot: DiscordBot, at: { channelId: string; id: string }, crewId: number, task: string, direct = false): Promise<void> {
    let run: Run
    try {
      run = this.o.runs.submit({ crewId, task, masterCli: bot.masterCli ?? 'claude' })
    } catch (err) {
      return this.say(bot.id, at.channelId, `Could not start the job: ${errText(err)}`)
    }
    this.o.log?.(`Discord bot ${bot.name} started JOB#${run.id}`, crewId)
    void this.attachJob(bot, at.channelId, run.id, crewId)
    // The mirror reports a Master run in its thread. The older single-status path remains for headless runs, for bots
    // without the Master port, and where the mirror has no place to post (a direct message to a project without a channel).
    const mirrored = !!this.o.master && run.mode === 'master' && bot.mirror !== 'off' && (this.o.store.getDiscordThread(bot.id, at.channelId) != null || (this.o.store.getCrew(crewId)?.discordChannels.length ?? 0) > 0)
    if (mirrored) return
    const origin: Origin = { botId: bot.id, channelId: at.channelId, messageId: at.id, last: '', chain: Promise.resolve(), target: null }
    this.origins.set(run.id, origin)
    origin.chain = this.progress(origin, run, direct)
  }

  // Puts the JOB# in the request's thread name, once.
  private async attachJob(bot: DiscordBot, threadId: string, runId: number, crewId: number): Promise<void> {
    const store = this.o.store
    const t = store.getDiscordThread(bot.id, threadId)
    if (!t) return
    const hadJob = t.runId != null
    store.updateDiscordThread(bot.id, threadId, { runId, crewId })
    if (hadJob) return
    const name = jobThreadName(runId, t.title)
    try {
      await this.live.get(bot.id)?.gateway.renameThread(threadId, name)
      store.updateDiscordThread(bot.id, threadId, { name })
    } catch {
      // Renaming needs Manage Threads; the thread keeps its first name.
    }
  }

  // Outbound

  // Called for each `run` event: posts the new status to the job's thread.
  onRunChange(n: { runId: number }): void {
    const changed = this.o.master ? this.o.store.getRun(n.runId) : null
    if (changed) this.mirror.onChange(changed)
    const origin = this.origins.get(n.runId)
    if (!origin) return
    origin.chain = origin.chain.then(() => {
      const run = this.o.store.getRun(n.runId)
      return run ? this.progress(origin, run, false) : undefined
    })
  }

  // Called for each run event (question, review, progress, approval, close-out): mirrors it by code into the run's thread.
  onRunEvent(run: Run, e: RunEvent): void {
    if (this.o.master) this.mirror.onEvent(run, e)
  }

  private async progress(origin: Origin, run: Run, direct: boolean): Promise<void> {
    try {
      if (run.status === origin.last) return
      origin.last = run.status
      if (origin.target === null) {
        origin.target = origin.channelId
        if (!direct) {
          try {
            origin.target = (await this.live.get(origin.botId)?.gateway.createThread(origin.channelId, origin.messageId, `JOB#${run.id} ${run.task.replace(/\s+/g, ' ')}`)) ?? origin.channelId
          } catch {
            // Threads are not available everywhere: post in the channel instead.
          }
        }
      }
      const final = run.status === 'done' || run.status === 'failed'
      const outcome = !final && run.status !== 'needs-you' ? '' : run.outcome
      const live = this.live.get(origin.botId)
      if (!live) return
      for (const piece of discordOutcome(`JOB#${run.id} ${run.status}`, outcome, { scrub: (t) => scrubSecrets(t) })) await live.gateway.send(origin.target, piece)
      if (final) this.origins.delete(run.id)
    } catch (err) {
      this.o.log?.(`Discord: could not post JOB#${run.id}: ${scrubSecrets(errText(err))}`)
    }
  }

  // The model that answers for this bot: the app's front desk unless the bot picked its own AI.
  private modelFor(bot: DiscordBot): FrontDeskModel {
    return (bot.ai.cli === 'claude' && !bot.ai.model ? undefined : this.o.frontDeskFor?.(bot.ai)) ?? this.o.frontDesk
  }

  private async say(botId: number, channelId: string, text: string): Promise<void> {
    const live = this.live.get(botId)
    if (!live) return
    for (const piece of chunkMessage(text)) await live.gateway.send(channelId, piece)
  }

  private async react(botId: number, at: { channelId: string; id: string }, emoji: string): Promise<void> {
    try {
      await this.live.get(botId)?.gateway.react(at.channelId, at.id, emoji)
    } catch {
      // A missing permission to react is not worth failing the message over.
    }
  }

  // Connections

  private async connectBot(id: number): Promise<void> {
    if (this.live.has(id)) return
    const bot = this.require(id)
    const token = bot.tokenRef ? this.o.secrets.get(bot.tokenRef) : null
    if (!token) {
      const why = (bot.tokenRef && this.o.secrets.problem?.(bot.tokenRef)) || 'No token is saved for this bot'
      this.setHealth(id, { state: 'error', error: why })
      this.o.log?.(`Discord bot ${bot.name} could not connect: ${why}`)
      throw new DiscordError('BAD_ARGS', why)
    }
    this.setHealth(id, { state: 'connecting', error: '' })
    this.o.log?.(`Discord bot ${bot.name} connecting`)
    const gateway = this.o.gateway()
    gateway.onLog?.((line) => this.o.log?.(`Discord bot ${bot.name}: ${scrubSecrets(line, token)}`))
    const fail = (err: unknown) => this.o.log?.(`Discord bot ${bot.name}: ${scrubSecrets(errText(err), token)}`)
    gateway.onMessage((m) => void this.onMessage(id, m).catch(fail))
    gateway.onReaction((r) => void this.onReaction(id, r).catch(fail))
    gateway.onInteraction?.((i) => void this.onInteraction(id, i).catch(fail))
    gateway.onClosed((reason) => this.setHealth(id, { state: 'error', error: scrubSecrets(reason, token) }))
    gateway.onRestored(() => this.setHealth(id, { state: 'connected', error: '', guilds: gateway.guilds().length }))
    try {
      const me = await gateway.connect(token)
      this.live.set(id, { gateway, selfId: me.userId })
      this.setHealth(id, { state: 'connected', username: me.username, guilds: gateway.guilds().length, error: '' })
      this.o.log?.(`Discord bot ${bot.name} connected`)
      if (this.o.master) void this.setupCommands(id).catch(fail)
    } catch (err) {
      await gateway.disconnect().catch(() => undefined)
      const message = scrubSecrets(errText(err), token)
      this.setHealth(id, { state: 'error', error: message })
      this.o.log?.(`Discord bot ${bot.name} could not connect: ${message}`)
      throw new DiscordError('BAD_ARGS', message)
    }
  }

  // Slash commands

  // Registers the commands in every server (replacing the set, so repeating is safe), then checks the channels'
  // permissions. Each problem is reported once in a channel, with the permission needed.
  private async setupCommands(id: number): Promise<void> {
    const gateway = this.live.get(id)?.gateway
    const bot = this.o.store.getDiscordBot(id)
    if (!gateway || !bot) return
    if (gateway.registerCommands) {
      const r = await gateway.registerCommands(commandDefs())
      const where = bot.homeChannel || this.o.store.listCrews().flatMap((c) => c.discordChannels)[0]
      if (where) for (const f of r.failed) await this.reportGap(id, where, `I could not set up my slash commands in ${f.guild}: ${scrubSecrets(f.reason)}`)
    }
    if (!gateway.inspect) return
    const checks = await this.checkChannels(bot, gateway)
    for (const c of checks) {
      const missing = c.missing.filter((p) => p in GAP_LABELS).map((p) => GAP_LABELS[p]!)
      if (c.found && missing.length) await this.reportGap(id, c.id, `I am missing permissions in this channel: ${missing.join(', ')}. Give them to my role (channel settings, Permissions) so commands, threads and updates work.`)
    }
  }

  // Says a problem once per bot, channel and text.
  private async reportGap(botId: number, channelId: string, text: string): Promise<void> {
    const key = `${botId}:${channelId}:${text}`
    if (this.gapsReported.has(key)) return
    this.gapsReported.add(key)
    this.o.log?.(`Discord bot ${this.o.store.getDiscordBot(botId)?.name ?? botId}: ${scrubSecrets(text)}`)
    await this.say(botId, channelId, text).catch(() => undefined)
  }

  private async onInteraction(botId: number, i: GatewayInteraction): Promise<void> {
    const bot = this.o.store.getDiscordBot(botId)
    const port = this.o.master
    if (!bot || !port) return i.type === 'autocomplete' ? i.choices([]) : i.reply('Commands are not available right now.')
    for (const [k, s] of this.starts) if (this.now() - s.at > CONFIRM_TTL) this.starts.delete(k)
    const host: CommandHost = {
      bot,
      store: this.o.store,
      port,
      submit: (input) => this.o.runs.submit(input),
      restart: () => this.restartBot(botId),
      now: this.now,
      scrub: (t) => scrubSecrets(t),
      hold: (input, userId) => {
        const nonce = randomBytes(6).toString('hex')
        this.starts.set(nonce, { input, userId, at: this.now() })
        return nonce
      },
      take: (nonce) => {
        const s = this.starts.get(nonce)
        this.starts.delete(nonce)
        return s ? { input: s.input, userId: s.userId } : null
      },
    }
    await handleInteraction(host, i)
  }

  // Restarts this bot's Discord connection only; the app and the other bots stay up. Commands are registered again.
  private async restartBot(id: number): Promise<void> {
    await this.dropConnection(id)
    await this.connectBot(id)
  }

  private async dropConnection(id: number): Promise<void> {
    const live = this.live.get(id)
    this.live.delete(id)
    await live?.gateway.disconnect().catch(() => undefined)
    if (this.healthOf.has(id)) this.setHealth(id, { state: 'disconnected', error: '', guilds: 0 })
  }

  private setHealth(id: number, patch: Partial<DiscordHealth>): void {
    const next = { ...this.healthFor(id), ...patch, since: this.now() }
    if (patch.error) next.lastError = patch.error
    this.healthOf.set(id, next)
    this.o.onHealth?.(next)
  }

  private healthFor(id: number): DiscordHealth {
    return this.healthOf.get(id) ?? { botId: id, state: 'disconnected', username: '', guilds: 0, error: '', lastError: '', since: 0 }
  }

  // Validation and helpers

  private require(id: number): DiscordBot {
    const bot = typeof id === 'number' ? this.o.store.getDiscordBot(id) : null
    if (!bot) throw new DiscordError('NOT_FOUND', `Discord bot ${String(id)} not found`)
    return bot
  }

  private view(bot: DiscordBot): DiscordBotView {
    return { ...bot, hasToken: !!bot.tokenRef && this.o.secrets.get(bot.tokenRef) !== null, health: this.healthFor(bot.id) }
  }

  private storeToken(bot: DiscordBot, token: string): void {
    const ref = bot.tokenRef || tokenRef(bot.id)
    this.o.secrets.set(ref, token)
    if (ref !== bot.tokenRef) this.o.store.updateDiscordBot(bot.id, { tokenRef: ref })
  }

  private cleanName(name: unknown): string {
    const n = typeof name === 'string' ? name.trim() : ''
    if (!n) throw new DiscordError('BAD_ARGS', 'The bot name cannot be empty')
    if (n.length > NAME_MAX) throw new DiscordError('BAD_ARGS', `The bot name is longer than ${NAME_MAX} characters`)
    return n
  }

  private cleanToken(token: unknown): string {
    const t = typeof token === 'string' ? token.trim() : ''
    if (t.length < 20 || t.length > 300 || /\s/.test(t)) throw new DiscordError('BAD_ARGS', 'That does not look like a bot token')
    return t
  }

  private cleanFields(p: DiscordBotPatch): DiscordBotPatch {
    const out: DiscordBotPatch = {}
    if (p.rules !== undefined) {
      if (typeof p.rules !== 'string' || p.rules.length > RULES_MAX) throw new DiscordError('BAD_ARGS', `The rules text must be at most ${RULES_MAX} characters`)
      out.rules = p.rules
    }
    if (p.allowlist !== undefined) {
      if (!Array.isArray(p.allowlist) || p.allowlist.some((u) => typeof u !== 'string' || !ID_RE.test(u.trim()))) throw new DiscordError('BAD_ARGS', 'Discord user ids are numbers of 5 to 25 digits')
      out.allowlist = [...new Set(p.allowlist.map((u) => u.trim()))]
    }
    if (p.admins !== undefined) {
      if (!Array.isArray(p.admins) || p.admins.some((u) => typeof u !== 'string' || !ID_RE.test(u.trim()))) throw new DiscordError('BAD_ARGS', 'Discord user ids are numbers of 5 to 25 digits')
      out.admins = [...new Set(p.admins.map((u) => u.trim()))]
    }
    if (p.mirror !== undefined) {
      if (!DISCORD_MIRRORS.includes(p.mirror)) throw new DiscordError('BAD_ARGS', 'mirror must be off, results or progress')
      out.mirror = p.mirror
    }
    for (const key of ['homeChannel', 'generalChannel'] as const) {
      const v = p[key]
      if (v === undefined) continue
      if (typeof v !== 'string' || (v.trim() !== '' && !ID_RE.test(v.trim()))) throw new DiscordError('BAD_ARGS', 'Discord channel ids are numbers of 5 to 25 digits')
      out[key] = v.trim()
    }
    for (const key of ['mentionOnly', 'confirmStart', 'enabled', 'threadPerRequest'] as const) {
      const v = p[key]
      if (v === undefined) continue
      if (typeof v !== 'boolean') throw new DiscordError('BAD_ARGS', `${key} must be true or false`)
      out[key] = v
    }
    if (p.threadNames !== undefined) {
      if (p.threadNames !== 'auto' && p.threadNames !== 'ai') throw new DiscordError('BAD_ARGS', 'threadNames must be auto or ai')
      out.threadNames = p.threadNames
    }
    if (p.threadArchive !== undefined) {
      if (!DISCORD_THREAD_ARCHIVES.includes(p.threadArchive)) throw new DiscordError('BAD_ARGS', 'threadArchive must be 60, 1440, 4320 or 10080 minutes')
      out.threadArchive = p.threadArchive
    }
    if (p.ai !== undefined) {
      const a = p.ai
      if (a === null || typeof a !== 'object') throw new DiscordError('BAD_ARGS', 'ai must be an object')
      if (a.cli !== undefined && a.cli !== 'claude' && a.cli !== 'opencode' && a.cli !== 'local') throw new DiscordError('BAD_ARGS', 'ai.cli must be claude, opencode or local')
      for (const k of ['model', 'effort'] as const) if (a[k] !== undefined && (typeof a[k] !== 'string' || a[k]!.length > 200)) throw new DiscordError('BAD_ARGS', `ai.${k} must be text`)
      if (a.localUrl !== undefined && !/^https?:\/\/[^\s]+$/.test(a.localUrl.trim())) throw new DiscordError('BAD_ARGS', 'ai.localUrl must be an http or https address')
      out.ai = { ...a, ...(a.localUrl !== undefined ? { localUrl: a.localUrl.trim().replace(/\/+$/, '') } : {}) }
    }
    if (p.masterCli !== undefined) {
      if (p.masterCli !== 'claude' && p.masterCli !== 'opencode') throw new DiscordError('BAD_ARGS', 'masterCli must be claude or opencode')
      out.masterCli = p.masterCli
    }
    return out
  }

  // Pending codes live in the store (codes only, never tokens), so a restart keeps them; expired ones go.
  private activePairings(id: number): DiscordPairing[] {
    this.o.store.purgeDiscordPairings(id, this.now() - PAIRING_TTL)
    return this.o.store.listDiscordPairings(id)
  }

  private newCode(taken: Set<string>): string {
    for (;;) {
      let code = ''
      for (let i = 0; i < 6; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
      if (!taken.has(code)) return code
    }
  }
}
