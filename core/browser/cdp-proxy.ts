// Loopback WebSocket proxy between @playwright/mcp (via playwright-core) and the app's raw CDP port.
// Secret path, Host/Origin checks, one upstream per client, pause hold queue.
// NEVER log the secret, the endpoint, the upstream URL or any message: they carry cookies and typed text.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { CdpFilter, type CdpMessage, type UpstreamResult } from './cdp-filter'

// Minimal slice of BrowserHub (core/browser/hub.ts, written in parallel; see section 3 of the design page).
export interface CdpProxyHub {
  targets(crewId: number): ReadonlySet<string>
  contextId(crewId: number): string | null
  isPaused(crewId: number): boolean
  /** Subscribe to state pushes; may return an unsubscribe function. */
  on(event: 'browser:state', cb: (state: { crewId: number }) => void): unknown
  /** Optional: resolve a panel tab id for a targetId the proxy did not create. */
  tabIdOf?(crewId: number, targetId: string): number | null
}

// Slice of BrowserHost (hub.ts).
export interface CdpProxyHost {
  newTab(crewId: number, url: string): Promise<{ tabId: number; targetId: string }>
  closeTab(crewId: number, tabId: number): void
  selectTab(crewId: number, tabId: number): void
}

export interface CdpProxyOptions {
  hub: CdpProxyHub
  host: CdpProxyHost
  /** ws://127.0.0.1:<port>/devtools/browser/<guid>, read from DevToolsActivePort. Resolved per client. */
  upstreamUrl: () => string
}

interface Client {
  ws: WebSocket
  upstream: WebSocket
  crewId: number
  filter: CdpFilter
  held: string[]
  early: string[]
  tabs: Map<string, number>
}

const MAX_PAYLOAD = 256 * 1024 * 1024
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

export class CdpProxy {
  private readonly secret = randomBytes(32).toString('hex')
  private readonly clients = new Set<Client>()
  private server: Server | null = null
  private wss: WebSocketServer | null = null
  private port = 0
  private unsub: (() => void) | null = null

  constructor(private readonly opts: CdpProxyOptions) {}

