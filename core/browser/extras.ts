// The browser tools @playwright/mcp does not have, appended to its tools/list by the gate. They run in the main
// process through ONE playwright-core connection per project to the filtering CDP proxy (never the raw app UI), except
// browser_run_playwright_script, which runs in a worker thread (script-runner.ts).
// NEVER log the endpoint, cookie values, password values or page contents; errors the AI sees are fixed texts.
import { createRequire } from 'node:module'
import type { Browser, BrowserContext, CDPSession, Page } from 'playwright-core'
import type { BrowserAutonomy, CertMode } from '../../shared/browser-compat'
import { ExtraError, type ExtraTool } from './gate'
import type { BrowserHub } from './hub'
import {
  clampTimeout,
  formatScriptResult,
  redactSecrets,
  runScriptInWorker,
  SCRIPT_DEFAULT_TIMEOUT_MS,
  type ScriptRequest,
  type ScriptResult,
} from './script-runner'

export interface ExtrasOptions {
  hub: Pick<BrowserHub, 'state' | 'actions' | 'confirms'>
  // The CdpProxy URL (with its secret) for a project. Never logged and never sent to the AI.
  cdpEndpoint(crewId: number): string | null
  autonomy(): BrowserAutonomy
  // Test seams.
  connect?: (endpoint: string) => Promise<Browser>
  runScript?: (req: ScriptRequest, signal: AbortSignal) => Promise<ScriptResult>
  playwrightPath?: () => string
  // Host-side permission grants (the panel's session lives in the main process, so Browser.grantPermissions cannot be used).
  permissions?: {
    grant(crewId: number, origin: string, permissions: string[]): void
    reset(crewId: number): void
  }
  // The project's real compatibility settings (persisted, shown in Settings, sessions reapplied by the host).
  compat?: {
    get(crewId: number): CompatValues
    set(crewId: number, patch: Partial<CompatValues>): Promise<void> | void
  }
  // Files the panel saved for the project. read only ever opens the file recorded for that download id.
  downloads?: {
    list(crewId: number): DownloadInfo[]
    read(crewId: number, id: string, maxBytes: number): Promise<DownloadContent | null>
  }
}

export interface CompatValues {
  relaxCors: boolean
  ignoreCertErrors: CertMode
}

export interface DownloadInfo {
  id: string
  filename: string
  url: string
  size: number
  mime: string | null
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  savedAt: string
}

// The start of a completed download's file (at most maxBytes), its full size and sha256.
export interface DownloadContent {
  info: DownloadInfo
  head: Uint8Array
  size: number
  sha256: string
}

export interface Extras {
  tools: ExtraTool[]
  // Closes the project's connection (the project or its browser went away).
  dropCrew(crewId: number): void
  dispose(): void
}

const STEP_MS = 15_000
const TEXT_DEFAULT = 40_000
const TEXT_MAX = 200_000
const COOKIES_MAX = 200

// ---------------------------------------------------------------- pure helpers

// The tab a tool acts on: the user's active tab (matched by URL), else the newest.
export function pickPage<T extends { url(): string }>(pages: readonly T[], activeUrl: string | null): T | undefined {
  return (activeUrl !== null ? pages.find((p) => p.url() === activeUrl) : undefined) ?? pages[pages.length - 1]
}

export interface DeviceSpec {
  width: number
  height: number
  deviceScaleFactor: number
  mobile: boolean
  touch: boolean
  userAgent: string
}

const CHROME = 'Chrome/131.0.0.0'
export const DEVICE_PRESETS: Record<string, DeviceSpec> = {
  'iphone': {
    width: 393,
    height: 852,
    deviceScaleFactor: 3,
    mobile: true,
    touch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  },
  'pixel': {
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
    touch: true,
    userAgent: `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) ${CHROME} Mobile Safari/537.36`,
  },
  'ipad': {
    width: 820,
    height: 1180,
    deviceScaleFactor: 2,
    mobile: true,
    touch: true,
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  },
  'laptop': { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false, touch: false, userAgent: '' },
  'desktop': { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false, touch: false, userAgent: '' },
}

export interface EmulationPlan {
  commands: Array<{ method: string; params: Record<string, unknown> }>
  summary: string
}

const num = (v: unknown, min: number, max: number, what: string): number | undefined => {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new ExtraError(`${what} must be a number from ${min} to ${max}.`)
  return v
}

