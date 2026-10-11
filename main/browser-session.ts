import { app, type Session } from 'electron'
import {
  cleanUserAgent,
  corsResponseHeaders,
  isLocalDevHost,
  mergeResponseHeaders,
  proxyConfig,
  shouldIgnoreCertError,
  type CrewBrowserOptions,
} from '../shared/browser-compat'

type Getter = (crewId: number) => CrewBrowserOptions

interface Entry {
  crewId: number
  get: Getter
  applied: string
}

const entries = new WeakMap<Session, Entry>()
let baseUa: string | null = null

function realisticUa(ses: Session): string {
  baseUa ??= cleanUserAgent(ses.getUserAgent(), app.getName())
  return baseUa
}

// Applies the crew's compatibility options to its session now. Header values are never logged.
function apply(ses: Session, e: Entry): void {
  const o = e.get(e.crewId)
  const key = JSON.stringify(o)
  if (key === e.applied) return
  e.applied = key

  ses.setUserAgent(o.userAgent || realisticUa(ses))

  void ses.setProxy(proxyConfig(o.proxy)).catch(() => {})

  // A cert error on a host the rule covers is accepted; anything else keeps the normal verdict and error page.
  ses.setCertificateVerifyProc((req, cb) => {
    if (req.errorCode !== 0 && shouldIgnoreCertError(o.ignoreCertErrors, req.hostname)) cb(0)
    else cb(-3)
  })

  // Request headers are remembered per request id so the response hook can echo the origin and answer preflights.
  const seen = new Map<number, { origin?: string; reqHeaders?: string; preflight: boolean }>()
  if (o.headers.length > 0 || o.relaxCors) {
    ses.webRequest.onBeforeSendHeaders((details, cb) => {
      const requestHeaders = { ...details.requestHeaders }
      const find = (n: string) => Object.entries(requestHeaders).find(([k]) => k.toLowerCase() === n)?.[1]
      if (o.relaxCors) {
        if (seen.size > 2000) seen.clear()
        seen.set(details.id, { origin: find('origin'), reqHeaders: find('access-control-request-headers'), preflight: details.method === 'OPTIONS' && find('access-control-request-method') !== undefined })
      }
      for (const h of o.headers) {
        for (const k of Object.keys(requestHeaders)) if (k.toLowerCase() === h.name.toLowerCase()) delete requestHeaders[k]
        requestHeaders[h.name] = h.value
      }
      cb({ requestHeaders })
    })
  } else {
    ses.webRequest.onBeforeSendHeaders(null)
  }

  // Opt-in, per project, only for this session: answer preflights and add permissive CORS headers. Web security stays on.
  if (o.relaxCors) {
    ses.webRequest.onHeadersReceived((details, cb) => {
      const info = seen.get(details.id)
      seen.delete(details.id)
      const add = corsResponseHeaders(info?.origin, info?.reqHeaders)
      const responseHeaders = mergeResponseHeaders(details.responseHeaders, add)
      if (info?.preflight) cb({ responseHeaders, statusLine: 'HTTP/1.1 200 OK' })
      else cb({ responseHeaders })
    })
  } else {
    ses.webRequest.onHeadersReceived(null)
  }
}

// Call once per crew session (from BrowserPanels.sessionOf). Permission handlers stay with the caller.
export function configureSession(ses: Session, crewId: number, getCrewSettings: Getter): void {
  const e: Entry = { crewId, get: getCrewSettings, applied: '' }
  entries.set(ses, e)
  apply(ses, e)
}

// Call when the browser settings change; re-applies live to a session that configureSession set up.
export function reapplySession(ses: Session): void {
  const e = entries.get(ses)
  if (e) apply(ses, e)
}

// Mixed content (http subresources on an https page) is only allowed for local dev pages. The caller reads this
// when creating a tab's webPreferences.allowRunningInsecureContent.
export function allowInsecureContentFor(url: string): boolean {
  try {
    return isLocalDevHost(new URL(url).hostname)
  } catch {
    return false
  }
}
