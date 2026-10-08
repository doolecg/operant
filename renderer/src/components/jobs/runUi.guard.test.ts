import { describe, expect, it } from 'vitest'
import type { RunEvent } from '@shared/types'
import { guardForLatestReview } from './runUi'

const ev = (id: number, kind: RunEvent['kind'], body = ''): RunEvent => ({ id, runId: 1, at: id, kind, source: 'system', body, options: [], readAt: null })
const GUARD = 'No seat subagent was used'

describe('guardForLatestReview', () => {
  it('shows a guard written after the latest review', () => {
    expect(guardForLatestReview([ev(1, 'review'), ev(2, 'guard', GUARD)])).toBe(true)
  })
  it('ignores a guard from an older review round after send-back', () => {
    expect(guardForLatestReview([ev(1, 'review'), ev(2, 'guard', GUARD), ev(3, 'sent-back'), ev(4, 'review')])).toBe(false)
    expect(guardForLatestReview([ev(1, 'review'), ev(2, 'guard', GUARD), ev(3, 'sent-back'), ev(4, 'review'), ev(5, 'guard', GUARD)])).toBe(true)
  })
  it('is off without a guard', () => {
    expect(guardForLatestReview([ev(1, 'review')])).toBe(false)
  })
})
