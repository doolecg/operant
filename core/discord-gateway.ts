// The Discord connection as the rest of Operant sees it. The real implementation wraps discord.js; tests use a fake.

export interface GatewayMessage {
  id: string
  channelId: string
  // For a message inside a thread: the channel the thread hangs off.
  parentId: string | null
  authorId: string
  authorName: string
  authorIsBot: boolean
  content: string
  isDirect: boolean
  mentionsBot: boolean
}

export interface GatewayReaction {
  channelId: string
  messageId: string
  userId: string
  emoji: string
}

export interface GatewayIdentity {
  userId: string
  username: string
}

export interface ConnectOptions {
  // False logs in without the privileged Message Content intent (the Test button uses it to tell a bad token from a
  // missing portal switch).
  messageContent?: boolean
}

// One configured channel as the bot sees it: which of the needed permissions it lacks there.
export interface ChannelCheck {
  id: string
  found: boolean
  name: string
  guild: string
  missing: string[]
}

export interface DiscordGateway {
  // Logs in; rejects (with a plain-language message) when the token or the intents are refused.
  connect(token: string, opts?: ConnectOptions): Promise<GatewayIdentity>
  disconnect(): Promise<void>
  guilds(): Array<{ id: string; name: string }>
  onMessage(cb: (m: GatewayMessage) => void): void
  onReaction(cb: (r: GatewayReaction) => void): void
  // Fires when the connection drops for good (not on disconnect()).
  onClosed(cb: (reason: string) => void): void
  // Fires when a dropped connection comes back by itself.
  onRestored(cb: () => void): void
  // Returns the sent message's id.
  send(channelId: string, text: string): Promise<string>
  react(channelId: string, messageId: string, emoji: string): Promise<void>
  // A public thread started from a message; returns the thread's channel id. A missing Discord permission rejects
  // with a ThreadPermissionError.
  createThread(channelId: string, messageId: string, name: string, autoArchiveMinutes?: number): Promise<string>
  renameThread(threadId: string, name: string): Promise<void>
  // Connection events worth showing in the Console (ready, disconnects with close codes, warnings). Never a token.
  onLog?(cb: (line: string) => void): void
  // Permission gaps in the given channels, read-only.
  inspect?(channelIds: string[]): Promise<ChannelCheck[]>
}

export class ThreadPermissionError extends Error {
  readonly permission = true
}

export type GatewayFactory = () => DiscordGateway

export const INTENTS_STEPS =
  'Open the Discord Developer Portal (discord.com/developers/applications), pick this bot\'s application, open Bot, turn on "Message Content Intent" under Privileged Gateway Intents, save, then connect again'

// Gateway close codes that end the session for good, in plain language.
const FATAL_CLOSE: Record<number, string> = {
  4004: 'Discord refused the token (authentication failed). Paste the current bot token again',
  4010: 'Discord rejected the shard settings (invalid shard)',
  4011: 'The bot is in too many servers and needs sharding',
  4012: 'Discord rejected the gateway version',
  4013: 'Discord rejected the intents the bot asked for (invalid intents)',
  4014: `Message Content Intent is off for this bot (Discord close code 4014). ${INTENTS_STEPS}`,
}

export function closeCodeMessage(code: number): string {
  return FATAL_CLOSE[code] ?? `Disconnected (code ${code}); reconnecting`
}

export const isFatalCloseCode = (code: number): boolean => code in FATAL_CLOSE

export const isIntentsError = (message: string): boolean => message === FATAL_CLOSE[4014]

// Turns whatever discord.js, Node or the network threw into one plain sentence. The token never appears in these.
export function describeConnectError(err: unknown): string {
  const e = err as { code?: unknown; message?: unknown; cause?: unknown; status?: unknown } | null
  const message = typeof e?.message === 'string' ? e.message : String(err)
  const code = typeof e?.code === 'string' || typeof e?.code === 'number' ? String(e.code) : ''
  if (code === 'DisallowedIntents' || /disallowed intents/i.test(message) || code === '4014') return FATAL_CLOSE[4014]!
  if (code === 'InvalidIntents' || /invalid intents/i.test(message) || code === '4013') return FATAL_CLOSE[4013]!
  if (code === 'TokenInvalid' || /invalid token|authentication failed|401: Unauthorized/i.test(message) || code === '4004' || e?.status === 401)
    return 'Discord says this token is not valid. Reset the token in the Discord Developer Portal (Bot, Reset Token) and paste the new one'
  if (code === 'TokenMissing') return 'No token was given to Discord'
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND' || /cannot find (module|package)/i.test(message))
    return 'The Discord library (discord.js) could not be loaded, so the bot cannot start. Reinstall Operant or run npm install in the project'
  if (code === 'ConnectTimeout') return message
  const net = describeCause(e?.cause) || describeCause(err)
  return net || message || 'Unknown error while connecting to Discord'
}

