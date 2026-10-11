import { ACTIONS_MAX, addVisit, isHistoryUrl, moveInList, type BrowserAction, type BrowserActionStatus, type BrowserAi, type BrowserFound, type BrowserHistoryEntry, type BrowserState, type BrowserTab } from '../../shared/browser'
import { ConfirmBroker } from './confirm'

// Implemented in main (BrowserPanels); core only sees this seam.
export interface BrowserHost {
  ensureOpen(crewId: number): Promise<void>
  newTab(crewId: number, url: string): Promise<{ tabId: number; targetId: string }>
  closeTab(crewId: number, tabId: number): void
  selectTab(crewId: number, tabId: number): void
}

export interface BrowserHubOptions {
  host: BrowserHost
  // Whether AI control is on (settings.browser.aiControl).
  aiAllowed?: () => boolean
  // How long the AI stays "active" after its last call ended.
  idleMs?: number
  now?: () => number
}

export type ResumeResult = 'resumed' | 'timeout' | 'aborted'

interface TabEntry {
  tab: BrowserTab
  targetId: string
}

interface CrewState {
  open: boolean
  tabs: Map<number, TabEntry>
  activeTabId: number | null
  contextId: string | null
  paused: boolean
  epoch: number
  busy: number
  active: boolean
  tileId: number | null
  lastAction: string | null
  at: number | null
  idleTimer: ReturnType<typeof setTimeout> | null
  history: BrowserHistoryEntry[]
  actions: BrowserAction[]
}

const IDLE_MS = 3000

// Per-project state of the browser panel, the AI activity on it, and Take control. Emits the whole
// BrowserState on every change; the panel (main) feeds it tab changes. No Electron, no polling.
export class BrowserHub {
  readonly host: BrowserHost
  // Approvals the AI is waiting for (autonomy 'confirm').
  readonly confirms: ConfirmBroker
  private actionSeq = 0
  private readonly crews = new Map<number, CrewState>()
  private readonly stateListeners = new Set<(s: BrowserState) => void>()
  private readonly controlListeners = new Set<(crewId: number, paused: boolean) => void>()
  private readonly historyListeners = new Set<(crewId: number, entries: BrowserHistoryEntry[]) => void>()
  private readonly foundListeners = new Set<(f: BrowserFound) => void>()
  private readonly actionListeners = new Set<(crewId: number, actions: BrowserAction[]) => void>()
  private readonly waiters = new Map<number, Set<() => void>>()
  private readonly aiAllowed: () => boolean
  private readonly idleMs: number
  private readonly now: () => number

  constructor(opts: BrowserHubOptions) {
    this.host = opts.host
    this.confirms = new ConfirmBroker()
    this.aiAllowed = opts.aiAllowed ?? (() => true)
    this.idleMs = opts.idleMs ?? IDLE_MS
    this.now = opts.now ?? Date.now
  }

  private crew(crewId: number): CrewState {
    let c = this.crews.get(crewId)
    if (!c) {
      c = {
        open: false,
        tabs: new Map(),
        activeTabId: null,
        contextId: null,
        paused: false,
        epoch: 0,
        busy: 0,
        active: false,
        tileId: null,
        lastAction: null,
        at: null,
        idleTimer: null,
        history: [],
        actions: [],
      }
      this.crews.set(crewId, c)
    }
    return c
  }

  state(crewId: number): BrowserState {
    const c = this.crew(crewId)
    const ai: BrowserAi = { active: c.active, paused: c.paused, tileId: c.tileId, lastAction: c.lastAction, at: c.at }
    return {
      crewId,
      open: c.open,
      activeTabId: c.activeTabId,
      tabs: [...c.tabs.values()].map((e) => ({ ...e.tab })),
      ai,
      aiAllowed: this.aiAllowed(),
    }
  }

  on(event: 'browser:state', cb: (s: BrowserState) => void): () => void {
    if (event !== 'browser:state') return () => {}
    this.stateListeners.add(cb)
    return () => this.stateListeners.delete(cb)
  }

  onHistory(cb: (crewId: number, entries: BrowserHistoryEntry[]) => void): () => void {
    this.historyListeners.add(cb)
    return () => this.historyListeners.delete(cb)
  }

  onActions(cb: (crewId: number, actions: BrowserAction[]) => void): () => void {
    this.actionListeners.add(cb)
    return () => this.actionListeners.delete(cb)
  }

