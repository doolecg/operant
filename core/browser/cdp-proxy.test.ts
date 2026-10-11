import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { CdpProxy, type CdpProxyHost, type CdpProxyHub } from './cdp-proxy'

type Msg = Record<string, unknown>

class StubHub implements CdpProxyHub {
  allowed = new Set(['PANEL'])
  paused = false
  cbs: Array<(s: { crewId: number }) => void> = []
  targets() {
    return this.allowed
  }
  contextId() {
    return 'ctx-1'
  }
  isPaused() {
    return this.paused
  }
  on(_e: 'browser:state', cb: (s: { crewId: number }) => void) {
    this.cbs.push(cb)
    return () => {
      this.cbs = this.cbs.filter((c) => c !== cb)
    }
  }
  fire() {
    for (const cb of this.cbs) cb({ crewId: 1 })
  }
}

let upstream: WebSocketServer
let upstreamSockets: WebSocket[]
let received: Msg[]
let hub: StubHub
let host: CdpProxyHost & { opened: string[]; closed: number[] }
let proxy: CdpProxy
let clients: WebSocket[]

beforeEach(async () => {
  received = []
  upstreamSockets = []
  clients = []
  upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((r) => upstream.once('listening', () => r()))
  upstream.on('connection', (s) => {
    upstreamSockets.push(s)
    s.on('message', (d) => {
      const m = JSON.parse(d.toString()) as Msg
      received.push(m)
      if (typeof m['id'] === 'number' && m['id'] < 1_000_000) s.send(JSON.stringify({ id: m['id'], ...(m['sessionId'] ? { sessionId: m['sessionId'] } : {}), result: { seen: m['method'] } }))
    })
  })
  hub = new StubHub()
  host = {
    opened: [],
    closed: [],
    async newTab(_c, url) {
      this.opened.push(url)
      hub.allowed.add('NEW')
      return { tabId: 7, targetId: 'NEW' }
    },
    closeTab(_c, t) {
      this.closed.push(t)
    },
    selectTab() {},
  }
  const up = `ws://127.0.0.1:${(upstream.address() as AddressInfo).port}/devtools/browser/x`
  proxy = new CdpProxy({ hub, host, upstreamUrl: () => up })
  await proxy.start()
})

afterEach(async () => {
  for (const c of clients) c.terminate()
  await proxy.close()
  for (const s of upstreamSockets) s.terminate()
  upstream.close()
})

async function connect(url = proxy.endpointFor(1)): Promise<{ ws: WebSocket; inbox: Msg[]; send(m: Msg): void; next(pred: (m: Msg) => boolean): Promise<Msg> }> {
  const ws = new WebSocket(url)
  clients.push(ws)
  const inbox: Msg[] = []
  const waiters: Array<{ pred: (m: Msg) => boolean; res: (m: Msg) => void }> = []
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString()) as Msg
    inbox.push(m)
    for (const w of [...waiters]) {
      if (w.pred(m)) {
        waiters.splice(waiters.indexOf(w), 1)
        w.res(m)
      }
    }
  })
  await new Promise<void>((res, rej) => {
    ws.once('open', () => res())
    ws.once('error', rej)
    ws.once('unexpected-response', (_q, r) => rej(new Error(`status ${r.statusCode}`)))
  })
  return {
    ws,
    inbox,
    send: (m) => ws.send(JSON.stringify(m)),
    next: (pred) =>
      new Promise((res) => {
        const hit = inbox.find(pred)
        if (hit) res(hit)
        else waiters.push({ pred, res })
      }),
  }
}

const tick = () => new Promise((r) => setTimeout(r, 60))

describe('cdp-proxy connection checks', () => {
  it('refuses a wrong secret, wrong path and a browser Origin', async () => {
    const base = proxy.endpointFor(1)
    await expect(connect(base.replace(/[0-9a-f]{64}$/, 'a'.repeat(64)))).rejects.toThrow('status 404')
    await expect(connect(base.replace('/cdp/', '/nope/'))).rejects.toThrow('status 404')
    const ws = new WebSocket(base, { origin: 'http://evil.test' })
    clients.push(ws)
    await expect(
      new Promise((res, rej) => {
        ws.once('open', res)
        ws.once('error', rej)
      }),
    ).rejects.toThrow('403')
  })

  it('refuses a foreign Host header (DNS rebinding)', async () => {
    const port = Number(new URL(proxy.endpointFor(1)).port)
    const path = new URL(proxy.endpointFor(1)).pathname
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({
        host: '127.0.0.1',
        port,
        path,
        headers: { Host: `evil.test:${port}`, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' },
      })
      req.on('upgrade', () => reject(new Error('upgraded')))
      req.on('response', (r) => resolve(r.statusCode ?? 0))
      req.on('error', () => resolve(0))
      req.end()
    })
    expect([0, 403]).toContain(status)
  })

  it('serves nothing over plain http', async () => {
    const port = Number(new URL(proxy.endpointFor(1)).port)
    const status = await new Promise<number>((resolve) => {
      request({ host: '127.0.0.1', port, path: '/json/version' }, (r) => resolve(r.statusCode ?? 0)).end()
    })
    expect(status).toBe(404)
  })

  it('binds loopback only', () => {
    expect((proxy as unknown as { server: { address(): AddressInfo } }).server.address().address).toBe('127.0.0.1')
  })
})

