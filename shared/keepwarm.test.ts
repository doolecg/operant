import { describe, expect, it } from 'vitest'
import { decidePing, formatSpan, keepWarmLine, keepWarmSummary, parseKeepWarm, pingLeadMs, warmBadge, type KeepWarmView } from './keepwarm'

const MIN = 60_000
const HOUR = 3_600_000

describe('parseKeepWarm', () => {
  it('ignores other text', () => {
    expect(parseKeepWarm('hello')).toBeNull()
    expect(parseKeepWarm('/keepwarmer')).toBeNull()
    expect(parseKeepWarm('/effort high')).toBeNull()
  })
  it('bare is six hours', () => {
    expect(parseKeepWarm('/keepwarm')).toEqual({ kind: 'start', ms: 6 * HOUR })
    expect(parseKeepWarm('  /KeepWarm  ')).toEqual({ kind: 'start', ms: 6 * HOUR })
  })
  it('reads windows', () => {
    expect(parseKeepWarm('/keepwarm 90m')).toEqual({ kind: 'start', ms: 90 * MIN })
    expect(parseKeepWarm('/keepwarm 2h')).toEqual({ kind: 'start', ms: 2 * HOUR })
    expect(parseKeepWarm('/keepwarm 1h30m')).toEqual({ kind: 'start', ms: 90 * MIN })
  })
  it('reads always, off and status', () => {
    expect(parseKeepWarm('/keepwarm always')).toEqual({ kind: 'start', ms: null })
    expect(parseKeepWarm('/keepwarm off')).toEqual({ kind: 'off' })
    expect(parseKeepWarm('/keepwarm status')).toEqual({ kind: 'status' })
  })
  it('rejects what it cannot read', () => {
    expect(parseKeepWarm('/keepwarm soon')?.kind).toBe('invalid')
    expect(parseKeepWarm('/keepwarm 0m')?.kind).toBe('invalid')
    expect(parseKeepWarm('/keepwarm 30h')?.kind).toBe('invalid')
  })
})

describe('decidePing', () => {
  const base = { now: 0, lastActivity: 0, lastPingAt: null, ttlMs: 5 * MIN, busy: false, endsAt: null }
  it('leads by 30s for the 5 minute cache and 5 minutes for the 1 hour cache', () => {
    expect(pingLeadMs(5 * MIN)).toBe(30_000)
    expect(pingLeadMs(HOUR)).toBe(5 * MIN)
  })
  it('waits until TTL minus the lead', () => {
    expect(decidePing({ ...base, now: 60_000 })).toEqual({ action: 'wait', at: 270_000, reason: 'not-due' })
    expect(decidePing({ ...base, ttlMs: HOUR, now: 10 * MIN })).toEqual({ action: 'wait', at: 55 * MIN, reason: 'not-due' })
  })
  it('sends when due and idle', () => {
    expect(decidePing({ ...base, now: 270_000 })).toEqual({ action: 'send' })
    expect(decidePing({ ...base, ttlMs: HOUR, now: 55 * MIN })).toEqual({ action: 'send' })
  })
  it('never while busy', () => {
    expect(decidePing({ ...base, now: 280_000, busy: true })).toEqual({ action: 'wait', at: null, reason: 'busy' })
  })
  it('not twice in one interval', () => {
    expect(decidePing({ ...base, now: 280_000, lastPingAt: 270_000 })).toMatchObject({ action: 'wait', reason: 'not-due', at: 540_000 })
  })
  it('does not ping a cold cache', () => {
    expect(decidePing({ ...base, now: 5 * MIN + 1 })).toMatchObject({ action: 'wait', reason: 'cold' })
  })
  it('waits for the first real message', () => {
    expect(decidePing({ ...base, lastActivity: null })).toMatchObject({ action: 'wait', reason: 'no-activity' })
  })
  it('stops at the end of the window and does not wait past it', () => {
    expect(decidePing({ ...base, now: 100_000, endsAt: 100_000 })).toEqual({ action: 'stop', reason: 'window' })
    expect(decidePing({ ...base, now: 60_000, endsAt: 120_000 })).toEqual({ action: 'wait', at: 120_000, reason: 'not-due' })
  })
})

describe('status text', () => {
  it('names the cache state', () => {
    expect(warmBadge(0, null, 5 * MIN)).toBeNull()
    expect(warmBadge(2 * MIN, 0, 5 * MIN)).toBe('warm')
    expect(warmBadge(4 * MIN + 1, 0, 5 * MIN)).toBe('cooling')
    expect(warmBadge(5 * MIN, 0, 5 * MIN)).toBe('cold')
  })
  it('formats spans', () => {
    expect(formatSpan(40_000)).toBe('40s')
    expect(formatSpan(270_000)).toBe('4m30s')
    expect(formatSpan(50 * MIN)).toBe('50m')
    expect(formatSpan(5 * HOUR + 10 * MIN)).toBe('5h10m')
    expect(formatSpan(2 * HOUR)).toBe('2h')
  })
  const view: KeepWarmView = { active: true, always: false, endsAt: 5 * HOUR + 10 * MIN, ttlMs: HOUR, lastActivityAt: 0, nextPingAt: 50 * MIN, pings: 2, lastPing: { at: 0, cacheRead: 61_000, usd: 0.03, ok: true }, stopped: null }
  it('builds the status line with every part', () => {
    expect(keepWarmLine(view, 0)).toEqual({ badge: 'warm', parts: ['keepwarm 5h10m left', 'ping in 50m', 'last ping read 61k $0.03'] })
  })
  it('leaves out what is unknown', () => {
    expect(keepWarmLine({ ...view, always: true, endsAt: null, nextPingAt: null, lastPing: null }, 0)).toEqual({ badge: 'warm', parts: ['keepwarm always'] })
    expect(keepWarmLine({ ...view, lastPing: { at: 0, cacheRead: 61_000, usd: null, ok: true } }, 0).parts[2]).toBe('last ping read 61k')
  })
  it('turns amber then grey as the cache ages', () => {
    expect(keepWarmLine(view, 48 * MIN).badge).toBe('warm')
    expect(keepWarmLine(view, 48 * MIN + 1).badge).toBe('cooling')
    expect(keepWarmLine(view, HOUR).badge).toBe('cold')
  })
  it('shows why it stopped', () => {
    expect(keepWarmLine({ ...view, active: false, stopped: 'Stopped by restart' }, 0)).toEqual({ badge: 'off', parts: ['Stopped by restart'] })
    expect(keepWarmSummary(null, 0)).toBe('Keep-warm is off.')
    expect(keepWarmSummary(view, 0)).toContain('2 pings sent')
  })
})
