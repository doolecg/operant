import { describe, expect, it } from 'vitest'
import type { DiscordHealth, Run, RunInput } from '../shared/types'
import { DiscordManager } from './discord'
import { closeCodeMessage, createDiscordJsGateway, describeConnectError, INTENTS_STEPS, isFatalCloseCode, type ChannelCheck, type ConnectOptions, type DiscordGateway } from './discord-gateway'
import { FileSecretStore, MemorySecretStore } from './discord-secrets'
import { Store } from './store'

const TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.GxYzAb.abcdefghijklmnopqrstuvwxyz0123456789'

// A stand-in for the discord.js module: a Client that logs in the way the test says.
function fakeDiscordJs(behaviour: { login?: (token: string) => Promise<void>; noReady?: boolean }) {
  const clients: FakeClient[] = []
  class FakeClient {
    handlers = new Map<string, Array<(...a: unknown[]) => void>>()
    user = { id: '900', username: 'FakeBot' }
    guilds = { cache: new Map([['1', { id: '1', name: 'Test Server' }]]) }
    intents: unknown[]
    constructor(o: { intents: unknown[] }) {
      this.intents = o.intents
      clients.push(this)
    }
    on(e: string, cb: (...a: unknown[]) => void) {
      this.handlers.set(e, [...(this.handlers.get(e) ?? []), cb])
      return this
    }
    once(e: string, cb: (...a: unknown[]) => void) {
      return this.on(e, cb)
    }
    emit(e: string, ...a: unknown[]) {
      for (const cb of this.handlers.get(e) ?? []) cb(...a)
    }
    async login(token: string) {
      await behaviour.login?.(token)
      if (!behaviour.noReady) setTimeout(() => this.emit('clientReady'), 0)
    }
    async destroy() {}
  }
  const mod = {
    Client: FakeClient,
    GatewayIntentBits: { Guilds: 1, GuildMessages: 2, GuildMessageReactions: 3, DirectMessages: 4, DirectMessageReactions: 5, MessageContent: 6 },
    Partials: { Channel: 'c', Message: 'm', Reaction: 'r' },
    Events: { MessageCreate: 'messageCreate', MessageReactionAdd: 'messageReactionAdd', ShardDisconnect: 'shardDisconnect', ShardResume: 'shardResume', ShardReady: 'shardReady', ShardReconnecting: 'shardReconnecting', ClientReady: 'clientReady', Error: 'error', Warn: 'warn' },
    PermissionFlagsBits: {},
  }
  return { load: async () => mod as unknown as typeof import('discord.js'), clients }
}

const coded = (code: string, message: string) => Object.assign(new Error(message), { code })

