import { describe, expect, it } from 'vitest'
import { clearNotices, getNotices, markNoticesRead, notify } from './notices'

describe('notices', () => {
  it('keeps the newest first, counts unread, and marks them read', () => {
    clearNotices()
    notify('first')
    notify('second', 'error')
    expect(getNotices().list.map((n) => n.text)).toEqual(['second', 'first'])
    expect(getNotices().list[0]).toMatchObject({ level: 'error' })
    expect(getNotices().unread).toBe(2)
    markNoticesRead()
    expect(getNotices().unread).toBe(0)
    expect(getNotices().list).toHaveLength(2)
  })

  it('caps the list at 100 and clears it', () => {
    clearNotices()
    for (let i = 0; i < 105; i++) notify(`n${i}`)
    expect(getNotices().list).toHaveLength(100)
    expect(getNotices().list[0]!.text).toBe('n104')
    clearNotices()
    expect(getNotices()).toEqual({ list: [], unread: 0 })
  })
})
