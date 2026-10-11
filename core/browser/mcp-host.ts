import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import { readFileSync, unlinkSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { gateTransport, type ExtraTool, type Gate, type GateTransport, type ToolCall } from './gate'
import type { BrowserHub } from './hub'

// The slice of CliServer the host needs.
export interface McpAuth {
  whoIs(token: unknown): number | null
  onRevoke(cb: (tileId: number) => void): () => void
}

// The MCP server (from @playwright/mcp) and the Streamable HTTP transport (from its bundled SDK).
export interface McpServerLike {
  connect(transport: unknown): Promise<void>
  close(): Promise<void>
}

export interface McpTransportLike extends GateTransport {
  onclose?: (() => void) | undefined
  close(): Promise<void>
  handleRequest(req: IncomingMessage, res: ServerResponse, body?: unknown): Promise<void>
}

export interface McpLoader {
  createServer(config: { cdpEndpoint: string; outputDir?: string }): Promise<McpServerLike>
  createTransport(opts: { sessionIdGenerator: () => string; onsessioninitialized: (id: string) => void }): McpTransportLike
}

// The config handed to @playwright/mcp. filePaths 'absolute' lets inlineSnapshots find the snapshot file it writes.
export function mcpConnectionConfig(c: { cdpEndpoint: string; outputDir?: string }): Record<string, unknown> {
  return {
    browser: { cdpEndpoint: c.cdpEndpoint },
    // vision: coordinate clicks for canvas pages; pdf: browser_pdf_save. 'devtools' (tracing, video, highlight) stays off.
    capabilities: ['core', 'pdf', 'vision'],
    filePaths: 'absolute',
    ...(c.outputDir ? { outputDir: c.outputDir } : {}),
  }
}

// @playwright/mcp always writes the page snapshot of navigate/click/etc. to a page-*.yml file and answers with a
// link (no config option keeps it inline). Swaps that link for the file's content so the AI needs no extra call.
const SNAPSHOT_LINK = /(### Snapshot\r?\n)- \[Snapshot\]\(([^)\r\n]+)\)/

export function inlineSnapshot(text: string, outputDir: string): string {
  return text.replace(SNAPSHOT_LINK, (whole, head: string, file: string) => {
    const path = resolve(file)
    if (!isAbsolute(file) || resolve(dirname(path)) !== resolve(outputDir) || !/^page-.+\.yml$/.test(basename(path))) return whole
    try {
      const yaml = readFileSync(path, 'utf8')
      try {
        unlinkSync(path)
      } catch {
        // Left for the output budget to evict.
      }
      return `${head}\`\`\`yaml\n${yaml}\n\`\`\``
    } catch {
      return whole
    }
  })
}

// Wrap before gateTransport so the gate (action log, untrusted fence) sees the inlined snapshot.
function inlineSnapshots(transport: McpTransportLike, outputDir: string): void {
  const send = transport.send.bind(transport)
  transport.send = ((message: { result?: { content?: unknown } }, options?: never) => {
    const content = message.result?.content
    if (Array.isArray(content)) {
      for (const part of content as { type?: unknown; text?: unknown }[]) {
        if (part.type === 'text' && typeof part.text === 'string') part.text = inlineSnapshot(part.text, outputDir)
      }
    }
    return send(message as never, options)
  }) as McpTransportLike['send']
}

// @playwright/mcp is CommonJS and bundles its own copy of the MCP SDK, so a plain require works.
export function defaultLoader(): McpLoader {
  const req = createRequire(import.meta.url ?? __filename)
  const mcp = req('@playwright/mcp') as { createConnection(config: unknown): Promise<McpServerLike> }
  const own = createRequire(req.resolve('@playwright/mcp'))
  const bundle = own('playwright-core/lib/utilsBundle') as {
    StreamableHTTPServerTransport: new (o: unknown) => McpTransportLike
  }
  return {
    createServer: (c) => mcp.createConnection(mcpConnectionConfig(c)),
    createTransport: (o) => new bundle.StreamableHTTPServerTransport(o),
  }
}

export interface McpHostOptions {
  hub: BrowserHub
  auth: McpAuth
  // Operant.identify: the project of a tile, or null when the tile is gone.
  crewOf(tileId: number): number | null
  aiAllowed(): boolean
  // The CdpProxy URL (with its secret) for a project. Never logged and never sent to a client.
  cdpEndpoint(crewId: number): string | null
  outputDir?(crewId: number): string
  loader?: McpLoader
  extras?: readonly ExtraTool[]
  pauseTimeoutMs?: number
  policy?: (call: ToolCall) => 'allow' | 'confirm'
  confirm?: (call: ToolCall, signal: AbortSignal) => Promise<boolean>
  // Sees successful tool result text (snapshots); never log it.
  onResult?: (crewId: number, tool: string, text: string) => void
  // A short fixed label only: errors can carry the proxy secret, so they are never passed on.
  onError?: (what: string) => void
}

interface Session {
  id: string
  tileId: number
  crewId: number
  transport: McpTransportLike
  server: McpServerLike
  gate: Gate
}

const MAX_BODY = 8 * 1024 * 1024

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization
  if (typeof h !== 'string') return null
  const m = /^Bearer ([0-9a-f]{64})$/.exec(h)
  return m ? (m[1] ?? null) : null
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined)
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

// The MCP endpoint for Claude tiles: Streamable HTTP on 127.0.0.1, bearer token = the tile's
// OPERANT_TOKEN. Each MCP session is one @playwright/mcp connection to the project's CDP proxy,
// behind the Take control gate. Tokens and the proxy secret are never logged.
export class McpHost {
  private readonly o: McpHostOptions
  private readonly sessions = new Map<string, Session>()
  private readonly offRevoke: () => void
  private loader: McpLoader | null
  private server: Server | null = null
  private port = 0

  constructor(opts: McpHostOptions) {
    this.o = opts
    this.loader = opts.loader ?? null
    this.offRevoke = opts.auth.onRevoke((tileId) => this.closeTile(tileId))
  }

  // http://127.0.0.1:<port>/mcp (the port is not a secret; the token is).
  get url(): string {
    return `http://127.0.0.1:${this.port}/mcp`
  }

  async listen(): Promise<string> {
    if (this.server) return this.url
    const server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        this.o.onError?.('request failed')
        if (!res.headersSent) this.reply(res, 500, 'internal error')
        else res.end()
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.port = (server.address() as AddressInfo).port
    this.server = server
    return this.url
  }

  // Ends every MCP session of a tile (its token was revoked).
  closeTile(tileId: number): void {
    for (const s of [...this.sessions.values()]) if (s.tileId === tileId) void this.end(s)
  }

  closeCrew(crewId: number): void {
    for (const s of [...this.sessions.values()]) if (s.crewId === crewId) void this.end(s)
  }

  closeAllSessions(): void {
    for (const s of [...this.sessions.values()]) void this.end(s)
  }

  async close(): Promise<void> {
    this.offRevoke()
    const ending = [...this.sessions.values()].map((s) => this.end(s))
    await Promise.all(ending)
    const server = this.server
    this.server = null
    if (server) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  private reply(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
  }

  private async end(s: Session): Promise<void> {
    if (!this.sessions.delete(s.id)) return
    s.gate.dispose()
    try {
      await s.server.close()
    } catch {
      // Already closed.
    }
  }

  private hostAllowed(req: IncomingMessage): boolean {
    if (req.headers.origin !== undefined) return false
    const host = req.headers.host
    return host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.hostAllowed(req)) return this.reply(res, 403, 'forbidden')
    if ((req.url ?? '').split('?')[0] !== '/mcp') return this.reply(res, 404, 'not found')

    const unauthorized = () => this.reply(res, 401, 'unauthorized', { 'www-authenticate': 'Bearer' })
    const token = bearer(req)
    if (token === null) return unauthorized()
    const tileId = this.o.auth.whoIs(token)
    if (tileId === null) return unauthorized()
    const crewId = this.o.crewOf(tileId)
    if (crewId === null || !this.o.aiAllowed()) return unauthorized()

    const sid = req.headers['mcp-session-id']
    if (typeof sid === 'string') {
      const s = this.sessions.get(sid)
      if (!s) return this.reply(res, 404, 'unknown session')
      if (s.tileId !== tileId) return this.reply(res, 403, 'forbidden')
      const body = req.method === 'POST' ? await readBody(req) : undefined
      return s.transport.handleRequest(req, res, body)
    }

    if (req.method !== 'POST') return this.reply(res, 400, 'no session')
    let body: unknown
    try {
      body = await readBody(req)
    } catch {
      return this.reply(res, 400, 'bad request')
    }
    const first = Array.isArray(body) ? body[0] : body
    if ((first as { method?: unknown } | undefined)?.method !== 'initialize') return this.reply(res, 400, 'no session')
    const s = await this.open(tileId, crewId)
    if (!s) return this.reply(res, 503, 'browser unavailable')
    return s.transport.handleRequest(req, res, body)
  }

  private async open(tileId: number, crewId: number): Promise<Session | null> {
    const { hub } = this.o
    try {
      // Every Claude tile connects at start; the browser opens only on the first tool call (beforeCall), not here.
      const cdpEndpoint = this.o.cdpEndpoint(crewId)
      if (!cdpEndpoint) return null
      this.loader ??= defaultLoader()
      const outputDir = this.o.outputDir?.(crewId)
      const server = await this.loader.createServer({ cdpEndpoint, ...(outputDir ? { outputDir } : {}) })
      let session: Session | null = null
      const transport = this.loader.createTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          if (session) {
            session.id = id
            this.sessions.set(id, session)
          }
        },
      })
      if (outputDir) inlineSnapshots(transport, outputDir)
      const gate = gateTransport(transport, {
        hub,
        crewId,
        tileId,
        ...(this.o.pauseTimeoutMs !== undefined ? { pauseTimeoutMs: this.o.pauseTimeoutMs } : {}),
        ...(this.o.extras ? { extras: this.o.extras } : {}),
        ...(this.o.policy ? { policy: this.o.policy } : {}),
        ...(this.o.confirm ? { confirm: this.o.confirm } : {}),
        ...(this.o.onResult ? { onResult: this.o.onResult } : {}),
        beforeCall: async () => {
          if (!hub.state(crewId).open) await hub.host.ensureOpen(crewId)
        },
      })
      session = { id: '', tileId, crewId, transport, server, gate }
      const made = session
      transport.onclose = () => void this.end(made)
      await server.connect(transport)
      return session
    } catch {
      this.o.onError?.('session failed')
      return null
    }
  }
}