  async start(): Promise<number> {
    if (this.server) return this.port
    const server = createServer((_req, res) => {
      res.writeHead(404).end()
    })
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false })
    server.on('upgrade', (req, socket) => this.onUpgrade(req, socket, wss))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    this.port = (server.address() as AddressInfo).port
    this.server = server
    this.wss = wss
    const off = this.opts.hub.on('browser:state', (s) => this.onState(s.crewId))
    this.unsub = typeof off === 'function' ? (off as () => void) : null
    return this.port
  }

  /** In-process only. Contains the secret: hand it to the MCP host, never log it. */
  endpointFor(crewId: number): string {
    return `ws://127.0.0.1:${this.port}/cdp/${crewId}/${this.secret}`
  }

  /** Drops every client (AI control turned off). */
  dropClients(): void {
    for (const c of [...this.clients]) this.closeClient(c)
  }

  dropCrew(crewId: number): void {
    for (const c of [...this.clients]) if (c.crewId === crewId) this.closeClient(c)
  }

  async close(): Promise<void> {
    this.unsub?.()
    this.unsub = null
    this.dropClients()
    const server = this.server
    this.server = null
    this.wss?.close()
    this.wss = null
    if (server) await new Promise<void>((r) => server.close(() => r()))
  }

  // ---------------------------------------------------------------- upgrade checks

  private onUpgrade(req: IncomingMessage, socket: Duplex, wss: WebSocketServer): void {
    const deny = (code: number): void => {
      socket.write(`HTTP/1.1 ${code} ${code === 404 ? 'Not Found' : 'Forbidden'}\r\nConnection: close\r\n\r\n`)
      socket.destroy()
    }
    const remote = req.socket.remoteAddress ?? ''
    if (!LOOPBACK.has(remote)) return deny(403)
    if (req.headers.origin !== undefined) return deny(403)
    const host = req.headers.host ?? ''
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return deny(403)
    const m = /^\/cdp\/(\d+)\/([0-9a-f]{64})$/.exec((req.url ?? '').split('?')[0] ?? '')
    if (!m) return deny(404)
    const given = Buffer.from(m[2]!)
    const want = Buffer.from(this.secret)
    if (given.length !== want.length || !timingSafeEqual(given, want)) return deny(404)
    const crewId = Number(m[1])
    wss.handleUpgrade(req, socket, Buffer.alloc(0), (ws) => this.attach(ws, crewId))
  }

  // ---------------------------------------------------------------- clients

  private attach(ws: WebSocket, crewId: number): void {
    const { hub } = this.opts
    let upstream: WebSocket
    try {
      upstream = new WebSocket(this.opts.upstreamUrl(), { perMessageDeflate: false, maxPayload: MAX_PAYLOAD })
    } catch {
      ws.close()
      return
    }
    const client: Client = {
      ws,
      upstream,
      crewId,
      filter: new CdpFilter({ targets: () => hub.targets(crewId), contextId: () => hub.contextId(crewId) }),
      held: [],
      early: [],
      tabs: new Map(),
    }
    this.clients.add(client)

    upstream.on('open', () => {
      for (const raw of client.early.splice(0)) upstream.send(raw)
    })
    upstream.on('message', (data) => this.onUpstream(client, text(data)))
    upstream.on('close', () => this.closeClient(client))
    upstream.on('error', () => this.closeClient(client))
    ws.on('message', (data) => {
      const raw = text(data)
      if (hub.isPaused(crewId)) client.held.push(raw)
      else this.onClient(client, raw)
    })
    ws.on('close', () => this.closeClient(client))
    ws.on('error', () => this.closeClient(client))
  }

  private closeClient(c: Client): void {
    if (!this.clients.delete(c)) return
    c.held.length = 0
    c.early.length = 0
    try {
      c.ws.close()
    } catch {
      /* already closed */
    }
    try {
      c.upstream.close()
    } catch {
      /* already closed */
    }
  }

  private onState(crewId: number): void {
    // A tab the hub just learned may already have been seen (and dropped) upstream: re-announce it.
    for (const c of [...this.clients]) if (c.crewId === crewId) this.emit(c, c.filter.recheck())
    if (this.opts.hub.isPaused(crewId)) return
    for (const c of [...this.clients]) {
      if (c.crewId !== crewId || c.held.length === 0) continue
      for (const raw of c.held.splice(0)) this.onClient(c, raw)
    }
  }

  // ---------------------------------------------------------------- traffic

  private toUpstream(c: Client, raw: string): void {
    if (c.upstream.readyState === WebSocket.OPEN) c.upstream.send(raw)
    else if (c.upstream.readyState === WebSocket.CONNECTING) c.early.push(raw)
  }

  private toClient(c: Client, raw: string): void {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(raw)
  }

  private emit(c: Client, r: UpstreamResult): void {
    for (const m of r.toClient) this.toClient(c, JSON.stringify(m))
    for (const m of r.toUpstream) this.toUpstream(c, JSON.stringify(m))
  }

  private onClient(c: Client, raw: string): void {
    const msg = parse(raw)
    if (!msg) return
    const d = c.filter.fromClient(msg)
    switch (d.kind) {
      case 'forward':
        this.toUpstream(c, d.message === msg ? raw : JSON.stringify(d.message))
        return
      case 'reply':
        this.toClient(c, JSON.stringify(d.message))
        return
      case 'create':
        void this.create(c, d.id, d.url, d.sessionId)
        return
      case 'host': {
        const tabId = c.tabs.get(d.targetId) ?? this.opts.hub.tabIdOf?.(c.crewId, d.targetId) ?? null
        if (tabId === null) {
          this.toClient(c, JSON.stringify(c.filter.hostError(d.id, 'Target cannot be changed', d.sessionId)))
          return
        }
        try {
          if (d.op === 'close') this.opts.host.closeTab(c.crewId, tabId)
          else this.opts.host.selectTab(c.crewId, tabId)
          this.toClient(c, JSON.stringify(c.filter.hostReply(d.id, d.op === 'close' ? { success: true } : {}, d.sessionId)))
        } catch {
          this.toClient(c, JSON.stringify(c.filter.hostError(d.id, 'Browser panel refused', d.sessionId)))
        }
        return
      }
    }
  }

  private async create(c: Client, id: number, url: string, sessionId?: string): Promise<void> {
    c.filter.beginCreate()
    let targetId: string | null = null
    try {
      const made = await this.opts.host.newTab(c.crewId, url)
      targetId = made.targetId
      c.tabs.set(made.targetId, made.tabId)
    } catch {
      /* reported below */
    }
    this.emit(c, c.filter.endCreate())
    const replies =
      targetId === null ? [c.filter.hostError(id, 'Could not open a tab', sessionId)] : c.filter.createdReply(id, targetId, sessionId)
    for (const m of replies) this.toClient(c, JSON.stringify(m))
  }

  private onUpstream(c: Client, raw: string): void {
    const msg = parse(raw)
    if (!msg) return
    if (c.filter.isInternalResponse(msg)) return
    const r = c.filter.fromUpstream(msg)
    if (r.toUpstream.length === 0 && r.toClient.length === 1 && r.toClient[0] === msg) {
      this.toClient(c, raw)
      return
    }
    this.emit(c, r)
  }
}

function text(data: RawData): string {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

function parse(raw: string): CdpMessage | null {
  try {
    const v: unknown = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as CdpMessage) : null
  } catch {
    return null
  }
}
