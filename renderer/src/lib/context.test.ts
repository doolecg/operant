import { describe, expect, it } from 'vitest'
import { contextView } from './context'

describe('contextView', () => {
  it('segments the window into new input, cache read, cache write and free from the status line', () => {
    const v = contextView({ updatedAt: 1, contextWindowSize: 1_000_000, usedPercentage: 9, currentUsage: { inputTokens: 1000, cacheReadTokens: 80_000, cacheCreationTokens: 9_000 } }, 987_000)
    expect(v).toMatchObject({ size: 1_000_000, used: 90_000, pct: 9, breakdown: true, compactAt: 987_000 })
    expect(v!.segments.map((s) => [s.key, s.tokens])).toEqual([
      ['input', 1000],
      ['cacheRead', 80_000],
      ['cacheWrite', 9_000],
      ['free', 910_000],
    ])
  })

  it('shows only used and free when no per-kind usage is reported, and omits the compaction point when unknown', () => {
    const v = contextView({ updatedAt: 1, contextWindowSize: 200_000, usedPercentage: 50 }, null)
    expect(v).toMatchObject({ used: 100_000, breakdown: false, compactAt: null })
    expect(v!.segments.map((s) => s.key)).toEqual(['used', 'free'])
  })

  it('is null with no window or no usage figure, so nothing is invented', () => {
    expect(contextView(null, null)).toBeNull()
    expect(contextView({ updatedAt: 1 }, null)).toBeNull()
    expect(contextView({ updatedAt: 1, contextWindowSize: 200_000 }, null)).toBeNull()
  })
})