describe('cdp-proxy filtering', () => {
  it('refuses Browser.close and createBrowserContext without touching upstream', async () => {
    const c = await connect()
    c.send({ id: 1, method: 'Browser.close' })
    c.send({ id: 2, method: 'Target.createBrowserContext' })
    const a = await c.next((m) => m['id'] === 1)
    const b = await c.next((m) => m['id'] === 2)
    expect(a['error']).toBeTruthy()
    expect(b['error']).toBeTruthy()
    await tick()
    expect(received).toEqual([])
  })

  it('sends cookie calls on a panel page session and answers on the client session', async () => {
    const c = await connect()
    c.send({ id: 9, method: 'Target.setAutoAttach', params: { autoAttach: true, flatten: true } })
    await c.next((m) => m['id'] === 9)
    const s = upstreamSockets[0]!
    s.send(JSON.stringify({ method: 'Target.attachedToTarget', params: { sessionId: 'SP', targetInfo: { targetId: 'PANEL' }, waitingForDebugger: false } }))
    await c.next((m) => m['method'] === 'Target.attachedToTarget')
    c.send({ id: 1, method: 'Storage.getCookies', params: { browserContextId: 'other' } })
    const r = await c.next((m) => m['id'] === 1)
    expect(r).toEqual({ id: 1, result: { seen: 'Network.getAllCookies' } })
    expect(received.find((m) => m['id'] === 1)).toEqual({ id: 1, method: 'Network.getAllCookies', sessionId: 'SP', params: {} })
  })

  it('drops events for other targets, detaches them, and passes panel events', async () => {
    const c = await connect()
    c.send({ id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true, flatten: true, waitForDebuggerOnStart: true } })
    await c.next((m) => m['id'] === 1)
    const s = upstreamSockets[0]!
    s.send(JSON.stringify({ method: 'Target.attachedToTarget', params: { sessionId: 'SA', targetInfo: { targetId: 'APP' }, waitingForDebugger: true } }))
    s.send(JSON.stringify({ method: 'Target.attachedToTarget', params: { sessionId: 'SP', targetInfo: { targetId: 'PANEL' }, waitingForDebugger: true } }))
    const got = await c.next((m) => m['method'] === 'Target.attachedToTarget')
    expect((got['params'] as Msg)['sessionId']).toBe('SP')
    await tick()
    expect(c.inbox.filter((m) => m['method'] === 'Target.attachedToTarget')).toHaveLength(1)
    const methods = received.map((m) => m['method'])
    expect(methods).toContain('Runtime.runIfWaitingForDebugger')
    expect(received.find((m) => m['method'] === 'Target.detachFromTarget')).toMatchObject({ params: { sessionId: 'SA' } })
    // the panel session is usable, the app one is not
    c.send({ id: 5, sessionId: 'SP', method: 'Page.navigate', params: { url: 'https://a.test' } })
    c.send({ id: 6, sessionId: 'SA', method: 'Page.navigate', params: { url: 'https://a.test' } })
    expect((await c.next((m) => m['id'] === 6))['error']).toBeTruthy()
    expect((await c.next((m) => m['id'] === 5))['result']).toBeTruthy()
  })

  it('fakes Target.createTarget through the host and emits the target events', async () => {
    const c = await connect()
    c.send({ id: 1, method: 'Target.setDiscoverTargets', params: { discover: true } })
    await c.next((m) => m['id'] === 1)
    c.send({ id: 2, method: 'Target.createTarget', params: { url: 'https://a.test/' } })
    // upstream announces the new page before the host answers, as Chromium would
    upstreamSockets[0]!.send(JSON.stringify({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'NEW', type: 'page' } } }))
    const reply = await c.next((m) => m['id'] === 2)
    expect(reply['result']).toEqual({ targetId: 'NEW' })
    expect(host.opened).toEqual(['https://a.test/'])
    expect(c.inbox.some((m) => m['method'] === 'Target.targetCreated')).toBe(true)
    expect(received.some((m) => m['method'] === 'Target.createTarget')).toBe(false)
    c.send({ id: 3, method: 'Target.closeTarget', params: { targetId: 'NEW' } })
    expect((await c.next((m) => m['id'] === 3))['result']).toEqual({ success: true })
    expect(host.closed).toEqual([7])
  })
})