  onFound(cb: (f: BrowserFound) => void): () => void {
    this.foundListeners.add(cb)
    return () => this.foundListeners.delete(cb)
  }

  // Fires when a crew is paused or resumed (the CDP proxy holds or releases its queue on this).
  onControl(cb: (crewId: number, paused: boolean) => void): () => void {
    this.controlListeners.add(cb)
    return () => this.controlListeners.delete(cb)
  }

  private emit(crewId: number): void {
    if (this.stateListeners.size === 0) return
    const s = this.state(crewId)
    for (const cb of this.stateListeners) cb(s)
  }

  // Re-pushes the state, for example after the AI control setting changed.
  refresh(crewId: number): void {
    this.emit(crewId)
  }

  // ---- Panel side (main feeds these) ----

  setOpen(crewId: number, open: boolean): void {
    const c = this.crew(crewId)
    if (c.open === open) return
    c.open = open
    if (!open) {
      c.tabs.clear()
      c.activeTabId = null
    }
    this.emit(crewId)
  }

  history(crewId: number): BrowserHistoryEntry[] {
    return [...this.crew(crewId).history]
  }

  clearHistory(crewId: number): void {
    const c = this.crew(crewId)
    if (c.history.length === 0) return
    c.history = []
    for (const cb of this.historyListeners) cb(crewId, [])
  }

  // A page was visited (main frame navigation); non-web URLs are ignored.
  recordVisit(crewId: number, url: string, title: string): void {
    if (!isHistoryUrl(url)) return
    const c = this.crew(crewId)
    c.history = addVisit(c.history, url, title, this.now())
    for (const cb of this.historyListeners) cb(crewId, [...c.history])
  }

  // The page title arrived after the visit was recorded.
  retitleVisit(crewId: number, url: string, title: string): void {
    const c = this.crew(crewId)
    const e = c.history.find((h) => h.url === url)
    if (!e || !title || e.title === title) return
    e.title = title
    for (const cb of this.historyListeners) cb(crewId, [...c.history])
  }

  setFound(f: BrowserFound): void {
    for (const cb of this.foundListeners) cb(f)
  }

  // Moves a tab so it lands at index `to` of the tab strip.
  moveTab(crewId: number, tabId: number, to: number): void {
    const c = this.crew(crewId)
    const entries = [...c.tabs.entries()]
    const from = entries.findIndex(([id]) => id === tabId)
    if (from < 0) return
    const next = moveInList(entries, from, to)
    if (next.every(([id], i) => id === entries[i]![0])) return
    c.tabs = new Map(next)
    this.emit(crewId)
  }

  setContextId(crewId: number, contextId: string | null): void {
    this.crew(crewId).contextId = contextId
  }

  tabOpened(crewId: number, tab: BrowserTab, targetId: string): void {
    const c = this.crew(crewId)
    c.tabs.set(tab.id, { tab: { ...tab }, targetId })
    c.open = true
    if (c.activeTabId === null) c.activeTabId = tab.id
    this.emit(crewId)
  }

  tabUpdated(crewId: number, tabId: number, patch: Partial<Omit<BrowserTab, 'id'>>): void {
    const e = this.crew(crewId).tabs.get(tabId)
    if (!e) return
    e.tab = { ...e.tab, ...patch }
    this.emit(crewId)
  }

  tabClosed(crewId: number, tabId: number): void {
    const c = this.crew(crewId)
    if (!c.tabs.delete(tabId)) return
    if (c.activeTabId === tabId) c.activeTabId = [...c.tabs.keys()].at(-1) ?? null
    this.emit(crewId)
  }

  setActiveTab(crewId: number, tabId: number | null): void {
    const c = this.crew(crewId)
    if (c.activeTabId === tabId) return
    c.activeTabId = tabId
    this.emit(crewId)
  }

  // ---- Proxy / gate side ----

  // The targetIds of the project's panel tabs: the only ones the AI may see.
  targets(crewId: number): ReadonlySet<string> {
    return new Set([...this.crew(crewId).tabs.values()].map((e) => e.targetId))
  }

  tabIdOf(crewId: number, targetId: string): number | null {
    for (const e of this.crew(crewId).tabs.values()) if (e.targetId === targetId) return e.tab.id
    return null
  }

