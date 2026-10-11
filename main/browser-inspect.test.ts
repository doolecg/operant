import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session, WebContents } from 'electron'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserInspect } from './browser-inspect'

class FakeDebugger extends EventEmitter {
  attached = false
  sent: Array<{ method: string; params?: unknown }> = []
  isAttached() {
    return this.attached
  }
  attach() {
    this.attached = true
  }
  detach() {
    this.attached = false
  }
  sendCommand(method: string, params?: unknown) {
    this.sent.push({ method, params })
    return Promise.resolve({})
  }
}

class FakeWc extends EventEmitter {
  debugger = new FakeDebugger()
  isDestroyed() {
    return false
  }
}

const dirs: string[] = []
const make = () => {
  const dir = mkdtempSync(join(tmpdir(), 'inspect-'))
  dirs.push(dir)
  return { dir, inspect: new BrowserInspect({ dir, sessionOf: () => ({}) as Session }) }
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('BrowserInspect logs', () => {
  it('captures console, errors and requests without keeping headers', async () => {
    const { inspect } = make()
    const wc = new FakeWc()
    await inspect.attachTab(1, 7, wc as unknown as WebContents)
    expect(wc.debugger.sent.map((s) => s.method)).toEqual(['Runtime.enable', 'Network.enable', 'Log.enable'])
    const emit = (m: string, p: unknown) => wc.debugger.emit('message', {}, m, p)

    emit('Runtime.consoleAPICalled', { type: 'warning', args: [{ type: 'string', value: 'careful' }, { type: 'number', value: 3 }], stackTrace: { callFrames: [{ url: 'https://a.test/app.js', lineNumber: 9 }] } })
    emit('Runtime.exceptionThrown', { exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: x' }, url: 'https://a.test/app.js', lineNumber: 1 } })
    emit('Log.entryAdded', { entry: { source: 'console-api', level: 'info', text: 'duplicate' } })
    emit('Log.entryAdded', { entry: { source: 'network', level: 'error', text: 'Failed to load resource' } })
    emit('Network.requestWillBeSent', { requestId: 'r1', timestamp: 10, wallTime: 1000, type: 'XHR', request: { url: 'https://a.test/api', method: 'POST', headers: { Authorization: 'secret' } } })
    emit('Network.responseReceived', { requestId: 'r1', type: 'XHR', response: { status: 201 } })
    emit('Network.loadingFinished', { requestId: 'r1', timestamp: 10.25, encodedDataLength: 321 })
    emit('Network.requestWillBeSent', { requestId: 'r2', timestamp: 11, type: 'Image', request: { url: 'https://a.test/i.png', method: 'GET' } })
    emit('Network.loadingFailed', { requestId: 'r2', timestamp: 11.1, errorText: 'net::ERR_FAILED' })
    emit('Network.requestWillBeSent', { requestId: 'r3', timestamp: 12, request: { url: 'data:text/plain,hi', method: 'GET' } })

    const logs = inspect.logs(1, 7)
    expect(logs.console.map((e) => [e.level, e.text])).toEqual([
      ['warn', 'careful 3'],
      ['error', 'TypeError: x'],
      ['error', 'Failed to load resource'],
    ])
    expect(logs.console[0]).toMatchObject({ url: 'https://a.test/app.js', line: 10 })
    expect(logs.net).toHaveLength(2)
    expect(logs.net[0]).toMatchObject({ id: 'r1', method: 'POST', status: 201, type: 'xhr', size: 321, durationMs: 250, at: 1_000_000 })
    expect(logs.net[1]).toMatchObject({ id: 'r2', error: 'net::ERR_FAILED' })
    expect(JSON.stringify(logs)).not.toContain('secret')

    inspect.clearLogs(1, 7, 'console')
    expect(inspect.logs(1, 7).console).toEqual([])
    expect(inspect.logs(1, 7).net).toHaveLength(2)
    inspect.detachTab(1, 7)
    expect(wc.debugger.attached).toBe(false)
    expect(inspect.logs(1, 7)).toEqual({ console: [], net: [] })
  })

  it('splits a redirect into hops and rings at 500', async () => {
    const { inspect } = make()
    const wc = new FakeWc()
    await inspect.attachTab(1, 1, wc as unknown as WebContents)
    const emit = (m: string, p: unknown) => wc.debugger.emit('message', {}, m, p)
    emit('Network.requestWillBeSent', { requestId: 'r', timestamp: 1, request: { url: 'http://a.test/', method: 'GET' } })
    emit('Network.requestWillBeSent', { requestId: 'r', timestamp: 1.1, redirectResponse: { status: 301 }, request: { url: 'https://a.test/', method: 'GET' } })
    expect(inspect.logs(1, 1).net.map((e) => [e.id, e.status])).toEqual([['r', 301], ['r#1', undefined]])
    for (let i = 0; i < 600; i++) emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: String(i) }] })
    const c = inspect.logs(1, 1).console
    expect(c).toHaveLength(500)
    expect(c[0]?.text).toBe('100')
  })

  it('sends the emulation to the page', async () => {
    const { inspect } = make()
    const wc = new FakeWc()
    await inspect.attachTab(1, 1, wc as unknown as WebContents)
    wc.debugger.sent.length = 0
    await inspect.setEmulation(1, 1, { preset: 'mobile', colorScheme: 'dark', throttle: 'slow3g' })
    const by = (m: string) => wc.debugger.sent.find((s) => s.method === m)?.params as Record<string, unknown>
    expect(by('Emulation.setDeviceMetricsOverride')).toMatchObject({ width: 412, height: 915, mobile: true })
    expect(by('Emulation.setEmulatedMedia')).toEqual({ features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
    expect(by('Network.emulateNetworkConditions')).toMatchObject({ latency: 2000, offline: false })
    expect(inspect.emulation(1, 1).preset).toBe('mobile')
    await expect(inspect.setEmulation(1, 99, { preset: 'none', colorScheme: 'system', throttle: 'none' })).rejects.toThrow()
  })
})

describe('BrowserInspect bookmarks', () => {
  it('adds, edits, removes and persists per project', async () => {
    const { dir, inspect } = make()
    const seen: number[] = []
    inspect.onBookmarks((_c, l) => seen.push(l.length))
    inspect.addBookmark(1, 'https://a.test/', 'A')
    inspect.addBookmark(1, 'https://a.test', 'A again')
    const b = inspect.addBookmark(1, 'https://b.test', 'B')
    inspect.addBookmark(2, 'https://c.test', 'C')
    expect(b.map((x) => x.title)).toEqual(['B', 'A'])
    expect(() => inspect.addBookmark(1, 'about:blank', 'x')).toThrow()
    const id = b[0]!.id
    expect(inspect.editBookmark(1, id, { title: 'Bee' })[0]?.title).toBe('Bee')
    expect(inspect.removeBookmark(1, id)).toHaveLength(1)
    await inspect.flush()
    const again = new BrowserInspect({ dir, sessionOf: () => ({}) as Session })
    expect(again.bookmarks(1).map((x) => x.url)).toEqual(['https://a.test/'])
    expect(again.bookmarks(2)).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(dir, 'browser-bookmarks.json'), 'utf8'))['2']).toHaveLength(1)
    expect(seen).toEqual([1, 2, 1, 2, 1])
  })
})