function describeCause(err: unknown): string {
  if (!err) return ''
  const e = err as { code?: unknown; message?: unknown; cause?: unknown }
  const code = typeof e.code === 'string' ? e.code : ''
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Could not find Discord on the network (DNS lookup failed). Check the internet connection or proxy'
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH')
    return `Could not reach Discord (${code}). Check the internet connection, firewall or proxy`
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'Connecting to Discord timed out. Check the internet connection, firewall or proxy'
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|TLS/i.test(code) || /certificate|self.signed/i.test(typeof e.message === 'string' ? e.message : ''))
    return 'The TLS certificate check for Discord failed (a proxy or antivirus may be intercepting HTTPS)'
  return describeCause(e.cause)
}

// Permissions the bot needs, as discord.js flag names and the words the Discord UI uses.
const NEEDED: Array<[string, string]> = [
  ['ViewChannel', 'View Channels'],
  ['SendMessages', 'Send Messages'],
  ['CreatePublicThreads', 'Create Public Threads'],
  ['SendMessagesInThreads', 'Send Messages in Threads'],
  ['ReadMessageHistory', 'Read Message History'],
  ['AddReactions', 'Add Reactions'],
  ['ManageThreads', 'Manage Threads'],
  ['UseApplicationCommands', 'Use Slash Commands'],
]

export interface DiscordJsGatewayOptions {
  // Loads the library; tests pass a fake module.
  load?: () => Promise<typeof import('discord.js')>
  // How long to wait for the bot to become ready after login. Default 30 seconds.
  readyTimeoutMs?: number
}