  // The panel partition's browserContextId (null until the first tab exists).
  contextId(crewId: number): string | null {
    return this.crew(crewId).contextId
  }

  isPaused(crewId: number): boolean {
    return this.crew(crewId).paused
  }

  // Bumps on every pause, so a call can tell whether control was taken while it ran.
  pauseEpoch(crewId: number): number {
    return this.crew(crewId).epoch
  }

  setControl(crewId: number, who: 'user' | 'ai'): BrowserState {
    const c = this.crew(crewId)
    const paused = who === 'user'
    if (c.paused !== paused) {
      c.paused = paused
      if (paused) c.epoch++
      for (const cb of this.controlListeners) cb(crewId, paused)
      if (!paused) for (const w of [...(this.waiters.get(crewId) ?? [])]) w()
      this.emit(crewId)
    }
    return this.state(crewId)
  }

  // Resolves when the crew is not paused (at once if it is not), after timeoutMs, or when aborted.
  waitUntilResumed(crewId: number, timeoutMs: number, signal?: AbortSignal): Promise<ResumeResult> {
    if (!this.crew(crewId).paused) return Promise.resolve('resumed')
    if (signal?.aborted) return Promise.resolve('aborted')
    return new Promise<ResumeResult>((resolve) => {
      let set = this.waiters.get(crewId)
      if (!set) this.waiters.set(crewId, (set = new Set()))
      const waiters = set
      const finish = (r: ResumeResult) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        waiters.delete(onResume)
        resolve(r)
      }
      const onResume = () => finish('resumed')
      const onAbort = () => finish('aborted')
      const timer = setTimeout(() => finish('timeout'), timeoutMs)
      timer.unref?.()
      waiters.add(onResume)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  // lastAction is a tool name plus a short target, never typed values.
  aiBegin(crewId: number, tileId: number, action: string): void {
    const c = this.crew(crewId)
    c.busy++
    if (c.idleTimer) {
      clearTimeout(c.idleTimer)
      c.idleTimer = null
    }
    c.active = true
    c.tileId = tileId
    c.lastAction = action
    c.at = this.now()
    this.emit(crewId)
  }

  aiEnd(crewId: number): void {
    const c = this.crew(crewId)
    if (c.busy > 0) c.busy--
    if (c.busy > 0) return
    if (c.idleTimer) clearTimeout(c.idleTimer)
    c.idleTimer = setTimeout(() => {
      c.idleTimer = null
      c.active = false
      this.emit(crewId)
    }, this.idleMs)
    c.idleTimer.unref?.()
  }

  // ---- Action log: the last ACTIONS_MAX AI calls of a project, oldest first ----

  actions(crewId: number): BrowserAction[] {
    return this.crew(crewId).actions.map((a) => ({ ...a }))
  }

  private emitActions(crewId: number): void {
    if (this.actionListeners.size === 0) return
    const list = this.actions(crewId)
    for (const cb of this.actionListeners) cb(crewId, list)
  }

  actionBegin(crewId: number, a: { tileId: number; tool: string; summary: string; target?: string; endTarget?: string }): number {
    const c = this.crew(crewId)
    const id = ++this.actionSeq
    const entry: BrowserAction = { id, crewId, at: this.now(), tileId: a.tileId, tool: a.tool, summary: a.summary, status: 'running' }
    if (a.target) entry.target = a.target
    if (a.endTarget) entry.endTarget = a.endTarget
    c.actions.push(entry)
    if (c.actions.length > ACTIONS_MAX) c.actions.splice(0, c.actions.length - ACTIONS_MAX)
    this.emitActions(crewId)
    return id
  }

  // Only a running action can end; a second call is ignored.
  actionEnd(crewId: number, id: number, status: Exclude<BrowserActionStatus, 'running'>): void {
    const e = this.crew(crewId).actions.find((x) => x.id === id)
    if (!e || e.status !== 'running') return
    e.status = status
    this.emitActions(crewId)
  }

  dispose(): void {
    this.confirms.dispose()
    this.actionListeners.clear()
    for (const c of this.crews.values()) if (c.idleTimer) clearTimeout(c.idleTimer)
    this.stateListeners.clear()
    this.controlListeners.clear()
    this.historyListeners.clear()
    this.foundListeners.clear()
    for (const set of this.waiters.values()) for (const w of [...set]) w()
  }
}
