import { writeFile } from 'node:fs/promises'
import { clipboard, ClipboardItem, dialog, nativeImage, session as electronSession, WebContentsView, type BrowserWindow, type NativeImage, type Session, type WebContents } from 'electron'
import type { BrowserHost, BrowserHub } from '../core/browser/hub'
import {
  nextZoom,
  partitionOf,
  toUrl,
  type BrowserAction,
  type BrowserCapture,
  type BrowserDevTools,
  type BrowserHistoryEntry,
  type BrowserNav,
  type BrowserRect,
  type BrowserState,
  type BrowserTab,
  type BrowserZoom,
} from '../shared/browser'
import type { CrewBrowserOptions } from '../shared/browser-compat'
import { encodeIpcError } from '../shared/ipc'
import { BrowserInspect } from './browser-inspect'
import { RefMemory, showAction } from './browser-overlay'
import type { BrowserPopout } from './browser-popout'
import { BrowserPrompts } from './browser-prompts'
import { configureSession, reapplySession } from './browser-session'
import { tabWebPreferences } from './browser-stealth'

interface Tab {
  id: number
  view: WebContentsView
  targetId: string
  // Set once the tab is known to the hub; events before that are ignored.
  ready: boolean
}

interface Panel {
  crewId: number
  session: Session
  tabs: Map<number, Tab>
  activeTabId: number | null
  // CSS px of the main window; null = hidden.
  rect: BrowserRect | null
}

export interface BrowserPanelsOptions {
  getWindow: () => BrowserWindow | null
  getHub: () => BrowserHub
  homeUrl: () => string
  searchUrl: () => string
  // The project's site compatibility options (certificates, CORS, proxy, headers, user agent).
  crewOptions: (crewId: number) => CrewBrowserOptions
  // Where the bookmarks file lives (under userData).
  dataDir: string
  // The pop-out windows, when the panel can leave the main window.
  popout?: BrowserPopout
}

const secureOf = (url: string): BrowserTab['secure'] => {
  try {
    const u = new URL(url)
    if (u.protocol === 'https:') return 'secure'
    if (u.protocol === 'http:') return /^(localhost|127\.|\[::1\])/i.test(u.host) ? 'local' : 'insecure'
  } catch {
    /* not a URL */
  }
  return 'unknown'
}

const fileStem = (title: string): string =>
  (title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 60) || 'page').replace(/\s+/g, '-')

// The visible area, or the whole page through the debugger (a short attach, like createTab's).
async function capturePng(wc: WebContents, fullPage: boolean): Promise<NativeImage> {
  if (!fullPage) return wc.capturePage()
  const own = !wc.debugger.isAttached()
  if (own) wc.debugger.attach('1.3')
  try {
    const m = (await wc.debugger.sendCommand('Page.getLayoutMetrics')) as { cssContentSize?: { width: number; height: number }; contentSize?: { width: number; height: number } }
    const size = m.cssContentSize ?? m.contentSize
    if (!size) return await wc.capturePage()
    const shot = (await wc.debugger.sendCommand('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      fromSurface: true,
      clip: { x: 0, y: 0, width: Math.ceil(size.width), height: Math.min(Math.ceil(size.height), 16000), scale: 1 },
    })) as { data: string }
    return nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64'))
  } finally {
    if (own && wc.debugger.isAttached()) wc.debugger.detach()
  }
}

// One WebContentsView per tab on a persistent per-project partition. The hub is told about every change; the
// user's mouse and keyboard reach the native view directly.
export class BrowserPanels implements BrowserHost {
  private readonly panels = new Map<number, Panel>()
  private nextTabId = 1
  private readonly configured = new WeakSet<Session>()
  // Page dialogs, permission questions, logins, certificate errors and downloads.
  readonly prompts = new BrowserPrompts()
  // Console and network log, emulation, cookies, site data and bookmarks.
  readonly inspect: BrowserInspect
  // Element refs from the AI's last snapshot per tab, so its clicks can be boxed on the right element.
  private readonly refs = new RefMemory()
  private readonly shownActions = new Map<number, number>()
  private readonly offActions: () => void

