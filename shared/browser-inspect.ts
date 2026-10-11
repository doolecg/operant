// Types and pure helpers of the browser panel's inspector: console and network log, device emulation, cookies and
// bookmarks. No Electron here. Cookie values and URL query values are never put in a description meant for a log.
import { isHistoryUrl } from './browser'

// ---- logs ----

export type ConsoleLevel = 'debug' | 'log' | 'info' | 'warn' | 'error'
export const CONSOLE_LEVELS: readonly ConsoleLevel[] = ['debug', 'log', 'info', 'warn', 'error']

export interface ConsoleEntry {
  at: number
  level: ConsoleLevel
  text: string
  url?: string
  line?: number
}

export interface NetEntry {
  // The debugger's request id, with "#n" for the n-th redirect hop.
  id: string
  at: number
  method: string
  url: string
  status?: number
  // Resource type in lower case: document, xhr, fetch, script, stylesheet, image, ...
  type: string
  error?: string
  durationMs?: number
  // Transferred bytes.
  size?: number
}

export const LOG_MAX = 500
export const LOG_TEXT_MAX = 2000

// Appends to a ring buffer in place: the oldest entries fall off the front. Returns the same array.
export function pushRing<T>(buf: T[], item: T, max: number = LOG_MAX): T[] {
  buf.push(item)
  if (buf.length > max) buf.splice(0, buf.length - max)
  return buf
}

export const clipText = (s: string, max: number = LOG_TEXT_MAX): string => (s.length > max ? `${s.slice(0, max)}…` : s)

const matchesText = (hay: string, text: string): boolean => {
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const h = hay.toLowerCase()
  return words.every((w) => h.includes(w))
}

export interface ConsoleFilter {
  // Levels to show; empty or absent shows all.
  levels?: readonly ConsoleLevel[]
  text?: string
}

export function filterConsole(list: readonly ConsoleEntry[], f: ConsoleFilter): ConsoleEntry[] {
  const levels = f.levels && f.levels.length > 0 ? new Set(f.levels) : null
  return list.filter((e) => (!levels || levels.has(e.level)) && matchesText(`${e.text} ${e.url ?? ''}`, f.text ?? ''))
}

export type StatusFilter = 'all' | '2xx' | '3xx' | '4xx' | '5xx' | 'failed'
export const STATUS_FILTERS: readonly StatusFilter[] = ['all', '2xx', '3xx', '4xx', '5xx', 'failed']

// 'failed' = the request errored, or came back 400 and up.
export function statusClass(e: NetEntry): Exclude<StatusFilter, 'all'> | 'pending' {
  if (e.error) return 'failed'
  if (e.status === undefined) return 'pending'
  if (e.status >= 500) return '5xx'
  if (e.status >= 400) return '4xx'
  if (e.status >= 300) return '3xx'
  return '2xx'
}

export interface NetFilter {
  status?: StatusFilter
  text?: string
}

export function filterNet(list: readonly NetEntry[], f: NetFilter): NetEntry[] {
  const status = f.status ?? 'all'
  return list.filter((e) => {
    if (status !== 'all') {
      const c = statusClass(e)
      if (status === 'failed' ? !(c === 'failed' || c === '4xx' || c === '5xx') : c !== status) return false
    }
    return matchesText(`${e.method} ${e.url} ${e.type} ${e.status ?? ''}`, f.text ?? '')
  })
}

