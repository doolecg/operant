import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { app, shell, type DownloadItem, type Session, type WebContents } from 'electron'
import {
  capDownloads,
  certificateKey,
  isRiskyFile,
  originOf,
  permissionKey,
  permissionLabel,
  permissionPolicy,
  safeFileName,
  uniqueFileName,
  type BrowserDownload,
  type BrowserPrompt,
  type BrowserPromptAnswer,
  type BrowserPromptKind,
  type BrowserPromptsState,
} from '../shared/browser-prompts'
import type { DownloadContent, DownloadInfo } from '../core/browser/extras'
import { debugClient, type DebugClient } from './browser-debugger'

type NewPrompt = Omit<BrowserPrompt, 'id'>

interface Pending {
  prompt: BrowserPrompt
  // Requests for the same permission on the same tab share one question.
  dedupe?: string
  promise: Promise<BrowserPromptAnswer | null>
  // null = nobody answered (tab closed, page moved on, answered elsewhere).
  settle: (a: BrowserPromptAnswer | null) => void
}

interface TabRef {
  crewId: number
  tabId: number
  wc: WebContents
  dbg?: DebugClient
}

interface Tracked {
  dl: BrowserDownload
  item: DownloadItem
}

// What the AI tools may see of a download: kept per project (the panel's own list is shorter), in memory only.
interface DownloadRecord {
  info: DownloadInfo
  path: string
}

const DOWNLOAD_RECORDS_PER_CREW = 100

export interface BrowserPromptsOptions {
  downloadsDir?: () => string
}

// Hides prompt() from pages: Electron neither shows nor answers it, so it would freeze the page for good.
const PROMPT_GUARD = `(() => { try { Object.defineProperty(window, 'prompt', { value: function prompt() { return null }, configurable: true, writable: true }) } catch (e) {} })()`

const DIALOG_KINDS: ReadonlySet<string> = new Set<BrowserPromptKind>(['alert', 'confirm', 'prompt', 'beforeunload'])

// What the embedded browser asks the user, per project: page dialogs, permission requests, basic-auth logins,
// certificate errors, and downloads. Main (BrowserPanels) hands in tabs and sessions; the renderer answers by id.
// Nothing here is logged: passwords only travel from answer() to the login callback.
export class BrowserPrompts {
  private readonly tabs = new Map<number, TabRef>()
  private readonly pending = new Map<string, Pending>()
  private readonly downloads = new Map<string, Tracked>()
  private readonly order: string[] = []
  private readonly records = new Map<number, DownloadRecord[]>()
  private readonly reserved = new Set<string>()
  private readonly remembered = new Map<number, Map<string, boolean>>()
  // Grants the AI made for a project (browser_grant_permissions): origin|permission, in memory only.
  private readonly granted = new Map<number, Set<string>>()
  private readonly trustedCerts =new Map<number, Set<string>>()
  private readonly sessions = new WeakSet<Session>()
  private readonly listeners = new Set<(s: BrowserPromptsState) => void>()
  private nextId = 1
  private readonly downloadsDir: () => string
  private readonly onCertError: (...args: unknown[]) => void

  constructor(o: BrowserPromptsOptions = {}) {
    this.downloadsDir = o.downloadsDir ?? (() => app.getPath('downloads'))
    this.onCertError = (...args: unknown[]) => {
      const [event, wc, url, error, certificate, callback, isMainFrame] = args as [
        { preventDefault: () => void },
        WebContents,
        string,
        string,
        { fingerprint: string },
        (ok: boolean) => void,
        boolean,
      ]
      this.certificateError(event, wc, url, error, certificate.fingerprint, callback, isMainFrame)
    }
    // The compat rule (browser-session) accepts the hosts it covers before this fires; every other bad certificate lands here.
    app.on('certificate-error', this.onCertError as never)
  }

  // ---- state ----

  state(crewId: number): BrowserPromptsState {
    return {
      crewId,
      prompts: [...this.pending.values()].map((p) => p.prompt).filter((p) => p.crewId === crewId),
      downloads: this.order.map((id) => this.downloads.get(id)?.dl).filter((d): d is BrowserDownload => d !== undefined && d.crewId === crewId),
    }
  }

