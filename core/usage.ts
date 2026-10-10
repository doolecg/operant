
export const DEFAULT_COLD_THRESHOLD_PCT = 50

// Ruling R2: a turn is cold when cache writes exceed the threshold share of its context, it is not the
// session's first turn (`prevContext` null), and the context did not fall by more than half against the
// previous turn (that looks like a compaction, whose transcript marker is unknown).
export function isColdTurn(
  turn: { contextTokens: number; cacheWriteTokens: number },
  prevContext: number | null,
  thresholdPct = DEFAULT_COLD_THRESHOLD_PCT,
): boolean {
  if (prevContext == null || turn.contextTokens <= 0) return false
  if (turn.contextTokens < prevContext * 0.5) return false
  return turn.cacheWriteTokens * 100 > turn.contextTokens * thresholdPct
}
