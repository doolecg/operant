import { randomInt } from 'node:crypto'
import type { Crew, DiscordBot, DiscordBotInput, DiscordBotPatch, DiscordBotView, DiscordHealth, DiscordPairing, DiscordTestResult, Run, RunInput } from '../shared/types'
import type { DiscordGateway, GatewayFactory, GatewayMessage, GatewayReaction } from './discord-gateway'
import { discordOutcome } from './discord-format'
import { askFrontDesk, findProject, type FrontDeskModel } from './discord-frontdesk'
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
  now?: () => number
  log?: (message: string, crewId?: number | null) => void
  onHealth?: (h: DiscordHealth) => void
  // A new pairing request arrived for the bot (the settings page lists it without a refresh).
  onPairing?: (botId: number) => void
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
  private readonly origins = new Map<number, Origin>()
  private readonly now: () => number

  constructor(private readonly o: DiscordManagerOptions) {
    this.now = o.now ?? Date.now
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
    if (live) return { tokenValid: true, username: this.healthFor(id).username, guilds: live.gateway.guilds(), error: '' }
    const token = bot.tokenRef ? this.o.secrets.get(bot.tokenRef) : null
    if (!token) return { tokenValid: false, username: '', guilds: [], error: 'No token is saved for this bot' }
    const gateway = this.o.gateway()
    try {
      const me = await gateway.connect(token)
      return { tokenValid: true, username: me.username, guilds: gateway.guilds(), error: '' }
    } catch (err) {
      return { tokenValid: false, username: '', guilds: [], error: scrubSecrets(errText(err), token) }
    } finally {
      await gateway.disconnect().catch(() => undefined)
    }
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
    if (bot.mentionOnly && !m.mentionsBot) return
    if (!text) return
    const channels = [m.channelId, m.parentId].filter((c): c is string => !!c)
    const crew = this.o.store.listCrews().find((c) => c.discordChannels.some((ch) => channels.includes(ch)))
    if (crew) {
      void this.react(botId, m, ACK)
      if (!allowed) return this.deskReply(bot, m, text, false)
      return this.startOrConfirm(bot, m, crew, text, false)
    }
    if (channels.some((c) => c === bot.homeChannel || c === bot.generalChannel)) {
      void this.react(botId, m, ACK)
      return this.deskReply(bot, m, text, false)
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
      out = await askFrontDesk(this.o.frontDesk, { bot, crews, runs: allowed ? store.listRuns() : [], text, chatOnly: !allowed })
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
    const sentId = await this.live.get(bot.id)?.gateway.send(m.channelId, `Start this on PRJ${crew.prjNumber} ${crew.name}? React ${CONFIRM} to confirm.\n${task.slice(0, 1500)}`)
    if (!sentId) return
    for (const [k, p] of this.pending) if (this.now() - p.at > CONFIRM_TTL) this.pending.delete(k)
    this.pending.set(sentId, { botId: bot.id, userId: m.authorId, crewId: crew.id, task, channelId: m.channelId, originMessageId: m.id, at: this.now() })
    void this.react(bot.id, { channelId: m.channelId, id: sentId }, CONFIRM)
  }

  private async onReaction(botId: number, r: GatewayReaction): Promise<void> {
    const p = this.pending.get(r.messageId)
    const bot = this.o.store.getDiscordBot(botId)
    if (!p || !bot || p.botId !== botId || r.emoji !== CONFIRM || r.userId !== p.userId) return
    this.pending.delete(r.messageId)
    if (this.now() - p.at > CONFIRM_TTL) return this.say(botId, p.channelId, 'That confirmation expired. Ask again.')
    if (!bot.allowlist.includes(p.userId)) return
    await this.startJob(bot, { channelId: p.channelId, id: p.originMessageId }, p.crewId, p.task)
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
    const origin: Origin = { botId: bot.id, channelId: at.channelId, messageId: at.id, last: '', chain: Promise.resolve(), target: null }
    this.origins.set(run.id, origin)
    origin.chain = this.progress(origin, run, direct)
  }

  // Outbound

  // Called for each `run` event: posts the new status to the job's thread.
  onRunChange(n: { runId: number }): void {
    const origin = this.origins.get(n.runId)
    if (!origin) return
    origin.chain = origin.chain.then(() => {
      const run = this.o.store.getRun(n.runId)
      return run ? this.progress(origin, run, false) : undefined
    })
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
      const body = !final && run.status !== 'needs-you' ? '' : run.outcome ? `\n${run.outcome}` : ''
      await this.say(origin.botId, origin.target, `JOB#${run.id} ${run.status}${body}`)
      if (final) this.origins.delete(run.id)
    } catch (err) {
      this.o.log?.(`Discord: could not post JOB#${run.id}: ${scrubSecrets(errText(err))}`)
    }
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
      this.setHealth(id, { state: 'error', error: 'No token is saved for this bot' })
      throw new DiscordError('BAD_ARGS', 'No token is saved for this bot')
    }
    this.setHealth(id, { state: 'connecting', error: '' })
    const gateway = this.o.gateway()
    const fail = (err: unknown) => this.o.log?.(`Discord bot ${bot.name}: ${scrubSecrets(errText(err), token)}`)
    gateway.onMessage((m) => void this.onMessage(id, m).catch(fail))
    gateway.onReaction((r) => void this.onReaction(id, r).catch(fail))
    gateway.onClosed((reason) => this.setHealth(id, { state: 'error', error: scrubSecrets(reason, token) }))
    gateway.onRestored(() => this.setHealth(id, { state: 'connected', error: '', guilds: gateway.guilds().length }))
    try {
      const me = await gateway.connect(token)
      this.live.set(id, { gateway, selfId: me.userId })
      this.setHealth(id, { state: 'connected', username: me.username, guilds: gateway.guilds().length, error: '' })
      this.o.log?.(`Discord bot ${bot.name} connected`)
    } catch (err) {
      await gateway.disconnect().catch(() => undefined)
      const message = scrubSecrets(errText(err), token)
      this.setHealth(id, { state: 'error', error: message })
      this.o.log?.(`Discord bot ${bot.name} could not connect: ${message}`)
      throw new DiscordError('BAD_ARGS', message)
    }
  }

  private async dropConnection(id: number): Promise<void> {
    const live = this.live.get(id)
    this.live.delete(id)
    await live?.gateway.disconnect().catch(() => undefined)
    if (this.healthOf.has(id)) this.setHealth(id, { state: 'disconnected', error: '', guilds: 0 })
  }

  private setHealth(id: number, patch: Partial<DiscordHealth>): void {
    const next = { ...this.healthFor(id), ...patch, since: this.now() }
    this.healthOf.set(id, next)
    this.o.onHealth?.(next)
  }

  private healthFor(id: number): DiscordHealth {
    return this.healthOf.get(id) ?? { botId: id, state: 'disconnected', username: '', guilds: 0, error: '', since: 0 }
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
    for (const key of ['homeChannel', 'generalChannel'] as const) {
      const v = p[key]
      if (v === undefined) continue
      if (typeof v !== 'string' || (v.trim() !== '' && !ID_RE.test(v.trim()))) throw new DiscordError('BAD_ARGS', 'Discord channel ids are numbers of 5 to 25 digits')
      out[key] = v.trim()
    }
    for (const key of ['mentionOnly', 'confirmStart', 'enabled'] as const) {
      const v = p[key]
      if (v === undefined) continue
      if (typeof v !== 'boolean') throw new DiscordError('BAD_ARGS', `${key} must be true or false`)
      out[key] = v
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
