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

export interface DiscordGateway {
  // Logs in; rejects when the token is refused.
  connect(token: string): Promise<GatewayIdentity>
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
  // A thread started from a message; returns the thread's channel id.
  createThread(channelId: string, messageId: string, name: string): Promise<string>
}

export type GatewayFactory = () => DiscordGateway

// discord.js is loaded on first use so the app and the tests start without it.
export function createDiscordJsGateway(): DiscordGateway {
  type Dj = typeof import('discord.js')
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
    async connect(token) {
      dj = await import('discord.js')
      const { Client, GatewayIntentBits, Partials, Events } = dj
      closing = false
      const c = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.GuildMessageReactions,
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.DirectMessageReactions,
          GatewayIntentBits.MessageContent,
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
        if (!closing) for (const cb of closedCbs) cb(`Disconnected (code ${event.code})`)
      })
      c.on(Events.ShardResume, () => {
        for (const cb of restoredCbs) cb()
      })
      try {
        await c.login(token)
        if (!c.isReady()) await new Promise<void>((resolve) => c.once(Events.ClientReady, () => resolve()))
      } catch (err) {
        client = null
        await c.destroy().catch(() => undefined)
        throw err
      }
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
    async createThread(channelId, messageId, name) {
      const ch = await textChannel(channelId)
      const msg = await ch.messages.fetch(messageId)
      const thread = await msg.startThread({ name: name.slice(0, 100) })
      return thread.id
    },
  }
}