  constructor(private readonly o: BrowserPanelsOptions) {
    this.inspect = new BrowserInspect({ dir: o.dataDir, sessionOf: (id) => this.sessionOf(id) })
    this.offActions = this.hub.onActions((crewId, actions) => this.showAiActions(crewId, actions))
  }

  // The window that holds a project's views: its pop-out while popped out, else the main window.
  private hostWindow(crewId: number): BrowserWindow | null {
    const w = this.o.popout?.windowFor(crewId) ?? this.o.getWindow()
    return w && !w.isDestroyed() ? w : null
  }

  // webContents id of the window that hosts the project's views (browser:layout is only honoured from it).
  hostContentsId(crewId: number): number | null {
    return this.hostWindow(crewId)?.webContents.id ?? null
  }

  // The active tab's view, when it is on screen, so a pop-out can carry it across.
  shownViews(crewId: number): WebContentsView[] {
    const p = this.panels.get(crewId)
    const t = p && p.rect !== null && p.activeTabId !== null ? p.tabs.get(p.activeTabId) : undefined
    return t ? [t.view] : []
  }

  // The views moved to or from a pop-out window: the new host's renderer sends its own rect next.
  hostChanged(crewId: number): void {
    const p = this.panels.get(crewId)
    if (!p) return
    p.rect = null
    this.applyVisibility(p)
  }

  popOut(crewId: number): void {
    if (!this.o.popout) return
    if (!this.panels.get(crewId)?.tabs.size) throw new Error(encodeIpcError('BAD_ARGS', 'The browser is not open'))
    this.o.popout.open(crewId)
  }

  popIn(crewId: number): void {
    this.o.popout?.close(crewId)
  }

  // Feeds an AI snapshot's text to the ref memory of the project's active tab.
  learnRefs(crewId: number, text: string): void {
    const id = this.panels.get(crewId)?.activeTabId
    if (id !== null && id !== undefined) this.refs.learn(id, text)
  }

  // A running AI action that names an element is boxed on the page, with the cursor gliding to it.
  private showAiActions(crewId: number, actions: BrowserAction[]): void {
    const seen = this.shownActions.get(crewId) ?? 0
    let top = seen
    for (const a of actions) {
      if (a.id <= seen) continue
      top = Math.max(top, a.id)
      if (a.status !== 'running' || !a.target) continue
      const p = this.panels.get(crewId)
      const t = p && p.activeTabId !== null ? p.tabs.get(p.activeTabId) : undefined
      if (!p || !t || !t.ready || p.rect === null || t.view.webContents.isDestroyed()) continue
      const wc = t.view.webContents
      const hints = this.refs.hints(t.id)
      const end = a.tool === 'browser_drag' ? a.endTarget : undefined
      void showAction(wc, a.target, a.summary, hints).then(() => (end ? showAction(wc, end, '', hints) : undefined))
    }
    if (top > seen) this.shownActions.set(crewId, top)
  }

  private get hub(): BrowserHub {
    return this.o.getHub()
  }

  crewIds(): number[] {
    return [...this.panels.keys()]
  }

  // Settings changed: every open project's session picks up its new compatibility options.
  reapplySessions(): void {
    for (const p of this.panels.values()) reapplySession(p.session)
  }

  private sessionOf(crewId: number): Session {
    const ses = electronSession.fromPartition(partitionOf(crewId))
    if (!this.configured.has(ses)) {
      this.configured.add(ses)
      // Pages may ask for some permissions; the prompts layer asks the user, or refuses the ones that are never allowed.
      this.prompts.attachSession(crewId, ses)
      configureSession(ses, crewId, this.o.crewOptions)
    }
    return ses
  }

  private panel(crewId: number): Panel {
    let p = this.panels.get(crewId)
    if (!p) {
      p = { crewId, session: this.sessionOf(crewId), tabs: new Map(), activeTabId: null, rect: null }
      this.panels.set(crewId, p)
    }
    return p
  }

