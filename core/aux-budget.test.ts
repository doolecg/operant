import { describe, expect, it } from 'vitest'
import { DEFAULT_AUX_MODELS, DEFAULT_AUX_SETTINGS, type AuxSettings } from '../shared/aux-settings'
import { DEFAULT_LEARN_SETTINGS } from '../shared/learn'
import { AuxBudget, AuxLimitError, resolveAux, type AuxStore } from './aux-budget'

const DAY1 = new Date(2026, 9, 9, 12).getTime()
const DAY2 = new Date(2026, 9, 10, 12).getTime()

function budget(cfg: Partial<AuxSettings> = {}, now = { t: DAY1 }, store?: AuxStore) {
  const sleeps: number[] = []
  let settings: AuxSettings = { ...DEFAULT_AUX_SETTINGS, backoffMs: 10, ...cfg }
  const b = new AuxBudget({
    now: () => now.t,
    sleep: async (ms) => void sleeps.push(ms),
    settings: () => settings,
    store,
  })
  return { b, sleeps, setSettings: (s: Partial<AuxSettings>) => (settings = { ...settings, ...s }) }
}

describe('resolveAux', () => {
  it('follows the learn settings unless a task names its own CLI', () => {
    const learn = { ...DEFAULT_LEARN_SETTINGS, cli: 'claude' as const, model: '', effort: '', localUrl: 'http://127.0.0.1:1234' }
    expect(resolveAux('extraction', DEFAULT_AUX_MODELS, learn)).toEqual({ cli: 'claude', model: '', effort: '', localUrl: 'http://127.0.0.1:1234' })
    const models = { ...DEFAULT_AUX_MODELS, retrieval: { cli: 'local' as const, model: 'qwen', effort: '', localUrl: '' } }
    expect(resolveAux('retrieval', models, learn)).toMatchObject({ cli: 'local', model: 'qwen', localUrl: 'http://127.0.0.1:1234' })
  })
})

describe('AuxBudget', () => {
  it('counts calls, tokens and spend per feature', async () => {
    const { b } = budget()
    await b.call('learn.extraction', async () => ({ text: 'ok', tokens: 120, usd: 0.01 }))
    await b.call('learn.test', async () => ({ text: 'ok', tokens: 5 }))
    const s = b.status()
    expect(s.total).toEqual({ calls: 2, tokens: 125, usd: 0.01 })
    expect(s.features['learn.extraction']).toEqual({ calls: 1, tokens: 120, usd: 0.01 })
    expect(s.blocked).toBeNull()
  })

  it('stops at the daily call limit with a local-limit label, and starts again the next day', async () => {
    const now = { t: DAY1 }
    const { b } = budget({ maxCallsPerDay: 2 }, now)
    await b.call('f', async () => ({ text: 'a' }))
    await b.call('f', async () => ({ text: 'b' }))
    await expect(b.call('f', async () => ({ text: 'c' }))).rejects.toMatchObject({ label: 'local limit' })
    expect(b.status()).toMatchObject({ label: 'local limit', blocked: expect.stringContaining('2 model calls') })
    now.t = DAY2
    expect(await b.call('f', async () => ({ text: 'd' }))).toEqual({ text: 'd' })
    expect(b.status().total.calls).toBe(1)
  })

  it('stops at the daily spend limit', async () => {
    const { b } = budget({ maxUsdPerDay: 0.5 })
    await b.call('f', async () => ({ text: 'a', usd: 0.5 }))
    await expect(b.call('f', async () => ({ text: 'b' }))).rejects.toBeInstanceOf(AuxLimitError)
  })

  it('retries a transient failure with exponential backoff, up to the retry limit', async () => {
    const { b, sleeps } = budget({ retryLimit: 2, backoffMs: 10 })
    let n = 0
    const r = await b.call('f', async (attempt) => {
      n++
      if (attempt < 2) throw new Error(`flaky ${attempt}`)
      return { text: 'finally' }
    })
    expect(r.text).toBe('finally')
    expect(n).toBe(3)
    expect(sleeps).toEqual([10, 20])
    expect(b.status().total.calls).toBe(3)
  })

  it('does not retry the same failure twice in a row', async () => {
    const { b } = budget({ retryLimit: 5 })
    let n = 0
    await expect(
      b.call('f', async () => {
        n++
        throw new Error('bad input')
      }),
    ).rejects.toThrow('bad input')
    expect(n).toBe(2)
  })

  it('stops at once on a provider rate or quota limit, labels it, and refuses the rest of the day', async () => {
    const { b, sleeps } = budget({ retryLimit: 3 })
    let n = 0
    const err = await b
      .call('f', async () => {
        n++
        throw new Error('Rate limit reached for requests')
      })
      .catch((e: unknown) => e)
    expect(err).toMatchObject({ label: 'provider limit' })
    expect(n).toBe(1)
    expect(sleeps).toEqual([])
    expect(b.status()).toMatchObject({ label: 'provider limit', lastError: 'Rate limit reached for requests' })
    await expect(b.call('f', async () => ({ text: 'x' }))).rejects.toMatchObject({ label: 'provider limit' })
  })

  it('asks first when onLimit is confirm, and goes through when the owner confirms', async () => {
    const { b } = budget({ maxCallsPerDay: 1, onLimit: 'confirm' })
    await b.call('f', async () => ({ text: 'a' }))
    const err = await b.call('f', async () => ({ text: 'b' })).catch((e: unknown) => e)
    expect(err).toMatchObject({ label: 'local limit', needsConfirm: true })
    expect(await b.call('f', async () => ({ text: 'c' }), { confirm: true })).toEqual({ text: 'c' })
  })

  it('keeps its counts across a restart when given a store', async () => {
    let saved: unknown = null
    const store: AuxStore = { load: () => saved, save: (v) => (saved = JSON.parse(JSON.stringify(v))) }
    const first = budget({}, { t: DAY1 }, store).b
    await first.call('learn', async () => ({ text: 'a', tokens: 40 }))
    const again = budget({}, { t: DAY1 }, store).b
    expect(again.status().total).toEqual({ calls: 1, tokens: 40, usd: 0 })
  })
})