// Turns browser_emulate_device arguments into CDP Emulation commands. Throws ExtraError for bad input.
export function planEmulation(args: Record<string, unknown>): EmulationPlan {
  const preset = typeof args['preset'] === 'string' ? args['preset'].toLowerCase() : undefined
  const scheme = args['colorScheme']
  if (scheme !== undefined && scheme !== null && scheme !== 'light' && scheme !== 'dark' && scheme !== 'none') throw new ExtraError('colorScheme must be light, dark or none.')
  const media = scheme === 'light' || scheme === 'dark' ? [{ name: 'prefers-color-scheme', value: scheme }] : []

  if (preset === 'reset') {
    return {
      commands: [
        { method: 'Emulation.clearDeviceMetricsOverride', params: {} },
        { method: 'Emulation.setUserAgentOverride', params: { userAgent: '' } },
        { method: 'Emulation.setTouchEmulationEnabled', params: { enabled: false } },
        { method: 'Emulation.setEmulatedMedia', params: { features: [] } },
      ],
      summary: 'Device emulation reset to the real browser.',
    }
  }
  if (preset !== undefined && !(preset in DEVICE_PRESETS)) {
    throw new ExtraError(`Unknown preset. Use one of: ${Object.keys(DEVICE_PRESETS).join(', ')}, reset, or give width and height.`)
  }
  const base = preset !== undefined ? DEVICE_PRESETS[preset] : undefined
  const width = num(args['width'], 100, 4000, 'width') ?? base?.width
  const height = num(args['height'], 100, 4000, 'height') ?? base?.height
  if (width === undefined || height === undefined) throw new ExtraError('Give a preset, or both width and height.')
  const deviceScaleFactor = num(args['deviceScaleFactor'], 0.5, 5, 'deviceScaleFactor') ?? base?.deviceScaleFactor ?? 1
  const mobile = typeof args['mobile'] === 'boolean' ? args['mobile'] : (base?.mobile ?? false)
  const touch = typeof args['touch'] === 'boolean' ? args['touch'] : (base?.touch ?? mobile)
  const userAgent = typeof args['userAgent'] === 'string' ? args['userAgent'].replace(/[\r\n]/g, '').slice(0, 500) : (base?.userAgent ?? '')
  const commands: EmulationPlan['commands'] = [
    { method: 'Emulation.setDeviceMetricsOverride', params: { width, height, deviceScaleFactor, mobile, screenWidth: width, screenHeight: height } },
    { method: 'Emulation.setTouchEmulationEnabled', params: { enabled: touch, maxTouchPoints: touch ? 5 : 1 } },
    { method: 'Emulation.setUserAgentOverride', params: { userAgent } },
    { method: 'Emulation.setEmulatedMedia', params: { features: media } },
  ]
  const bits = [`${width}x${height} @${deviceScaleFactor}x`, mobile ? 'mobile' : 'desktop', touch ? 'touch' : 'no touch']
  if (userAgent) bits.push('custom user agent')
  if (media.length > 0) bits.push(`${scheme} mode`)
  return { commands, summary: `Emulating ${bits.join(', ')}.` }
}

export interface CookieInput {
  name: string
  value: string
  url?: string
  domain?: string
  path?: string
  expires?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
}

