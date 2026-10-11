import { describe, expect, it } from 'vitest'
import { CdpFilter, type CdpMessage } from './cdp-filter'

const PANEL = 'PANEL1'
const APP = 'APPUI'
const CTX = 'ctx-panel'

function mk(ctx: string | null = CTX) {
  const targets = new Set([PANEL])
  const f = new CdpFilter({ targets: () => targets, contextId: () => ctx })
  return { f, targets }
}

const created = (id: string): CdpMessage => ({
  method: 'Target.targetCreated',
  params: { targetInfo: { targetId: id, type: 'page', url: 'x' } },
})
const attached = (id: string, sid: string, waiting = false, parent?: string): CdpMessage => ({
  method: 'Target.attachedToTarget',
  ...(parent ? { sessionId: parent } : {}),
  params: { sessionId: sid, targetInfo: { targetId: id, type: 'page' }, waitingForDebugger: waiting },
})

describe('cdp-filter client commands', () => {
  const refused = [
    'Browser.close',
    'Browser.crash',
    'Browser.setWindowBounds',
    'Target.createBrowserContext',
    'Target.disposeBrowserContext',
    'Target.sendMessageToTarget',
    'SystemInfo.getInfo',
    'Made.up',
  ]
  it.each(refused)('refuses %s', (method) => {
    const { f } = mk()
    const d = f.fromClient({ id: 1, method })
    expect(d.kind).toBe('reply')
    if (d.kind === 'reply') expect(d.message['error']).toBeTruthy()
  })

  it.each(['Browser.getVersion', 'Target.setDiscoverTargets', 'Target.setAutoAttach', 'Target.getTargets', 'Target.getBrowserContexts'])(
    'forwards %s',
    (method) => {
      const { f } = mk()
      expect(f.fromClient({ id: 1, method, params: {} }).kind).toBe('forward')
    },
  )

  it('refuses attach to a disallowed target and allows a panel target (forcing flatten)', () => {
    const { f } = mk()
    expect(f.fromClient({ id: 1, method: 'Target.attachToTarget', params: { targetId: APP } }).kind).toBe('reply')
    const d = f.fromClient({ id: 2, method: 'Target.attachToTarget', params: { targetId: PANEL } })
    expect(d.kind).toBe('forward')
    if (d.kind === 'forward') expect((d.message['params'] as CdpMessage)['flatten']).toBe(true)
  })

  it('refuses getTargetInfo for a disallowed target', () => {
    const { f } = mk()
    expect(f.fromClient({ id: 1, method: 'Target.getTargetInfo', params: { targetId: APP } }).kind).toBe('reply')
    expect(f.fromClient({ id: 2, method: 'Target.getTargetInfo', params: { targetId: PANEL } }).kind).toBe('forward')
  })

  it('answers setDownloadBehavior itself and refuses permission calls', () => {
    const { f } = mk()
    expect(f.fromClient({ id: 1, method: 'Browser.setDownloadBehavior', params: { behavior: 'allowAndName' } })).toEqual({
      kind: 'reply',
      message: { id: 1, result: {} },
    })
    for (const method of ['Browser.grantPermissions', 'Browser.resetPermissions', 'Browser.setPermission']) {
      const d = f.fromClient({ id: 2, method, params: { browserContextId: 'evil' } })
      expect(d.kind).toBe('reply')
      if (d.kind === 'reply') expect(d.message['error']).toBeTruthy()
    }
  })

  it('moves Storage cookie calls onto a panel page session as Network calls, dropping any context id', () => {
    const { f } = mk()
    expect(f.fromClient({ id: 1, method: 'Storage.getCookies' }).kind).toBe('reply')
    f.fromUpstream(attached(PANEL, 'S1'))
    expect(f.fromClient({ id: 2, method: 'Storage.getCookies', params: { browserContextId: 'evil' } })).toEqual({
      kind: 'forward',
      message: { id: 2, method: 'Network.getAllCookies', sessionId: 'S1', params: {} },
    })
    const cookies = [{ name: 'a', value: '1', url: 'https://a.test/' }]
    expect(f.fromClient({ id: 3, method: 'Storage.setCookies', params: { cookies, browserContextId: 'evil' } })).toEqual({
      kind: 'forward',
      message: { id: 3, method: 'Network.setCookies', sessionId: 'S1', params: { cookies } },
    })
    expect(f.fromClient({ id: 4, method: 'Storage.clearCookies' })).toMatchObject({ message: { method: 'Network.clearBrowserCookies', sessionId: 'S1' } })
  })

  it('answers a moved cookie call on the session the client sent it on', () => {
    const { f } = mk()
    f.fromUpstream(attached(PANEL, 'S1'))
    f.fromClient({ id: 2, method: 'Storage.getCookies' })
    expect(f.fromUpstream({ id: 2, sessionId: 'S1', result: { cookies: [] } }).toClient).toEqual([{ id: 2, result: { cookies: [] } }])
    f.fromClient({ id: 3, sessionId: 'S1', method: 'Storage.getCookies' })
    expect(f.fromUpstream({ id: 3, sessionId: 'S1', result: { cookies: [] } }).toClient).toEqual([{ id: 3, sessionId: 'S1', result: { cookies: [] } }])
  })

  it('never uses a frame session under a panel page for cookie calls', () => {
    const { f } = mk()
    f.fromUpstream(attached('FRAME', 'C1', false, 'S0'))
    expect(f.fromClient({ id: 1, method: 'Storage.getCookies' }).kind).toBe('reply')
  })

  it('gives a virtual browser session whose commands are checked, sent on the root and answered on it', () => {
    const { f } = mk()
    const d = f.fromClient({ id: 1, method: 'Target.attachToBrowserTarget' })
    expect(d.kind).toBe('reply')
    const root = d.kind === 'reply' ? ((d.message['result'] as CdpMessage)['sessionId'] as string) : ''
    expect(root).toMatch(/^operant-root-/)
    expect(f.fromClient({ id: 2, sessionId: root, method: 'Browser.close' })).toMatchObject({ kind: 'reply', message: { sessionId: root } })
    expect(f.fromClient({ id: 3, sessionId: root, method: 'Target.setAutoAttach', params: { autoAttach: true } }).kind).toBe('reply')
    expect(f.fromClient({ id: 4, sessionId: root, method: 'Target.attachToTarget', params: { targetId: APP } }).kind).toBe('reply')
    expect(f.fromClient({ id: 5, sessionId: root, method: 'Target.attachToTarget', params: { targetId: PANEL } })).toEqual({
      kind: 'forward',
      message: { id: 5, method: 'Target.attachToTarget', params: { targetId: PANEL, flatten: true } },
    })
    // Chrome reports the attach on the real root: the client gets it on the virtual session.
    expect(f.fromUpstream(attached(PANEL, 'S9')).toClient).toEqual([{ ...attached(PANEL, 'S9'), sessionId: root }])
    expect(f.fromUpstream({ id: 5, result: { sessionId: 'S9' } }).toClient).toEqual([{ id: 5, sessionId: root, result: { sessionId: 'S9' } }])
    expect(f.fromClient({ id: 6, sessionId: 'S9', method: 'Page.reload', params: { ignoreCache: true } }).kind).toBe('forward')
    const detached = { method: 'Target.detachedFromTarget', params: { sessionId: 'S9', targetId: PANEL } }
    expect(f.fromUpstream(detached).toClient).toEqual([{ ...detached, sessionId: root }])
    expect(f.fromClient({ id: 7, method: 'Target.detachFromTarget', params: { sessionId: root } }).kind).toBe('reply')
    expect(f.fromClient({ id: 8, sessionId: root, method: 'Browser.getVersion' }).kind).toBe('reply')
  })

  it('leaves the main session attach to a panel page untouched', () => {
    const { f } = mk()
    f.fromClient({ id: 1, method: 'Target.attachToBrowserTarget' })
    expect(f.fromUpstream(attached(PANEL, 'S1')).toClient).toEqual([attached(PANEL, 'S1')])
  })

  it('routes createTarget to the host and refuses non-web urls', () => {
    const { f } = mk()
    const d = f.fromClient({ id: 5, method: 'Target.createTarget', params: { url: 'https://a.test' } })
    expect(d).toEqual({ kind: 'create', id: 5, url: 'https://a.test' })
    expect(f.fromClient({ id: 6, method: 'Target.createTarget', params: {} })).toMatchObject({ kind: 'create', url: 'about:blank' })
    expect(f.fromClient({ id: 7, method: 'Target.createTarget', params: { url: 'file:///etc/passwd' } }).kind).toBe('reply')
    expect(f.fromClient({ id: 8, method: 'Target.createTarget', params: { url: 'javascript:1' } }).kind).toBe('reply')
  })

  it('routes close and activate for allowed targets only', () => {
    const { f } = mk()
    expect(f.fromClient({ id: 1, method: 'Target.closeTarget', params: { targetId: PANEL } })).toMatchObject({ kind: 'host', op: 'close', targetId: PANEL })
    expect(f.fromClient({ id: 2, method: 'Target.activateTarget', params: { targetId: PANEL } })).toMatchObject({ kind: 'host', op: 'activate' })
    expect(f.fromClient({ id: 3, method: 'Target.closeTarget', params: { targetId: APP } }).kind).toBe('reply')
  })

  it('only passes session commands for allowed sessions', () => {
    const { f } = mk()
    expect(f.fromClient({ id: 1, sessionId: 'nope', method: 'Page.navigate' }).kind).toBe('reply')
    f.fromUpstream(attached(PANEL, 'S1'))
    expect(f.fromClient({ id: 2, sessionId: 'S1', method: 'Page.navigate', params: {} }).kind).toBe('forward')
    expect(f.fromClient({ id: 3, sessionId: 'S1', method: 'Emulation.setDeviceMetricsOverride', params: {} }).kind).toBe('forward')
  })

  it('treats browser-domain methods on a page session as browser level', () => {
    const { f } = mk()
    f.fromUpstream(attached(PANEL, 'S1'))
    expect(f.fromClient({ id: 1, sessionId: 'S1', method: 'Browser.close' }).kind).toBe('reply')
    const d = f.fromClient({ id: 2, sessionId: 'S1', method: 'Storage.getCookies' })
    expect(d.kind).toBe('forward')
    expect(f.fromClient({ id: 3, sessionId: 'S1', method: 'Target.setAutoAttach', params: { autoAttach: true } }).kind).toBe('forward')
    expect(f.fromClient({ id: 4, sessionId: 'S1', method: 'Browser.getWindowForTarget' }).kind).toBe('forward')
  })

  it('error replies keep the session id', () => {
    const { f } = mk()
    f.fromUpstream(attached(PANEL, 'S1'))
    const d = f.fromClient({ id: 9, sessionId: 'S1', method: 'Browser.close' })
    if (d.kind === 'reply') expect(d.message['sessionId']).toBe('S1')
  })
})