export function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} kB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return ''
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`
}

// A URL with its query and fragment values blanked, for anything that may end up in a log line.
export function redactUrl(url: string): string {
  try {
    const u = new URL(url)
    const q = [...u.searchParams.keys()].map((k) => `${k}=…`).join('&')
    return `${u.origin}${u.pathname}${q ? `?${q}` : ''}`
  } catch {
    return url.replace(/[?#].*$/, '')
  }
}

// ---- emulation ----

export type EmulationPreset = 'none' | 'mobile' | 'tablet' | 'desktop' | 'custom'
export type ColorScheme = 'system' | 'light' | 'dark'
export type Throttle = 'none' | 'fast3g' | 'slow3g' | 'offline'

export interface Emulation {
  preset: EmulationPreset
  // Custom size only; the other presets take theirs from DEVICE_PRESETS.
  width?: number
  height?: number
  deviceScaleFactor?: number
  mobile?: boolean
  // An empty or absent value keeps the preset's (or the session's) user agent.
  userAgent?: string
  colorScheme: ColorScheme
  throttle: Throttle
}

export const DEFAULT_EMULATION: Emulation = { preset: 'none', colorScheme: 'system', throttle: 'none' }

export interface DevicePreset {
  label: string
  width: number
  height: number
  deviceScaleFactor: number
  mobile: boolean
  userAgent?: string
}

export const DEVICE_PRESETS: Readonly<Record<'mobile' | 'tablet' | 'desktop', DevicePreset>> = {
  mobile: {
    label: 'Mobile (412 x 915)',
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  },
  tablet: {
    label: 'Tablet (820 x 1180)',
    width: 820,
    height: 1180,
    deviceScaleFactor: 2,
    mobile: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  },
  desktop: { label: 'Desktop (1280 x 800)', width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
}

export interface ThrottleProfile {
  label: string
  offline: boolean
  // ms of added latency; bytes per second, -1 = unlimited.
  latency: number
  downloadThroughput: number
  uploadThroughput: number
}

export const THROTTLE_PROFILES: Readonly<Record<Throttle, ThrottleProfile>> = {
  none: { label: 'No throttling', offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
  fast3g: { label: 'Fast 3G', offline: false, latency: 562.5, downloadThroughput: 188_743, uploadThroughput: 86_400 },
  slow3g: { label: 'Slow 3G', offline: false, latency: 2000, downloadThroughput: 46_080, uploadThroughput: 46_080 },
  offline: { label: 'Offline', offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
}

export const PRESET_LABELS: Readonly<Record<EmulationPreset, string>> = {
  none: 'Off (fit the panel)',
  mobile: DEVICE_PRESETS.mobile.label,
  tablet: DEVICE_PRESETS.tablet.label,
  desktop: DEVICE_PRESETS.desktop.label,
  custom: 'Custom size',
}

export const COLOR_SCHEME_LABELS: Readonly<Record<ColorScheme, string>> = { system: 'System', light: 'Light', dark: 'Dark' }

export const SIZE_MIN = 200
export const SIZE_MAX = 4000
export const SCALE_MIN = 0.5
export const SCALE_MAX = 4

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

// Anything that came over IPC becomes a valid Emulation: unknown values fall back to the defaults, sizes are clamped.
export function normalizeEmulation(raw: unknown): Emulation {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const preset = (['none', 'mobile', 'tablet', 'desktop', 'custom'] as const).find((p) => p === r.preset) ?? 'none'
  const colorScheme = (['system', 'light', 'dark'] as const).find((p) => p === r.colorScheme) ?? 'system'
  const throttle = (['none', 'fast3g', 'slow3g', 'offline'] as const).find((p) => p === r.throttle) ?? 'none'
  const out: Emulation = { preset, colorScheme, throttle }
  if (preset === 'custom') {
    out.width = clamp(Math.round(num(r.width) ?? 800), SIZE_MIN, SIZE_MAX)
    out.height = clamp(Math.round(num(r.height) ?? 600), SIZE_MIN, SIZE_MAX)
    out.deviceScaleFactor = clamp(num(r.deviceScaleFactor) ?? 1, SCALE_MIN, SCALE_MAX)
    out.mobile = r.mobile === true
  }
  if (typeof r.userAgent === 'string' && r.userAgent.trim() !== '') out.userAgent = r.userAgent.trim().replace(/[\u0000-\u001f]/g, '').slice(0, 512)
  return out
}

export const isDefaultEmulation = (e: Emulation): boolean => e.preset === 'none' && e.colorScheme === 'system' && e.throttle === 'none' && !e.userAgent

export interface EmulationPlan {
  // null = remove the override.
  metrics: { width: number; height: number; deviceScaleFactor: number; mobile: boolean } | null
  // '' = remove the override.
  userAgent: string
  // '' = follow the system.
  colorScheme: '' | 'light' | 'dark'
  network: { offline: boolean; latency: number; downloadThroughput: number; uploadThroughput: number }
}

// What to send to the page for an emulation setting.
export function emulationPlan(input: Emulation): EmulationPlan {
  const e = normalizeEmulation(input)
  let metrics: EmulationPlan['metrics'] = null
  let presetUa = ''
  if (e.preset === 'custom') {
    metrics = { width: e.width ?? 800, height: e.height ?? 600, deviceScaleFactor: e.deviceScaleFactor ?? 1, mobile: e.mobile === true }
  } else if (e.preset !== 'none') {
    const d = DEVICE_PRESETS[e.preset]
    metrics = { width: d.width, height: d.height, deviceScaleFactor: d.deviceScaleFactor, mobile: d.mobile }
    presetUa = d.userAgent ?? ''
  }
  const t = THROTTLE_PROFILES[e.throttle]
  return {
    metrics,
    userAgent: e.userAgent ?? presetUa,
    colorScheme: e.colorScheme === 'system' ? '' : e.colorScheme,
    network: { offline: t.offline, latency: t.latency, downloadThroughput: t.downloadThroughput, uploadThroughput: t.uploadThroughput },
  }
}

// One line for the toolbar badge, e.g. "Mobile (412 x 915) · Dark · Fast 3G"; '' when nothing is emulated.
export function describeEmulation(input: Emulation): string {
  const e = normalizeEmulation(input)
  const parts: string[] = []
  if (e.preset === 'custom') parts.push(`${e.width ?? 800} x ${e.height ?? 600}`)
  else if (e.preset !== 'none') parts.push(PRESET_LABELS[e.preset])
  if (e.userAgent) parts.push('Custom user agent')
  if (e.colorScheme !== 'system') parts.push(COLOR_SCHEME_LABELS[e.colorScheme])
  if (e.throttle !== 'none') parts.push(THROTTLE_PROFILES[e.throttle].label)
  return parts.join(' · ')
}

// ---- cookies ----

export interface CookieInfo {
  name: string
  value: string
  // As stored: a leading dot means the cookie also goes to subdomains.
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
  // Epoch seconds; absent for a session cookie.
  expires?: number
}

export interface CookieKey {
  name: string
  domain: string
  path: string
  secure?: boolean
}

// What the cookie editor saves.
export interface CookieDraft {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite: CookieInfo['sameSite']
  // Epoch seconds; absent or null = session cookie.
  expires?: number | null
}

export const MASKED_VALUE = '••••••••'

// The value is hidden unless the user asked to see it. The mask has a fixed length so it does not hint at the size.
export const maskValue = (value: string, reveal: boolean): string => (reveal ? value : value === '' ? '' : MASKED_VALUE)

export const cookieKey = (c: CookieKey): string => `${c.name}\u0000${c.domain}\u0000${c.path}`

export const bareDomain = (domain: string): string => domain.replace(/^\./, '').toLowerCase()

// The URL the cookie jar needs to set or remove a cookie.
export function cookieUrl(c: { domain: string; path: string; secure?: boolean }): string {
  const path = c.path.startsWith('/') ? c.path : `/${c.path}`
  return `${c.secure ? 'https' : 'http'}://${bareDomain(c.domain)}${path}`
}

