import { describe, expect, it } from 'vitest'
import type { Browser } from 'playwright-core'
import {
  clearPageStorageJs,
  GRANTABLE_PERMISSIONS,
  parseGeolocation,
  parseGrantOrigin,
  parsePermissions,
  createExtras,
  decodeDownloadText,
  describeDownloadRead,
  describeDownloads,
  downloadUrlLabel,
  parseCompat,
  type DownloadContent,
  type DownloadInfo,
  describeCookies,
  DEVICE_PRESETS,
  parseCookies,
  parseStorageKinds,
  pickPage,
  planEmulation,
  redactPasswordInputs,
  stripScripts,
  truncate,
} from './extras'
import { ExtraError } from './gate'
import { BrowserHub, type BrowserHost } from './hub'

const host: BrowserHost = { ensureOpen: async () => {}, newTab: async () => ({ tabId: 1, targetId: 't' }), closeTab: () => {}, selectTab: () => {} }
const ctx = { crewId: 1, tileId: 5 }
const signal = new AbortController().signal

describe('pure helpers', () => {
  it('pickPage prefers the active tab URL, else the newest', () => {
    const pages = [{ url: () => 'a' }, { url: () => 'b' }, { url: () => 'c' }]
    expect(pickPage(pages, 'b')?.url()).toBe('b')
    expect(pickPage(pages, 'zzz')?.url()).toBe('c')
    expect(pickPage(pages, null)?.url()).toBe('c')
    expect(pickPage([], 'a')).toBeUndefined()
  })

  it('planEmulation builds the CDP commands for a preset, with overrides', () => {
    const p = planEmulation({ preset: 'iphone', colorScheme: 'dark', width: 400 })
    const metrics = p.commands.find((c) => c.method === 'Emulation.setDeviceMetricsOverride')
    expect(metrics?.params).toMatchObject({ width: 400, height: DEVICE_PRESETS['iphone']!.height, mobile: true })
    expect(p.commands.find((c) => c.method === 'Emulation.setTouchEmulationEnabled')?.params).toMatchObject({ enabled: true })
    expect(p.commands.find((c) => c.method === 'Emulation.setUserAgentOverride')?.params['userAgent']).toMatch(/iPhone/)
    expect(p.commands.find((c) => c.method === 'Emulation.setEmulatedMedia')?.params).toEqual({ features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
    expect(p.summary).toContain('dark mode')
  })

  it('planEmulation reset clears everything, custom sizes need both sides, bad input throws', () => {
    expect(planEmulation({ preset: 'reset' }).commands.map((c) => c.method)).toContain('Emulation.clearDeviceMetricsOverride')
    expect(planEmulation({ width: 800, height: 600 }).commands[0]?.params).toMatchObject({ width: 800, height: 600, mobile: false })
    expect(() => planEmulation({ width: 800 })).toThrow(ExtraError)
    expect(() => planEmulation({ preset: 'toaster' })).toThrow(ExtraError)
    expect(() => planEmulation({ width: 99999, height: 10 })).toThrow(ExtraError)
    expect(() => planEmulation({ preset: 'pixel', colorScheme: 'purple' })).toThrow(ExtraError)
  })

  it('parseCookies validates and normalizes', () => {
    expect(parseCookies([{ name: 'a', value: 'b', url: 'https://x.test/', sameSite: 'lax' }])).toEqual([{ name: 'a', value: 'b', url: 'https://x.test/', sameSite: 'Lax' }])
    expect(parseCookies([{ name: 'a', value: 'b', domain: 'x.test' }])[0]).toMatchObject({ domain: 'x.test', path: '/' })
    expect(() => parseCookies([])).toThrow(ExtraError)
    expect(() => parseCookies([{ name: 'a b', value: 'v', url: 'https://x.test/' }])).toThrow(ExtraError)
    expect(() => parseCookies([{ name: 'a', value: 'v' }])).toThrow(ExtraError)
    expect(() => parseCookies([{ name: 'a', value: 'v', url: 'javascript:1' }])).toThrow(ExtraError)
  })

  it('an invalid-cookie error never repeats the value', () => {
    try {
      parseCookies([{ name: 'bad name', value: 'super-secret-value', url: 'https://x.test/' }])
    } catch (e) {
      expect((e as Error).message).not.toContain('super-secret-value')
    }
  })

  it('describeCookies hides values unless asked', () => {
    const c = { name: 'sid', value: 'topsecret', domain: 'x.test', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }
    const hidden = describeCookies([c], false)
    expect(hidden).not.toContain('topsecret')
    expect(hidden).toContain('"valueLength": 9')
    expect(hidden).toContain('session')
    expect(describeCookies([c], true)).toContain('topsecret')
  })

  it('redactPasswordInputs blanks only password values', () => {
    const html = '<input type="password" value="hunter2" name=p><input type="text" value="keep"><input value=\'x\' TYPE=password>'
    const out = redactPasswordInputs(html)
    expect(out).not.toContain('hunter2')
    expect(out).not.toContain("value='x'")
    expect(out).toContain('value="keep"')
  })

  it('stripScripts removes script, style and comments', () => {
    expect(stripScripts('<p>a</p><script>alert(1)</script><style>p{}</style><!-- c --><b>z</b>')).toBe('<p>a</p><script></script><style></style><b>z</b>')
  })

  it('truncate marks cut text', () => {
    expect(truncate('abcdef', 3)).toMatch(/^abc\n\.\.\.\(truncated, 3 more/)
    expect(truncate('abc', 3)).toBe('abc')
  })

  it('parseStorageKinds expands all and rejects unknown', () => {
    expect(parseStorageKinds(undefined)).toContain('indexedDB')
    expect(parseStorageKinds(['all'])).toHaveLength(6)
    expect(parseStorageKinds(['localStorage'])).toEqual(['localStorage'])
    expect(() => parseStorageKinds(['bananas'])).toThrow(ExtraError)
    expect(() => parseStorageKinds([])).toThrow(ExtraError)
    expect(clearPageStorageJs(['localStorage'])).toContain('"localStorage"')
  })
})

// A fake playwright-core browser: one context, two pages.
function fakeBrowser() {
  const log: string[] = []
  let connected = true
  const page = (url: string) => ({
    url: () => url,
    title: async () => `Title ${url}`,
    content: async () => '<html><script>x()</script><input type="password" value="pw1"><p>hello</p></html>',
    evaluate: async (src: string) => {
      log.push(`evaluate:${src.includes('localStorage') ? 'storage' : src}`)
      return src.includes('localStorage') ? ['localStorage'] : 'body text'
    },
    locator: (sel: string) => ({
      first: () => ({
        innerText: async () => `text of ${sel}`,
        evaluate: async () => `<div id="${sel}">x</div>`,
      }),
    }),
    goForward: async () => true,
    reload: async () => {
      log.push('reload')
    },
  })
  const pages = [page('https://a.test/'), page('https://b.test/')]
  const session = { send: async (m: string, p: unknown) => void log.push(`cdp:${m}:${JSON.stringify(p)}`) }
  const context = {
    pages: () => pages,
    cookies: async (urls?: string[]) => {
      log.push(`cookies:${urls?.join(',') ?? ''}`)
      return [{ name: 'sid', value: 'topsecret', domain: 'a.test', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }]
    },
    addCookies: async (c: unknown[]) => void log.push(`add:${c.length}`),
    clearCookies: async (f?: unknown) => void log.push(`clear:${JSON.stringify(f ?? {})}`),
    newCDPSession: async () => session,
    setOffline: async (v: boolean) => void log.push(`offline:${String(v)}`),
    setGeolocation: async (g: unknown) => void log.push(`geo:${JSON.stringify(g)}`),
  }
  const handlers: Record<string, () => void> = {}
  const browser = {
    contexts: () => [context],
    isConnected: () => connected,
    on: (ev: string, cb: () => void) => void (handlers[ev] = cb),
    close: async () => void log.push('close'),
  } as unknown as Browser
  return { browser, log, disconnect: () => ((connected = false), handlers['disconnected']?.()) }
}

function setup() {
  const hub = new BrowserHub({ host })
  hub.tabOpened(1, { id: 1, url: 'https://a.test/', title: 'A', loading: false, canGoBack: false, canGoForward: false, secure: 'secure' }, 'T1')
  const fb = fakeBrowser()
  let connects = 0
  const grants: unknown[][] = []
  const compatLog: unknown[][] = []
  const compat = { relaxCors: false, ignoreCertErrors: 'auto' as 'auto' | 'on' | 'off' }
  const dlInfo = (id: string, state: DownloadInfo['state'], filename = 'a.txt', mime: string | null = 'text/plain'): DownloadInfo => ({
    id, filename, url: 'https://files.test/dl/a.txt?token=secret', size: 5, mime, state, savedAt: '2026-01-01T00:00:00.000Z',
  })
  const files = new Map<string, Buffer>([
    ['d1', Buffer.from('hello world')],
    ['d3', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3])],
  ])
  const infos = [dlInfo('d3', 'completed', 'b.png', 'image/png'), dlInfo('d2', 'cancelled'), dlInfo('d1', 'completed')]
  const reads: unknown[][] = []
  const extras = createExtras({
    hub,
    cdpEndpoint: (id) => (id === 1 ? 'ws://127.0.0.1:1/cdp/1/' + 'e'.repeat(64) : null),
    autonomy: () => 'confirm',
    connect: async () => {
      connects++
      return fb.browser
    },
    runScript: async (req) => ({ ok: true, value: JSON.stringify(req.pageUrl), output: ['line'] }),
    playwrightPath: () => '/fake',
    permissions: { grant: (...a) => void grants.push(['grant', ...a]), reset: (id) => void grants.push(['reset', id]) },
    compat: {
      get: () => ({ ...compat }),
      set: (id, patch) => {
        compatLog.push([id, patch])
        Object.assign(compat, patch)
      },
    },
    downloads: {
      list: () => infos,
      read: async (id, dlId, max) => {
        reads.push([id, dlId, max])
        const info = infos.find((i) => i.id === dlId)
        const buf = files.get(dlId)
        if (!info || info.state !== 'completed' || !buf) return null
        return { info, head: buf.subarray(0, max), size: buf.length, sha256: 'abc123' }
      },
    },
  })
  const tool = (name: string) => extras.tools.find((t) => t.name === name)!
  return { hub, fb, extras, tool, grants, compatLog, reads, connects: () => connects }
}

describe('offline, location and permission helpers', () => {
  it('parseGeolocation validates ranges and clear', () => {
    expect(parseGeolocation({ latitude: 51.5, longitude: -0.1 })).toEqual({ latitude: 51.5, longitude: -0.1 })
    expect(parseGeolocation({ latitude: 1, longitude: 2, accuracy: 10 })).toEqual({ latitude: 1, longitude: 2, accuracy: 10 })
    expect(parseGeolocation({ clear: true })).toBeNull()
    expect(() => parseGeolocation({ latitude: 91, longitude: 0 })).toThrow(ExtraError)
    expect(() => parseGeolocation({ latitude: 0, longitude: -181 })).toThrow(ExtraError)
    expect(() => parseGeolocation({ latitude: 0, longitude: 0, accuracy: -1 })).toThrow(ExtraError)
    expect(() => parseGeolocation({ latitude: 0 })).toThrow(ExtraError)
    expect(() => parseGeolocation({ latitude: '0', longitude: 0 })).toThrow(ExtraError)
  })

  it('parsePermissions only takes the grantable names, parseGrantOrigin only http(s)', () => {
    expect(parsePermissions(['geolocation', 'geolocation', 'notifications'])).toEqual(['geolocation', 'notifications'])
    for (const bad of [[], 'geolocation', ['camera'], ['media'], ['microphone'], ['geolocation', 'payment-handler'], [5]]) expect(() => parsePermissions(bad)).toThrow(ExtraError)
    expect(GRANTABLE_PERMISSIONS).not.toContain('media')
    expect(parseGrantOrigin('https://a.test/path?q=1')).toBe('https://a.test')
    expect(() => parseGrantOrigin('file:///x')).toThrow(ExtraError)
    expect(() => parseGrantOrigin('nope')).toThrow(ExtraError)
  })
})

describe('extra tools', () => {
  it('lists the tool names', () => {
    const { extras } = setup()
    expect(extras.tools.map((t) => t.name).sort()).toEqual(
      [
        'browser_status',
        'browser_get_cookies',
        'browser_set_cookies',
        'browser_clear_storage',
        'browser_emulate_device',
        'browser_get_html',
        'browser_get_page_text',
        'browser_navigate_forward',
        'browser_reload',
        'browser_run_playwright_script',
        'browser_set_offline',
        'browser_set_geolocation',
        'browser_grant_permissions',
        'browser_set_compat',
        'browser_list_downloads',
        'browser_read_download',
      ].sort(),
    )
    for (const t of extras.tools) expect(t.inputSchema['type']).toBe('object')
  })

  it('browser_status is ungated and reports state without secrets', async () => {
    const { tool, hub } = setup()
    const id = hub.actionBegin(1, { tileId: 5, tool: 'browser_click', summary: 'browser_click Save' })
    hub.actionEnd(1, id, 'done')
    expect(tool('browser_status').ungated).toBe(true)
    const s = JSON.parse(await tool('browser_status').run(ctx, {}, signal))
    expect(s).toMatchObject({ open: true, autonomy: 'confirm', userHasControl: false, activeTabId: 1, recentActions: ['browser_click Save [done]'] })
  })

  it('cookies: hidden values by default, set and clear go through the context', async () => {
    const { tool, fb } = setup()
    const hidden = await tool('browser_get_cookies').run(ctx, { urls: ['https://a.test/', 'file:///x'] }, signal)
    expect(hidden).not.toContain('topsecret')
    expect(fb.log).toContain('cookies:https://a.test/')
    expect(await tool('browser_get_cookies').run(ctx, { includeValues: true }, signal)).toContain('topsecret')
    expect(await tool('browser_set_cookies').run(ctx, { cookies: [{ name: 'a', value: 'v', url: 'https://a.test/' }] }, signal)).toBe('Set 1 cookie: a')
    expect(await tool('browser_clear_storage').run(ctx, { what: ['cookies', 'localStorage'], domain: 'a.test' }, signal)).toBe('Cleared: cookies, localStorage.')
    expect(fb.log).toContain('clear:{"domain":"a.test"}')
  })

  it('emulate_device sends the CDP commands on the active page session', async () => {
    const { tool, fb } = setup()
    const r = await tool('browser_emulate_device').run(ctx, { preset: 'pixel' }, signal)
    expect(r).toMatch(/Emulating 412x915/)
    expect(fb.log.filter((l) => l.startsWith('cdp:Emulation.')).length).toBe(4)
  })

  it('get_html strips scripts and password values; get_page_text adds URL and title', async () => {
    const { tool } = setup()
    const html = await tool('browser_get_html').run(ctx, {}, signal)
    expect(html).not.toContain('x()')
    expect(html).not.toContain('pw1')
    expect(html).toContain('hello')
    expect(await tool('browser_get_html').run(ctx, { selector: '#a' }, signal)).toContain('<div id="#a">')
    const text = await tool('browser_get_page_text').run(ctx, {}, signal)
    expect(text).toBe('URL: https://a.test/\nTitle: Title https://a.test/\n\nbody text')
  })

  it('reload and forward use the active page', async () => {
    const { tool, fb } = setup()
    expect(await tool('browser_reload').run(ctx, {}, signal)).toMatch(/^Reloaded https:\/\/a\.test\//)
    expect(fb.log).toContain('reload')
    expect(await tool('browser_reload').run(ctx, { hard: true }, signal)).toMatch(/Reloaded/)
    expect(fb.log.some((l) => l.startsWith('cdp:Page.reload:{"ignoreCache":true}'))).toBe(true)
    expect(await tool('browser_navigate_forward').run(ctx, {}, signal)).toMatch(/Went forward/)
  })

  it('run_playwright_script passes the active tab URL and formats the result', async () => {
    const { tool } = setup()
    expect(await tool('browser_run_playwright_script').run(ctx, { script: 'return 1' }, signal)).toBe('Result: "https://a.test/"\nConsole output:\nline')
    await expect(tool('browser_run_playwright_script').run(ctx, {}, signal)).rejects.toBeInstanceOf(ExtraError)
  })

  it('reuses one connection per project and reconnects after a disconnect', async () => {
    const { tool, fb, connects } = setup()
    await tool('browser_get_cookies').run(ctx, {}, signal)
    await tool('browser_get_cookies').run(ctx, {}, signal)
    expect(connects()).toBe(1)
    fb.disconnect()
    await tool('browser_get_cookies').run(ctx, {}, signal)
    expect(connects()).toBe(2)
  })

  it('a project without an endpoint gets a safe error', async () => {
    const { tool } = setup()
    await expect(tool('browser_get_cookies').run({ crewId: 9, tileId: 5 }, {}, signal)).rejects.toThrow('The browser is not available.')
  })

  it('dropCrew closes the connection', async () => {
    const { tool, fb, extras } = setup()
    await tool('browser_get_cookies').run(ctx, {}, signal)
    extras.dropCrew(1)
    await new Promise((r) => setTimeout(r, 5))
    expect(fb.log).toContain('close')
  })

  it('set_offline toggles the context and shows in browser_status', async () => {
    const { tool, fb } = setup()
    expect(await tool('browser_set_offline').run(ctx, { offline: true }, signal)).toMatch(/offline/)
    expect(fb.log).toContain('offline:true')
    expect(JSON.parse(await tool('browser_status').run(ctx, {}, signal)).offline).toBe(true)
    await tool('browser_set_offline').run(ctx, { offline: false }, signal)
    expect(fb.log).toContain('offline:false')
    expect(JSON.parse(await tool('browser_status').run(ctx, {}, signal)).offline).toBe(false)
    await expect(tool('browser_set_offline').run(ctx, { offline: 'yes' }, signal)).rejects.toThrow(ExtraError)
  })

  it('the offline status resets when the connection drops', async () => {
    const { tool, fb } = setup()
    await tool('browser_set_offline').run(ctx, { offline: true }, signal)
    fb.disconnect()
    expect(JSON.parse(await tool('browser_status').run(ctx, {}, signal)).offline).toBe(false)
  })

  it('set_geolocation sets and clears, and points at the permission', async () => {
    const { tool, fb } = setup()
    const r = await tool('browser_set_geolocation').run(ctx, { latitude: 10, longitude: 20, accuracy: 5 }, signal)
    expect(r).toContain('browser_grant_permissions')
    expect(fb.log).toContain('geo:{"latitude":10,"longitude":20,"accuracy":5}')
    await tool('browser_set_geolocation').run(ctx, { clear: true }, signal)
    expect(fb.log).toContain('geo:null')
    await expect(tool('browser_set_geolocation').run(ctx, { latitude: 100, longitude: 0 }, signal)).rejects.toThrow(ExtraError)
  })

  it('grant_permissions calls the hook for the active tab origin, an explicit origin, and reset', async () => {
    const { tool, grants } = setup()
    await tool('browser_grant_permissions').run(ctx, { permissions: ['geolocation'] }, signal)
    await tool('browser_grant_permissions').run(ctx, { permissions: ['notifications'], origin: 'https://c.test/x?y=1' }, signal)
    await tool('browser_grant_permissions').run(ctx, { reset: true }, signal)
    expect(grants).toEqual([
      ['grant', 1, 'https://a.test', ['geolocation']],
      ['grant', 1, 'https://c.test', ['notifications']],
      ['reset', 1],
    ])
    await expect(tool('browser_grant_permissions').run(ctx, { permissions: ['camera'] }, signal)).rejects.toThrow(ExtraError)
    expect(grants.length).toBe(3)
  })
})

describe('compat and download tools', () => {
  it('parseCompat takes only the given, valid keys', () => {
    expect(parseCompat({ relaxCors: true })).toEqual({ relaxCors: true })
    expect(parseCompat({ ignoreCertErrors: 'off', relaxCors: false })).toEqual({ ignoreCertErrors: 'off', relaxCors: false })
    for (const bad of [{}, { relaxCors: 'yes' }, { ignoreCertErrors: 'maybe' }, { ignoreCertErrors: true }]) expect(() => parseCompat(bad)).toThrow(ExtraError)
  })

  it('set_compat calls the host hook with the patch, states the new values, and shows them in browser_status', async () => {
    const { tool, compatLog } = setup()
    const r = await tool('browser_set_compat').run(ctx, { relaxCors: true }, signal)
    expect(compatLog).toEqual([[1, { relaxCors: true }]])
    expect(r).toContain('relaxCors is on')
    expect(r).toContain('ignoreCertErrors is auto')
    expect(r).toContain('stays until')
    await tool('browser_set_compat').run(ctx, { ignoreCertErrors: 'on' }, signal)
    expect(compatLog[1]).toEqual([1, { ignoreCertErrors: 'on' }])
    expect(JSON.parse(await tool('browser_status').run(ctx, {}, signal)).compat).toEqual({ relaxCors: true, ignoreCertErrors: 'on' })
    await expect(tool('browser_set_compat').run(ctx, {}, signal)).rejects.toThrow(ExtraError)
    expect(compatLog.length).toBe(2)
  })

  it('url labels drop query and fragment', () => {
    expect(downloadUrlLabel('https://files.test/dl/a.txt?token=secret#x')).toBe('files.test/dl/a.txt')
    expect(downloadUrlLabel('blob:null/1234')).not.toContain('1234')
    expect(downloadUrlLabel('nope')).toBe('unknown')
  })

  it('list_downloads shows the metadata without the query', async () => {
    const { tool } = setup()
    const out = await tool('browser_list_downloads').run(ctx, {}, signal)
    expect(out).not.toContain('secret')
    const list = JSON.parse(out)
    expect(list.map((d: { id: string; state: string }) => `${d.id}:${d.state}`)).toEqual(['d3:completed', 'd2:cancelled', 'd1:completed'])
    expect(list[0]).toMatchObject({ filename: 'b.png', url: 'files.test/dl/a.txt', mime: 'image/png', size: 5, savedAt: '2026-01-01T00:00:00.000Z' })
    expect(describeDownloads([])).toBe('[]')
  })

  it('read_download returns text, metadata and binary hex; refuses unfinished or unknown ids', async () => {
    const { tool, reads } = setup()
    const text = await tool('browser_read_download').run(ctx, { id: 'd1' }, signal)
    expect(text).toContain('hello world')
    expect(text).toContain('sha256: abc123')
    expect(reads[0]).toEqual([1, 'd1', 40_000 * 4 + 4])
    const bin = await tool('browser_read_download').run(ctx, { id: 'd3' }, signal)
    expect(bin).toContain('Binary file')
    expect(bin).toContain('89504e4700010203')
    await expect(tool('browser_read_download').run(ctx, { id: 'd2' }, signal)).rejects.toThrow(ExtraError)
    await expect(tool('browser_read_download').run(ctx, { id: '../x' }, signal)).rejects.toThrow(ExtraError)
    await expect(tool('browser_read_download').run(ctx, {}, signal)).rejects.toThrow(ExtraError)
    // There is no path argument to pass.
    expect(tool('browser_read_download').inputSchema['properties']).not.toHaveProperty('path')
  })

  it('decodes text by content, treats NUL bytes as binary, and caps with a note', () => {
    const info = { filename: 'x.bin', mime: null }
    expect(decodeDownloadText(Buffer.from('plain \u00fcn\u00ef'), info, false)).toBe('plain \u00fcn\u00ef')
    expect(decodeDownloadText(Buffer.from([0x68, 0, 0x69]), { filename: 'a.txt', mime: 'text/plain' }, false)).toBeNull()
    expect(decodeDownloadText(Buffer.from([0xff, 0xfe, 0x41]), info, false)).toBeNull()
    expect(decodeDownloadText(Buffer.from([0xff, 0x41]), { filename: 'a.csv', mime: null }, false)).toContain('A')
    const c: DownloadContent = { info: { id: 'd1', filename: 'big.txt', url: 'https://a.test/big.txt', size: 3000, mime: 'text/plain', state: 'completed', savedAt: '' }, head: Buffer.from('x'.repeat(3000)), size: 3000, sha256: 'h' }
    const out = describeDownloadRead(c, 500)
    expect(out).toContain('truncated, 2500 more characters')
    expect(out.length).toBeLessThan(900)
  })
})
