import { describe, expect, it } from 'vitest'
import { agentCounts, clockText, dateText, fullDateTime, isMediaCommand, isoWeek, monthGrid } from './media'

// Local time on purpose: the helpers format in the viewer's zone.
const d = new Date(2026, 9, 7, 14, 5, 9)

describe('clock formatting', () => {
  it('shows 24 hour and 12 hour times, with optional seconds', () => {
    expect(clockText(d, { format: '24', seconds: false }, 'en-GB')).toBe('14:05')
    expect(clockText(d, { format: '24', seconds: true }, 'en-GB')).toBe('14:05:09')
    expect(clockText(d, { format: '12', seconds: false }, 'en-GB')).toMatch(/^0?2:05\s?pm$/i)
    expect(clockText(d, { format: '12', seconds: true }, 'en-US')).toMatch(/^0?2:05:09\s?PM$/)
  })
  it('follows the locale in auto', () => {
    expect(clockText(d, { format: 'auto', seconds: false }, 'en-US')).toMatch(/PM$/)
    expect(clockText(d, { format: 'auto', seconds: false }, 'de-DE')).toBe('14:05')
  })
  it('formats the date as a short weekday, day and short month', () => {
    expect(dateText(d, 'en-GB')).toBe('Wed 7 Oct')
  })
  it('builds the text a click copies', () => {
    expect(fullDateTime(d, { format: '24' }, 'en-GB')).toMatch(/^Wednesday,? 7 October 2026, 14:05:09$/)
  })
})

describe('calendar', () => {
  it('numbers ISO weeks', () => {
    expect(isoWeek(new Date(2026, 9, 7))).toBe(41)
    expect(isoWeek(new Date(2026, 0, 1))).toBe(1)
    expect(isoWeek(new Date(2021, 0, 3))).toBe(53)
  })
  it('lays out a Monday-first month with week numbers', () => {
    const g = monthGrid(new Date(2026, 9, 7))
    expect(g[0]!.days).toEqual([null, null, null, 1, 2, 3, 4])
    expect(g[0]!.week).toBe(40)
    expect(g.at(-1)!.days.filter(Boolean).at(-1)).toBe(31)
    expect(g.every((w) => w.days.length === 7)).toBe(true)
  })
})

describe('agent counts', () => {
  it('counts running, idle, waiting, and done since midnight', () => {
    const runs = [
      { status: 'working' },
      { status: 'working' },
      { status: 'queued' },
      { status: 'needs-you' },
      { status: 'review' },
      { status: 'done', finishedAt: 2000 },
      { status: 'done', finishedAt: 500 },
      { status: 'failed', finishedAt: 2000 },
    ]
    expect(agentCounts(runs, 1000)).toEqual({ running: 2, idle: 1, done: 1, waiting: 2 })
    expect(agentCounts([], 1000)).toEqual({ running: 0, idle: 0, done: 0, waiting: 0 })
  })
})

describe('media commands', () => {
  it('accepts the whitelist only', () => {
    for (const c of ['toggle', 'next', 'prev', 'shuffle', 'focus', 'vol 0', 'vol 1', 'vol 0.25', 'vol .5']) expect(isMediaCommand(c)).toBe(true)
    for (const c of ['vol 2', 'vol -1', 'vol 1.5', 'exit', 'toggle ', 'vol 0.5\nfocus', 3]) expect(isMediaCommand(c)).toBe(false)
  })
})
