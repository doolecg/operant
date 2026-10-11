import { describe, expect, it, vi } from 'vitest'
import type { BrowserConfirm, BrowserConfirmEnd } from '../../shared/browser'
import { ConfirmBroker } from './confirm'

const info = { crewId: 1, tileId: 5, tool: 'browser_click', summary: 'Click "Pay"' }

function setup(timeoutMs?: number) {
  let n = 0
  const broker = new ConfirmBroker({ ...(timeoutMs !== undefined ? { timeoutMs } : {}), newId: () => `c${++n}` })
  const requests: BrowserConfirm[] = []
  const ends: BrowserConfirmEnd[] = []
  broker.onRequest((c) => requests.push(c))
  broker.onEnd((e) => ends.push(e))
  return { broker, requests, ends }
}

describe('ConfirmBroker', () => {
  it('pushes the request and resolves true on allow', async () => {
    const { broker, requests, ends } = setup()
    const p = broker.request(info, new AbortController().signal)
    expect(requests).toEqual([{ id: 'c1', ...info }])
    expect(broker.pending(1)).toHaveLength(1)
    expect(broker.answer('c1', true)).toBe(true)
    await expect(p).resolves.toBe(true)
    expect(ends).toEqual([{ id: 'c1', crewId: 1, outcome: 'allowed' }])
    expect(broker.pending(1)).toHaveLength(0)
  })

  it('resolves false on deny, and ignores a second answer', async () => {
    const { broker, ends } = setup()
    const p = broker.request(info, new AbortController().signal)
    broker.answer('c1', false)
    await expect(p).resolves.toBe(false)
    expect(broker.answer('c1', true)).toBe(false)
    expect(ends.map((e) => e.outcome)).toEqual(['denied'])
  })

  it('refuses after the timeout', async () => {
    vi.useFakeTimers()
    try {
      const { broker, ends } = setup()
      const p = broker.request(info, new AbortController().signal)
      await vi.advanceTimersByTimeAsync(5 * 60_000 - 1)
      expect(broker.pending(1)).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(2)
      await expect(p).resolves.toBe(false)
      expect(ends[0]?.outcome).toBe('timeout')
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels when the call is aborted', async () => {
    const { broker, ends } = setup()
    const ac = new AbortController()
    const p = broker.request(info, ac.signal)
    ac.abort()
    await expect(p).resolves.toBe(false)
    expect(ends[0]?.outcome).toBe('cancelled')
    expect(broker.answer('c1', true)).toBe(false)
  })

  it('does not even ask for an already aborted call', async () => {
    const { broker, requests } = setup()
    const ac = new AbortController()
    ac.abort()
    await expect(broker.request(info, ac.signal)).resolves.toBe(false)
    expect(requests).toHaveLength(0)
  })

  it('lists only the project\'s own pending approvals and cancels per project', async () => {
    const { broker } = setup()
    const a = broker.request(info, new AbortController().signal)
    const b = broker.request({ ...info, crewId: 2 }, new AbortController().signal)
    expect(broker.pending(1).map((c) => c.id)).toEqual(['c1'])
    broker.cancelCrew(1)
    await expect(a).resolves.toBe(false)
    expect(broker.pending(2)).toHaveLength(1)
    broker.dispose()
    await expect(b).resolves.toBe(false)
  })

  describe('allow all', () => {
    const grant = async (b: ConfirmBroker) => {
      const p = b.request(info, new AbortController().signal)
      b.answer('c1', true, true)
      await p
    }
    const ask = (b: ConfirmBroker, over: Partial<typeof info> = {}) => b.request({ ...info, ...over }, new AbortController().signal)

    it('lets later requests of the same project and tile through unasked', async () => {
      const { broker, requests } = setup()
      await grant(broker)
      await expect(ask(broker)).resolves.toBe(true)
      expect(requests).toHaveLength(1)
      expect(broker.allowAllActive(1)).toBe(true)
    })

    it('does not cover another tile or project', async () => {
      const { broker, requests } = setup()
      await grant(broker)
      void ask(broker, { tileId: 6 })
      void ask(broker, { crewId: 2 })
      expect(requests).toHaveLength(3)
      broker.dispose()
    })

    it('also lets through requests already waiting for that tile', async () => {
      const { broker } = setup()
      const first = ask(broker)
      const second = ask(broker)
      broker.answer('c1', true, true)
      await expect(first).resolves.toBe(true)
      await expect(second).resolves.toBe(true)
    })

    it('ends on revokeTile, revokeCrew, revokeAll and cancelCrew', async () => {
      for (const end of [(b: ConfirmBroker) => b.revokeTile(5), (b: ConfirmBroker) => b.revokeCrew(1), (b: ConfirmBroker) => b.revokeAll(), (b: ConfirmBroker) => b.cancelCrew(1)]) {
        const { broker, requests } = setup()
        const changes: boolean[] = []
        broker.onGrants((_c, active) => changes.push(active))
        await grant(broker)
        end(broker)
        expect(broker.allowAllActive(1)).toBe(false)
        expect(changes).toEqual([true, false])
        void ask(broker)
        expect(requests).toHaveLength(2)
        broker.dispose()
      }
    })

    it('keeps the grant of another tile when one tile ends', async () => {
      const { broker } = setup()
      await grant(broker)
      broker.revokeTile(9)
      expect(broker.allowAllActive(1)).toBe(true)
    })

    it('still denies a plain deny, and a deny never grants', async () => {
      const { broker, requests } = setup()
      const p = ask(broker)
      broker.answer('c1', false, true)
      await expect(p).resolves.toBe(false)
      expect(broker.allowAllActive(1)).toBe(false)
      void ask(broker)
      expect(requests).toHaveLength(2)
      broker.dispose()
    })
  })
})
