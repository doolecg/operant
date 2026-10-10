import { describe, expect, it } from 'vitest'
import { KeepWarm, type KeepWarmDeps, type KeepWarmPersisted } from './keepwarm'
import type { KeepWarmView } from '../shared/keepwarm'

const MIN = 60_000

function setup(over: Partial<KeepWarmDeps> = {}, saved: KeepWarmPersisted | null = null) {
  let now = 0
  let timer: { fn: () => void; at: number } | null = null
  const log = { pings: 0, notices: [] as string[], usage: [] as Array<{ tokens: number; usd: number }>, views: [] as Array<KeepWarmView | null>, saved: [] as Array<KeepWarmPersisted | null> }
  const d: KeepWarmDeps = {
    now: () => now,
    setTimer: (fn, ms) => ((timer = { fn, at: now + ms }), timer),
    clearTimer: () => (timer = null),
    ttlMs: () => 5 * MIN,
    isBusy: () => false,
    isRunning: () => true,
    sendPing: () => (log.pings++, true),
    budgetBlocked: () => null,
    recordUsage: (u) => log.usage.push(u),
    emit: (v) => log.views.push(v),
    notice: (t) => log.notices.push(t),
    load: () => saved,
    save: (p) => log.saved.push(p),
    ...over,
  }
  const kw = new KeepWarm(d)
  return {
    kw,
    log,
    advance(ms: number) {
      now += ms
      const t = timer as { fn: () => void; at: number } | null
      if (t && t.at <= now) {
        timer = null
        t.fn()
      }
    },
    armed: () => timer !== null,
  }
}

describe('KeepWarm', () => {
  it('is off until asked and shows a restart', () => {
    expect(setup().kw.view()).toBeNull()
    const s = setup({}, { active: true, always: false, endsAt: 1, stopped: null })
    expect(s.kw.isActive).toBe(false)
    expect(s.kw.view()?.stopped).toBe('Stopped by restart')
    expect(s.log.saved[0]?.active).toBe(false)
  })

  it('pings once near the end of the TTL while idle, then waits an interval', () => {
    const s = setup()
    s.kw.noteActivity(0)
    s.kw.command({ kind: 'start', ms: 60 * MIN })
    expect(s.log.pings).toBe(0)
    s.advance(269_000)
    expect(s.log.pings).toBe(0)
    s.advance(2_000)
    expect(s.log.pings).toBe(1)
    s.kw.onPingResult({ ok: true, cacheRead: 61_000, tokens: 61_010, usd: 0.03 })
    expect(s.log.usage).toEqual([{ tokens: 61_010, usd: 0.03 }])
    expect(s.log.pings).toBe(1)
    s.advance(270_000)
    expect(s.log.pings).toBe(2)
  })

  it('does not ping while busy', () => {
    const s = setup({ isBusy: () => true })
    s.kw.noteActivity(0)
    s.kw.command({ kind: 'start', ms: null })
    s.advance(280_000)
    expect(s.log.pings).toBe(0)
  })

  it('stops at the end of the window', () => {
    const s = setup()
    s.kw.noteActivity(0)
    s.kw.command({ kind: 'start', ms: 2 * MIN })
    s.advance(2 * MIN)
    expect(s.kw.isActive).toBe(false)
    expect(s.log.pings).toBe(0)
    expect(s.kw.view()?.stopped).toMatch(/window/)
  })

  it('stops on off, on two errors in a row and when the budget is reached', () => {
    const a = setup()
    a.kw.command({ kind: 'start', ms: null })
    a.kw.command({ kind: 'off' })
    expect(a.kw.isActive).toBe(false)
    expect(a.armed()).toBe(false)

    const b = setup()
    b.kw.noteActivity(0)
    b.kw.command({ kind: 'start', ms: null })
    b.advance(271_000)
    b.kw.onPingResult({ ok: false, cacheRead: 0, tokens: 0, usd: null })
    expect(b.kw.isActive).toBe(true)
    b.advance(271_000)
    b.kw.onPingResult({ ok: false, cacheRead: 0, tokens: 0, usd: null })
    expect(b.kw.isActive).toBe(false)

    const c = setup({ budgetBlocked: () => 'daily limit' })
    c.kw.noteActivity(0)
    c.kw.command({ kind: 'start', ms: null })
    c.advance(271_000)
    expect(c.log.pings).toBe(0)
    expect(c.kw.isActive).toBe(false)
  })

  it('halts when the tile closes without clearing the saved state', () => {
    const s = setup()
    s.kw.noteActivity(0)
    s.kw.command({ kind: 'start', ms: null })
    s.log.saved.length = 0
    s.kw.halt('The tile is closed')
    expect(s.kw.isActive).toBe(false)
    expect(s.log.saved).toEqual([])
  })
})
