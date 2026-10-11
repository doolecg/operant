// Pure CDP rule engine for the browser panel proxy. One CdpFilter per client connection.
// It holds no sockets: the proxy feeds it messages and acts on what it returns.
// Never log message contents here or in the proxy (they carry cookies and typed text).

export type CdpMessage = Record<string, unknown>

export interface CdpFilterEnv {
  /** targetIds of the crew's panel tabs. */
  targets(): ReadonlySet<string>
  /** The panel partition's browserContextId, or null when unknown. */
  contextId(): string | null
}

export type ClientDecision =
  | { kind: 'forward'; message: CdpMessage }
  | { kind: 'reply'; message: CdpMessage }
  | { kind: 'create'; id: number; url: string; sessionId?: string }
  | { kind: 'host'; id: number; sessionId?: string; op: 'close' | 'activate'; targetId: string }

export interface UpstreamResult {
  toClient: CdpMessage[]
  toUpstream: CdpMessage[]
}

const ERR = -32000

export function cdpError(msg: CdpMessage, message: string): CdpMessage {
  const out: CdpMessage = { id: msg['id'], error: { code: ERR, message } }
  if (typeof msg['sessionId'] === 'string') out['sessionId'] = msg['sessionId']
  return out
}

function ok(msg: CdpMessage, result: CdpMessage = {}): CdpMessage {
  const out: CdpMessage = { id: msg['id'], result }
  if (typeof msg['sessionId'] === 'string') out['sessionId'] = msg['sessionId']
  return out
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const obj = (v: unknown): CdpMessage => (v && typeof v === 'object' ? (v as CdpMessage) : {})

// Browser-level methods that are forwarded untouched.
const PASS = new Set([
  'Browser.getVersion',
  'Target.getBrowserContexts',
  'Target.setDiscoverTargets',
  'Target.setAutoAttach',
])
// Electron does not register session partitions as DevTools browser contexts, so browser-level calls that take a
// browserContextId fail for the panel ("Failed to find browser context"), and without one they would reach the app's
// default session. Cookie calls are sent instead as the Network domain on one of the client's panel page sessions,
// which is scoped to the panel partition.
const COOKIES_VIA_PAGE: Record<string, string> = {
  'Storage.getCookies': 'Network.getAllCookies',
  'Storage.setCookies': 'Network.setCookies',
  'Storage.clearCookies': 'Network.clearBrowserCookies',
}
// Playwright sends this when it connects. Downloads are the panel session's own business: answer it here.
const ACK = new Set(['Browser.setDownloadBehavior'])
const NO_PERMISSIONS = new Set(['Browser.grantPermissions', 'Browser.resetPermissions', 'Browser.setPermission'])
// Target-scoped methods that need an allowed targetId.
const NEEDS_TARGET = new Set(['Browser.getWindowForTarget'])
// Domains that mean "browser level" even when sent on a page session.
const BROWSER_DOMAINS = /^(Target|Browser|Storage|SystemInfo)\./
// Session-level Target methods that are fine on a page session.
const SESSION_TARGET_PASS = new Set(['Target.setAutoAttach', 'Target.autoAttachRelated', 'Target.getTargetInfo'])

export class CdpFilter {
  private readonly sessions = new Map<string, string>() // sessionId -> targetId
  private readonly announced = new Set<string>() // targets the client has been told about
  private readonly granted = new Set<string>() // targets created through the proxy
  private readonly pending = new Map<string, string>() // `${sessionId}:${id}` -> method
  private readonly droppedInfo = new Map<string, CdpMessage>() // targetCreated dropped before the hub knew the target
  private readonly droppedAttach = new Set<string>() // auto-attaches we detached for the same reason
  private discover = false
  private autoAttach = false
  private creating = 0
  private stash: CdpMessage[] = []

  constructor(private readonly env: CdpFilterEnv) {}

  private allowed(targetId: string): boolean {
    return this.env.targets().has(targetId) || this.granted.has(targetId)
  }

  private key(msg: CdpMessage): string {
    return `${str(msg['sessionId']) ?? ''}:${String(msg['id'])}`
  }

  // ---------------------------------------------------------------- client -> browser

  fromClient(msg: CdpMessage): ClientDecision {
    const method = str(msg['method'])
    const id = msg['id']
    if (!method || typeof id !== 'number') return { kind: 'reply', message: cdpError(msg, 'Malformed message') }
    const sessionId = str(msg['sessionId'])
    if (sessionId !== undefined && this.roots.has(sessionId)) return this.fromRoot(msg, method, id, sessionId)
    if (sessionId !== undefined) {
      if (!this.sessions.has(sessionId)) return { kind: 'reply', message: cdpError(msg, 'Session not found') }
      if (SESSION_TARGET_PASS.has(method)) {
        if (method === 'Target.getTargetInfo') {
          const t = str(obj(msg['params'])['targetId'])
          if (t !== undefined && !this.allowed(t)) return { kind: 'reply', message: cdpError(msg, 'Target not found') }
        }
        return { kind: 'forward', message: msg }
      }
      if (!BROWSER_DOMAINS.test(method)) return { kind: 'forward', message: msg }
    }
    return this.browserLevel(msg, method, id, sessionId)
  }

  // A command on a virtual browser session: checked as a browser-level command, sent on the real root, and answered
  // on the virtual session.
  private fromRoot(msg: CdpMessage, method: string, id: number, root: string): ClientDecision {
    if (method === 'Target.setAutoAttach' || method === 'Target.setDiscoverTargets') return { kind: 'reply', message: cdpError(msg, 'Not allowed') }
    const { sessionId: _root, ...plain } = msg
    const d = this.browserLevel(plain, method, id, undefined)
    switch (d.kind) {
      case 'reply':
        return { kind: 'reply', message: { ...d.message, sessionId: root } }
      case 'forward': {
        this.rewritten.set(`${str(d.message['sessionId']) ?? ''}:${id}`, root)
        const t = str(obj(d.message['params'])['targetId'])
        if (method === 'Target.attachToTarget' && t !== undefined) this.rootAttach.set(t, root)
        return d
      }
      default:
        return { ...d, sessionId: root }
    }
  }

  private browserLevel(msg: CdpMessage, method: string, id: number, sessionId: string | undefined): ClientDecision {
    const params = obj(msg['params'])
    const refuse = (why: string): ClientDecision => ({ kind: 'reply', message: cdpError(msg, why) })
    const sess = sessionId !== undefined ? { sessionId } : {}

    if (PASS.has(method)) {
      if (method === 'Target.setDiscoverTargets') this.discover = params['discover'] === true
      if (method === 'Target.setAutoAttach' && sessionId === undefined) this.autoAttach = params['autoAttach'] === true
      return { kind: 'forward', message: msg }
    }
    if (ACK.has(method)) return { kind: 'reply', message: ok(msg) }
    if (NO_PERMISSIONS.has(method)) return refuse('Permissions are not available in the browser panel')
    const viaPage = COOKIES_VIA_PAGE[method]
    if (viaPage !== undefined) {
      const page = this.pageSession()
      if (page === undefined) return refuse('No open tab')
      this.rewritten.set(`${page}:${id}`, sessionId)
      const cookies = method === 'Storage.setCookies' ? { cookies: params['cookies'] } : {}
      return { kind: 'forward', message: { id, method: viaPage, sessionId: page, params: cookies } }
    }
    if (NEEDS_TARGET.has(method)) {
      const t = str(params['targetId'])
      if (t !== undefined && !this.allowed(t)) return refuse('Target not found')
      if (t === undefined && sessionId === undefined) return refuse('Target not found')
      return { kind: 'forward', message: msg }
    }
    switch (method) {
      case 'Target.getTargets':
      case 'Target.getTargetInfo': {
        const t = str(params['targetId'])
        if (method === 'Target.getTargetInfo' && t !== undefined && !this.allowed(t)) return refuse('Target not found')
        this.pending.set(this.key(msg), method)
        return { kind: 'forward', message: msg }
      }
      case 'Target.attachToTarget': {
        const t = str(params['targetId'])
        if (t === undefined || !this.allowed(t)) return refuse('Target not found')
        this.pending.set(this.key(msg), method)
        this.pendingAttach.set(this.key(msg), t)
        return { kind: 'forward', message: { ...msg, params: { ...params, flatten: true } } }
      }
      case 'Target.attachToBrowserTarget': {
        // Playwright's newCDPSession opens one. The real browser session is never handed out: this one is virtual.
        const root = `operant-root-${this.nextRoot++}`
        this.roots.add(root)
        return { kind: 'reply', message: ok(msg, { sessionId: root }) }
      }
      case 'Target.detachFromTarget': {
        const s = str(params['sessionId']) ?? sessionId
        if (s !== undefined && this.roots.delete(s)) return { kind: 'reply', message: ok(msg) }
        if (s === undefined || !this.sessions.has(s)) return refuse('Session not found')
        return { kind: 'forward', message: msg }
      }
      case 'Target.createTarget': {
        const url = str(params['url']) || 'about:blank'
        if (url !== 'about:blank' && !/^https?:\/\//i.test(url)) return refuse('URL not allowed')
        return { kind: 'create', id, url, ...sess }
      }
      case 'Target.closeTarget':
      case 'Target.activateTarget': {
        const t = str(params['targetId'])
        if (t === undefined || !this.allowed(t)) return refuse('Target not found')
        return { kind: 'host', id, op: method === 'Target.closeTarget' ? 'close' : 'activate', targetId: t, ...sess }
      }
      default:
        // Includes Browser.close/crash, Target.createBrowserContext/disposeBrowserContext,
        // Target.sendMessageToTarget, SystemInfo.*, Browser.setWindowBounds and anything unlisted.
        return refuse('Not allowed')
    }
  }

  private readonly pendingAttach = new Map<string, string>()
  private readonly roots = new Set<string>() // virtual browser sessions (Target.attachToBrowserTarget)
  private nextRoot = 1
  private readonly rootAttach = new Map<string, string>() // targetId -> virtual session attaching to it
  private readonly rootChildren = new Map<string, string>() // session opened from a virtual session -> that session
  // `${pageSessionId}:${id}` of cookie calls moved onto a page session -> the session the client sent them on.
  private readonly rewritten = new Map<string, string | undefined>()

  // A client session on a panel page itself (not a frame or worker under it).
  private pageSession(): string | undefined {
    for (const [s, t] of this.sessions) if (this.allowed(t)) return s
    return undefined
  }

  // ---------------------------------------------------------------- create handling

  beginCreate(): void {
    this.creating++
  }

  /** Call when the host answered (or failed). Returns the stashed upstream events, re-filtered. */
  endCreate(): UpstreamResult {
    this.creating = Math.max(0, this.creating - 1)
    const out: UpstreamResult = { toClient: [], toUpstream: [] }
    if (this.creating > 0) return out
    const events = this.stash
    this.stash = []
    for (const e of events) {
      const r = this.fromUpstream(e)
      out.toClient.push(...r.toClient)
      out.toUpstream.push(...r.toUpstream)
    }
    return out
  }

  /** Messages to send the client after the host created a panel tab: synthetic events if needed, then the reply. */
  createdReply(id: number, targetId: string, sessionId?: string): CdpMessage[] {
    this.granted.add(targetId)
    const out: CdpMessage[] = []
    if (this.discover && !this.announced.has(targetId)) {
      this.announced.add(targetId)
      out.push({
        method: 'Target.targetCreated',
        params: {
          targetInfo: {
            targetId,
            type: 'page',
            title: '',
            url: 'about:blank',
            attached: false,
            canAccessOpener: false,
            ...(this.env.contextId() ? { browserContextId: this.env.contextId() } : {}),
          },
        },
      })
    }
    out.push(ok({ id, ...(sessionId ? { sessionId } : {}) }, { targetId }))
    return out
  }

  hostReply(id: number, result: CdpMessage, sessionId?: string): CdpMessage {
    return ok({ id, ...(sessionId ? { sessionId } : {}) }, result)
  }

  hostError(id: number, message: string, sessionId?: string): CdpMessage {
    return cdpError({ id, ...(sessionId ? { sessionId } : {}) }, message)
  }

  // ---------------------------------------------------------------- browser -> client

  fromUpstream(msg: CdpMessage): UpstreamResult {
    const none: UpstreamResult = { toClient: [], toUpstream: [] }
    const pass: UpstreamResult = { toClient: [msg], toUpstream: [] }
    const method = str(msg['method'])
    const sessionId = str(msg['sessionId'])

    if (method === undefined) {
      if (typeof msg['id'] !== 'number') return none
      return this.response(msg)
    }
    const params = obj(msg['params'])

    switch (method) {
      case 'Target.targetCreated':
      case 'Target.targetInfoChanged': {
        const info = obj(params['targetInfo'])
        const t = str(info['targetId'])
        if (t === undefined) return none
        if (!this.allowed(t) && !this.announced.has(t)) {
          if (this.creating > 0) this.stash.push(msg)
          else if (method === 'Target.targetCreated') this.droppedInfo.set(t, info)
          return none
        }
        if (method === 'Target.targetCreated') {
          if (this.announced.has(t)) return none
          this.announced.add(t)
        }
        return pass
      }
      case 'Target.targetDestroyed': {
        const t = str(params['targetId'])
        if (t !== undefined) {
          this.droppedInfo.delete(t)
          this.droppedAttach.delete(t)
        }
        if (t === undefined || !this.announced.has(t)) return none
        this.announced.delete(t)
        return pass
      }
      case 'Target.targetCrashed': {
        const t = str(params['targetId'])
        return t !== undefined && this.announced.has(t) ? pass : none
      }
      case 'Target.attachedToTarget': {
        const info = obj(params['targetInfo'])
        const t = str(info['targetId'])
        const s = str(params['sessionId'])
        if (t === undefined || s === undefined) return none
        const root = sessionId === undefined ? this.rootAttach.get(t) : undefined
        if (root !== undefined && this.allowed(t)) {
          // The real root sees this attach; the client must see it on the virtual session that asked for it.
          this.sessions.set(s, t)
          this.rootChildren.set(s, root)
          return { toClient: [{ ...msg, sessionId: root }], toUpstream: [] }
        }
        const childOfAllowed = sessionId !== undefined && this.sessions.has(sessionId)
        if (childOfAllowed || this.allowed(t)) {
          this.sessions.set(s, t)
          this.announced.add(t)
          return pass
        }
        if (this.creating > 0) {
          this.stash.push(msg)
          return none
        }
        this.droppedAttach.add(t)
        const toUpstream: CdpMessage[] = []
        if (params['waitingForDebugger'] === true) {
          toUpstream.push({ id: this.internalId(), sessionId: s, method: 'Runtime.runIfWaitingForDebugger' })
        }
        toUpstream.push({ id: this.internalId(), method: 'Target.detachFromTarget', params: { sessionId: s } })
        return { toClient: [], toUpstream }
      }
      case 'Target.detachedFromTarget': {
        const s = str(params['sessionId'])
        if (s === undefined || !this.sessions.has(s)) return none
        this.sessions.delete(s)
        const root = this.rootChildren.get(s)
        this.rootChildren.delete(s)
        // On the client's real root this would read as the page closing.
        if (root !== undefined) return this.roots.has(root) ? { toClient: [{ ...msg, sessionId: root }], toUpstream: [] } : none
        return pass
      }
      default:
        if (method.startsWith('Target.')) return none
        if (sessionId === undefined) return none
        return this.sessions.has(sessionId) ? pass : none
    }
  }

  /**
   * Call when the hub's target set may have grown. Targets whose events were dropped because the hub
   * did not know them yet are announced (and re-attached if the client auto-attaches) now.
   */
  recheck(): UpstreamResult {
    const out: UpstreamResult = { toClient: [], toUpstream: [] }
    for (const [t, info] of [...this.droppedInfo]) {
      if (!this.allowed(t)) continue
      this.droppedInfo.delete(t)
      if (this.discover && !this.announced.has(t)) {
        this.announced.add(t)
        out.toClient.push({ method: 'Target.targetCreated', params: { targetInfo: info } })
      }
    }
    for (const t of [...this.droppedAttach]) {
      if (!this.allowed(t)) continue
      this.droppedAttach.delete(t)
      if (this.autoAttach) {
        out.toUpstream.push({ id: this.internalId(), method: 'Target.attachToTarget', params: { targetId: t, flatten: true } })
      }
    }
    return out
  }

  private nextInternal = 2_000_000_000
  private internalId(): number {
    return this.nextInternal++
  }

  /** True for ids the filter issued itself; the proxy swallows their responses. */
  isInternalResponse(msg: CdpMessage): boolean {
    return typeof msg['id'] === 'number' && msg['id'] >= 2_000_000_000
  }

  private response(msg: CdpMessage): UpstreamResult {
    const k = this.key(msg)
    if (!this.rewritten.has(k)) return this.answer(msg, k, undefined)
    const original = this.rewritten.get(k)
    this.rewritten.delete(k)
    const { sessionId: _moved, ...rest } = msg
    return this.answer(original !== undefined ? { ...rest, sessionId: original } : rest, k, original)
  }

  private answer(msg: CdpMessage, k: string, root: string | undefined): UpstreamResult {
    const method = this.pending.get(k)
    if (method === undefined) return { toClient: [msg], toUpstream: [] }
    this.pending.delete(k)
    const attachTarget = this.pendingAttach.get(k)
    this.pendingAttach.delete(k)
    const result = obj(msg['result'])
    if (method === 'Target.getTargets' && Array.isArray(result['targetInfos'])) {
      const infos = (result['targetInfos'] as unknown[]).filter((i) => {
        const t = str(obj(i)['targetId'])
        return t !== undefined && this.allowed(t)
      })
      return { toClient: [{ ...msg, result: { ...result, targetInfos: infos } }], toUpstream: [] }
    }
    if (method === 'Target.attachToTarget' && attachTarget !== undefined) {
      if (root !== undefined && this.rootAttach.get(attachTarget) === root) this.rootAttach.delete(attachTarget)
      const s = str(result['sessionId'])
      if (s !== undefined) {
        this.sessions.set(s, attachTarget)
        if (root !== undefined && this.roots.has(root)) this.rootChildren.set(s, root)
      }
    }
    return { toClient: [msg], toUpstream: [] }
  }
}