// Validates browser_set_cookies input. Throws ExtraError (the message never repeats a value).
export function parseCookies(raw: unknown): CookieInput[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new ExtraError('cookies must be a non-empty array.')
  if (raw.length > 50) throw new ExtraError('At most 50 cookies at once.')
  return raw.map((c, i) => {
    const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>
    const where = `cookies[${i}]`
    if (typeof o['name'] !== 'string' || !o['name'] || /[\s;=]/.test(o['name'])) throw new ExtraError(`${where}.name is missing or invalid.`)
    if (typeof o['value'] !== 'string') throw new ExtraError(`${where}.value must be a string.`)
    const out: CookieInput = { name: o['name'], value: o['value'] }
    if (typeof o['url'] === 'string' && o['url']) {
      if (!/^https?:\/\//i.test(o['url'])) throw new ExtraError(`${where}.url must be http or https.`)
      out.url = o['url']
    } else if (typeof o['domain'] === 'string' && o['domain']) {
      out.domain = o['domain']
      out.path = typeof o['path'] === 'string' && o['path'] ? o['path'] : '/'
    } else throw new ExtraError(`${where} needs a url, or a domain.`)
    if (typeof o['expires'] === 'number' && Number.isFinite(o['expires'])) out.expires = o['expires']
    if (typeof o['httpOnly'] === 'boolean') out.httpOnly = o['httpOnly']
    if (typeof o['secure'] === 'boolean') out.secure = o['secure']
    const ss = typeof o['sameSite'] === 'string' ? o['sameSite'].toLowerCase() : ''
    if (ss === 'strict') out.sameSite = 'Strict'
    else if (ss === 'lax') out.sameSite = 'Lax'
    else if (ss === 'none') out.sameSite = 'None'
    return out
  })
}

export interface CookieLike {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite: string
}

// The cookie list for the AI: values stay hidden (only their length) unless asked for, and then only after approval.
export function describeCookies(cookies: readonly CookieLike[], includeValues: boolean): string {
  const list = cookies.slice(0, COOKIES_MAX).map((c) => ({
    name: c.name,
    domain: c.domain,
    path: c.path,
    ...(includeValues ? { value: c.value } : { valueLength: c.value.length }),
    expires: c.expires > 0 ? new Date(c.expires * 1000).toISOString() : 'session',
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite,
  }))
  const more = cookies.length > COOKIES_MAX ? `\n(${cookies.length - COOKIES_MAX} more not shown)` : ''
  return `${cookies.length} cookie${cookies.length === 1 ? '' : 's'}${includeValues ? '' : ' (values hidden)'}\n${JSON.stringify(list, null, 2)}${more}`
}

// Blanks the value="" of password inputs so a password the page echoed into its markup does not reach the AI.
export function redactPasswordInputs(html: string): string {
  return html.replace(/<input\b[^>]*>/gi, (tag) =>
    /\btype\s*=\s*["']?password\b/i.test(tag) ? tag.replace(/\bvalue\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, 'value=""') : tag,
  )
}

export function stripScripts(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '<script></script>')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '<style></style>')
    .replace(/<!--[\s\S]*?-->/g, '')
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n...(truncated, ${text.length - max} more characters; narrow it with a selector)` : text
}

export const STORAGE_KINDS = ['cookies', 'localStorage', 'sessionStorage', 'indexedDB', 'cacheStorage', 'serviceWorkers'] as const
export type StorageKind = (typeof STORAGE_KINDS)[number]

export function parseStorageKinds(raw: unknown): StorageKind[] {
  if (raw === undefined) return [...STORAGE_KINDS]
  if (!Array.isArray(raw) || raw.length === 0) throw new ExtraError('what must be a non-empty array.')
  const out = new Set<StorageKind>()
  for (const k of raw) {
    if (k === 'all') for (const x of STORAGE_KINDS) out.add(x)
    else if ((STORAGE_KINDS as readonly unknown[]).includes(k)) out.add(k as StorageKind)
    else throw new ExtraError(`Unknown storage kind. Use: all, ${STORAGE_KINDS.join(', ')}.`)
  }
  return [...out]
}

// Runs in the page; a string (not a function) so a bundler cannot rewrite it.
export const clearPageStorageJs = (kinds: readonly StorageKind[]): string => `(async () => {
  const want = new Set(${JSON.stringify(kinds)});
  const done = [];
  const step = async (name, fn) => { if (!want.has(name)) return; try { await fn(); done.push(name) } catch (e) {} };
  await step('localStorage', () => localStorage.clear());
  await step('sessionStorage', () => sessionStorage.clear());
  await step('indexedDB', async () => { const dbs = indexedDB.databases ? await indexedDB.databases() : []; for (const d of dbs) if (d.name) indexedDB.deleteDatabase(d.name) });
  await step('cacheStorage', async () => { for (const k of await caches.keys()) await caches.delete(k) });
  await step('serviceWorkers', async () => { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister() });
  return done;
})()`

export const GRANTABLE_PERMISSIONS = ['geolocation', 'notifications', 'clipboard-read', 'clipboard-write', 'midi', 'idle-detection', 'local-fonts', 'window-management', 'sensors'] as const

// Validates browser_grant_permissions input. Throws ExtraError.
export function parsePermissions(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new ExtraError('permissions must be a non-empty array.')
  const out = new Set<string>()
  for (const p of raw) {
    if (typeof p !== 'string' || !(GRANTABLE_PERMISSIONS as readonly string[]).includes(p)) {
      throw new ExtraError(`Permission not allowed. Use: ${GRANTABLE_PERMISSIONS.join(', ')}. Camera, microphone and other permissions are never granted by the AI.`)
    }
    out.add(p)
  }
  return [...out]
}

// The http(s) origin a grant applies to; throws ExtraError when it is not one.
export function parseGrantOrigin(raw: string): string {
  try {
    const u = new URL(raw)
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin
  } catch {
    /* fall through */
  }
  throw new ExtraError('origin must be an http or https URL.')
}

export interface GeoInput {
  latitude: number
  longitude: number
  accuracy?: number
}

// Validates browser_set_geolocation input: null means clear. Throws ExtraError.
export function parseGeolocation(a: Record<string, unknown>): GeoInput | null {
  if (a['clear'] === true) return null
  const latitude = num(a['latitude'], -90, 90, 'latitude')
  const longitude = num(a['longitude'], -180, 180, 'longitude')
  if (latitude === undefined || longitude === undefined) throw new ExtraError('Give latitude and longitude, or clear: true.')
  const accuracy = num(a['accuracy'], 0, Number.MAX_VALUE, 'accuracy')
  return accuracy === undefined ? { latitude, longitude } : { latitude, longitude, accuracy }
}

// Validates browser_set_compat input: only the given keys. Throws ExtraError.
export function parseCompat(a: Record<string, unknown>): Partial<CompatValues> {
  const out: Partial<CompatValues> = {}
  if (a['relaxCors'] !== undefined) {
    if (typeof a['relaxCors'] !== 'boolean') throw new ExtraError('relaxCors must be true or false.')
    out.relaxCors = a['relaxCors']
  }
  if (a['ignoreCertErrors'] !== undefined) {
    const v = a['ignoreCertErrors']
    if (v !== 'auto' && v !== 'on' && v !== 'off') throw new ExtraError('ignoreCertErrors must be auto, on or off.')
    out.ignoreCertErrors = v
  }
  if (Object.keys(out).length === 0) throw new ExtraError('Give relaxCors and/or ignoreCertErrors.')
  return out
}

export function describeCompat(v: CompatValues): string {
  return `relaxCors is ${v.relaxCors ? 'on' : 'off'} and ignoreCertErrors is ${v.ignoreCertErrors}. This stays until it is switched back (also in Settings, Browser).`
}

// The host and path of a download URL, never its query or fragment.
export function downloadUrlLabel(url: string): string {
  try {
    const u = new URL(url)
    return u.host ? `${u.host}${u.pathname === '/' ? '' : u.pathname}` : `${u.protocol}...`
  } catch {
    return 'unknown'
  }
}

export function describeDownloads(list: readonly DownloadInfo[]): string {
  return JSON.stringify(
    list.map((d) => ({ id: d.id, filename: d.filename, url: downloadUrlLabel(d.url), size: d.size, mime: d.mime, state: d.state, savedAt: d.savedAt })),
    null,
    2,
  )
}

const TEXT_MIME = /^text\/|json|xml|csv|javascript|ecmascript|markdown|svg|html|yaml|toml/i
const TEXT_EXT = /\.(?:txt|json|xml|csv|tsv|js|mjs|cjs|ts|html?|md|svg|css|yml|yaml|toml|log|ini)$/i

// Text for a downloaded file, or null when it is binary: a NUL byte means binary; otherwise valid UTF-8, or a text-like
// type or extension (decoded leniently).
export function decodeDownloadText(head: Uint8Array, info: Pick<DownloadInfo, 'filename' | 'mime'>, partial: boolean): string | null {
  if (head.includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: partial })
  } catch {
    return (info.mime && TEXT_MIME.test(info.mime)) || TEXT_EXT.test(info.filename) ? new TextDecoder('utf-8').decode(head, { stream: partial }) : null
  }
}

export function describeDownloadRead(c: DownloadContent, maxChars: number): string {
  const d = c.info
  const meta = `File: ${d.filename}\nFrom: ${downloadUrlLabel(d.url)}\nSize: ${c.size} bytes\nType: ${d.mime ?? 'unknown'}\nsha256: ${c.sha256}`
  const partial = c.head.length < c.size
  const text = decodeDownloadText(c.head, d, partial)
  if (text === null) return `${meta}\nBinary file. First ${Math.min(64, c.head.length)} bytes (hex): ${Buffer.from(c.head.subarray(0, 64)).toString('hex')}`
  const cut = text.length > maxChars
  const body = cut ? `${text.slice(0, maxChars)}\n...(truncated, ${text.length - maxChars} more characters read, the file may hold more)` : partial ? `${text}\n...(truncated, the file is larger than what was read)` : text
  return `${meta}\n\n${body}`
}

const strArg = (a: Record<string, unknown>, k: string): string | undefined => (typeof a[k] === 'string' && a[k] !== '' ? (a[k] as string) : undefined)

const limitArg = (a: Record<string, unknown>): number => {
  const v = a['maxChars']
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(500, Math.min(Math.round(v), TEXT_MAX)) : TEXT_DEFAULT
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new ExtraError(message)), ms)
    t.unref?.()
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(t)
        reject(e instanceof Error ? e : new Error('failed'))
      },
    )
  })
}

// ---------------------------------------------------------------- the tools

export function createExtras(o: ExtrasOptions): Extras {
  const conns = new Map<number, Promise<Browser>>()
  // Offline per project; forgotten when its connection goes (the emulation dies with the page sessions).
  const offline = new Map<number, boolean>()
  const sessions = new WeakMap<Page, Promise<CDPSession>>()
  let pw: { chromium: { connectOverCDP(endpoint: string, opts?: { timeout?: number }): Promise<Browser> } } | null = null
  const req = createRequire(import.meta.url ?? __filename)
  const connect =
    o.connect ??
    ((endpoint: string) => {
      pw ??= req('playwright-core') as NonNullable<typeof pw>
      return pw.chromium.connectOverCDP(endpoint, { timeout: STEP_MS })
    })

  async function browserOf(crewId: number): Promise<Browser> {
    const known = conns.get(crewId)
    if (known) {
      try {
        const b = await known
        if (b.isConnected()) return b
      } catch {
        // Fall through and reconnect.
      }
      conns.delete(crewId)
    }
    const endpoint = o.cdpEndpoint(crewId)
    if (!endpoint) throw new ExtraError('The browser is not available.')
    const p: Promise<Browser> = connect(endpoint).then((b) => {
      b.on('disconnected', () => {
        if (conns.get(crewId) === p) conns.delete(crewId)
        offline.delete(crewId)
      })
      return b
    })
    conns.set(crewId, p)
    try {
      return await withTimeout(p, STEP_MS + 2000, 'Could not connect to the browser panel in time.')
    } catch (err) {
      conns.delete(crewId)
      throw err instanceof ExtraError ? err : new ExtraError('Could not connect to the browser panel.')
    }
  }

  async function current(crewId: number): Promise<{ context: BrowserContext; page: Page }> {
    const browser = await browserOf(crewId)
    const context = browser.contexts()[0]
    if (!context) throw new ExtraError('The browser has no open page. Use browser_navigate first.')
    const st = o.hub.state(crewId)
    const active = st.tabs.find((t) => t.id === st.activeTabId)
    const page = pickPage(context.pages(), active?.url ?? null)
    if (!page) throw new ExtraError('There is no open tab. Use browser_navigate first.')
    return { context, page }
  }

  const sessionOf = (context: BrowserContext, page: Page): Promise<CDPSession> => {
    let s = sessions.get(page)
    if (!s) {
      s = context.newCDPSession(page)
      sessions.set(page, s)
      s.catch(() => sessions.delete(page))
    }
    return s
  }

  // Every Playwright call is bounded; a hung page becomes a short fixed message.
  const guard = <T>(p: Promise<T>, what: string): Promise<T> => withTimeout(p, STEP_MS + 5000, `${what} timed out.`)
  const fail = (what: string) => (): never => {
    throw new ExtraError(`${what} failed.`)
  }

  const tools: ExtraTool[] = [
    {
      name: 'browser_status',
      description: 'Shows the browser panel state: open tabs, the active tab, whether the user has taken control, the autonomy mode and the last actions.',
      inputSchema: { type: 'object', properties: {} },
      ungated: true,
      run: ({ crewId }) => {
        const st = o.hub.state(crewId)
        return JSON.stringify(
          {
            open: st.open,
            aiControlAllowed: st.aiAllowed,
            userHasControl: st.ai.paused,
            autonomy: o.autonomy(),
            offline: offline.get(crewId) === true,
            ...(o.compat ? { compat: o.compat.get(crewId) } : {}),
            activeTabId: st.activeTabId,
            tabs: st.tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, loading: t.loading, active: t.id === st.activeTabId })),
            pendingApprovals: o.hub.confirms.pending(crewId).length,
            recentActions: o.hub
              .actions(crewId)
              .slice(-5)
              .map((a) => `${a.summary} [${a.status}]`),
          },
          null,
          2,
        )
      },
    },
    {
      name: 'browser_get_cookies',
      description:
        'Lists the cookies of the browser session (optionally only those for given URLs). Values are hidden unless includeValues is true, which asks the user for approval.',
      inputSchema: {
        type: 'object',
        properties: {
          urls: { type: 'array', items: { type: 'string' }, description: 'Only cookies that apply to these http(s) URLs.' },
          includeValues: { type: 'boolean', description: 'Include cookie values (needs the user\'s approval).' },
        },
      },
      run: async ({ crewId }, a) => {
        const { context } = await current(crewId)
        const urls = Array.isArray(a['urls']) ? a['urls'].filter((u): u is string => typeof u === 'string' && /^https?:\/\//i.test(u)).slice(0, 20) : undefined
        const cookies = await guard(context.cookies(urls && urls.length > 0 ? urls : undefined), 'Reading cookies').catch(fail('Reading cookies'))
        return describeCookies(cookies, a['includeValues'] === true)
      },
    },
    {
      name: 'browser_set_cookies',
      description:
        'Sets cookies in the browser session. Each cookie needs name, value and either url, or domain (path defaults to /). Optional: expires (unix seconds), httpOnly, secure, sameSite.',
      inputSchema: {
        type: 'object',
        properties: {
          cookies: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                value: { type: 'string' },
                url: { type: 'string' },
                domain: { type: 'string' },
                path: { type: 'string' },
                expires: { type: 'number' },
                httpOnly: { type: 'boolean' },
                secure: { type: 'boolean' },
                sameSite: { type: 'string', enum: ['Strict', 'Lax', 'None'] },
              },
              required: ['name', 'value'],
            },
          },
        },
        required: ['cookies'],
      },
      run: async ({ crewId }, a) => {
        const cookies = parseCookies(a['cookies'])
        const { context } = await current(crewId)
        await guard(context.addCookies(cookies), 'Setting cookies').catch(fail('Setting cookies'))
        return `Set ${cookies.length} cookie${cookies.length === 1 ? '' : 's'}: ${cookies.map((c) => c.name).join(', ')}`
      },
    },
    {
      name: 'browser_clear_storage',
      description:
        'Clears stored browser data. what: any of all, cookies, localStorage, sessionStorage, indexedDB, cacheStorage, serviceWorkers (default all). Web storage is cleared for the current page\'s site; cookies for the whole session, or only domain.',
      inputSchema: {
        type: 'object',
        properties: {
          what: { type: 'array', items: { type: 'string', enum: ['all', ...STORAGE_KINDS] } },
          domain: { type: 'string', description: 'Only clear cookies of this domain.' },
        },
      },
      run: async ({ crewId }, a) => {
        const kinds = parseStorageKinds(a['what'])
        const domain = strArg(a, 'domain')
        const { context, page } = await current(crewId)
        const done: string[] = []
        if (kinds.includes('cookies')) {
          await guard(context.clearCookies(domain ? { domain } : undefined), 'Clearing cookies').catch(fail('Clearing cookies'))
          done.push('cookies')
        }
        const web = kinds.filter((k) => k !== 'cookies')
        if (web.length > 0) {
          const res = await guard(page.evaluate(clearPageStorageJs(web)) as Promise<string[]>, 'Clearing storage').catch(fail('Clearing storage'))
          done.push(...res)
        }
        return done.length > 0 ? `Cleared: ${done.join(', ')}.` : 'Nothing was cleared (the page may not allow storage access).'
      },
    },
    {
      name: 'browser_emulate_device',
      description:
        'Emulates a device on the current tab: viewport size, pixel ratio, mobile mode, touch, user agent and dark/light colour scheme. preset: iphone, pixel, ipad, laptop, desktop, or reset to undo. Explicit fields override the preset.',
      inputSchema: {
        type: 'object',
        properties: {
          preset: { type: 'string', enum: [...Object.keys(DEVICE_PRESETS), 'reset'] },
          width: { type: 'number' },
          height: { type: 'number' },
          deviceScaleFactor: { type: 'number' },
          mobile: { type: 'boolean' },
          touch: { type: 'boolean' },
          userAgent: { type: 'string' },
          colorScheme: { type: 'string', enum: ['light', 'dark', 'none'] },
        },
      },
      run: async ({ crewId }, a) => {
        const plan = planEmulation(a)
        const { context, page } = await current(crewId)
        const session = await guard(sessionOf(context, page), 'Emulation').catch(fail('Emulation'))
        for (const c of plan.commands) await guard(session.send(c.method as never, c.params as never), 'Emulation').catch(fail('Emulation'))
        return plan.summary
      },
    },
    {
      name: 'browser_get_html',
      description:
        'Returns the HTML of the current page, or of the first element matching a CSS selector (outer HTML). Scripts, styles and comments are stripped unless keepScripts is true; password values are always blanked. Long output is truncated.',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string' },
          keepScripts: { type: 'boolean' },
          maxChars: { type: 'number', description: `Default ${TEXT_DEFAULT}, at most ${TEXT_MAX}.` },
        },
      },
      run: async ({ crewId }, a) => {
        const { page } = await current(crewId)
        const selector = strArg(a, 'selector')
        let html = selector
          ? await guard(page.locator(selector).first().evaluate('el => el.outerHTML', undefined, { timeout: STEP_MS }) as Promise<string>, 'Reading the element').catch(
              fail('Reading the element (check the selector)'),
            )
          : await guard(page.content(), 'Reading the page').catch(fail('Reading the page'))
        if (a['keepScripts'] !== true) html = stripScripts(html)
        return truncate(redactPasswordInputs(html), limitArg(a))
      },
    },
    {
      name: 'browser_get_page_text',
      description: 'Returns the visible text of the current page (or of the first element matching a CSS selector), with the URL and title. Cheaper than a snapshot when only the words matter.',
      inputSchema: {
        type: 'object',
        properties: { selector: { type: 'string' }, maxChars: { type: 'number', description: `Default ${TEXT_DEFAULT}, at most ${TEXT_MAX}.` } },
      },
      run: async ({ crewId }, a) => {
        const { page } = await current(crewId)
        const selector = strArg(a, 'selector')
        const text = selector
          ? await guard(page.locator(selector).first().innerText({ timeout: STEP_MS }), 'Reading the element').catch(fail('Reading the element (check the selector)'))
          : await guard(page.evaluate('document.body ? document.body.innerText : ""') as Promise<string>, 'Reading the page').catch(fail('Reading the page'))
        const title = await page.title().catch(() => '')
        return `URL: ${page.url()}\nTitle: ${title}\n\n${truncate(text, limitArg(a))}`
      },
    },
    {
      name: 'browser_navigate_forward',
      description: 'Goes forward in the current tab\'s history.',
      inputSchema: { type: 'object', properties: {} },
      run: async ({ crewId }) => {
        const { page } = await current(crewId)
        const r = await guard(page.goForward({ timeout: STEP_MS }), 'Going forward').catch(fail('Going forward'))
        return r ? `Went forward to ${page.url()}. Use browser_snapshot to see the page.` : 'There is no page to go forward to.'
      },
    },
    {
      name: 'browser_reload',
      description: 'Reloads the current tab. hard: true bypasses the cache.',
      inputSchema: { type: 'object', properties: { hard: { type: 'boolean' } } },
      run: async ({ crewId }, a) => {
        const { context, page } = await current(crewId)
        if (a['hard'] === true) {
          const session = await guard(sessionOf(context, page), 'Reloading').catch(fail('Reloading'))
          await guard(session.send('Page.reload' as never, { ignoreCache: true } as never), 'Reloading').catch(fail('Reloading'))
        } else await guard(page.reload({ timeout: STEP_MS }), 'Reloading').catch(fail('Reloading'))
        return `Reloaded ${page.url()}. Use browser_snapshot to see the page.`
      },
    },
    {
      name: 'browser_set_offline',
      description: "Turns the browser panel's network off (offline: true) or back on (offline: false) for all its tabs, including tabs opened later. Use it to test offline behaviour.",
      inputSchema: { type: 'object', properties: { offline: { type: 'boolean' } }, required: ['offline'] },
      run: async ({ crewId }, a) => {
        const value = a['offline']
        if (typeof value !== 'boolean') throw new ExtraError('offline must be true or false.')
        const { context } = await current(crewId)
        await guard(context.setOffline(value), 'Setting offline mode').catch(fail('Setting offline mode'))
        offline.set(crewId, value)
        return value ? 'The browser is offline.' : 'The browser is online again.'
      },
    },
    {
      name: 'browser_set_geolocation',
      description:
        'Overrides the location pages get from navigator.geolocation (latitude -90..90, longitude -180..180, optional accuracy in metres), or removes the override with clear: true. Pages also need the geolocation permission: call browser_grant_permissions with geolocation for the site.',
      inputSchema: {
        type: 'object',
        properties: { latitude: { type: 'number' }, longitude: { type: 'number' }, accuracy: { type: 'number' }, clear: { type: 'boolean' } },
      },
      run: async ({ crewId }, a) => {
        const geo = parseGeolocation(a)
        const { context } = await current(crewId)
        await guard(context.setGeolocation(geo), 'Setting the location').catch(fail('Setting the location'))
        return geo
          ? `Location set to ${geo.latitude}, ${geo.longitude}. Pages only see it once the geolocation permission is granted (browser_grant_permissions).`
          : 'Location override removed.'
      },
    },
    {
      name: 'browser_grant_permissions',
      description: `Grants site permissions without asking the user again (this needs the user's approval): permissions from ${GRANTABLE_PERMISSIONS.join(', ')}, for origin (default: the current tab's site). reset: true removes all grants made this way. Camera and microphone cannot be granted.`,
      inputSchema: {
        type: 'object',
        properties: {
          permissions: { type: 'array', items: { type: 'string', enum: [...GRANTABLE_PERMISSIONS] } },
          origin: { type: 'string', description: 'An http(s) URL or origin. Default: the current tab.' },
          reset: { type: 'boolean', description: 'Remove all grants instead of adding.' },
        },
      },
      run: async ({ crewId }, a) => {
        const perms = o.permissions
        if (!perms) throw new ExtraError('Granting permissions is not available.')
        if (a['reset'] === true) {
          perms.reset(crewId)
          return 'All permission grants were removed.'
        }
        const names = parsePermissions(a['permissions'])
        const origin = parseGrantOrigin(strArg(a, 'origin') ?? (await current(crewId)).page.url())
        perms.grant(crewId, origin, names)
        return `Granted ${names.join(', ')} to ${origin}. They answer without asking until reset.`
      },
    },
    {
      name: 'browser_set_compat',
      description:
        "Changes the project's real browser compatibility settings (they persist and show in Settings and the toolbar warning): relaxCors true makes every site answer cross-origin requests with permissive CORS headers, ignoreCertErrors on accepts every bad certificate, off refuses all, auto only accepts localhost, 127.0.0.1, *.test and *.local. Turning relaxCors or ignoreCertErrors on needs the user's approval. They stay until switched back.",
      inputSchema: {
        type: 'object',
        properties: { relaxCors: { type: 'boolean' }, ignoreCertErrors: { type: 'string', enum: ['auto', 'on', 'off'] } },
      },
      run: async ({ crewId }, a) => {
        const compat = o.compat
        if (!compat) throw new ExtraError('Changing compatibility settings is not available.')
        const patch = parseCompat(a)
        await compat.set(crewId, patch)
        return `Updated: ${describeCompat(compat.get(crewId))}`
      },
    },
    {
      name: 'browser_list_downloads',
      description: 'Lists the files the browser panel downloaded for this project: id, filename, url (host and path), size, mime, state (progressing, completed, cancelled, interrupted) and savedAt.',
      inputSchema: { type: 'object', properties: {} },
      run: ({ crewId }) => {
        if (!o.downloads) throw new ExtraError('Downloads are not available.')
        return describeDownloads(o.downloads.list(crewId))
      },
    },
    {
      name: 'browser_read_download',
      description: `Reads a completed download by id (from browser_list_downloads): text files come back as text (maxChars default ${TEXT_DEFAULT}, at most ${TEXT_MAX}); binary files as size, sha256 and the first 64 bytes in hex.`,
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, maxChars: { type: 'number', description: `Default ${TEXT_DEFAULT}, at most ${TEXT_MAX}.` } },
        required: ['id'],
      },
      run: async ({ crewId }, a) => {
        if (!o.downloads) throw new ExtraError('Downloads are not available.')
        const id = strArg(a, 'id')
        if (!id) throw new ExtraError('id is required.')
        const max = limitArg(a)
        const c = await o.downloads.read(crewId, id, max * 4 + 4).catch(fail('Reading the download'))
        if (!c) throw new ExtraError('No completed download with that id in this project. Use browser_list_downloads.')
        return describeDownloadRead(c, max)
      },
    },
    {
      name: 'browser_run_playwright_script',
      description:
        'Runs a multi-step Playwright script against the current page. script is the body of an async function with page, context, browser, console and sleep(ms) in scope (return a value to get it back), or a function like async (page) => {...}. Console output and errors are captured. Stops after timeoutMs (default 30000, max 120000). A failing or endless script cannot harm the browser.',
      inputSchema: {
        type: 'object',
        properties: { script: { type: 'string' }, timeoutMs: { type: 'number' } },
        required: ['script'],
      },
      run: async ({ crewId }, a, signal) => {
        const script = strArg(a, 'script')
        if (!script) throw new ExtraError('script is required.')
        if (script.length > 50_000) throw new ExtraError('The script is too long (50000 characters at most).')
        const endpoint = o.cdpEndpoint(crewId)
        if (!endpoint) throw new ExtraError('The browser is not available.')
        const st = o.hub.state(crewId)
        const active = st.tabs.find((t) => t.id === st.activeTabId)
        const run = o.runScript ?? runScriptInWorker
        const result = await run(
          {
            endpoint,
            playwrightPath: (o.playwrightPath ?? (() => req.resolve('playwright-core')))(),
            code: script,
            pageUrl: active?.url ?? null,
            timeoutMs: clampTimeout(a['timeoutMs'] ?? SCRIPT_DEFAULT_TIMEOUT_MS),
          },
          signal,
        )
        return redactSecrets(formatScriptResult(result), [endpoint])
      },
    },
  ]

  const drop = (crewId: number): void => {
    const p = conns.get(crewId)
    conns.delete(crewId)
    void p?.then((b) => b.close()).catch(() => undefined)
  }

  return {
    tools,
    dropCrew: (crewId) => {
      offline.delete(crewId)
      drop(crewId)
    },
    dispose() {
      for (const id of [...conns.keys()]) drop(id)
    },
  }
}
