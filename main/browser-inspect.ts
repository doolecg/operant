import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Session, WebContents } from 'electron'
import {
  addBookmark,
  clipText,
  cookieKey,
  cookiesForOrigin,
  cookieUrl,
  DEFAULT_EMULATION,
  editBookmark,
  emulationPlan,
  normalizeEmulation,
  originOf,
  parseBookmarks,
  pushRing,
  removeBookmark,
  validateCookieDraft,
  type Bookmark,
  type ClearResult,
  type ConsoleEntry,
  type ConsoleLevel,
  type CookieDraft,
  type CookieInfo,
  type CookieKey,
  type Emulation,
  type InspectLogs,
  type NetEntry,
} from '../shared/browser-inspect'
import { encodeIpcError } from '../shared/ipc'
import { debugClient, type DebugClient } from './browser-debugger'

export interface BrowserInspectOptions {
  // Where bookmarks are kept (browser-bookmarks.json); created when missing.
  dir: string
  // The project's browser session, for cookies and storage.
  sessionOf: (crewId: number) => Session
  now?: () => number
}

interface TabLogs {
  crewId: number
  tabId: number
  wc: WebContents
  console: ConsoleEntry[]
  net: NetEntry[]
  // Requests still in flight: the entry (already in `net`), when it started (debugger clock, seconds), redirect hops so far.
  pending: Map<string, { entry: NetEntry; start: number; hop: number }>
  emulation: Emulation
  dbg: DebugClient
  dirty: boolean
  timer: ReturnType<typeof setTimeout> | null
  off: () => void
}

type Params = Record<string, unknown>

const CONSOLE_LEVEL: Record<string, ConsoleLevel> = { log: 'log', info: 'info', debug: 'debug', warning: 'warn', error: 'error', assert: 'error', trace: 'debug' }
const PENDING_MAX = 1000
const PUSH_MS = 150

const isObj = (v: unknown): v is Params => typeof v === 'object' && v !== null

// A console argument as text. Objects arrive as a preview or description, never as a dump of the live object.
function argText(a: unknown): string {
  if (!isObj(a)) return ''
  if (a.value !== undefined) return typeof a.value === 'string' ? a.value : JSON.stringify(a.value) ?? String(a.value)
  if (typeof a.unserializableValue === 'string') return a.unserializableValue
  if (typeof a.description === 'string') return a.description
  return typeof a.type === 'string' ? a.type : ''
}

// Each tab gets a debugger attach (shared with the prompts, see browser-debugger.ts) that stays for the tab's life (so the console and network are captured with
// DevTools closed). It coexists with Playwright's remote debugging connection and with the DevTools window.
// Logs hold no request or response headers, bodies or cookies. Cookie values travel to the renderer only on request
// (the panel masks them) and are never logged.
export class BrowserInspect {
  private readonly tabs = new Map<string, TabLogs>()
  private readonly logListeners = new Set<(crewId: number, tabId: number) => void>()
  private readonly bookmarkListeners = new Set<(crewId: number, list: Bookmark[]) => void>()
  private books: Record<string, Bookmark[]> | null = null
  private writing: Promise<void> = Promise.resolve()
  private readonly file: string

  constructor(private readonly o: BrowserInspectOptions) {
    this.file = join(o.dir, 'browser-bookmarks.json')
  }

  private now(): number {
    return (this.o.now ?? Date.now)()
  }

  // ---- logs and emulation ----

  // Starts capturing a tab. Never throws: a tab without a log still works. Call it after the tab's short
  // Target.getTargetInfo attach has been detached.
  async attachTab(crewId: number, tabId: number, wc: WebContents): Promise<void> {
    this.detachTab(crewId, tabId)
    const dbg = debugClient(wc)
    const t: TabLogs = { crewId, tabId, wc, console: [], net: [], pending: new Map(), emulation: { ...DEFAULT_EMULATION }, dbg, dirty: false, timer: null, off: () => undefined }
    this.tabs.set(this.k(crewId, tabId), t)
    const offMessage = dbg.onMessage((method, params) => this.onMessage(t, method, params))
    // Runs on every fresh attachment (also after DevTools or a crash took the debugger away): domains on, emulation back.
    const offAttach = dbg.onAttach(async () => {
      await Promise.all([this.send(t, 'Runtime.enable'), this.send(t, 'Network.enable'), this.send(t, 'Log.enable')])
      if (JSON.stringify(t.emulation) !== JSON.stringify(DEFAULT_EMULATION)) await this.applyEmulation(t)
    })
    const onDestroyed = () => this.detachTab(crewId, tabId)
    wc.once('destroyed', onDestroyed)
    t.off = () => {
      offMessage()
      offAttach()
      if (!wc.isDestroyed()) wc.removeListener('destroyed', onDestroyed)
    }
    await dbg.ensure()
  }

