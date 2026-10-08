import { describe, expect, it } from 'vitest'
import { BOARD_COLUMNS, columnOf, inboxItems, parseSeen, pruneSeen } from './board'
import type { Run, RunStatus } from './types'

const run = (o: Partial<Run> & { id: number }): Run =>
  ({
    crewId: 1,
    task: 't',
    masterCli: 'claude',
    masterModel: '',
    masterEffort: '',
    teamId: null,
    seats: [],
    limits: {},
    rules: '',
    status: 'queued',
    outcome: '',
    createdAt: 1000,
    startedAt: null,
    finishedAt: null,
    mode: 'master',
    waiting: '',
    question: '',
    questionOptions: [],
    reviewSummary: '',
    sentBackNote: '',
    ackedAt: null,
    approvedAt: null,
    approvedBy: null,
    closeoutState: '',
    sendBacks: 0,
    ...o,
  }) as unknown as Run

describe('columnOf', () => {
  it('maps every status', () => {
    const want: Record<RunStatus, string> = {
      queued: 'queued',
      working: 'working',
      'needs-you': 'needs-you',
      review: 'review',
      done: 'done',
      failed: 'done',
    }
    for (const [s, c] of Object.entries(want)) expect(columnOf({ status: s as RunStatus })).toBe(c)
  })

  it('every result is one of the five columns', () => {
    for (const s of ['queued', 'working', 'needs-you', 'review', 'done', 'failed'] as const) expect(BOARD_COLUMNS).toContain(columnOf({ status: s }))
  })
})

describe('inboxItems', () => {
  const none = new Set<number>()

  it('ignores queued, working and done runs', () => {
    const runs = [run({ id: 1, status: 'queued' }), run({ id: 2, status: 'working' }), run({ id: 3, status: 'done' })]
    expect(inboxItems(runs, none)).toEqual([])
  })

  it('a needs-you run maps by what it waits for', () => {
    const items = inboxItems(
      [
        run({ id: 1, status: 'needs-you', waiting: 'question', question: 'Which database?\nmore', startedAt: 10 }),
        run({ id: 2, status: 'needs-you', waiting: 'permission', startedAt: 20 }),
        run({ id: 3, status: 'needs-you', waiting: 'master', startedAt: 30 }),
        run({ id: 4, status: 'needs-you', waiting: '', question: '', startedAt: 40 }),
      ],
      none,
    )
    expect(items.map((i) => i.kind)).toEqual(['question', 'permission', 'master', 'question'])
    expect(items[0]).toEqual({ runId: 1, kind: 'question', text: 'Which database?', at: 10 })
    expect(items[3]!.text).toBe('Waiting for your answer')
  })

  it('a review run uses the first line of its summary', () => {
    const [i] = inboxItems([run({ id: 5, status: 'review', reviewSummary: '## Done\n\nAll good', finishedAt: 50 })], none)
    expect(i).toEqual({ runId: 5, kind: 'review', text: 'Done', at: 50 })
    expect(inboxItems([run({ id: 6, status: 'review' })], none)[0]!.text).toBe('Ready for your review')
  })

  it('failed runs show until seen', () => {
    const runs = [run({ id: 7, status: 'failed', outcome: 'Build broke', finishedAt: 5 })]
    expect(inboxItems(runs, none)).toEqual([{ runId: 7, kind: 'failed', text: 'Build broke', at: 5 }])
    expect(inboxItems(runs, new Set([7]))).toEqual([])
  })

  it('seen only hides failures, not other kinds', () => {
    expect(inboxItems([run({ id: 8, status: 'review', startedAt: 1 })], new Set([8]))).toHaveLength(1)
  })

  it('orders oldest first, ties by JOB#, and falls back to createdAt', () => {
    const items = inboxItems(
      [
        run({ id: 12, status: 'review', startedAt: 300 }),
        run({ id: 11, status: 'needs-you', waiting: 'permission', startedAt: 100 }),
        run({ id: 10, status: 'failed', createdAt: 200 }),
        run({ id: 9, status: 'needs-you', waiting: 'master', startedAt: 100 }),
      ],
      none,
    )
    expect(items.map((i) => i.runId)).toEqual([9, 11, 10, 12])
  })

  it('caps long text on one line', () => {
    const [i] = inboxItems([run({ id: 1, status: 'needs-you', waiting: 'question', question: 'x'.repeat(500) })], none)
    expect(i!.text.length).toBe(160)
    expect(i!.text.endsWith('…')).toBe(true)
  })

  it('does not reorder the runs it is given', () => {
    const runs = [run({ id: 2, status: 'review', startedAt: 9 }), run({ id: 1, status: 'review', startedAt: 1 })]
    inboxItems(runs, none)
    expect(runs.map((r) => r.id)).toEqual([2, 1])
  })
})

describe('seen list', () => {
  it('parses stored ids and ignores junk', () => {
    expect(parseSeen('[20001,20002]')).toEqual([20001, 20002])
    expect(parseSeen('[1,"x",2.5,null]')).toEqual([1])
    expect(parseSeen('nope')).toEqual([])
    expect(parseSeen('{"a":1}')).toEqual([])
    expect(parseSeen(null)).toEqual([])
  })

  it('prunes ids of deleted runs', () => {
    expect(pruneSeen([1, 2, 3], new Set([2, 3, 9]))).toEqual([2, 3])
  })
})