  private tab(crewId: number, tabId: number): Tab {
    const t = this.panels.get(crewId)?.tabs.get(tabId)
    if (!t) throw new Error(encodeIpcError('NOT_FOUND', `Browser tab ${String(tabId)} not found`))
    return t
  }

  // ---- BrowserHost (core calls these) ----

  async ensureOpen(crewId: number): Promise<void> {
    const p = this.panel(crewId)
    if (p.tabs.size === 0) await this.createTab(p, this.o.homeUrl())
    else this.hub.setOpen(crewId, true)
  }

  async newTab(crewId: number, url: string): Promise<{ tabId: number; targetId: string }> {
    const t = await this.createTab(this.panel(crewId), url)
    return { tabId: t.id, targetId: t.targetId }
  }

  closeTab(crewId: number, tabId: number): void {
    const p = this.panels.get(crewId)
    const t = p?.tabs.get(tabId)
    if (p && t) this.removeTab(p, t)
  }

  // Closes the tab's window for real (an opener sees popup.closed) and forgets it. Safe to call twice.
  private removeTab(p: Panel, t: Tab): void {
    const crewId = p.crewId
    const tabId = t.id
    if (p.tabs.get(tabId) !== t) return
    p.tabs.delete(tabId)
    this.inspect.detachTab(crewId, tabId)
    this.refs.forget(tabId)
    this.destroyView(crewId, t)
    this.hub.tabClosed(crewId, tabId)
    if (p.activeTabId === tabId) {
      p.activeTabId = [...p.tabs.keys()].at(-1) ?? null
      this.hub.setActiveTab(crewId, p.activeTabId)
    }
    if (p.tabs.size === 0) this.hub.setOpen(crewId, false)
    this.applyVisibility(p)
  }

  selectTab(crewId: number, tabId: number): void {
    const p = this.panels.get(crewId)
    if (!p || !p.tabs.has(tabId)) return
    p.activeTabId = tabId
    this.hub.setActiveTab(crewId, tabId)
    this.applyVisibility(p)
  }

  // ---- IPC side ----

  state(crewId: number): BrowserState {
    return this.stateOf(crewId)
  }

  // The hub's state plus whether the panel sits in its own window.
  stateOf(crewId: number): BrowserState {
    return { ...this.hub.state(crewId), poppedOut: this.o.popout?.isOut(crewId) === true }
  }

  async open(crewId: number, url?: string): Promise<BrowserState> {
    const p = this.panel(crewId)
    const target = url === undefined ? null : toUrl(url, this.o.searchUrl())
    if (url !== undefined && target === null) throw new Error(encodeIpcError('BAD_ARGS', 'That address cannot be opened'))
    if (p.tabs.size === 0) await this.createTab(p, target ?? this.o.homeUrl())
    else if (target) await this.createTab(p, target)
    else this.hub.setOpen(crewId, true)
    return this.stateOf(crewId)
  }

  // The user closed the tile: views go, the partition stays.
  close(crewId: number): void {
    const p = this.panels.get(crewId)
    if (!p) return
    const tabs = [...p.tabs.values()]
    p.tabs.clear()
    for (const t of tabs) {
      this.inspect.detachTab(crewId, t.id)
      this.refs.forget(t.id)
      this.destroyView(crewId, t)
    }
    p.activeTabId = null
    this.hub.setOpen(crewId, false)
  }

  layout(crewId: number, rect: BrowserRect | null): void {
    const p = this.panels.get(crewId)
    if (!p) return
    p.rect = rect && rect.w > 0 && rect.h > 0 ? rect : null
    this.applyVisibility(p)
  }

  // Re-places the active view, for example after the window zoom changed.
  relayout(): void {
    for (const p of this.panels.values()) this.applyVisibility(p)
  }

  async navigate(crewId: number, tabId: number, input: string): Promise<void> {
    const url = toUrl(input, this.o.searchUrl())
    if (url === null) throw new Error(encodeIpcError('BAD_ARGS', 'That address cannot be opened'))
    await this.load(this.tab(crewId, tabId), url)
  }

