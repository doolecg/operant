import { describe, expect, it, vi } from 'vitest'
import type { BrowserTab } from '../../shared/browser'
import { BrowserHub, type BrowserHost } from './hub'

const host: BrowserHost = {
  ensureOpen: async () => {},
  newTab: async () => ({ tabId: 1, targetId: 't1' }),
  closeTab: () => {},
  selectTab: () => {},
}
const tab = (id: number): BrowserTab => ({ id, url: 'http://a/', title: 'A', loading: false, canGoBack: false, canGoForward: false, secure: 'local' })

describe('BrowserHub', () => {
  it('tracks tabs, targets and pushes state', () => {
    const hub = new BrowserHub({ host })
    const seen: number[] = []
    hub.on('browser:state', (s) => seen.push(s.tabs.length))
    hub.tabOpened(1, tab(1), 'T1')
    hub.tabOpened(1, tab(2), 'T2')
    expect(hub.targets(1)).toEqual(new Set(['T1', 'T2']))
    expect(hub.targets(2).size).toBe(0)
    expect(hub.state(1).activeTabId).toBe(1)
    hub.tabUpdated(1, 2, { title: 'B' })
    expect(hub.state(1).tabs[1]?.title).toBe('B')
    hub.tabClosed(1, 1)
    expect(hub.state(1).activeTabId).toBe(2)
    expect(hub.tabIdOf(1, 'T2')).toBe(2)
    expect(seen.length).toBeGreaterThan(3)
    hub.setOpen(1, false)
    expect(hub.targets(1).size).toBe(0)
  })

  it('pauses, resumes and wakes waiters', async () => {
    const hub = new BrowserHub({ host })
    const controls: boolean[] = []
    hub.onControl((_c, p) => controls.push(p))
    expect(await hub.waitUntilResumed(1, 50)).toBe('resumed')
    hub.setControl(1, 'user')
    expect(hub.isPaused(1)).toBe(true)
    expect(hub.state(1).ai.paused).toBe(true)
    const w = hub.waitUntilResumed(1, 5000)
    hub.setControl(1, 'ai')
    expect(await w).toBe('resumed')
    expect(controls).toEqual([true, false])
    expect(hub.pauseEpoch(1)).toBe(1)
  })

  it('times out and aborts a wait', async () => {
    vi.useFakeTimers()
    const hub = new BrowserHub({ host })
    hub.setControl(1, 'user')
    const t = hub.waitUntilResumed(1, 100)
    await vi.advanceTimersByTimeAsync(100)
    expect(await t).toBe('timeout')
    const ac = new AbortController()
    const a = hub.waitUntilResumed(1, 5000, ac.signal)
    ac.abort()
    expect(await a).toBe('aborted')
    vi.useRealTimers()
  })

  it('marks the AI active until idle after the last call', async () => {
    vi.useFakeTimers()
    const hub = new BrowserHub({ host, idleMs: 3000 })
    hub.aiBegin(1, 7, 'browser_click e3')
    hub.aiBegin(1, 7, 'browser_type e4')
    hub.aiEnd(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(hub.state(1).ai.active).toBe(true)
    hub.aiEnd(1)
    await vi.advanceTimersByTimeAsync(2999)
    expect(hub.state(1).ai.active).toBe(true)
    await vi.advanceTimersByTimeAsync(2)
    expect(hub.state(1).ai).toMatchObject({ active: false, tileId: 7, lastAction: 'browser_type e4' })
    vi.useRealTimers()
  })

  it('reports aiAllowed from the setting', () => {
    let on = false
    const hub = new BrowserHub({ host, aiAllowed: () => on })
    expect(hub.state(1).aiAllowed).toBe(false)
    on = true
    expect(hub.state(1).aiAllowed).toBe(true)
  })

  it('moves tabs and keeps the active one', () => {
    const hub = new BrowserHub({ host })
    for (const id of [1, 2, 3]) hub.tabOpened(1, tab(id), `T${id}`)
    const seen: number[][] = []
    hub.on('browser:state', (s) => seen.push(s.tabs.map((t) => t.id)))
    hub.moveTab(1, 3, 0)
    expect(hub.state(1).tabs.map((t) => t.id)).toEqual([3, 1, 2])
    hub.moveTab(1, 3, 0)
    hub.moveTab(1, 99, 0)
    expect(seen).toHaveLength(1)
    expect(hub.state(1).activeTabId).toBe(1)
  })

  it('records history for web pages only and pushes it', () => {
    const hub = new BrowserHub({ host })
    const pushed: number[] = []
    hub.onHistory((_c, e) => pushed.push(e.length))
    hub.recordVisit(1, 'https://a.com/', 'A')
    hub.recordVisit(1, 'about:blank', '')
    hub.recordVisit(1, 'https://a.com/', 'A')
    hub.retitleVisit(1, 'https://a.com/', 'A2')
    expect(hub.history(1)).toMatchObject([{ url: 'https://a.com/', title: 'A2', visits: 2 }])
    expect(hub.history(2)).toEqual([])
    expect(pushed).toEqual([1, 1, 1])
  })

  it('clears the history and tells listeners', () => {
    const hub = new BrowserHub({ host })
    const seen: number[] = []
    hub.onHistory((_c, e) => seen.push(e.length))
    hub.recordVisit(1, 'https://a.test/', 'A')
    hub.clearHistory(1)
    hub.clearHistory(1)
    expect(hub.history(1)).toEqual([])
    expect(seen).toEqual([1, 0])
  })
})