describe('cdp-filter upstream events and responses', () => {
  it('drops events about other targets and passes panel ones', () => {
    const { f } = mk()
    expect(f.fromUpstream(created(APP)).toClient).toEqual([])
    expect(f.fromUpstream(created(PANEL)).toClient).toHaveLength(1)
    expect(f.fromUpstream(created(PANEL)).toClient).toHaveLength(0) // not announced twice
    expect(f.fromUpstream({ method: 'Target.targetInfoChanged', params: { targetInfo: { targetId: APP } } }).toClient).toEqual([])
    expect(f.fromUpstream({ method: 'Target.targetInfoChanged', params: { targetInfo: { targetId: PANEL } } }).toClient).toHaveLength(1)
    expect(f.fromUpstream({ method: 'Target.targetDestroyed', params: { targetId: APP } }).toClient).toEqual([])
    expect(f.fromUpstream({ method: 'Target.targetDestroyed', params: { targetId: PANEL } }).toClient).toHaveLength(1)
  })

  it('still reports destruction of a panel tab that left the allowlist', () => {
    const { f, targets } = mk()
    f.fromUpstream(created(PANEL))
    targets.delete(PANEL)
    expect(f.fromUpstream({ method: 'Target.targetDestroyed', params: { targetId: PANEL } }).toClient).toHaveLength(1)
  })

  it('resumes then detaches a disallowed target that was auto-attached waiting for the debugger', () => {
    const { f } = mk()
    const r = f.fromUpstream(attached(APP, 'SX', true))
    expect(r.toClient).toEqual([])
    expect(r.toUpstream).toHaveLength(2)
    expect(r.toUpstream[0]).toMatchObject({ method: 'Runtime.runIfWaitingForDebugger', sessionId: 'SX' })
    expect(r.toUpstream[1]).toMatchObject({ method: 'Target.detachFromTarget', params: { sessionId: 'SX' } })
    expect(f.isInternalResponse({ id: r.toUpstream[0]!['id'] })).toBe(true)
    // later traffic on that session is dropped
    expect(f.fromUpstream({ sessionId: 'SX', method: 'Page.frameNavigated', params: {} }).toClient).toEqual([])
  })

  it('detaches a disallowed target that is not waiting without a resume', () => {
    const { f } = mk()
    const r = f.fromUpstream(attached(APP, 'SX', false))
    expect(r.toUpstream).toHaveLength(1)
    expect(r.toUpstream[0]).toMatchObject({ method: 'Target.detachFromTarget' })
  })

  it('passes a panel attach and its session events, plus child sessions', () => {
    const { f } = mk()
    expect(f.fromUpstream(attached(PANEL, 'S1')).toClient).toHaveLength(1)
    expect(f.fromUpstream({ sessionId: 'S1', method: 'Page.loadEventFired', params: {} }).toClient).toHaveLength(1)
    expect(f.fromUpstream(attached('OOPIF', 'S2', true, 'S1')).toClient).toHaveLength(1)
    expect(f.fromUpstream({ sessionId: 'S2', method: 'Runtime.consoleAPICalled', params: {} }).toClient).toHaveLength(1)
    expect(f.fromUpstream({ method: 'Target.detachedFromTarget', params: { sessionId: 'S2' } }).toClient).toHaveLength(1)
    expect(f.fromUpstream({ sessionId: 'S2', method: 'Page.x' }).toClient).toEqual([])
  })

  it('drops session-less non-target events and receivedMessageFromTarget', () => {
    const { f } = mk()
    expect(f.fromUpstream({ method: 'Browser.downloadWillBegin', params: {} }).toClient).toEqual([])
    expect(f.fromUpstream({ method: 'Target.receivedMessageFromTarget', params: {} }).toClient).toEqual([])
  })

  it('filters Target.getTargets responses', () => {
    const { f } = mk()
    f.fromClient({ id: 3, method: 'Target.getTargets' })
    const r = f.fromUpstream({ id: 3, result: { targetInfos: [{ targetId: APP }, { targetId: PANEL }] } })
    expect(r.toClient[0]!['result']).toEqual({ targetInfos: [{ targetId: PANEL }] })
  })

  it('records the session from an attachToTarget response', () => {
    const { f } = mk()
    f.fromClient({ id: 4, method: 'Target.attachToTarget', params: { targetId: PANEL } })
    f.fromUpstream({ id: 4, result: { sessionId: 'S9' } })
    expect(f.fromClient({ id: 5, sessionId: 'S9', method: 'Page.enable' }).kind).toBe('forward')
  })
})