// discord.js is loaded on first use so the app and the tests start without it.
export function createDiscordJsGateway(opts: DiscordJsGatewayOptions = {}): DiscordGateway {
  type Dj = typeof import('discord.js')
  const load = opts.load ?? (() => import('discord.js'))
  const readyTimeout = opts.readyTimeoutMs ?? 30_000
  const logCbs: Array<(line: string) => void> = []
  const say = (line: string) => {
    for (const cb of logCbs) cb(line)
  }
  let dj: Dj | null = null
  let client: import('discord.js').Client | null = null
  const messageCbs: Array<(m: GatewayMessage) => void> = []
  const reactionCbs: Array<(r: GatewayReaction) => void> = []
  const closedCbs: Array<(reason: string) => void> = []
  const restoredCbs: Array<() => void> = []
  let closing = false

  const textChannel = async (id: string) => {
    const ch = await client!.channels.fetch(id)
    if (!ch || !ch.isTextBased() || !('send' in ch)) throw new Error('That channel cannot be written to')
    return ch
  }

  return {
    async connect(token, copts) {
      try {
        dj = await load()
      } catch (err) {
        say(`discord.js could not be loaded: ${err instanceof Error ? err.message : String(err)}`)
        throw new Error(describeConnectError(err))
      }
      const { Client, GatewayIntentBits, Partials, Events } = dj
      closing = false
      const withContent = copts?.messageContent !== false
      say(`Connecting (intents: guilds, messages, reactions, direct messages${withContent ? ', message content' : ''})`)
      const c = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.GuildMessageReactions,
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.DirectMessageReactions,
          ...(withContent ? [GatewayIntentBits.MessageContent] : []),
        ],
        partials: [Partials.Channel, Partials.Message, Partials.Reaction],
      })
      client = c
      c.on(Events.MessageCreate, (m) => {
        const msg: GatewayMessage = {
          id: m.id,
          channelId: m.channelId,
          parentId: m.channel.isThread() ? (m.channel.parentId ?? null) : null,
          authorId: m.author.id,
          authorName: m.author.username,
          authorIsBot: m.author.bot,
          content: m.content,
          isDirect: m.guildId == null,
          mentionsBot: c.user ? m.mentions.users.has(c.user.id) : false,
        }
        for (const cb of messageCbs) cb(msg)
      })
      c.on(Events.MessageReactionAdd, (r, u) => {
        const rx: GatewayReaction = { channelId: r.message.channelId, messageId: r.message.id, userId: u.id, emoji: r.emoji.name ?? '' }
        for (const cb of reactionCbs) cb(rx)
      })
      c.on(Events.ShardDisconnect, (event) => {
        if (closing) return
        say(`Disconnected (close code ${event.code})`)
        for (const cb of closedCbs) cb(closeCodeMessage(event.code))
      })
      c.on(Events.ShardResume, () => {
        say('Connection resumed')
        for (const cb of restoredCbs) cb()
      })
      let up = false
      c.on(Events.ShardReady, () => {
        if (up) for (const cb of restoredCbs) cb()
      })
      c.on(Events.ShardReconnecting, () => say('Reconnecting'))
      // Without a listener an 'error' event would throw out of the main process.
      c.on(Events.Error, (err) => say(`Client error: ${describeConnectError(err)}`))
      c.on(Events.Warn, (text) => say(`Warning: ${text}`))
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const ready = new Promise<void>((resolve, reject) => {
          c.once(Events.ClientReady, () => resolve())
          timer = setTimeout(
            () => reject(Object.assign(new Error(`Discord did not answer within ${Math.round(readyTimeout / 1000)} seconds. Check the internet connection, firewall or proxy`), { code: 'ConnectTimeout' })),
            readyTimeout,
          )
        })
        ready.catch(() => undefined)
        await c.login(token)
        await ready
      } catch (err) {
        client = null
        await c.destroy().catch(() => undefined)
        const message = describeConnectError(err)
        say(`Login failed: ${message}`)
        throw new Error(message)
      } finally {
        clearTimeout(timer)
      }
      up = true
      say(`Ready as ${c.user!.username} in ${c.guilds.cache.size} server${c.guilds.cache.size === 1 ? '' : 's'}`)
      return { userId: c.user!.id, username: c.user!.username }
    },
    async disconnect() {
      closing = true
      const c = client
      client = null
      await c?.destroy()
    },
    guilds: () => (client ? [...client.guilds.cache.values()].map((g) => ({ id: g.id, name: g.name })) : []),
    onMessage: (cb) => void messageCbs.push(cb),
    onReaction: (cb) => void reactionCbs.push(cb),
    onClosed: (cb) => void closedCbs.push(cb),
    onRestored: (cb) => void restoredCbs.push(cb),
    onLog: (cb) => void logCbs.push(cb),
    async inspect(channelIds) {
      const c = client
      if (!c || !dj) return []
      const flags = dj.PermissionFlagsBits as Record<string, bigint>
      const out: ChannelCheck[] = []
      for (const id of channelIds) {
        try {
          const ch = await c.channels.fetch(id)
          const name = ch && 'name' in ch && ch.name ? String(ch.name) : ''
          if (!ch || !('guild' in ch) || !ch.guild) {
            out.push({ id, found: !!ch, name, guild: '', missing: [] })
            continue
          }
          const me = ch.guild.members.me ?? (await ch.guild.members.fetchMe())
          const perms = ch.permissionsFor(me)
          out.push({ id, found: true, name, guild: ch.guild.name, missing: NEEDED.filter(([flag]) => !perms?.has(flags[flag]!)).map(([, label]) => label) })
        } catch {
          out.push({ id, found: false, name: '', guild: '', missing: [] })
        }
      }
      return out
    },
    async send(channelId, text) {
      const ch = await textChannel(channelId)
      const sent = await (ch as unknown as { send(c: { content: string; allowedMentions: { parse: [] } }): Promise<{ id: string }> }).send({ content: text, allowedMentions: { parse: [] } })
      return sent.id
    },
    async react(channelId, messageId, emoji) {
      const ch = await textChannel(channelId)
      const msg = await ch.messages.fetch(messageId)
      await msg.react(emoji)
    },
    async createThread(channelId, messageId, name, autoArchiveMinutes) {
      const ch = await textChannel(channelId)
      const msg = await ch.messages.fetch(messageId)
      try {
        const thread = await msg.startThread({ name: name.slice(0, 100), ...(autoArchiveMinutes ? { autoArchiveDuration: autoArchiveMinutes as 60 | 1440 | 4320 | 10080 } : {}) })
        return thread.id
      } catch (err) {
        // 50013 = Missing Permissions, 50001 = Missing Access.
        const code = (err as { code?: number }).code
        if (code === 50013 || code === 50001) throw new ThreadPermissionError('Missing Create Public Threads or Send Messages in Threads')
        throw err
      }
    },
    async renameThread(threadId, name) {
      const ch = await client!.channels.fetch(threadId)
      if (!ch || !ch.isThread()) throw new Error('That is not a thread')
      await ch.setName(name.slice(0, 100))
    },
  }
}
