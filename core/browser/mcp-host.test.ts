import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserHub, type BrowserHost } from './hub'
import { McpHost, inlineSnapshot, mcpConnectionConfig, type McpLoader, type McpTransportLike } from './mcp-host'

const TOKEN_A = 'a'.repeat(64)
const TOKEN_B = 'b'.repeat(64)

let opened = 0
const host: BrowserHost = {
  ensureOpen: async () => void opened++,
  newTab: async () => ({ tabId: 1, targetId: 't' }),
  closeTab: () => {},
  selectTab: () => {},
}

function fakeLoader() {
  const closed: string[] = []
  const created: Array<{ cdpEndpoint: string }> = []
  const loader: McpLoader = {
    async createServer(config) {
      created.push(config)
      return {
        async connect() {},
        async close() {
          closed.push('server')
        },
      }
    },
    createTransport(opts) {
      const t: McpTransportLike = {
        onmessage: undefined,
        onclose: undefined,
        async send() {},
        async close() {},
        async handleRequest(_req, res, body) {
          const m = (body as { method?: string } | undefined)?.method
          if (m === 'initialize') {
            const id = opts.sessionIdGenerator()
            opts.onsessioninitialized(id)
            res.writeHead(200, { 'mcp-session-id': id, 'content-type': 'application/json' })
            return void res.end('{}')
          }
          res.writeHead(200)
          res.end('ok')
        },
      }
      return t
    },
  }
  return { loader, closed, created }
}

let current: McpHost | null = null
afterEach(async () => {
  await current?.close()
  current = null
})

async function start(over: { aiAllowed?: () => boolean } = {}) {
  const revoke: Array<(t: number) => void> = []
  const { loader, closed, created } = fakeLoader()
  const mcp = new McpHost({
    hub: new BrowserHub({ host }),
    auth: {
      whoIs: (t) => (t === TOKEN_A ? 1 : t === TOKEN_B ? 2 : null),
      onRevoke: (cb) => {
        revoke.push(cb)
        return () => {}
      },
    },
    crewOf: (tile) => (tile === 1 ? 10 : tile === 2 ? 20 : null),
    aiAllowed: over.aiAllowed ?? (() => true),
    cdpEndpoint: (c) => `ws://127.0.0.1:1/cdp/${c}/secret`,
    loader,
  })
  current = mcp
  await mcp.listen()
  return { mcp, revoke, closed, created }
}

function post(url: string, headers: Record<string, string>, body?: unknown) {
  const u = new URL(url)
  return new Promise<{ status: number; headers: Record<string, unknown>; text: string }>((resolve, reject) => {
    const r = request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let text = ''
      res.on('data', (c) => (text += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }))
    })
    r.on('error', reject)
    r.end(body === undefined ? undefined : JSON.stringify(body))
  })
}
const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }
const ping = { jsonrpc: '2.0', id: 2, method: 'ping' }

describe('McpHost', () => {
  it('401 without a token, with a malformed one, and with an unknown one', async () => {
    const { mcp } = await start()
    expect((await post(mcp.url, {}, init)).status).toBe(401)
    expect((await post(mcp.url, { authorization: 'Bearer nope' }, init)).status).toBe(401)
    expect((await post(mcp.url, { authorization: `Bearer ${'c'.repeat(64)}` }, init)).status).toBe(401)
  })

  it('401 when AI control is off', async () => {
    const off = await start({ aiAllowed: () => false })
    expect((await post(off.mcp.url, { authorization: `Bearer ${TOKEN_A}` }, init)).status).toBe(401)
  })

  it('opens a session bound to the tile and passes follow-up calls', async () => {
    const { mcp, created } = await start()
    const auth = { authorization: `Bearer ${TOKEN_A}` }
    const r = await post(mcp.url, auth, init)
    expect(r.status).toBe(200)
    expect(created[0]?.cdpEndpoint).toBe('ws://127.0.0.1:1/cdp/10/secret')
    // A tile connecting at start must not open the browser; only a tool call does.
    expect(opened).toBe(0)
    const sid = String(r.headers['mcp-session-id'])
    const next = await post(mcp.url, { ...auth, 'mcp-session-id': sid }, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect(next.status).toBe(200)
    expect(next.text).toBe('ok')
  })

  it('403 when another tile uses the session, 404 for an unknown session', async () => {
    const { mcp } = await start()
    const r = await post(mcp.url, { authorization: `Bearer ${TOKEN_A}` }, init)
    const sid = String(r.headers['mcp-session-id'])
    expect((await post(mcp.url, { authorization: `Bearer ${TOKEN_B}`, 'mcp-session-id': sid }, ping)).status).toBe(403)
    expect((await post(mcp.url, { authorization: `Bearer ${TOKEN_A}`, 'mcp-session-id': 'zzz' }, ping)).status).toBe(404)
  })

  it('refuses a foreign Origin or Host, a wrong path, and a call without a session', async () => {
    const { mcp } = await start()
    const auth = { authorization: `Bearer ${TOKEN_A}` }
    expect((await post(mcp.url, { ...auth, origin: 'http://evil.test' }, init)).status).toBe(403)
    expect((await post(mcp.url.replace('/mcp', '/other'), auth, init)).status).toBe(404)
    expect((await post(mcp.url, auth, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(400)
  })

  it('closes a tile sessions when its token is revoked', async () => {
    const { mcp, revoke, closed } = await start()
    const auth = { authorization: `Bearer ${TOKEN_A}` }
    const r = await post(mcp.url, auth, init)
    const sid = String(r.headers['mcp-session-id'])
    revoke.forEach((cb) => cb(1))
    await new Promise((res) => setTimeout(res, 10))
    expect(closed).toEqual(['server'])
    expect((await post(mcp.url, { ...auth, 'mcp-session-id': sid }, ping)).status).toBe(404)
  })
})

describe('snapshots inline', () => {
  it('asks @playwright/mcp for absolute file paths', () => {
    const c = mcpConnectionConfig({ cdpEndpoint: 'ws://x', outputDir: '/out' })
    expect(c.filePaths).toBe('absolute')
    expect(c.outputDir).toBe('/out')
  })

  it('replaces the snapshot file link with the yaml and removes the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'op-snap-'))
    try {
      mkdirSync(dir, { recursive: true })
      const file = join(dir, 'page-1.yml')
      writeFileSync(file, '- button "Hi" [ref=e2]')
      const out = inlineSnapshot(`### Page
- Page URL: x
### Snapshot
- [Snapshot](${file})`, dir)
      expect(out).toContain('### Snapshot\n```yaml\n- button "Hi" [ref=e2]\n```')
      expect(out).not.toContain(file)
      expect(existsSync(file)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves links outside the output dir or not named page-*.yml alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'op-snap-'))
    try {
      const other = join(dir, 'secret.yml')
      writeFileSync(other, 'x')
      const a = `### Snapshot
- [Snapshot](${other})`
      expect(inlineSnapshot(a, dir)).toBe(a)
      const b = `### Snapshot
- [Snapshot](${join(dir, '..', 'page-1.yml')})`
      expect(inlineSnapshot(b, dir)).toBe(b)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
