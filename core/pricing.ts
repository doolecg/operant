// Anthropic first-party list prices, USD per million tokens (as of 2026-09).
// Spend shown in Operant is an estimate from transcript usage, not a bill.
interface Rate {
  input: number
  output: number
  cacheRead?: number
}

const RATES: Array<[prefix: string, rate: Rate]> = [
  ['claude-fable-5', { input: 10, output: 50, cacheRead: 0.25 }],
  ['claude-fable-5-1', { input: 10, output: 50, cacheRead: 0.25 }],
  ['claude-mythos-5', { input: 10, output: 50, cacheRead: 0.25 }],
  ['claude-opus-5-5', { input: 4, output: 20, cacheRead: 0.2 }],
  ['claude-opus-5', { input: 5, output: 25 }],
  ['claude-opus-4', { input: 5, output: 25 }],
  ['claude-sonnet-5-5', { input: 2, output: 10, cacheRead: 0.2 }],
  ['claude-sonnet-5', { input: 2, output: 10 }],
  ['claude-sonnet-4', { input: 3, output: 15 }],
  // Haiku 5.5 launched 75% below Haiku 4.5 (2026-10).
  ['claude-haiku-5-5', { input: 0.25, output: 1.25, cacheRead: 0.025 }],
  ['claude-haiku-4', { input: 1, output: 5 }],
  ['claude-haiku-4-5', { input: 1, output: 5, cacheRead: 0.1 }],
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

// Models with no row are priced at the most expensive known family so caps still fire; callers show
// `isPriced` as an "unpriced model" flag.
const FALLBACK_RATE: Rate = { input: 10, output: 50, cacheRead: 0.25 }

export function isPriced(model: string): boolean {
  return rateFor(model) !== null
}

export function rateOrFallback(model: string): Rate {
  return rateFor(model) ?? FALLBACK_RATE
}

export function costUsd(model: string, u: TokenUsage): number {
  const r = rateOrFallback(model)
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
