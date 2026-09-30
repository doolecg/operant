// Anthropic first-party list prices, USD per million tokens (as of 2026-09).
// Spend shown in Operant is an estimate from transcript usage, not a bill.
interface Rate {
  input: number
  output: number
  cacheRead?: number
}

const RATES: Array<[prefix: string, rate: Rate]> = [
  ['claude-fable-5', { input: 10, output: 50, cacheRead: 0.25 }],
  ['claude-mythos-5', { input: 10, output: 50, cacheRead: 0.25 }],
  ['claude-opus-5-5', { input: 4, output: 20, cacheRead: 0.2 }],
  ['claude-opus-5', { input: 5, output: 25 }],
  ['claude-opus-4', { input: 5, output: 25 }],
  ['claude-sonnet-5-5', { input: 2, output: 10, cacheRead: 0.2 }],
  ['claude-sonnet-5', { input: 2, output: 10 }],
  ['claude-sonnet-4', { input: 3, output: 15 }],
  ['claude-haiku-4', { input: 1, output: 5 }],
]

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWrite5mTokens: number
  cacheWrite1hTokens: number
}

// Longest matching prefix wins, so claude-opus-5-5 beats claude-opus-5.
export function rateFor(model: string): Rate | null {
  let best: [string, Rate] | null = null
  for (const entry of RATES) if (model.startsWith(entry[0]) && (!best || entry[0].length > best[0].length)) best = entry
  return best?.[1] ?? null
}

export function costUsd(model: string, u: TokenUsage): number {
  const r = rateFor(model)
  if (!r) return 0
  const cacheRead = r.cacheRead ?? r.input * 0.1
  return (
    (u.inputTokens * r.input +
      u.outputTokens * r.output +
      u.cacheReadTokens * cacheRead +
      u.cacheWrite5mTokens * r.input * 1.25 +
      u.cacheWrite1hTokens * r.input * 2) /
    1_000_000
  )
}