  nav(crewId: number, tabId: number, action: BrowserNav): void {
    const wc = this.tab(crewId, tabId).view.webContents
    if (action === 'back') wc.navigationHistory.goBack()
    else if (action === 'forward') wc.navigationHistory.goForward()
    else if (action === 'reload') wc.reload()
    else if (action === 'hardReload') wc.reloadIgnoringCache()
    else wc.stop()
  }

  async tabNew(crewId: number, url?: string): Promise<number> {
    const target = url === undefined ? this.o.homeUrl() : toUrl(url, this.o.searchUrl())
    if (target === null) throw new Error(encodeIpcError('BAD_ARGS', 'That address cannot be opened'))
    return (await this.createTab(this.panel(crewId), target)).id
  }

  // ---- human browser tools ----

  history(crewId: number): BrowserHistoryEntry[] {
    return this.hub.history(crewId)
  }

  tabMove(crewId: number, tabId: number, to: number): void {
    if (!Number.isInteger(to)) return
    this.hub.moveTab(crewId, tabId, to)
  }

  async tabDuplicate(crewId: number, tabId: number): Promise<number> {
    const src = this.tab(crewId, tabId)
    const url = src.view.webContents.getURL() || this.o.homeUrl()
    const ids = this.hub.state(crewId).tabs.map((t) => t.id)
    const copy = await this.createTab(this.panel(crewId), url)
    this.hub.moveTab(crewId, copy.id, ids.indexOf(tabId) + 1)
    return copy.id
  }

  devtools(crewId: number, tabId: number, mode: BrowserDevTools): void {
    const wc = this.tab(crewId, tabId).view.webContents
    if (wc.isDevToolsOpened()) wc.closeDevTools()
    if (mode !== 'close') wc.openDevTools({ mode: mode === 'dock' ? 'right' : 'detach', activate: true })
  }

  zoom(crewId: number, tabId: number, action: BrowserZoom): void {
    const t = this.tab(crewId, tabId)
    const wc = t.view.webContents
    wc.setZoomFactor(nextZoom(Math.round(wc.getZoomFactor() * 100), action) / 100)
    this.refresh(crewId, t)
  }

  find(crewId: number, tabId: number, text: string, forward: boolean, next: boolean): void {
    const wc = this.tab(crewId, tabId).view.webContents
    if (!text) {
      wc.stopFindInPage('clearSelection')
      this.hub.setFound({ crewId, tabId, active: 0, matches: 0 })
      return
    }
    // Electron's findNext means "start a new find session": true for a new term, false to step to the next match.
    wc.findInPage(text, { forward, findNext: !next })
  }

  findStop(crewId: number, tabId: number): void {
    this.tab(crewId, tabId).view.webContents.stopFindInPage('clearSelection')
  }