// A line about a cookie that is safe to log: never the value.
export function describeCookie(c: CookieKey & Partial<Pick<CookieInfo, 'httpOnly' | 'sameSite' | 'expires'>>): string {
  const flags = [c.secure ? 'secure' : '', c.httpOnly ? 'httpOnly' : '', c.sameSite && c.sameSite !== 'unspecified' ? `sameSite=${c.sameSite}` : '', c.expires === undefined ? 'session' : 'persistent']
  return `${c.name} @ ${bareDomain(c.domain)}${c.path} [${flags.filter(Boolean).join(', ')}]`
}

export function originOf(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null
  } catch {
    return null
  }
}

// Whether a cookie goes to this host (exact domain, or a domain cookie of a parent).
export function cookieMatchesHost(c: Pick<CookieInfo, 'domain'>, host: string): boolean {
  const d = bareDomain(c.domain)
  const h = host.toLowerCase()
  return h === d || h.endsWith(`.${d}`)
}

export function cookiesForOrigin<T extends Pick<CookieInfo, 'domain'>>(list: readonly T[], origin: string): T[] {
  let host: string
  try {
    host = new URL(origin).hostname
  } catch {
    return []
  }
  return list.filter((c) => cookieMatchesHost(c, host))
}

// Search hits on the name and the domain only; the value is not searched, so a filter cannot be used to probe it.
export function filterCookies<T extends Pick<CookieInfo, 'name' | 'domain'>>(list: readonly T[], text: string): T[] {
  return list.filter((c) => matchesText(`${c.name} ${c.domain}`, text))
}