  // Called with a crew's state whenever its prompts or downloads change. Returns the unsubscribe function.
  onChange(cb: (s: BrowserPromptsState) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private emit(crewId: number): void {
    const s = this.state(crewId)
    for (const cb of this.listeners) cb(s)
  }

  // ---- wiring ----

  // Call from BrowserPanels.wire(), after createTab's short debugger attach has been detached.
  attachTab(crewId: number, tabId: number, wc: WebContents): void {
    const ref: TabRef = { crewId, tabId, wc }
    const wcId = wc.id
    this.tabs.set(wcId, ref)
    wc.once('destroyed', () => this.detachTab(wcId))

    // A page that moved on no longer wants the permission it asked for.
    wc.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) this.abortWhere((p) => p.prompt.tabId === tabId && p.prompt.crewId === crewId && p.prompt.kind === 'permission')
    })

    wc.on('login', (event, details, info, callback) => {
      event.preventDefault()
      void this.ask({
        crewId,
        tabId,
        kind: 'auth',
        origin: info.isProxy ? `proxy ${info.host}:${String(info.port)}` : originOf(details.url),
        realm: info.realm || undefined,
      }).then((a) => {
        if (a && typeof a.username === 'string') callback(a.username, a.password ?? '')
        else callback()
      })
    })

    this.watchDialogs(ref)
  }

  // Called with BrowserPanels.sessionOf's session; replaces its deny-everything permission handlers.
  attachSession(crewId: number, ses: Session): void {
    if (this.sessions.has(ses)) return
    this.sessions.add(ses)

    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      const ref = this.tabs.get(wc.id)
      const policy = permissionPolicy(permission)
      if (!ref || policy === 'deny') return callback(false)
      if (policy === 'allow') return callback(true)
      if (this.isGranted(crewId, originOf(details.requestingUrl || wc.getURL()), permission)) return callback(true)
      const mediaTypes = 'mediaTypes' in details && details.mediaTypes ? details.mediaTypes : []
      const origin = originOf(details.requestingUrl || wc.getURL())
      const key = permissionKey(origin, permission, mediaTypes)
      const known = this.remembered.get(crewId)?.get(key)
      if (known !== undefined) return callback(known)
      void this.ask(
        { crewId, tabId: ref.tabId, kind: 'permission', origin, permission, permissionLabel: permissionLabel(permission, mediaTypes) },
        `${String(ref.tabId)}|${key}`,
      ).then((a) => {
        const allow = a?.allow === true
        if (a && a.remember === true) {
          let m = this.remembered.get(crewId)
          if (!m) this.remembered.set(crewId, (m = new Map()))
          m.set(key, allow)
        }
        callback(allow)
      })
    })

    // Checks never ask: a remembered yes, or a permission that is always granted.
    ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
      const policy = permissionPolicy(permission)
      if (policy === 'allow') return true
      if (policy === 'deny') return false
      if (this.isGranted(crewId, originOf(requestingOrigin), permission)) return true
      const mediaTypes = 'mediaType' in details && details.mediaType && details.mediaType !== 'unknown' ? [details.mediaType] : []
      const m = this.remembered.get(crewId)
      return m?.get(permissionKey(originOf(requestingOrigin), permission, mediaTypes)) === true
    })

    ses.on('will-download', (_e, item) => this.download(crewId, item))
  }

  private isGranted(crewId: number, origin: string, permission: string): boolean {
    return this.granted.get(crewId)?.has(`${origin}|${permission}`) === true
  }

  // Answers these permissions for this origin without asking. Camera/microphone and never-allowed ones are ignored.
  grantPermissions(crewId: number, origin: string, permissions: readonly string[]): void {
    let set = this.granted.get(crewId)
    if (!set) this.granted.set(crewId, (set = new Set()))
    for (const p of permissions) if (p !== 'media' && permissionPolicy(p) === 'ask') set.add(`${origin}|${p}`)
  }

  resetGrants(crewId: number): void {
    this.granted.delete(crewId)
  }

  private detachTab(wcId: number): void {
    const ref = this.tabs.get(wcId)
    this.tabs.delete(wcId)
    ref?.dbg?.release()
    if (ref) this.abortWhere((p) => p.prompt.crewId === ref.crewId && p.prompt.tabId === ref.tabId)
  }

  // ---- asking ----

  private ask(prompt: NewPrompt, dedupe?: string): Promise<BrowserPromptAnswer | null> {
    if (dedupe) {
      for (const p of this.pending.values()) if (p.dedupe === dedupe) return p.promise
    }
    const id = `p${String(this.nextId++)}`
    let settle!: (a: BrowserPromptAnswer | null) => void
    const promise = new Promise<BrowserPromptAnswer | null>((resolve) => {
      settle = resolve
    })
    this.pending.set(id, { prompt: { ...prompt, id }, dedupe, promise, settle })
    this.emit(prompt.crewId)
    return promise
  }

  private drop(id: string, answer: BrowserPromptAnswer | null): void {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    p.settle(answer)
    this.emit(p.prompt.crewId)
  }

  private abortWhere(match: (p: Pending) => boolean): void {
    for (const [id, p] of [...this.pending]) if (match(p)) this.drop(id, null)
  }

  // The user's answer from the tile.
  answer(id: string, a: BrowserPromptAnswer): void {
    this.drop(id, a)
  }

  // ---- page dialogs ----

  // alert and confirm (and beforeunload, if the page raises one) reach us as Page.javascriptDialogOpening on our own
  // debugger session. Chromium shows its native box too; either side may answer, and Page.javascriptDialogClosed
  // clears our prompt when the AI (Playwright, on the remote-debugging port) or the native box answered first.
  private watchDialogs(ref: TabRef): void {
    const { wc, crewId, tabId } = ref
    let open: string | null = null
    const dbg = debugClient(wc)
    ref.dbg = dbg
    dbg.onMessage((method, params) => {
      if (method === 'Page.javascriptDialogOpening') {
        const type = typeof params.type === 'string' ? params.type : 'alert'
        if (!DIALOG_KINDS.has(type)) return
        const kind = type as BrowserPromptKind
        const promise = this.ask({
          crewId,
          tabId,
          kind,
          origin: originOf(typeof params.url === 'string' ? params.url : wc.getURL()),
          message: typeof params.message === 'string' ? params.message : '',
          defaultValue: typeof params.defaultPrompt === 'string' ? params.defaultPrompt : undefined,
        })
        open = [...this.pending.entries()].find(([, p]) => p.promise === promise)?.[0] ?? null
        void promise.then((a) => {
          if (!a || wc.isDestroyed() || !wc.debugger.isAttached()) return
          // Fails harmlessly when the AI or the native box answered first.
          void wc.debugger
            .sendCommand('Page.handleJavaScriptDialog', { accept: a.allow === true, promptText: a.value ?? '' })
            .catch(() => undefined)
        })
      } else if (method === 'Page.javascriptDialogClosed' && open) {
        const id = open
        open = null
        this.drop(id, null)
      }
    })
    // On every fresh attachment (the first, and after DevTools or a crash took the debugger away).
    dbg.onAttach(async () => {
      try {
        await wc.debugger.sendCommand('Page.enable')
        await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: PROMPT_GUARD, runImmediately: true })
      } catch {
        /* the page may be going away; dialogs just are not mirrored */
      }
    })
    void dbg.ensure()
  }

  // ---- certificates ----

  private certificateError(
    event: { preventDefault: () => void },
    wc: WebContents,
    url: string,
    error: string,
    fingerprint: string,
    callback: (ok: boolean) => void,
    isMainFrame: boolean,
  ): void {
    const ref = this.tabs.get(wc.id)
    if (!ref) return
    let host = ''
    try {
      host = new URL(url).hostname
    } catch {
      return
    }
    const key = certificateKey(host, fingerprint)
    // Once allowed, the same certificate on the same host is accepted for the rest of the session (subresources too).
    if (this.trustedCerts.get(ref.crewId)?.has(key)) {
      event.preventDefault()
      callback(true)
      return
    }
    // Only the page itself can be allowed by the user; a bad subresource keeps Chromium's refusal.
    if (!isMainFrame) return
    event.preventDefault()
    void this.ask({ crewId: ref.crewId, tabId: ref.tabId, kind: 'certificate', origin: originOf(url), message: error }, `${String(ref.tabId)}|cert|${key}`).then((a) => {
      const proceed = a?.proceed === true
      if (proceed) {
        let set = this.trustedCerts.get(ref.crewId)
        if (!set) this.trustedCerts.set(ref.crewId, (set = new Set()))
        set.add(key)
      }
      callback(proceed)
    })
  }

  // ---- downloads ----

  private download(crewId: number, item: DownloadItem): void {
    const dir = this.downloadsDir()
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      /* setSavePath fails below if it is unusable */
    }
    const filename = uniqueFileName(safeFileName(item.getFilename()), (n) => this.reserved.has(join(dir, n)) || existsSync(join(dir, n)))
    const path = join(dir, filename)
    this.reserved.add(path)
    item.setSavePath(path)

    const dl: BrowserDownload = {
      id: `d${String(this.nextId++)}`,
      crewId,
      url: item.getURL(),
      filename,
      path,
      state: 'progressing',
      received: 0,
      total: Math.max(0, item.getTotalBytes()),
    }
    const rec: DownloadRecord = {
      info: { id: dl.id, filename, url: dl.url, size: 0, mime: item.getMimeType() || null, state: 'progressing', savedAt: new Date().toISOString() },
      path,
    }
    this.record(crewId, rec)
    this.downloads.set(dl.id, { dl, item })
    this.order.unshift(dl.id)
    this.trim(crewId)
    this.emit(crewId)

    let last = 0
    item.on('updated', (_e, state) => {
      dl.received = item.getReceivedBytes()
      dl.total = Math.max(0, item.getTotalBytes())
      dl.state = state === 'interrupted' ? 'interrupted' : 'progressing'
      rec.info.state = dl.state
      rec.info.size = dl.received
      const now = Date.now()
      if (state === 'interrupted' || now - last >= 250) {
        last = now
        this.emit(crewId)
      }
    })
    item.once('done', (_e, state) => {
      dl.received = item.getReceivedBytes()
      dl.total = Math.max(dl.total, dl.received)
      dl.state = state
      rec.info.state = state
      rec.info.size = dl.received
      rec.info.savedAt = new Date().toISOString()
      this.reserved.delete(path)
      this.emit(crewId)
    })
  }

  private record(crewId: number, rec: DownloadRecord): void {
    let list = this.records.get(crewId)
    if (!list) this.records.set(crewId, (list = []))
    list.push(rec)
    if (list.length > DOWNLOAD_RECORDS_PER_CREW) list.splice(0, list.length - DOWNLOAD_RECORDS_PER_CREW)
  }

  // For the AI tools: this project's downloads, newest first. A download the user cancelled or refused is not completed.
  listDownloads(crewId: number): DownloadInfo[] {
    return [...(this.records.get(crewId) ?? [])].reverse().map((r) => ({ ...r.info }))
  }

  // For the AI tools: the start of a COMPLETED download of this project, only from the path the panel itself saved it to.
  async readDownload(crewId: number, id: string, maxBytes: number): Promise<DownloadContent | null> {
    const r = this.records.get(crewId)?.find((x) => x.info.id === id)
    if (!r || r.info.state !== 'completed' || !existsSync(r.path)) return null
    const sha256 = await new Promise<string>((resolve, reject) => {
      const h = createHash('sha256')
      createReadStream(r.path)
        .on('data', (c) => h.update(c))
        .on('error', reject)
        .on('end', () => resolve(h.digest('hex')))
    })
    const f = await open(r.path, 'r')
    try {
      const size = (await f.stat()).size
      const buf = Buffer.alloc(Math.min(size, Math.max(0, maxBytes)))
      const { bytesRead } = await f.read(buf, 0, buf.length, 0)
      return { info: { ...r.info }, head: buf.subarray(0, bytesRead), size, sha256 }
    } finally {
      await f.close()
    }
  }

  private trim(crewId: number): void {
    const mine = this.order.map((id) => this.downloads.get(id)?.dl).filter((d): d is BrowserDownload => d !== undefined && d.crewId === crewId)
    const keep = new Set(capDownloads(mine).map((d) => d.id))
    for (const d of mine) {
      if (keep.has(d.id)) continue
      this.downloads.delete(d.id)
      this.order.splice(this.order.indexOf(d.id), 1)
    }
  }

  cancelDownload(id: string): void {
    const t = this.downloads.get(id)
    if (t && t.dl.state === 'progressing') t.item.cancel()
  }

  // Opens a finished download with the system's default app. Programs and scripts are refused (false); the user can
  // still reveal them in the folder. Also false when the file is gone.
  async openDownload(id: string): Promise<boolean> {
    const d = this.downloads.get(id)?.dl
    if (!d || d.state !== 'completed' || isRiskyFile(d.filename) || !existsSync(d.path)) return false
    return (await shell.openPath(d.path)) === ''
  }

  showDownloadInFolder(id: string): void {
    const d = this.downloads.get(id)?.dl
    if (d && existsSync(d.path)) shell.showItemInFolder(d.path)
  }

  // A project was deleted: its prompts, remembered answers and download list go.
  forgetCrew(crewId: number): void {
    this.abortWhere((p) => p.prompt.crewId === crewId)
    this.remembered.delete(crewId)
    this.granted.delete(crewId)
    this.trustedCerts.delete(crewId)
    this.records.delete(crewId)
    for (const id of [...this.order]) {
      const t = this.downloads.get(id)
      if (t?.dl.crewId !== crewId) continue
      this.downloads.delete(id)
      this.order.splice(this.order.indexOf(id), 1)
    }
    this.emit(crewId)
  }

  dispose(): void {
    app.removeListener('certificate-error', this.onCertError as never)
    this.abortWhere(() => true)
    this.listeners.clear()
  }
}
