import { describe, expect, it } from 'vitest'
import { costUsd, isPriced, rateFor } from './pricing'

const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 }

describe('pricing', () => {
  it('matches the most specific model prefix', () => {
    expect(rateFor('claude-opus-5-5')?.input).toBe(4)
    expect(rateFor('claude-opus-5')?.input).toBe(5)
    expect(rateFor('claude-opus-4-8')?.input).toBe(5)
    expect(rateFor('claude-sonnet-4-6')?.output).toBe(15)
    expect(rateFor('claude-haiku-4-5-20251001')?.input).toBe(1)
    expect(rateFor('claude-fable-5-1')).toEqual({ input: 10, output: 50, cacheRead: 0.25 })
    expect(rateFor('claude-haiku-4-5')).toEqual({ input: 1, output: 5, cacheRead: 0.1 })
    expect(rateFor('gpt-5')).toBeNull()
  })

  it('prices each token kind', () => {
    expect(costUsd('claude-opus-5-5', { ...zero, inputTokens: 1_000_000 })).toBeCloseTo(4)
    expect(costUsd('claude-opus-5-5', { ...zero, outputTokens: 1_000_000 })).toBeCloseTo(20)
    expect(costUsd('claude-opus-5-5', { ...zero, cacheReadTokens: 1_000_000 })).toBeCloseTo(0.2)
    expect(costUsd('claude-opus-5-5', { ...zero, cacheWrite5mTokens: 1_000_000 })).toBeCloseTo(5)
    expect(costUsd('claude-opus-5-5', { ...zero, cacheWrite1hTokens: 1_000_000 })).toBeCloseTo(8)
    expect(costUsd('claude-haiku-4-5', { ...zero, cacheReadTokens: 1_000_000 })).toBeCloseTo(0.1)
    expect(isPriced('claude-opus-5-5')).toBe(true)
    expect(isPriced('unknown')).toBe(false)
    // unpriced models use the most expensive known rate so caps still fire
    expect(costUsd('unknown', { ...zero, inputTokens: 1_000_000 })).toBeCloseTo(10)
    expect(costUsd('unknown', { ...zero, outputTokens: 1_000_000 })).toBeCloseTo(50)
  })
})
