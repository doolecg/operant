// Types and pure helpers of the embedded browser panel. No Electron here.
import type { BrowserAutonomy, CrewBrowserOptions } from './browser-compat'

export interface BrowserTab {
  id: number
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  secure: 'secure' | 'insecure' | 'local' | 'unknown'
  // Page zoom in percent; absent means 100.
  zoom?: number
}

// lastAction = tool name + short arg, never values typed.
export interface BrowserAi {
  active: boolean
  paused: boolean
  tileId: number | null
  lastAction: string | null
  at: number | null
}

export interface BrowserState {
  crewId: number
  open: boolean
  activeTabId: number | null
  tabs: BrowserTab[]
  ai: BrowserAi
  aiAllowed: boolean
  // The panel shows in its own window (pop-out).
  poppedOut?: boolean
}

// CSS px in the main window.
export interface BrowserRect {
  x: number
  y: number
  w: number
  h: number
}

export type BrowserNav = 'back' | 'forward' | 'reload' | 'hardReload' | 'stop'

export type BrowserZoom = 'in' | 'out' | 'reset'
export type BrowserDevTools = 'dock' | 'detach' | 'close'
export interface BrowserCapture {
  fullPage: boolean
  to: 'clipboard' | 'file'
}

// Find in page result, pushed while the user types in the find bar.
export interface BrowserFound {
  crewId: number
  tabId: number
  active: number
  matches: number
}

export interface BrowserHistoryEntry {
  url: string
  title: string
  visits: number
  at: number
}

export const HISTORY_MAX = 300
export const ZOOM_STEPS = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500]

// Next zoom percent for in/out/reset, snapping to the browser's usual steps.
export function nextZoom(current: number, action: BrowserZoom): number {
  if (action === 'reset') return 100
  if (action === 'in') return ZOOM_STEPS.find((z) => z > current) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]!
  return [...ZOOM_STEPS].reverse().find((z) => z < current) ?? ZOOM_STEPS[0]!
}

// Records a visit: the entry moves to the front, visits count up, the list stays capped. Returns a new list.
export function addVisit(list: readonly BrowserHistoryEntry[], url: string, title: string, at: number, max: number = HISTORY_MAX): BrowserHistoryEntry[] {
  const old = list.find((e) => e.url === url)
  const entry: BrowserHistoryEntry = { url, title: title || old?.title || url, visits: (old?.visits ?? 0) + 1, at }
  return [entry, ...list.filter((e) => e.url !== url)].slice(0, max)
}

// Only real web pages are worth remembering.
export const isHistoryUrl = (url: string): boolean => /^https?:\/\/\S+$/i.test(url)

// Suggestions for the address bar: every word of the query must appear in the URL or title; hits on the host or a
// URL prefix rank first, then more visits, then newer.
export function matchHistory(list: readonly BrowserHistoryEntry[], query: string, limit = 6): BrowserHistoryEntry[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const rank = (e: BrowserHistoryEntry): number => {
    const bare = e.url.toLowerCase().replace(/^https?:\/\/(www\.)?/, '')
    return bare.startsWith(words[0]!) ? 0 : bare.includes(words[0]!) ? 1 : 2
  }
  return list
    .filter((e) => {
      const hay = `${e.url} ${e.title}`.toLowerCase()
      return words.every((w) => hay.includes(w))
    })
    .sort((a, b) => rank(a) - rank(b) || b.visits - a.visits || b.at - a.at)
    .slice(0, limit)
}

// Index after moving the item at `from` so it lands where the tab at `to` was; clamps to the list.
export function moveInList<T>(list: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length) return [...list]
  const out = [...list]
  const [item] = out.splice(from, 1)
  out.splice(Math.max(0, Math.min(to, out.length)), 0, item as T)
  return out
}

// One AI browser call in the action log. summary = tool name + short target, never typed values, cookies or URL queries.
export type BrowserActionStatus = 'running' | 'done' | 'error' | 'refused' | 'interrupted'

export interface BrowserAction {
  id: number
  crewId: number
  at: number
  tileId: number
  tool: string
  summary: string
  status: BrowserActionStatus
  // The element ref or selector the call acted on (browser_drag: the start), for a highlight overlay.
  target?: string
  // browser_drag only: the drop target.
  endTarget?: string
}

export const ACTIONS_MAX = 200

// The AI wants to do something risky and waits for browser:confirmAnswer. summary never holds password values.
export interface BrowserConfirm {
  id: string
  crewId: number
  tileId: number
  tool: string
  summary: string
}

// A pending confirm is over (answered, timed out after 5 minutes, or the call was cancelled): hide its prompt.
export interface BrowserConfirmEnd {
  id: string
  crewId: number
  outcome: 'allowed' | 'denied' | 'timeout' | 'cancelled'
}

export interface BrowserSettings {
  aiControl: boolean
  homeUrl: string
  searchUrl: string
  // 'confirm': the AI asks before sensitive browser actions; 'full': it does not. The gate itself is wired elsewhere.
  autonomy: BrowserAutonomy
  // Keyed by crew id.
  perCrew: Record<string, CrewBrowserOptions>
}

export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = {
  aiControl: true,
  homeUrl: 'https://duckduckgo.com/',
  searchUrl: 'https://duckduckgo.com/?q=%s',
  autonomy: 'confirm',
  perCrew: {},
}

// One persistent session per project.
export const partitionOf = (crewId: number): string => `persist:browser-crew-${crewId}`

const SCHEME = /^([a-z][a-z0-9+.-]*):/i
const HOST_PORT = /^[^\s/?#:]+:\d{1,5}(?:[/?#]|$)/
const HOSTNAME = /^(?:localhost|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]{2,}|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\])(?::\d{1,5})?(?:[/?#].*)?$/i
const LOCAL = /^(?:localhost|127\.|\[::1\]|\d{1,3}(?:\.\d{1,3}){3})/i

// Turns address bar text into a URL to load, or null when it must be refused (javascript:, file:, data: and so on).
// Anything that does not look like an address becomes a search; searchUrl holds %s for the query.
export function toUrl(input: string, searchUrl: string = DEFAULT_BROWSER_SETTINGS.searchUrl): string | null {
  const text = input.trim()
  if (!text) return null
  const search = () => {
    const q = encodeURIComponent(text)
    return searchUrl.includes('%s') ? searchUrl.replace('%s', q) : searchUrl + q
  }
  if (/\s/.test(text)) return search()
  if (text === 'about:blank') return text
  const scheme = SCHEME.exec(text)
  // "host:port" parses as a scheme; treat it as an address.
  if (scheme && !HOST_PORT.test(text)) {
    const s = scheme[1]!.toLowerCase()
    return (s === 'http' || s === 'https') && /^[a-z]+:\/\/\S+$/i.test(text) ? text : null
  }
  if (HOSTNAME.test(text)) return `${LOCAL.test(text) ? 'http' : 'https'}://${text}`
  return search()
}
