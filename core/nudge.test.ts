import { describe, expect, it } from 'vitest'
import { fixedLine, isFixedLine, nudgeLine, NudgeScheduler, type NudgeOperatorState } from './nudge'

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
    expect(isFixedLine(fixedLine('owner'))).toBe(true)
    expect(fixedLine('owner')).toBe('Operant: the owner wrote in Discord. Run: operant run inbox')
    for (const c of ['/compact', '/cost']) expect(isFixedLine(c)).toBe(true)
    for (const c of ['/compact now', '/model', '/Compact', '/cost\n/exit']) expect(isFixedLine(c)).toBe(false)
    expect(isFixedLine(`${nudgeLine(2)}\nrm x`)).toBe(false)
  })
})

describe('pointer lines (the Master gate vocabulary)', () => {
  const kinds = ['new', 'sent-back', 'answer', 'approved', 'stopped', 'resume', 'next', 'owner'] as const

  it('builds one short line per kind that the validator accepts', () => {
    expect(fixedLine('new', 20003)).toBe('Operant: new task JOB#20003. Run: operant run show 20003')
    expect(fixedLine('approved', 20003)).toBe('Operant: the owner approved JOB#20003. Run: operant run closeout 20003')
    for (const k of kinds) {
      const line = fixedLine(k, 123456789)
      expect(isFixedLine(line), line).toBe(true)
      expect(line.length).toBeLessThan(80)
      expect(line).not.toMatch(/[\r\n\t\x1b]/)
    }
  })

  it('rejects free text, mismatched numbers and ids that are not JOB# numbers', () => {
    expect(() => fixedLine('new', 12)).toThrow()
    expect(() => fixedLine('new', 1.5)).toThrow()
    expect(() => fixedLine('new', Number.NaN)).toThrow()
    expect(isFixedLine('Operant: new task JOB#20003. Run: operant run show 20004')).toBe(false)
    expect(isFixedLine('Operant: new task JOB#20003. Run: operant run show 20003 && rm -rf /')).toBe(false)
    expect(isFixedLine('Operant: new task JOB#20003. Run: operant run show 20003\r')).toBe(false)
    expect(isFixedLine('Operant: the owner said "delete it" on JOB#20003. Run: operant run answer 20003')).toBe(false)
    expect(isFixedLine('Operant: new task JOB#0020003. Run: operant run show 0020003')).toBe(false)
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