export function siteCount(list: readonly Pick<CookieInfo, 'domain'>[]): number {
  return new Set(list.map((c) => bareDomain(c.domain))).size
}

// Why a cookie draft cannot be saved, or null. Mirrors what the cookie jar refuses.
export function validateCookieDraft(d: CookieDraft): string | null {
  if (d.name.trim() === '') return 'A cookie needs a name'
  if (/[\s;=,\u0000-\u001f\u007f]/.test(d.name)) return 'The name cannot contain spaces, ; = , or control characters'
  if (/[;\u0000-\u001f\u007f]/.test(d.value)) return 'The value cannot contain ; or control characters'
  if (!/^\.?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(d.domain.trim()) && !/^\[[0-9a-f:]+\]$/i.test(d.domain.trim())) return 'Enter a domain such as example.com'
  if (!d.path.startsWith('/')) return 'The path must start with /'
  if (d.sameSite === 'no_restriction' && !d.secure) return 'SameSite=None needs Secure'
  if (d.expires != null && (!Number.isFinite(d.expires) || d.expires < 0)) return 'The expiry is not a valid time'
  return null
}

export const emptyCookieDraft = (domain = ''): CookieDraft => ({ name: '', value: '', domain, path: '/', secure: false, httpOnly: false, sameSite: 'unspecified', expires: null })

export const draftOfCookie = (c: CookieInfo): CookieDraft => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite, expires: c.expires ?? null })

// ---- bookmarks ----

export interface Bookmark {
  id: string
  url: string
  title: string
  at: number
}

export const BOOKMARK_MAX = 500

// The address without its fragment or a trailing slash, so a page counts as bookmarked however it was reached.
export const bookmarkKey = (url: string): string => url.replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase()

export const isBookmarkable = (url: string): boolean => isHistoryUrl(url)

export const findBookmark = (list: readonly Bookmark[], url: string): Bookmark | undefined => {
  const k = bookmarkKey(url)
  return list.find((b) => bookmarkKey(b.url) === k)
}

// Adds a bookmark at the front. A page that is already bookmarked is left alone (returns the same list).
export function addBookmark(list: readonly Bookmark[], b: Bookmark, max: number = BOOKMARK_MAX): readonly Bookmark[] {
  if (!isBookmarkable(b.url) || findBookmark(list, b.url)) return list
  return [{ ...b, title: b.title.trim() || b.url }, ...list].slice(0, max)
}

// Changes the title or address of one bookmark. An empty title falls back to the address; a bad address is ignored.
export function editBookmark(list: readonly Bookmark[], id: string, patch: { url?: string; title?: string }): readonly Bookmark[] {
  return list.map((b) => {
    if (b.id !== id) return b
    const url = patch.url !== undefined && isBookmarkable(patch.url.trim()) ? patch.url.trim() : b.url
    const title = patch.title !== undefined ? patch.title.trim() || url : b.title
    return { ...b, url, title }
  })
}

export const removeBookmark = (list: readonly Bookmark[], id: string): readonly Bookmark[] => list.filter((b) => b.id !== id)

// Reads a bookmark file's contents defensively; bad entries are dropped.
export function parseBookmarks(raw: unknown): Bookmark[] {
  if (!Array.isArray(raw)) return []
  const out: Bookmark[] = []
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue
    const o = x as Record<string, unknown>
    if (typeof o.id !== 'string' || typeof o.url !== 'string' || !isBookmarkable(o.url)) continue
    out.push({ id: o.id, url: o.url, title: typeof o.title === 'string' && o.title ? o.title : o.url, at: typeof o.at === 'number' ? o.at : 0 })
  }
  return out.slice(0, BOOKMARK_MAX)
}

// ---- IPC payloads ----

export interface InspectLogs {
  console: ConsoleEntry[]
  net: NetEntry[]
}

// Pushed (coalesced) when a tab's logs changed; the renderer invalidates its logs query.
export interface InspectLogsChanged {
  crewId: number
  tabId: number
}

export interface ClearResult {
  cookies: number
}
