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

// Slash commands, buttons and modals. A gateway without them still serves messages (every member below is optional).
export interface CommandOptionDef {
  name: string
  description: string
  type: 'string' | 'integer'
  required?: boolean
  // Discord asks for choices while the user types (type 'autocomplete'). Cannot be combined with `choices`.
  autocomplete?: boolean
  choices?: string[]
}

export interface CommandDef {
  name: string
  description: string
  options?: CommandOptionDef[]
}

export interface ButtonDef {
  id: string
  label: string
  style?: 'primary' | 'secondary' | 'success' | 'danger'
}

export interface ModalDef {
  id: string
  title: string
  label: string
  long?: boolean
}

// One interaction from a user. Every reply is private to them (ephemeral). Answer within 3 seconds, or defer first.
export interface GatewayInteraction {
  type: 'command' | 'autocomplete' | 'button' | 'modal'
  userId: string
  userName: string
  channelId: string
  // For an interaction inside a thread: the channel the thread hangs off.
  parentId: string | null
  guildId: string | null
  // The slash command's name (command and autocomplete).
  name: string
  options: Record<string, string | number>
  focused: { name: string; value: string } | null
  // Button or modal id.
  customId: string
  // The text typed into a modal.
  text: string
  reply(text: string, buttons?: ButtonDef[]): Promise<void>
  // Shows "thinking" privately; the next reply replaces it.
  defer(): Promise<void>
  choices(list: Array<{ name: string; value: string }>): Promise<void>
  modal(def: ModalDef): Promise<void>
  // Removes the buttons of the message a button (or a modal opened from one) belongs to.
  clearButtons(): Promise<void>
}

export interface CommandRegistration {
  guilds: number
  failed: Array<{ guild: string; reason: string }>
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
  // Registers the application commands in every server the bot is in. Replaces the whole set, so repeating it is harmless.
  registerCommands?(defs: CommandDef[]): Promise<CommandRegistration>
  onInteraction?(cb: (i: GatewayInteraction) => void): void
  // A message with buttons under it; returns its id.
  sendRich?(channelId: string, text: string, buttons: ButtonDef[]): Promise<string>
  // Replaces a message's text; `buttons` (when given, [] removes them) replaces its buttons.
  edit?(channelId: string, messageId: string, text: string, buttons?: ButtonDef[]): Promise<void>
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
  const interactionCbs: Array<(i: GatewayInteraction) => void> = []
  let closing = false

  const textChannel = async (id: string) => {
    const ch = await client!.channels.fetch(id)
    if (!ch || !ch.isTextBased() || !('send' in ch)) throw new Error('That channel cannot be written to')
    return ch
  }

  const rows = (buttons: ButtonDef[]) => {
    const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = dj!
    const styles = { primary: ButtonStyle.Primary, secondary: ButtonStyle.Secondary, success: ButtonStyle.Success, danger: ButtonStyle.Danger }
    const out: Array<import('discord.js').ActionRowBuilder<import('discord.js').ButtonBuilder>> = []
    for (let i = 0; i < buttons.length && out.length < 5; i += 5) {
      out.push(
        new ActionRowBuilder<import('discord.js').ButtonBuilder>().addComponents(
          buttons.slice(i, i + 5).map((b) => new ButtonBuilder().setCustomId(b.id.slice(0, 100)).setLabel(b.label.slice(0, 80)).setStyle(styles[b.style ?? 'secondary'])),
        ),
      )
    }
    return out
  }

