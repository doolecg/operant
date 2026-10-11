import type { WebContents } from 'electron'

type Params = Record<string, unknown>

// A webContents has exactly one debugger attachment, but several parts of the browser panel want CDP events from a
// tab (page dialogs, the console and network log). They share it here: the first client attaches, every client gets the
// same messages, and the last one to release detaches. Playwright's own connection (remote debugging port) and the
// DevTools window are separate clients of the page and are not affected.
export interface DebugClient {
  // Attaches when needed and runs every client's init (domain enables) on a fresh attachment. False when the page
  // cannot be inspected right now (destroyed, or someone else holds the debugger); the next call tries again.
  ensure(): Promise<boolean>
  // Sends a command, attaching first. Rejects when the tab cannot be inspected.
  send(method: string, params?: Params): Promise<unknown>
  // CDP events (Runtime.*, Network.*, Page.*) of the tab.
  onMessage(cb: (method: string, params: Params) => void): () => void
  // The attachment was lost (DevTools took it, the page crashed). It is retried a few times by itself.
  onDetach(cb: () => void): () => void
  // Runs on every fresh attachment, before ensure() resolves: turn domains on, put emulation back.
  onAttach(cb: () => Promise<void> | void): () => void
  // Done with the tab: detaches when no other client remains.
  release(): void
}

const REATTACH_DELAY_MS = 250
const REATTACH_MAX = 5
const REATTACH_WINDOW_MS = 10_000

const isObj = (v: unknown): v is Params => typeof v === 'object' && v !== null

class SharedDebugger {
  private readonly messages = new Set<(method: string, params: Params) => void>()
  private readonly detaches = new Set<() => void>()
  private readonly attaches = new Set<() => Promise<void> | void>()
  private clients = 0
  private ready: Promise<boolean> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private retries: number[] = []
  private closed = false
  private readonly onMessageEv: (e: unknown, method: string, params: unknown) => void
  private readonly onDetachEv: () => void
  private readonly onDestroyed: () => void

  constructor(
    private readonly wc: WebContents,
    private readonly forget: () => void,
  ) {
    this.onMessageEv = (_e, method, params) => {
      const p = isObj(params) ? params : {}
      for (const cb of [...this.messages]) cb(method, p)
    }
    this.onDetachEv = () => {
      this.ready = null
      for (const cb of [...this.detaches]) cb()
      this.scheduleReattach()
    }
    this.onDestroyed = () => this.shutdown(false)
    wc.debugger.on('message', this.onMessageEv as never)
    wc.debugger.on('detach', this.onDetachEv)
    wc.once('destroyed', this.onDestroyed)
  }

  client(): DebugClient {
    this.clients++
    const mine = {
      messages: new Set<(method: string, params: Params) => void>(),
      detaches: new Set<() => void>(),
      attaches: new Set<() => Promise<void> | void>(),
    }
    let released = false
    const add = <T>(own: Set<T>, all: Set<T>, cb: T): (() => void) => {
      own.add(cb)
      all.add(cb)
      return () => {
        own.delete(cb)
        all.delete(cb)
      }
    }
    return {
      ensure: () => this.ensure(),
      send: async (method, params) => {
        if (!(await this.ensure())) throw new Error('The page cannot be inspected right now')
        return this.wc.debugger.sendCommand(method, params)
      },
      onMessage: (cb) => add(mine.messages, this.messages, cb),
      onDetach: (cb) => add(mine.detaches, this.detaches, cb),
      onAttach: (cb) => add(mine.attaches, this.attaches, cb),
      release: () => {
        if (released) return
        released = true
        for (const cb of mine.messages) this.messages.delete(cb)
        for (const cb of mine.detaches) this.detaches.delete(cb)
        for (const cb of mine.attaches) this.attaches.delete(cb)
        if (--this.clients <= 0) this.shutdown(true)
      },
    }
  }

  private ensure(): Promise<boolean> {
    if (this.closed || this.wc.isDestroyed()) return Promise.resolve(false)
    if (this.ready && this.wc.debugger.isAttached()) return this.ready
    const run = this.attachNow()
    this.ready = run
    void run.then((ok) => {
      if (!ok && this.ready === run) this.ready = null
    })
    return run
  }

  private async attachNow(): Promise<boolean> {
    try {
      if (!this.wc.debugger.isAttached()) this.wc.debugger.attach('1.3')
      await Promise.all([...this.attaches].map((cb) => cb()))
      return true
    } catch {
      // Someone else holds the debugger for a moment (a screenshot); the next call tries again.
      return false
    }
  }

  // The debugger went away without us asking: take it back, a few times at most, so a tool that keeps stealing it
  // cannot make us fight over it.
  private scheduleReattach(): void {
    if (this.closed || this.timer || this.wc.isDestroyed() || this.clients <= 0) return
    const now = Date.now()
    this.retries = this.retries.filter((t) => now - t < REATTACH_WINDOW_MS)
    if (this.retries.length >= REATTACH_MAX) return
    this.retries.push(now)
    this.timer = setTimeout(() => {
      this.timer = null
      if (!this.closed && !this.wc.isDestroyed() && !this.wc.debugger.isAttached()) void this.ensure()
    }, REATTACH_DELAY_MS)
    this.timer.unref?.()
  }

  private shutdown(detach: boolean): void {
    if (this.closed) return
    this.closed = true
    this.ready = null
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.messages.clear()
    this.detaches.clear()
    this.attaches.clear()
    this.forget()
    if (this.wc.isDestroyed()) return
    this.wc.debugger.removeListener('message', this.onMessageEv as never)
    this.wc.debugger.removeListener('detach', this.onDetachEv)
    this.wc.removeListener('destroyed', this.onDestroyed)
    try {
      if (detach && this.wc.debugger.isAttached()) this.wc.debugger.detach()
    } catch {
      /* already detached */
    }
  }
}

const shared = new WeakMap<WebContents, SharedDebugger>()

// A client of the tab's shared debugger attachment. Release it when done with the tab.
export function debugClient(wc: WebContents): DebugClient {
  let s = shared.get(wc)
  if (!s) {
    const made = new SharedDebugger(wc, () => {
      if (shared.get(wc) === made) shared.delete(wc)
    })
    shared.set(wc, made)
    s = made
  }
  return s.client()
}