describe('describeConnectError', () => {
  it('maps the privileged intents refusal to the portal steps', () => {
    const msg = describeConnectError(coded('DisallowedIntents', 'Privileged intent provided is not enabled or whitelisted.'))
    expect(msg).toContain('4014')
    expect(msg).toContain(INTENTS_STEPS)
    expect(describeConnectError(new Error('Used disallowed intents'))).toBe(msg)
  })
  it('maps an invalid token, a missing module and network failures', () => {
    expect(describeConnectError(coded('TokenInvalid', 'An invalid token was provided.'))).toMatch(/not valid/)
    expect(describeConnectError(Object.assign(new Error('401: Unauthorized'), { status: 401 }))).toMatch(/not valid/)
    expect(describeConnectError(coded('ERR_MODULE_NOT_FOUND', "Cannot find package 'discord.js'"))).toMatch(/could not be loaded/)
    expect(describeConnectError(Object.assign(new Error('fetch failed'), { cause: coded('ENOTFOUND', 'getaddrinfo ENOTFOUND discord.com') }))).toMatch(/DNS/)
    expect(describeConnectError(Object.assign(new Error('x'), { cause: coded('UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'x') }))).toMatch(/TLS/)
  })
  it('knows which close codes end the session', () => {
    expect(isFatalCloseCode(4014)).toBe(true)
    expect(isFatalCloseCode(1006)).toBe(false)
    expect(closeCodeMessage(4014)).toContain(INTENTS_STEPS)
    expect(closeCodeMessage(1006)).toMatch(/reconnecting/)
  })
})

describe('createDiscordJsGateway', () => {
  it('turns a failed import into a plain message and logs it', async () => {
    const lines: string[] = []
    const gw = createDiscordJsGateway({ load: () => Promise.reject(coded('ERR_MODULE_NOT_FOUND', "Cannot find package 'discord.js'")) })
    gw.onLog?.((l) => lines.push(l))
    await expect(gw.connect(TOKEN)).rejects.toThrow(/discord\.js\) could not be loaded/)
    expect(lines.some((l) => /could not be loaded/.test(l))).toBe(true)
  })

  it('reports error 4014 as the Message Content intent being off', async () => {
    const fake = fakeDiscordJs({ login: () => Promise.reject(coded('DisallowedIntents', 'Privileged intent provided is not enabled or whitelisted.')) })
    const gw = createDiscordJsGateway({ load: fake.load })
    await expect(gw.connect(TOKEN)).rejects.toThrow(INTENTS_STEPS)
  })

  it('reports TokenInvalid and never leaks the token', async () => {
    const lines: string[] = []
    const fake = fakeDiscordJs({ login: () => Promise.reject(coded('TokenInvalid', 'An invalid token was provided.')) })
    const gw = createDiscordJsGateway({ load: fake.load })
    gw.onLog?.((l) => lines.push(l))
    await expect(gw.connect(TOKEN)).rejects.toThrow(/not valid/)
    expect(lines.join('\n')).not.toContain(TOKEN)
  })

  it('gives up with a timeout message when Discord never answers', async () => {
    const fake = fakeDiscordJs({ noReady: true })
    const gw = createDiscordJsGateway({ load: fake.load, readyTimeoutMs: 20 })
    await expect(gw.connect(TOKEN)).rejects.toThrow(/did not answer/)
  })

  it('connects, asks for message content unless told not to, and reports close codes', async () => {
    const fake = fakeDiscordJs({})
    const gw = createDiscordJsGateway({ load: fake.load })
    const closed: string[] = []
    const restored: number[] = []
    gw.onClosed((r) => closed.push(r))
    gw.onRestored(() => restored.push(1))
    const me = await gw.connect(TOKEN)
    expect(me).toEqual({ userId: '900', username: 'FakeBot' })
    expect(fake.clients[0]!.intents).toContain(6)
    fake.clients[0]!.emit('shardDisconnect', { code: 4014 })
    expect(closed[0]).toContain(INTENTS_STEPS)
    fake.clients[0]!.emit('shardReady')
    expect(restored).toHaveLength(1)
    // An 'error' event has a listener, so it cannot throw out of the process.
    expect(() => fake.clients[0]!.emit('error', new Error('boom'))).not.toThrow()
    await gw.disconnect()
    const bare = createDiscordJsGateway({ load: fake.load })
    await bare.connect(TOKEN, { messageContent: false })
    expect(fake.clients[1]!.intents).not.toContain(6)
  })
})

class ScriptedGateway implements DiscordGateway {
  logs: Array<(l: string) => void> = []
  closed: (r: string) => void = () => {}
  constructor(private readonly fail: (opts?: ConnectOptions) => string | null, private readonly checks: ChannelCheck[] = []) {}
  async connect(_t: string, opts?: ConnectOptions) {
    const why = this.fail(opts)
    for (const l of this.logs) l(why ? `Login failed: ${why}` : 'Ready')
    if (why) throw new Error(why)
    return { userId: '9', username: 'desk-bot' }
  }
  async disconnect() {}
  guilds = () => [{ id: '1', name: 'Test Server' }]
  onMessage() {}
  onReaction() {}
  onClosed(cb: (r: string) => void) {
    this.closed = cb
  }
  onRestored() {}
  onLog(cb: (l: string) => void) {
    this.logs.push(cb)
  }
  inspect = async () => this.checks
  send = async () => '1'
  react = async () => {}
  createThread = async () => 't'
  renameThread = async () => {}
}

describe('DiscordManager connection reporting', () => {
  const setup = (gw: () => DiscordGateway) => {
    const store = new Store(':memory:')
    const logs: string[] = []
    const health: DiscordHealth[] = []
    const mgr = new DiscordManager({
      store,
      runs: { submit: (i: RunInput): Run => store.createRun({ crewId: i.crewId, task: i.task, masterCli: i.masterCli }) },
      secrets: new MemorySecretStore(),
      gateway: gw,
      frontDesk: async () => '{}',
      log: (m) => logs.push(m),
      onHealth: (h) => health.push(h),
    })
    return { store, mgr, logs, health }
  }

  it('shows a refused-intents error, keeps it as lastError and logs it without the token', async () => {
    const { store, mgr, logs } = setup(() => new ScriptedGateway(() => closeCodeMessage(4014)))
    const bot = await mgr.create({ name: 'desk', token: TOKEN })
    await expect(mgr.connect(bot.id)).rejects.toThrow(/Message Content Intent/)
    expect(mgr.get(bot.id).health.state).toBe('error')
    expect(mgr.get(bot.id).health.error).toContain(INTENTS_STEPS)
    await mgr.disconnect(bot.id)
    const h = mgr.get(bot.id).health
    expect(h.state).toBe('disconnected')
    expect(h.error).toBe('')
    expect(h.lastError).toContain('Message Content Intent')
    expect(logs.join('\n')).toContain('connecting')
    expect(logs.join('\n')).not.toContain(TOKEN)
    store.close()
  })

  it('passes gateway log lines to the log and a later close code to the health', async () => {
    let gw!: ScriptedGateway
    const { store, mgr, logs } = setup(() => (gw = new ScriptedGateway(() => null)))
    const bot = await mgr.create({ name: 'desk', token: TOKEN, enabled: true })
    expect(mgr.get(bot.id).health.state).toBe('connected')
    expect(logs.some((l) => l.includes('Ready'))).toBe(true)
    gw.closed(closeCodeMessage(4004))
    expect(mgr.get(bot.id).health.state).toBe('error')
    expect(mgr.get(bot.id).health.lastError).toMatch(/refused the token/)
    store.close()
  })

  it('Test: reports a valid token with the intent off, the servers and channel permission gaps', async () => {
    const checks: ChannelCheck[] = [{ id: '3000000001', found: true, name: 'general', guild: 'Test Server', missing: ['Create Public Threads'] }]
    const { store, mgr } = setup(() => new ScriptedGateway((o) => (o?.messageContent === false ? null : closeCodeMessage(4014)), checks))
    const bot = await mgr.create({ name: 'desk', token: TOKEN, homeChannel: '3000000001' })
    const r = await mgr.test(bot.id)
    expect(r.tokenValid).toBe(true)
    expect(r.username).toBe('desk-bot')
    expect(r.intents).toBe('missing')
    expect(r.error).toContain(INTENTS_STEPS)
    expect(r.guilds).toEqual([{ id: '1', name: 'Test Server' }])
    expect(r.channels).toEqual(checks)
    store.close()
  })

  it('Test: reports an invalid token and one that is fine', async () => {
    let fail: string | null = 'Discord says this token is not valid.'
    const { store, mgr } = setup(() => new ScriptedGateway(() => fail))
    const bot = await mgr.create({ name: 'desk', token: TOKEN })
    expect(await mgr.test(bot.id)).toMatchObject({ tokenValid: false, intents: 'unknown', error: 'Discord says this token is not valid.' })
    fail = null
    expect(await mgr.test(bot.id)).toMatchObject({ tokenValid: true, intents: 'ok', error: '' })
    store.close()
  })
})

describe('FileSecretStore problems', () => {
  it('says why a stored token cannot be read', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'operant-secrets-'))
    try {
      let available = true
      let broken = false
      const store = new FileSecretStore(dir, {
        isAvailable: () => available,
        encrypt: (p) => Buffer.from(p),
        decrypt: (b) => {
          if (broken) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
          return b.toString()
        },
      })
      store.set('discord-bot-1', TOKEN)
      expect(store.get('discord-bot-1')).toBe(TOKEN)
      broken = true
      expect(store.get('discord-bot-1')).toBeNull()
      expect(store.problem('discord-bot-1')).toMatch(/could not be decrypted/)
      broken = false
      available = false
      expect(store.get('discord-bot-1')).toBeNull()
      expect(store.problem('discord-bot-1')).toMatch(/keychain is not available/)
      available = true
      expect(store.get('discord-bot-1')).toBe(TOKEN)
      expect(store.problem('discord-bot-1')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