  // Wraps a discord.js interaction as a GatewayInteraction.
  const wrap = (it: import('discord.js').Interaction): GatewayInteraction | null => {
    const { MessageFlags, ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle } = dj!
    const channel = it.channel
    const base = {
      userId: it.user.id,
      userName: it.user.username,
      channelId: it.channelId ?? '',
      parentId: channel && channel.isThread() ? (channel.parentId ?? null) : null,
      guildId: it.guildId,
      name: '',
      options: {} as Record<string, string | number>,
      focused: null as { name: string; value: string } | null,
      customId: '',
      text: '',
    }
    const noop = async () => undefined
    if (it.isAutocomplete()) {
      for (const o of it.options.data) if (typeof o.value === 'string' || typeof o.value === 'number') base.options[o.name] = o.value
      const f = it.options.getFocused(true)
      return {
        ...base,
        type: 'autocomplete',
        name: it.commandName,
        focused: { name: f.name, value: String(f.value) },
        reply: noop,
        defer: noop,
        choices: (list) => it.respond(list.slice(0, 25).map((c) => ({ name: c.name.slice(0, 100), value: c.value.slice(0, 100) }))),
        modal: noop,
        clearButtons: noop,
      }
    }
    if (!it.isChatInputCommand() && !it.isButton() && !it.isModalSubmit()) return null
    const respond = async (text: string, buttons?: ButtonDef[]) => {
      const body = { content: text.slice(0, 2000), allowedMentions: { parse: [] as never[] }, ...(buttons?.length ? { components: rows(buttons) } : {}) }
      if (it.deferred || it.replied) await it.editReply(body)
      else await it.reply({ ...body, flags: MessageFlags.Ephemeral })
    }
    const common = {
      reply: respond,
      defer: async () => {
        if (!it.deferred && !it.replied) await it.deferReply({ flags: MessageFlags.Ephemeral })
      },
      choices: noop,
      modal: async (def: ModalDef) => {
        if (it.isModalSubmit()) return
        const input = new TextInputBuilder().setCustomId('text').setLabel(def.label.slice(0, 45)).setStyle(def.long ? TextInputStyle.Paragraph : TextInputStyle.Short).setRequired(true).setMaxLength(1000)
        await it.showModal(new ModalBuilder().setCustomId(def.id.slice(0, 100)).setTitle(def.title.slice(0, 45)).addComponents(new ActionRowBuilder<import('discord.js').TextInputBuilder>().addComponents(input)))
      },
      clearButtons: async () => {
        if (it.isButton() || (it.isModalSubmit() && it.isFromMessage())) await it.message.edit({ components: [] })
      },
    }
    if (it.isChatInputCommand()) {
      for (const o of it.options.data) if (typeof o.value === 'string' || typeof o.value === 'number') base.options[o.name] = o.value
      return { ...base, ...common, type: 'command', name: it.commandName }
    }
    if (it.isButton()) return { ...base, ...common, type: 'button', customId: it.customId }
    return { ...base, ...common, type: 'modal', customId: it.customId, text: it.fields.getTextInputValue('text') }
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
      c.on(Events.InteractionCreate, (it) => {
        try {
          const wrapped = wrap(it)
          if (wrapped) for (const cb of interactionCbs) cb(wrapped)
        } catch (err) {
          say(`Interaction error: ${describeConnectError(err)}`)
        }
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
    onInteraction: (cb) => void interactionCbs.push(cb),
    async registerCommands(defs) {
      const c = client
      const result: CommandRegistration = { guilds: 0, failed: [] }
      if (!c || !dj) return result
      const { ApplicationCommandOptionType } = dj
      const api = defs.map((d) => ({
        name: d.name,
        description: d.description.slice(0, 100),
        options: (d.options ?? []).map((o) => ({
          type: o.type === 'integer' ? ApplicationCommandOptionType.Integer : ApplicationCommandOptionType.String,
          name: o.name,
          description: o.description.slice(0, 100),
          required: o.required === true,
          ...(o.autocomplete ? { autocomplete: true } : {}),
          ...(o.choices && !o.autocomplete ? { choices: o.choices.map((v) => ({ name: v, value: v })) } : {}),
        })),
      }))
      for (const g of c.guilds.cache.values()) {
        try {
          await g.commands.set(api as never)
          result.guilds++
        } catch (err) {
          const code = (err as { code?: number }).code
          result.failed.push({ guild: g.name, reason: code === 50001 || code === 50013 ? 'Missing Access: invite the bot again with the applications.commands scope' : describeConnectError(err) })
        }
      }
      say(`Slash commands registered in ${result.guilds} server${result.guilds === 1 ? '' : 's'}${result.failed.length ? `, ${result.failed.length} failed` : ''}`)
      return result
    },
    async sendRich(channelId, text, buttons) {
      const ch = await textChannel(channelId)
      const sent = await (ch as unknown as { send(c: unknown): Promise<{ id: string }> }).send({ content: text, components: rows(buttons), allowedMentions: { parse: [] } })
      return sent.id
    },
    async edit(channelId, messageId, text, buttons) {
      const ch = await textChannel(channelId)
      const msg = await ch.messages.fetch(messageId)
      await msg.edit({ content: text, allowedMentions: { parse: [] }, ...(buttons ? { components: rows(buttons) } : {}) })
    },
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
