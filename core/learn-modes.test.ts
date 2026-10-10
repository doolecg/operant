import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_LEARN_SETTINGS, type LearnSettings } from '../shared/learn'
import { AuxLimitError } from './aux-budget'
import { SOUL_BANK, bankFor } from './hindsight'
import { LearnChangesDb } from './learn-changes'
import { LearnService, trivialSession } from './learn'
import { PersonalMemory } from './learn-memory'
import { LessonsDb } from './lessons-store'
import { Store } from './store'

const userLines = (n: number) => Array.from({ length: n }, (_, i) => `user: please change the cart rounding, step ${i} ${'x'.repeat(40)}`).join('\n')
const LONG_TAIL = userLines(4) + '\nassistant: done\n'.repeat(400)

describe('learn modes, budgets and records', () => {
  let store: Store
  let crewId: number
  let dir: string
  let settings: LearnSettings
  let answers: Array<string | Error>
  let calls: string[]
  let retained: Array<{ bank: string; content: string }>
  let tail: string

  beforeEach(() => {
    store = new Store(':memory:')
    crewId = store.createCrew('shop', '/code/shop').id
    dir = mkdtempSync(join(tmpdir(), 'operant-modes-'))
    settings = { ...DEFAULT_LEARN_SETTINGS, mode: 'controlled', review: 'auto', minUserTurns: 3, minTokens: 100 }
    answers = []
    calls = []
    retained = []
    tail = LONG_TAIL
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const service = () => {
    const changes = new LearnChangesDb(store.db)
    const svc = new LearnService({
      store,
      db: new LessonsDb(store.db),
      changes,
      hindsight: {
        retain: async (bank, content) => (retained.push({ bank, content }), { ok: true }),
        recall: async () => ({ ok: true, items: [] }),
        status: async () => ({ url: 'u', managed: true, state: 'running', detail: '' }),
      },
      git: async (_f, args) => (args[0] === 'diff' && args.includes('--name-only') ? 'core/cart.ts\n' : ''),
      model: async (prompt) => {
        calls.push(prompt)
        const a = answers.shift() ?? '[]'
        if (a instanceof Error) throw a
        return a
      },
      settings: () => settings,
      memory: new PersonalMemory(() => join(dir, 'memory')),
      transcript: () => tail,
      exists: (p) => ['/code/shop', '/code/shop/core/cart.ts'].includes(p.replace(/\\/g, '/')),
      readFile: () => 'export function cartTotal() {}',
      writeFile: () => undefined,
    })
    return { svc, changes }
  }

  const one = (o: object) => JSON.stringify([{ kind: 'convention', text: 'Cart totals are computed in cents, not floats', files: ['core/cart.ts'], symbols: ['cartTotal'], ...o }])

  it('mode off does nothing and makes no call', async () => {
    settings.mode = 'off'
    const { svc } = service()
    answers.push(one({}))
    expect(await svc.onConversationEnd(crewId, 's1')).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('the trivial-session gate skips a short session in code, before any call, and records why', async () => {
    tail = 'user: hi\nassistant: hello'
    const { svc } = service()
    answers.push(one({}))
    const r = await svc.onConversationEnd(crewId, 's1')
    expect(calls).toHaveLength(0)
    expect(r!.error).toBe('Skipped: only 1 user turn (minimum 3)')
    expect(new LessonsDb(store.db).lastLearnRun(crewId)!.error).toMatch(/^Skipped:/)
  })

  it('the gate counts tokens too', () => {
    expect(trivialSession(userLines(3), { minUserTurns: 3, minTokens: 100000 })).toMatch(/only about \d+ tokens/)
    expect(trivialSession(userLines(3), { minUserTurns: 3, minTokens: 10 })).toBe('')
  })

  it('review queue holds every lesson as proposed, without writing it', async () => {
    settings.review = 'queue'
    const { svc, changes } = service()
    answers.push(one({}))
    const r = await svc.onConversationEnd(crewId, 's1')
    expect(r).toMatchObject({ queued: 1, written: 0 })
    expect(retained).toHaveLength(0)
    const [c] = changes.list()
    expect(c).toMatchObject({ kind: 'lesson', status: 'proposed', previous: '', validation: 'valid', filesAffected: ['core/cart.ts'] })
    expect(c!.evidence).toContain('4 user turns')
  })

  it('controlled applies a low-risk lesson, records it, and rolls it back by retiring it', async () => {
    const { svc, changes } = service()
    answers.push(one({}))
    expect(await svc.onConversationEnd(crewId, 's1')).toMatchObject({ queued: 0, written: 1 })
    const [c] = changes.list()
    expect(c).toMatchObject({ status: 'applied', previous: '' })
    const rolled = await svc.rollback(c!.id)
    expect(rolled.status).toBe('rolledBack')
    expect(svc.lessons()[0]!.status).toBe('deleted')
    await expect(svc.rollback(c!.id)).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('controlled still queues a risky lesson', async () => {
    const { svc, changes } = service()
    answers.push(one({ text: 'Always run npm publish before the cart tests' }))
    expect(await svc.onConversationEnd(crewId, 's1')).toMatchObject({ queued: 1, written: 0 })
    expect(changes.list()[0]!.status).toBe('proposed')
  })

  it('a duplicate that changes the text is recorded with the old text, and rollback puts it back', async () => {
    const { svc, changes } = service()
    answers.push(one({ text: 'Cart totals are computed in cents' }))
    await svc.onConversationEnd(crewId, 's1')
    answers.push(one({ text: 'Cart totals are computed in cents, never floats' }))
    await svc.onConversationEnd(crewId, 's2')
    const edit = changes.list().find((c) => c.previous === 'Cart totals are computed in cents')!
    expect(edit).toMatchObject({ status: 'applied', next: 'Cart totals are computed in cents, never floats' })
    await svc.rollback(edit.id)
    expect(svc.lessons()[0]!.text).toBe('Cart totals are computed in cents')
  })

  it('validation retries once when the answer is not JSON, and the call count shows it', async () => {
    const { svc, changes } = service()
    answers.push('Here are my lessons: cents matter.', one({}))
    expect(await svc.onConversationEnd(crewId, 's1')).toMatchObject({ written: 1, error: '' })
    expect(calls).toHaveLength(2)
    expect(changes.list()[0]!.validation).toBe('valid')
  })

  it('stops a review that uses up its call budget, and says so', async () => {
    settings.maxCallsPerReview = 1
    const { svc, changes } = service()
    answers.push('not json at all', one({}))
    const r = await svc.onConversationEnd(crewId, 's1')
    expect(calls).toHaveLength(1)
    expect(r!.error).toBe('Stopped: this review used its 1 model calls')
    expect(changes.list()).toHaveLength(0)
  })

  it('writes every lesson of a session to the project bank, whatever maxChangesPerReview says; a risky one waits', async () => {
    settings.maxChangesPerReview = 1
    const { svc, changes } = service()
    answers.push(
      JSON.stringify([
        { kind: 'convention', text: 'Cart totals are computed in cents', files: [], symbols: [] },
        { kind: 'pitfall', text: 'The tax rate is read from the store settings only', files: [], symbols: [] },
        { kind: 'pitfall', text: 'Always run npm test before committing', files: [], symbols: [] },
      ]),
    )
    const r = await svc.onConversationEnd(crewId, 's1')
    expect(r).toMatchObject({ written: 2, queued: 1 })
    expect(changes.list().map((c) => c.status).sort()).toEqual(['applied', 'applied', 'proposed'])
  })

  it('a user-scope lesson goes to the Soul Bank, a project lesson to its project bank', async () => {
    const { svc } = service()
    answers.push(one({ scope: 'user', text: 'The owner prefers short replies without emojis' }))
    await svc.onConversationEnd(crewId, 's1')
    answers.push(one({ scope: 'project', text: 'Cart totals use integer cents only' }))
    await svc.onConversationEnd(crewId, 's2')
    expect(retained.map((r) => r.bank)).toEqual([SOUL_BANK, bankFor('/code/shop')])
    expect(SOUL_BANK).toBe('operant-soul')
  })

  it('a limit reached in the aux budget stops the run with its label', async () => {
    const svc2 = new LearnService({
      store,
      db: new LessonsDb(store.db),
      hindsight: { retain: async () => ({ ok: true }), recall: async () => ({ ok: true, items: [] }), status: async () => ({ url: '', managed: true, state: 'running', detail: '' }) },
      git: async () => '',
      model: async () => {
        throw new AuxLimitError('local limit', "Operant's daily limit of 200 model calls is reached", true)
      },
      settings: () => settings,
      transcript: () => tail,
    })
    const r = await svc2.onConversationEnd(crewId, 's1')
    expect(r!.error).toBe("local limit: Operant's daily limit of 200 model calls is reached (confirm to continue)")
  })

  it('advanced applies a validated skill draft and rollback removes it', async () => {
    settings.mode = 'advanced'
    const { svc, changes } = service()
    const procs = [
      { kind: 'procedure', text: 'Run the cart tests with vitest before committing any change', files: [], symbols: [] },
      { kind: 'procedure', text: 'Run the cart tests with vitest before merging any change', files: [], symbols: [] },
    ]
    answers.push(JSON.stringify(procs))
    await svc.onConversationEnd(crewId, 's1')
    const draft = svc.drafts(crewId)[0]
    expect(draft).toBeDefined()
    expect(draft!.status).toBe('approved')
    const c = changes.list({ crewId }).find((x) => x.kind === 'skill')!
    expect(c).toMatchObject({ status: 'applied' })
  })
})