  // view-source: is not a typeable address (toUrl refuses it), so it is opened here, for web pages only.
  async viewSource(crewId: number, tabId: number): Promise<number> {
    const url = this.tab(crewId, tabId).view.webContents.getURL()
    if (!/^https?:\/\//i.test(url)) throw new Error(encodeIpcError('BAD_ARGS', 'Only web pages have a source to view'))
    return (await this.createTab(this.panel(crewId), `view-source:${url}`)).id
  }

  print(crewId: number, tabId: number): void {
    this.tab(crewId, tabId).view.webContents.print({ printBackground: true })
  }

  async savePdf(crewId: number, tabId: number): Promise<string | null> {
    const wc = this.tab(crewId, tabId).view.webContents
    const file = await this.saveAs(`${fileStem(wc.getTitle())}.pdf`, 'PDF', 'pdf')
    if (!file) return null
    await writeFile(file, await wc.printToPDF({ printBackground: true }))
    return file
  }

  async capture(crewId: number, tabId: number, opts: BrowserCapture): Promise<string | null> {
    const wc = this.tab(crewId, tabId).view.webContents
    const img = await capturePng(wc, opts.fullPage === true)
    if (opts.to === 'clipboard') {
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(img.toPNG())], { type: 'image/png' }) })])
      return null
    }
    const file = await this.saveAs(`${fileStem(wc.getTitle())}.png`, 'PNG image', 'png')
    if (!file) return null
    await writeFile(file, img.toPNG())
    return file
  }

  private async saveAs(defaultPath: string, label: string, ext: string): Promise<string | null> {
    const win = this.o.getWindow()
    const opts = { defaultPath, filters: [{ name: label, extensions: [ext] }] }
    const r = win && !win.isDestroyed() ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    return r.canceled || !r.filePath ? null : r.filePath
  }

  async clearData(crewId: number): Promise<{ cookies: number }> {
    return this.inspect.clearAll(crewId)
  }

  // The project was deleted: drop its views and its stored data.
  async destroyCrew(crewId: number): Promise<void> {
    this.close(crewId)
    this.popIn(crewId)
    this.panels.delete(crewId)
    this.shownActions.delete(crewId)
    this.prompts.forgetCrew(crewId)
    this.inspect.forgetCrew(crewId)
    try {
      await this.clearData(crewId)
    } catch {
      /* partition already gone */
    }
  }

  dispose(): void {
    this.offActions()
    for (const id of [...this.panels.keys()]) {
      const p = this.panels.get(id)
      if (p) for (const t of p.tabs.values()) this.destroyView(id, t)
    }
    this.panels.clear()
    this.inspect.dispose()
    this.prompts.dispose()
  }

  // ---- views ----

  private async load(t: Tab, url: string): Promise<void> {
    try {
      await t.view.webContents.loadURL(url)
    } catch {
      // A failed or superseded load shows in the tab (title, loading flag); nothing to report.
    }
  }

  private async createTab(p: Panel, url: string): Promise<Tab> {
    const view = new WebContentsView({ webPreferences: tabWebPreferences(p.session, url) })
    const wc = view.webContents
    const id = this.nextTabId++
    const tab: Tab = { id, view, targetId: '', ready: false }

    // The target id and the partition's browser context id, from a short debugger attach.
    let contextId: string | null = null
    try {
      wc.debugger.attach('1.3')
      const info = (await wc.debugger.sendCommand('Target.getTargetInfo')) as { targetInfo?: { targetId?: string; browserContextId?: string } }
      tab.targetId = info.targetInfo?.targetId ?? ''
      contextId = info.targetInfo?.browserContextId ?? null
    } finally {
      if (wc.debugger.isAttached()) wc.debugger.detach()
    }
    if (!tab.targetId) {
      this.destroyView(p.crewId, tab)
      throw new Error(encodeIpcError('INTERNAL', 'Could not open a browser tab'))
    }

    this.register(p, tab, url, contextId)
    void this.load(tab, url)
    return tab
  }

  // Makes a tab known to the panel and the hub (and so to the AI's browser endpoint) and the active one.
  private register(p: Panel, tab: Tab, url: string, contextId: string | null): void {
    this.wire(p.crewId, tab)
    p.tabs.set(tab.id, tab)
    p.activeTabId = tab.id
    if (contextId) this.hub.setContextId(p.crewId, contextId)
    this.hub.tabOpened(p.crewId, this.snapshot(tab, url), tab.targetId)
    this.hub.setActiveTab(p.crewId, tab.id)
    tab.ready = true
    // After the short attach has been let go; the log shares the debugger with the prompts.
    void this.inspect.attachTab(p.crewId, tab.id, tab.view.webContents)
    this.applyVisibility(p)
  }

  // A page-made window (window.open, target=_blank): the window keeps its opener and becomes a tab once its target id is known.
  private popupTab(p: Panel, url: string, options: unknown): WebContents {
    const given = (options as { webContents?: WebContents }).webContents
    const view = new WebContentsView(given ? { webContents: given } : { webPreferences: tabWebPreferences(p.session, url) })
    const wc = view.webContents
    const tab: Tab = { id: this.nextTabId++, view, targetId: '', ready: false }
    void (async () => {
      let contextId: string | null = null
      try {
        wc.debugger.attach('1.3')
        const info = (await wc.debugger.sendCommand('Target.getTargetInfo')) as { targetInfo?: { targetId?: string; browserContextId?: string } }
        tab.targetId = info.targetInfo?.targetId ?? ''
        contextId = info.targetInfo?.browserContextId ?? null
      } catch {
        /* closed before it could be read */
      } finally {
        if (!wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach()
      }
      if (!tab.targetId || wc.isDestroyed() || this.panels.get(p.crewId) !== p) {
        this.destroyView(p.crewId, tab)
        return
      }
      this.register(p, tab, url, contextId)
    })()
    return wc
  }

  private snapshot(t: Tab, url?: string): BrowserTab {
    const wc = t.view.webContents
    const h = wc.navigationHistory
    const current = url ?? wc.getURL()
    return {
      id: t.id,
      url: current,
      title: wc.getTitle() || current,
      loading: wc.isLoading(),
      canGoBack: h.canGoBack(),
      canGoForward: h.canGoForward(),
      secure: secureOf(current),
      zoom: Math.round(wc.getZoomFactor() * 100),
    }
  }

  private refresh(crewId: number, t: Tab): void {
    if (!t.ready || t.view.webContents.isDestroyed()) return
    const { id: _id, ...patch } = this.snapshot(t)
    this.hub.tabUpdated(crewId, t.id, patch)
  }

  private wire(crewId: number, t: Tab): void {
    const wc = t.view.webContents
    this.prompts.attachTab(crewId, t.id, wc)
    const update = () => this.refresh(crewId, t)
    for (const ev of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated'] as const) {
      wc.on(ev as 'did-navigate', update)
    }
    wc.on('did-navigate', (_e, url) => {
      if (t.ready) this.hub.recordVisit(crewId, url, wc.getTitle())
    })
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (t.ready && isMainFrame) this.hub.recordVisit(crewId, url, wc.getTitle())
    })
    wc.on('page-title-updated', (_e, title) => {
      if (t.ready) this.hub.retitleVisit(crewId, wc.getURL(), title)
    })
    wc.on('found-in-page', (_e, r) => {
      this.hub.setFound({ crewId, tabId: t.id, active: r.activeMatchOrdinal, matches: r.matches })
    })
    wc.once('destroyed', () => {
      const p = this.panels.get(crewId)
      if (p) this.removeTab(p, t)
    })
    // Links that want a new window become a tab that keeps its opener; the app window never gets one.
    wc.setWindowOpenHandler(({ url }) => {
      const target = url === '' ? 'about:blank' : toUrl(url, this.o.searchUrl())
      if (!target || (target !== 'about:blank' && !/^https?:/i.test(target))) return { action: 'deny' }
      return { action: 'allow', createWindow: (options) => this.popupTab(this.panel(crewId), target, options) }
    })
  }

  private destroyView(crewId: number, t: Tab): void {
    const win = this.hostWindow(crewId)
    try {
      if (win && !win.isDestroyed()) win.contentView.removeChildView(t.view)
    } catch {
      /* not attached */
    }
    // A destroyed view has no webContents any more.
    const wc = t.view.webContents as WebContents | undefined
    if (wc && !wc.isDestroyed()) wc.close()
  }

  // Shows only the active tab of a panel that has a rect; every other view of the panel is detached.
  private applyVisibility(p: Panel): void {
    const win = this.hostWindow(p.crewId)
    if (!win) return
    const zoom = win.webContents.getZoomFactor()
    for (const t of p.tabs.values()) {
      const show = p.rect !== null && t.id === p.activeTabId
      if (show && p.rect) {
        t.view.setBounds({
          x: Math.round(p.rect.x * zoom),
          y: Math.round(p.rect.y * zoom),
          width: Math.max(1, Math.round(p.rect.w * zoom)),
          height: Math.max(1, Math.round(p.rect.h * zoom)),
        })
        win.contentView.addChildView(t.view)
        t.view.setVisible(true)
      } else {
        t.view.setVisible(false)
        try {
          win.contentView.removeChildView(t.view)
        } catch {
          /* not attached */
        }
      }
    }
  }
}