  detachTab(crewId: number, tabId: number): void {
    const key = this.k(crewId, tabId)
    const t = this.tabs.get(key)
    if (!t) return
    this.tabs.delete(key)
    if (t.timer) clearTimeout(t.timer)
    t.off()
    t.dbg.release()
  }

  detachCrew(crewId: number): void {
    for (const t of [...this.tabs.values()]) if (t.crewId === crewId) this.detachTab(crewId, t.tabId)
  }

  dispose(): void {
    for (const t of [...this.tabs.values()]) this.detachTab(t.crewId, t.tabId)
    this.logListeners.clear()
    this.bookmarkListeners.clear()
  }

  logs(crewId: number, tabId: number): InspectLogs {
    const t = this.tabs.get(this.k(crewId, tabId))
    return { console: t ? t.console.map((e) => ({ ...e })) : [], net: t ? t.net.map((e) => ({ ...e })) : [] }
  }

  clearLogs(crewId: number, tabId: number, which: 'console' | 'net' | 'both' = 'both'): void {
    const t = this.tabs.get(this.k(crewId, tabId))
    if (!t) return
    if (which !== 'net') t.console.length = 0
    if (which !== 'console') {
      t.net.length = 0
      t.pending.clear()
    }
    this.touch(t)
  }

  // Calls back (coalesced) when a tab's logs changed; the callback is expected to push 'browser:inspect:logs'.
  onLogs(cb: (crewId: number, tabId: number) => void): () => void {
    this.logListeners.add(cb)
    return () => this.logListeners.delete(cb)
  }

  emulation(crewId: number, tabId: number): Emulation {
    return { ...(this.tabs.get(this.k(crewId, tabId))?.emulation ?? DEFAULT_EMULATION) }
  }

  async setEmulation(crewId: number, tabId: number, input: Emulation): Promise<Emulation> {
    const t = this.tab(crewId, tabId)
    t.emulation = normalizeEmulation(input)
    if (!(await t.dbg.ensure())) throw new Error(encodeIpcError('INTERNAL', 'The page cannot be inspected right now'))
    await this.applyEmulation(t)
    return { ...t.emulation }
  }

  private tab(crewId: number, tabId: number): TabLogs {
    const t = this.tabs.get(this.k(crewId, tabId))
    if (!t) throw new Error(encodeIpcError('NOT_FOUND', `Browser tab ${String(tabId)} not found`))
    return t
  }

  private k(crewId: number, tabId: number): string {
    return `${String(crewId)}:${String(tabId)}`
  }

  // Straight to the attached debugger (callers ensure the attachment first).
  private async send(t: TabLogs, method: string, params?: Params): Promise<unknown> {
    return t.wc.debugger.sendCommand(method, params)
  }

