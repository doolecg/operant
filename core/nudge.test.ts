import { describe, expect, it } from 'vitest'
import { isFixedLine, nudgeLine, NudgeScheduler, type NudgeOperatorState } from './nudge'

const op = (over: Partial<NudgeOperatorState> = {}): NudgeOperatorState => ({
  key: 1,
  agent: 'claude',
  idleMs: 10_000,
  unread: 1,
  newestUnreadAt: 0,
  ...over,
})

describe('nudge line', () => {
  it('is fixed text and singular or plural', () => {
    expect(nudgeLine(1)).toBe('Operant: you have 1 unread message. Run: operant inbox')
    expect(nudgeLine(3)).toBe('Operant: you have 3 unread messages. Run: operant inbox')
  })

  it('only fixed lines pass the allowlist', () => {
    expect(isFixedLine(nudgeLine(2))).toBe(true)
    expect(isFixedLine('/clear')).toBe(true)
    expect(isFixedLine('/exit')).toBe(true)
    expect(isFixedLine('rm -rf /')).toBe(false)
    expect(isFixedLine('/clear now')).toBe(false)
    expect(isFixedLine(`${nudgeLine(2)}\nrm x`)).toBe(false)
  })
})

describe('NudgeScheduler', () => {
  it('nudges exactly once after the batch delay when idle', () => {
    const s = new NudgeScheduler()
    expect(s.tick(10_000, [op()])).toEqual([])
    expect(s.tick(15_000, [op()])).toEqual([{ key: 1, kind: 'nudge', line: nudgeLine(1) }])
    expect(s.tick(16_000, [op()])).toEqual([])
    expect(s.tick(60_000, [op()])).toEqual([])
  })

  it('does not nudge while output is flowing', () => {
    const s = new NudgeScheduler()
    expect(s.tick(20_000, [op({ idleMs: 4_000 })])).toEqual([])
    expect(s.tick(21_000, [op({ idleMs: 5_000 })])).toHaveLength(1)
  })

  it('re-nudges after 2 minutes while still unread', () => {
    const s = new NudgeScheduler()
    s.tick(15_000, [op()])
    expect(s.tick(134_000, [op()])).toEqual([])
    expect(s.tick(135_000, [op()])).toHaveLength(1)
    expect(s.tick(136_000, [op()])).toEqual([])
  })

  it('batches several messages into one line with the count', () => {
    const s = new NudgeScheduler()
    expect(s.tick(30_000, [op({ unread: 3, newestUnreadAt: 14_000 })])).toEqual([{ key: 1, kind: 'nudge', line: nudgeLine(3) }])
  })

  it('nudges a new batch that arrives after a nudge, and resets once the inbox is read', () => {
    const s = new NudgeScheduler()
    s.tick(15_000, [op()])
    expect(s.tick(40_000, [op({ unread: 2, newestUnreadAt: 20_000 })])).toHaveLength(1)
    s.tick(41_000, [op({ unread: 0 })])
    expect(s.tick(60_000, [op({ newestUnreadAt: 45_000 })])).toHaveLength(1)
  })

  it('skips the batch delay for urgent messages', () => {
    const s = new NudgeScheduler()
    expect(s.tick(1_000, [op({ newestUnreadAt: 900, urgent: true })])).toHaveLength(1)
  })

  it('does nothing for shell or codex, stopped, paused or zero unread', () => {
    const s = new NudgeScheduler()
    const states = [
      op({ key: 1, agent: 'shell' }),
      op({ key: 2, agent: 'codex' }),
      op({ key: 3, idleMs: null }),
      op({ key: 4, paused: true }),
      op({ key: 5, unread: 0 }),
    ]
    expect(s.tick(60_000, states)).toEqual([])
  })

  it('types /clear once per finished job, only when idle, enabled, and no job is doing', () => {
    const s = new NudgeScheduler()
    const base = { unread: 0, clearBetweenJobs: true, jobFinishedAt: 1_000 }
    expect(s.tick(2_000, [op({ ...base, idleMs: 2_000 })])).toEqual([])
    expect(s.tick(2_000, [op({ ...base, hasDoingJob: true })])).toEqual([])
    expect(s.tick(2_000, [op({ ...base, clearBetweenJobs: false })])).toEqual([])
    expect(s.tick(2_000, [op({ ...base, agent: 'codex' })])).toEqual([])
    expect(s.tick(2_000, [op({ ...base, paused: true })])).toEqual([])
    expect(s.tick(2_000, [op(base)])).toEqual([{ key: 1, kind: 'clear', line: '/clear' }])
    expect(s.tick(3_000, [op(base)])).toEqual([])
    expect(s.tick(9_000, [op({ ...base, jobFinishedAt: 8_000 })])).toHaveLength(1)
  })

  it('sends /clear before a nudge, never both in one tick', () => {
    const s = new NudgeScheduler()
    const st = op({ clearBetweenJobs: true, jobFinishedAt: 1_000 })
    expect(s.tick(30_000, [st]).map((a) => a.kind)).toEqual(['clear'])
    expect(s.tick(30_001, [st]).map((a) => a.kind)).toEqual(['nudge'])
  })

  it('honours changed config', () => {
    const s = new NudgeScheduler()
    s.setConfig({ nudgeIdleSeconds: 20 })
    expect(s.tick(60_000, [op({ idleMs: 10_000 })])).toEqual([])
  })
})
