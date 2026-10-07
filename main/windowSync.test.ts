import { describe, expect, it } from 'vitest'
import { viewportStale } from './windowSync'

describe('viewportStale', () => {
  const content = { width: 2560, height: 1385 }
  it('accepts a page that fills the window at any zoom', () => {
    expect(viewportStale(content, { width: 2560, height: 1385 }, 1)).toBe(false)
    expect(viewportStale(content, { width: 1651, height: 893 }, 1.55)).toBe(false)
    expect(viewportStale(content, { width: 1463, height: 792 }, 1.75)).toBe(false)
  })
  it('flags a page laid out for the old, smaller window', () => {
    expect(viewportStale(content, { width: 1127, height: 720 }, 1)).toBe(true)
    expect(viewportStale(content, { width: 1127, height: 893 }, 1.55)).toBe(true)
  })
  it('ignores a page larger than the window and unknown sizes', () => {
    expect(viewportStale({ width: 1000, height: 600 }, { width: 1200, height: 700 }, 1)).toBe(false)
    expect(viewportStale({ width: 0, height: 0 }, { width: 100, height: 100 }, 1)).toBe(false)
  })
})