describe('cdp-filter createTarget flow', () => {
  it('replays events for the new tab once the host has created it, then replies', () => {
    const { f, targets } = mk()
    f.fromClient({ id: 1, method: 'Target.setDiscoverTargets', params: { discover: true } })
    f.beginCreate()
    // upstream announces the new tab before the host resolves: stashed, not dropped for good
    expect(f.fromUpstream(created('NEW')).toClient).toEqual([])
    expect(f.fromUpstream(attached('NEW', 'SN', true)).toClient).toEqual([])
    expect(f.fromUpstream(attached(APP, 'SA', true)).toClient).toEqual([])
    targets.add('NEW')
    const replay = f.endCreate()
    expect(replay.toClient.map((m) => m['method'])).toEqual(['Target.targetCreated', 'Target.attachedToTarget'])
    // the app UI attach is detached at replay time
    expect(replay.toUpstream.map((m) => m['method'])).toEqual(['Runtime.runIfWaitingForDebugger', 'Target.detachFromTarget'])
    const out = f.createdReply(7, 'NEW')
    expect(out).toEqual([{ id: 7, result: { targetId: 'NEW' } }]) // already announced, no synthetic event
  })

  it('synthesises targetCreated when upstream never announced the tab', () => {
    const { f } = mk()
    f.fromClient({ id: 1, method: 'Target.setDiscoverTargets', params: { discover: true } })
    f.beginCreate()
    f.endCreate()
    const out = f.createdReply(7, 'NEW2')
    expect(out[0]).toMatchObject({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'NEW2', browserContextId: CTX } } })
    expect(out[1]).toEqual({ id: 7, result: { targetId: 'NEW2' } })
    // and the new tab is now usable even if the hub list lags
    expect(f.fromClient({ id: 8, method: 'Target.attachToTarget', params: { targetId: 'NEW2' } }).kind).toBe('forward')
  })
})