describe('cdp-proxy late target registration', () => {
  const setup = async () => {
    const c = await connect()
    c.send({ id: 1, method: 'Target.setDiscoverTargets', params: { discover: true } })
    c.send({ id: 2, method: 'Target.setAutoAttach', params: { autoAttach: true, flatten: true, waitForDebuggerOnStart: true } })
    await c.next((m) => m['id'] === 2)
    return c
  }
  const info = { targetId: 'LATE', type: 'page', url: 'about:blank' }

  it('event first, then the hub learns: announces and re-attaches', async () => {
    const c = await setup()
    const s = upstreamSockets[0]!
    s.send(JSON.stringify({ method: 'Target.targetCreated', params: { targetInfo: info } }))
    s.send(JSON.stringify({ method: 'Target.attachedToTarget', params: { sessionId: 'S1', targetInfo: info, waitingForDebugger: true } }))
    await tick()
    expect(c.inbox.some((m) => m['method'] === 'Target.targetCreated')).toBe(false)
    expect(received.some((m) => m['method'] === 'Target.detachFromTarget')).toBe(true)
    hub.allowed.add('LATE')
    hub.fire()
    const created = await c.next((m) => m['method'] === 'Target.targetCreated')
    expect(((created['params'] as Msg)['targetInfo'] as Msg)['targetId']).toBe('LATE')
    await tick()
    expect(received.find((m) => m['method'] === 'Target.attachToTarget')).toMatchObject({ params: { targetId: 'LATE', flatten: true } })
    // upstream answers with the new session; it is forwarded and usable
    s.send(JSON.stringify({ method: 'Target.attachedToTarget', params: { sessionId: 'S2', targetInfo: info, waitingForDebugger: false } }))
    const att = await c.next((m) => m['method'] === 'Target.attachedToTarget')
    expect((att['params'] as Msg)['sessionId']).toBe('S2')
    c.send({ id: 9, sessionId: 'S2', method: 'Page.enable' })
    expect((await c.next((m) => m['id'] === 9))['result']).toBeTruthy()
    // a second state push does not repeat anything
    hub.fire()
    await tick()
    expect(received.filter((m) => m['method'] === 'Target.attachToTarget')).toHaveLength(1)
    expect(c.inbox.filter((m) => m['method'] === 'Target.targetCreated')).toHaveLength(1)
  })

  it('hub first, then the event: passes once with no extra attach', async () => {
    const c = await setup()
    hub.allowed.add('LATE')
    hub.fire()
    const s = upstreamSockets[0]!
    s.send(JSON.stringify({ method: 'Target.targetCreated', params: { targetInfo: info } }))
    s.send(JSON.stringify({ method: 'Target.attachedToTarget', params: { sessionId: 'S1', targetInfo: info, waitingForDebugger: false } }))
    await c.next((m) => m['method'] === 'Target.attachedToTarget')
    hub.fire()
    await tick()
    expect(c.inbox.filter((m) => m['method'] === 'Target.targetCreated')).toHaveLength(1)
    expect(received.some((m) => m['method'] === 'Target.attachToTarget' || m['method'] === 'Target.detachFromTarget')).toBe(false)
  })
})

describe('cdp-proxy pause', () => {
  it('holds client messages while paused and releases them in order on resume', async () => {
    const c = await connect()
    hub.paused = true
    c.send({ id: 1, method: 'Browser.getVersion' })
    c.send({ id: 2, method: 'Browser.getVersion' })
    await tick()
    expect(received).toEqual([])
    // events keep flowing while paused
    upstreamSockets[0]!.send(JSON.stringify({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'PANEL' } } }))
    await c.next((m) => m['method'] === 'Target.targetCreated')
    hub.paused = false
    hub.fire()
    await c.next((m) => m['id'] === 2)
    expect(received.map((m) => m['id'])).toEqual([1, 2])
  })

  it('drops held messages when the client goes away', async () => {
    const c = await connect()
    hub.paused = true
    c.send({ id: 1, method: 'Browser.getVersion' })
    await tick()
    c.ws.close()
    await tick()
    hub.paused = false
    hub.fire()
    await tick()
    expect(received).toEqual([])
  })

  it('opens one upstream per client and dropClients closes both sides', async () => {
    const a = await connect()
    await connect()
    await tick()
    expect(upstreamSockets).toHaveLength(2)
    const closed = new Promise<void>((r) => a.ws.once('close', () => r()))
    proxy.dropClients()
    await closed
  })
})
