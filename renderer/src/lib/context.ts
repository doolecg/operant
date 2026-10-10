import type { ClaudeSessionStatus } from '@shared/claude-mods'

// The context window of a Claude tile, segmented from the status line's real numbers. Segments are only those the
// status line reports: new input, cache read, cache write and free. With no per-kind usage, the bar shows used and free.
export interface ContextSegment {
  key: 'input' | 'cacheRead' | 'cacheWrite' | 'used' | 'free'
  label: string
  tokens: number
  pct: number
}

export interface ContextView {
  size: number
  used: number
  // The percent to show: the status line's used_percentage when it reported one.
  pct: number
  segments: ContextSegment[]
  // True when the per-kind usage is known (the segments are real, not just used and free).
  breakdown: boolean
  // The token count auto-compaction runs at, when the tile's context cap is known.
  compactAt: number | null
}

export function contextView(status: ClaudeSessionStatus | null | undefined, compactAt: number | null): ContextView | null {
  const size = status?.contextWindowSize
  if (!status || size === undefined || size <= 0) return null
  const u = status.currentUsage
  const reported = status.usedPercentage
  const seg = (key: ContextSegment['key'], label: string, tokens: number): ContextSegment => ({ key, label, tokens, pct: (tokens / size) * 100 })
  if (u && (u.inputTokens !== undefined || u.cacheReadTokens !== undefined || u.cacheCreationTokens !== undefined)) {
    const input = u.inputTokens ?? 0
    const read = u.cacheReadTokens ?? 0
    const write = u.cacheCreationTokens ?? 0
    const used = input + read + write
    return {
      size,
      used,
      pct: reported ?? (used / size) * 100,
      segments: [seg('input', 'new input', input), seg('cacheRead', 'cache read', read), seg('cacheWrite', 'cache write', write), seg('free', 'free', Math.max(0, size - used))],
      breakdown: true,
      compactAt,
    }
  }
  if (reported === undefined) return null
  const used = Math.round((size * reported) / 100)
  return {
    size,
    used,
    pct: reported,
    segments: [seg('used', 'used', used), seg('free', 'free', Math.max(0, size - used))],
    breakdown: false,
    compactAt,
  }
}