  private async applyEmulation(t: TabLogs): Promise<void> {
    const p = emulationPlan(t.emulation)
    if (p.metrics) {
      await this.send(t, 'Emulation.setDeviceMetricsOverride', { ...p.metrics, screenWidth: p.metrics.width, screenHeight: p.metrics.height })
      await this.send(t, 'Emulation.setTouchEmulationEnabled', { enabled: p.metrics.mobile })
    } else {
      await this.send(t, 'Emulation.clearDeviceMetricsOverride')
      await this.send(t, 'Emulation.setTouchEmulationEnabled', { enabled: false })
    }
    await this.send(t, 'Emulation.setUserAgentOverride', { userAgent: p.userAgent })
    await this.send(t, 'Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: p.colorScheme }] })
    await this.send(t, 'Network.emulateNetworkConditions', p.network)
  }

  private touch(t: TabLogs): void {
    t.dirty = true
    if (t.timer || this.logListeners.size === 0) return
    t.timer = setTimeout(() => {
      t.timer = null
      if (!t.dirty) return
      t.dirty = false
      for (const cb of this.logListeners) cb(t.crewId, t.tabId)
    }, PUSH_MS)
  }

  private onMessage(t: TabLogs, method: string, p: Params): void {
    switch (method) {
      case 'Runtime.consoleAPICalled': {
        const args = Array.isArray(p.args) ? p.args : []
        const frame = isObj(p.stackTrace) && Array.isArray(p.stackTrace.callFrames) && isObj(p.stackTrace.callFrames[0]) ? p.stackTrace.callFrames[0] : null
        const entry: ConsoleEntry = { at: this.now(), level: CONSOLE_LEVEL[String(p.type)] ?? 'log', text: clipText(args.map(argText).join(' ')) }
        if (frame && typeof frame.url === 'string' && frame.url) entry.url = frame.url
        if (frame && typeof frame.lineNumber === 'number') entry.line = frame.lineNumber + 1
        pushRing(t.console, entry)
        break
      }
      case 'Runtime.exceptionThrown': {
        const d = isObj(p.exceptionDetails) ? p.exceptionDetails : {}
        const ex = isObj(d.exception) ? d.exception : {}
        const entry: ConsoleEntry = { at: this.now(), level: 'error', text: clipText(typeof ex.description === 'string' ? ex.description : String(d.text ?? 'Uncaught error')) }
        if (typeof d.url === 'string' && d.url) entry.url = d.url
        if (typeof d.lineNumber === 'number') entry.line = d.lineNumber + 1
        pushRing(t.console, entry)
        break
      }
      case 'Log.entryAdded': {
        // The page's own console calls arrive through Runtime; this is what the browser itself reports.
        const e = isObj(p.entry) ? p.entry : {}
        if (e.source === 'console-api') return
        const entry: ConsoleEntry = { at: this.now(), level: e.level === 'error' ? 'error' : e.level === 'warning' ? 'warn' : e.level === 'verbose' ? 'debug' : 'info', text: clipText(String(e.text ?? '')) }
        if (typeof e.url === 'string' && e.url) entry.url = e.url
        if (typeof e.lineNumber === 'number') entry.line = e.lineNumber + 1
        pushRing(t.console, entry)
        break
      }
      case 'Network.requestWillBeSent': {
        const req = isObj(p.request) ? p.request : {}
        const url = String(req.url ?? '')
        const id = String(p.requestId ?? '')
        if (!id || url.startsWith('data:')) return
        const prev = t.pending.get(id)
        // A redirect: the earlier hop gets the redirect's status, the next hop is a new row.
        if (prev && isObj(p.redirectResponse)) {
          if (typeof p.redirectResponse.status === 'number') prev.entry.status = p.redirectResponse.status
          prev.entry.durationMs = Math.max(0, (Number(p.timestamp) - prev.start) * 1000)
        }
        const hop = prev ? prev.hop + 1 : 0
        const entry: NetEntry = {
          id: hop > 0 ? `${id}#${String(hop)}` : id,
          at: typeof p.wallTime === 'number' ? Math.round(p.wallTime * 1000) : this.now(),
          method: String(req.method ?? 'GET'),
          url: clipText(url),
          type: String(p.type ?? 'other').toLowerCase(),
        }
        pushRing(t.net, entry)
        if (t.pending.size >= PENDING_MAX) t.pending.delete(t.pending.keys().next().value as string)
        t.pending.set(id, { entry, start: Number(p.timestamp), hop })
        break
      }
      case 'Network.responseReceived': {
        const cur = t.pending.get(String(p.requestId))
        const r = isObj(p.response) ? p.response : {}
        if (!cur) return
        if (typeof r.status === 'number') cur.entry.status = r.status
        if (typeof p.type === 'string') cur.entry.type = p.type.toLowerCase()
        break
      }
      case 'Network.loadingFinished': {
        const id = String(p.requestId)
        const cur = t.pending.get(id)
        if (!cur) return
        cur.entry.durationMs = Math.max(0, (Number(p.timestamp) - cur.start) * 1000)
        if (typeof p.encodedDataLength === 'number') cur.entry.size = p.encodedDataLength
        t.pending.delete(id)
        break
      }
      case 'Network.loadingFailed': {
        const id = String(p.requestId)
        const cur = t.pending.get(id)
        if (!cur) return
        cur.entry.error = p.canceled === true ? 'canceled' : String(p.errorText ?? 'failed')
        cur.entry.durationMs = Math.max(0, (Number(p.timestamp) - cur.start) * 1000)
        t.pending.delete(id)
        break
      }
      default:
        return
    }
    this.touch(t)
  }

  // ---- cookies and site data ----

  async cookies(crewId: number, url?: string): Promise<CookieInfo[]> {
    const ses = this.o.sessionOf(crewId)
    const list = await ses.cookies.get(url ? { url } : {})
    return list.map((c) => {
      const out: CookieInfo = {
        name: c.name,
        value: c.value,
        domain: c.domain ?? '',
        path: c.path ?? '/',
        secure: c.secure === true,
        httpOnly: c.httpOnly === true,
        sameSite: c.sameSite ?? 'unspecified',
      }
      if (!c.session && typeof c.expirationDate === 'number') out.expires = c.expirationDate
      return out
    })
  }

  // Saves a cookie. When `replacing` names another cookie (the editor changed the name, domain or path), that one is
  // removed after the new one is set.
  async setCookie(crewId: number, draft: CookieDraft, replacing?: CookieKey): Promise<void> {
    const bad = validateCookieDraft(draft)
    if (bad) throw new Error(encodeIpcError('BAD_ARGS', bad))
    const ses = this.o.sessionOf(crewId)
    const domain = draft.domain.trim()
    try {
      await ses.cookies.set({
        url: cookieUrl({ domain, path: draft.path, secure: draft.secure }),
        name: draft.name,
        value: draft.value,
        // A leading dot keeps the cookie a domain cookie; without one it is host-only.
        ...(domain.startsWith('.') ? { domain } : {}),
        path: draft.path,
        secure: draft.secure,
        httpOnly: draft.httpOnly,
        sameSite: draft.sameSite,
        ...(draft.expires != null ? { expirationDate: draft.expires } : {}),
      })
    } catch (e) {
      throw new Error(encodeIpcError('BAD_ARGS', e instanceof Error ? e.message.replace(draft.value, '…') : 'The cookie was refused'))
    }
    if (replacing && cookieKey(replacing) !== cookieKey({ name: draft.name, domain, path: draft.path })) await this.removeCookie(crewId, replacing)
  }

  async removeCookie(crewId: number, key: CookieKey): Promise<void> {
    await this.o.sessionOf(crewId).cookies.remove(cookieUrl({ domain: key.domain, path: key.path, secure: key.secure }), key.name)
  }

  // Cookies, storage and cache of one origin. Electron cannot empty the HTTP cache per origin, so that part is the
  // session-wide cache (it only costs a reload).
  async clearSite(crewId: number, origin: string): Promise<ClearResult> {
    const o = originOf(origin)
    if (!o) throw new Error(encodeIpcError('BAD_ARGS', 'Only web sites have data to clear'))
    const ses = this.o.sessionOf(crewId)
    const mine = cookiesForOrigin(await this.cookies(crewId), o)
    for (const c of mine) await this.removeCookie(crewId, c).catch(() => undefined)
    await ses.clearStorageData({ origin: o })
    await ses.clearCache()
    return { cookies: mine.length }
  }

  async clearAll(crewId: number): Promise<ClearResult> {
    const ses = this.o.sessionOf(crewId)
    const cookies = (await ses.cookies.get({})).length
    await ses.clearStorageData()
    await ses.clearCache()
    return { cookies }
  }

  // ---- bookmarks ----

  private load(): Record<string, Bookmark[]> {
    if (this.books) return this.books
    const out: Record<string, Bookmark[]> = {}
    try {
      if (existsSync(this.file)) {
        const raw: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
        if (isObj(raw)) for (const [k, v] of Object.entries(raw)) out[k] = parseBookmarks(v)
      }
    } catch {
      /* unreadable file: start empty, the next save replaces it */
    }
    this.books = out
    return out
  }

  private save(crewId: number, list: readonly Bookmark[]): Bookmark[] {
    const all = this.load()
    const next = [...list]
    if (next.length > 0) all[String(crewId)] = next
    else delete all[String(crewId)]
    const body = JSON.stringify(all, null, 2)
    this.writing = this.writing
      .then(async () => {
        mkdirSync(this.o.dir, { recursive: true })
        const tmp = `${this.file}.tmp`
        await writeFile(tmp, body, 'utf8')
        // On Windows a rename over the file can fail for a moment (virus scanner, indexer, a reader); try again, then
        // write the file in place so the change is never lost.
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            await rename(tmp, this.file)
            return
          } catch {
            await new Promise((r) => setTimeout(r, 20 * (attempt + 1)))
          }
        }
        await writeFile(this.file, body, 'utf8')
        await rm(tmp, { force: true })
      })
      .catch(() => undefined)
    for (const cb of this.bookmarkListeners) cb(crewId, [...next])
    return next
  }

  bookmarks(crewId: number): Bookmark[] {
    return [...(this.load()[String(crewId)] ?? [])]
  }

  addBookmark(crewId: number, url: string, title: string): Bookmark[] {
    const cur = this.bookmarks(crewId)
    const next = addBookmark(cur, { id: randomUUID(), url, title, at: this.now() })
    if (next === cur) {
      if (originOf(url) === null) throw new Error(encodeIpcError('BAD_ARGS', 'Only web pages can be bookmarked'))
      return cur
    }
    return this.save(crewId, next)
  }

  editBookmark(crewId: number, id: string, patch: { url?: string; title?: string }): Bookmark[] {
    return this.save(crewId, editBookmark(this.bookmarks(crewId), id, patch))
  }

  removeBookmark(crewId: number, id: string): Bookmark[] {
    return this.save(crewId, removeBookmark(this.bookmarks(crewId), id))
  }

  // Resolves when every bookmark change so far is on disk.
  flush(): Promise<void> {
    return this.writing
  }

  // Calls back with the project's new list after every change; the callback is expected to push 'browser:bookmarks'.
  onBookmarks(cb: (crewId: number, list: Bookmark[]) => void): () => void {
    this.bookmarkListeners.add(cb)
    return () => this.bookmarkListeners.delete(cb)
  }

  // The project was deleted: its logs and bookmarks go.
  forgetCrew(crewId: number): void {
    this.detachCrew(crewId)
    if (this.load()[String(crewId)]) this.save(crewId, [])
  }
}
