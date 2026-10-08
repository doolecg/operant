import { describe, expect, it } from 'vitest'
import { draftKey, parseDraftKey, pruneDrafts } from './drafts'

describe('drafts', () => {
  it('formats keys', () => {
    expect(draftKey('approve', 42)).toBe('operant.draft.approve.42')
    expect(draftKey('newtask', 3)).toBe('operant.draft.newtask.3')
  })
  it('parses keys back and rejects others', () => {
    expect(parseDraftKey('operant.draft.sendback.7')).toEqual({ kind: 'sendback', id: 7 })
    expect(parseDraftKey('operant.draft.bogus.7')).toBeNull()
    expect(parseDraftKey('other.key')).toBeNull()
  })
  it('prunes drafts whose run is gone', () => {
    const keys = [draftKey('approve', 1), draftKey('answer', 2), draftKey('sendback', 3), 'unrelated']
    expect(pruneDrafts(keys, new Set([2]))).toEqual([draftKey('approve', 1), draftKey('sendback', 3)])
  })
  it('prunes newtask drafts by project set', () => {
    const keys = [draftKey('newtask', 1), draftKey('newtask', 2), draftKey('approve', 1)]
    expect(pruneDrafts(keys, new Set([1]), new Set([2]))).toEqual([draftKey('newtask', 1)])
  })
})

describe('drafts store', () => {
  it('sets, clears on submit, notifies and prunes', async () => {
    const s = await import('../renderer/src/lib/drafts')
    s.resetDraftsForTest()
    const key = draftKey('approve', 5)
    s.setDraftByKey(key, 'hello')
    expect(s.getDraft(key)).toBe('hello')
    s.setDraftByKey(draftKey('answer', 9), 'x')
    s.pruneStoredDrafts(new Set([5]))
    expect(s.getDraft(draftKey('answer', 9))).toBe('')
    expect(s.getDraft(key)).toBe('hello')
    s.clearDraftByKey(key)
    expect(s.getDraft(key)).toBe('')
  })
})
