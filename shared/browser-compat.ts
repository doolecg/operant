// Per-project real-world site compatibility options of the embedded browser, and their pure helpers. No Electron here.

export type CertMode = 'auto' | 'on' | 'off'
export type BrowserAutonomy = 'full' | 'confirm'

export interface BrowserHeader {
  name: string
  value: string
}

export interface CrewBrowserOptions {
  ignoreCertErrors: CertMode
  relaxCors: boolean
  proxy: string
  headers: BrowserHeader[]
  userAgent: string
}

export const DEFAULT_CREW_BROWSER: CrewBrowserOptions = {
  ignoreCertErrors: 'auto',
  relaxCors: false,
  proxy: '',
  headers: [],
  userAgent: '',
}

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/
// Headers a page must not be able to forge through the settings (hop-by-hop and framing).
const BLOCKED_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding'])
const PROXY_RE = /^(?:(?:https?|socks[45]?):\/\/)?[^\s/]+(?::\d{1,5})?$|^direct:\/\/$/i

export function sanitizeCrewBrowser(raw: unknown): CrewBrowserOptions {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const d = DEFAULT_CREW_BROWSER
  const proxy = typeof r.proxy === 'string' ? r.proxy.trim().slice(0, 300) : ''
  const headers: BrowserHeader[] = []
  if (Array.isArray(r.headers)) {
    for (const h of r.headers) {
      if (!h || typeof h !== 'object') continue
      const name = typeof (h as BrowserHeader).name === 'string' ? (h as BrowserHeader).name.trim() : ''
      const value = typeof (h as BrowserHeader).value === 'string' ? (h as BrowserHeader).value.replace(/[\r\n]/g, '').slice(0, 2000) : ''
      if (!HEADER_NAME.test(name) || BLOCKED_HEADERS.has(name.toLowerCase())) continue
      headers.push({ name, value })
      if (headers.length >= 20) break
    }
  }
  return {
    ignoreCertErrors: r.ignoreCertErrors === 'on' || r.ignoreCertErrors === 'off' || r.ignoreCertErrors === 'auto' ? r.ignoreCertErrors : d.ignoreCertErrors,
    relaxCors: r.relaxCors === true,
    proxy: PROXY_RE.test(proxy) ? proxy : '',
    headers,
    userAgent: typeof r.userAgent === 'string' ? r.userAgent.replace(/[\r\n]/g, '').trim().slice(0, 500) : d.userAgent,
  }
}

export function sanitizePerCrew(raw: unknown): Record<string, CrewBrowserOptions> {
  const out: Record<string, CrewBrowserOptions> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [k, v] of Object.entries(raw)) {
    if (/^\d{1,9}$/.test(k)) out[k] = sanitizeCrewBrowser(v)
  }
  return out
}

// Hosts where a self-signed certificate and mixed content are expected: localhost, loopback, *.test, *.local.
export function isLocalDevHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!h) return false
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost') || h.endsWith('.test') || h.endsWith('.local')
}

export function shouldIgnoreCertError(mode: CertMode, hostname: string): boolean {
  if (mode === 'on') return true
  if (mode === 'off') return false
  return isLocalDevHost(hostname)
}

// The default Electron user agent minus the "Electron/x" and app-name tokens, so sites see plain Chrome.
export function cleanUserAgent(ua: string, appName = ''): string {
  let out = ua.replace(/\s*Electron\/\S+/gi, '')
  const names = new Set([appName, 'Operant', 'Operant2', 'operant2'].filter(Boolean))
  for (const n of names) out = out.replace(new RegExp(`\\s*${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/\\S+`, 'gi'), '')
  return out.replace(/\s{2,}/g, ' ').trim()
}

// Permissive CORS response headers for one response; echoes the request origin so credentials work.
export function corsResponseHeaders(origin: string | undefined, requestHeaders: string | undefined): Record<string, string[]> {
  const o = origin && origin !== 'null' ? origin : '*'
  const out: Record<string, string[]> = {
    'Access-Control-Allow-Origin': [o],
    'Access-Control-Allow-Methods': ['GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD'],
    'Access-Control-Allow-Headers': [requestHeaders && requestHeaders.trim() ? requestHeaders : '*'],
    'Access-Control-Expose-Headers': ['*'],
    'Access-Control-Max-Age': ['600'],
  }
  if (o !== '*') {
    out['Access-Control-Allow-Credentials'] = ['true']
    out.Vary = ['Origin']
  }
  return out
}

// Merges added headers into a response header map, replacing any existing header of the same name (case-insensitive).
export function mergeResponseHeaders(existing: Record<string, string[]> | undefined, add: Record<string, string[]>): Record<string, string[]> {
  const addLower = new Set(Object.keys(add).map((k) => k.toLowerCase()))
  const out: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(existing ?? {})) if (!addLower.has(k.toLowerCase())) out[k] = v
  return { ...out, ...add }
}

// Electron proxyRules value for a proxy setting; '' means no proxy.
export function proxyConfig(proxy: string): { mode: 'direct' } | { mode: 'fixed_servers'; proxyRules: string } {
  const p = proxy.trim()
  return p && p !== 'direct://' ? { mode: 'fixed_servers', proxyRules: p } : { mode: 'direct' }
}

// What the toolbar should warn about for a crew: relaxed CORS, or certificate errors ignored for every host.
export function compatWarnings(o: CrewBrowserOptions): { relaxCors: boolean; ignoreCerts: boolean } {
  return { relaxCors: o.relaxCors, ignoreCerts: o.ignoreCertErrors === 'on' }
}
