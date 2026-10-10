import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_LEARN_SETTINGS } from '../shared/learn'
import { DEFAULT_AUX_MODELS, DEFAULT_MEMORY_SETTINGS, type MemorySettings } from '../shared/aux-settings'
import { AuxBudget } from './aux-budget'
import { SOUL_BANK, bankFor, type RecallResult } from './hindsight'
import { LearnService } from './learn'
import { PersonalMemory } from './learn-memory'
import { LessonsDb } from './lessons-store'
import { recallMemory } from './memory-recall'
import { exportMemory, memoryDiagnostics, resetMemory, type MemoryAdminDeps } from './memory-admin'
import { Store } from './store'

const FOLDER = '/code/shop'

describe('recallMemory', () => {
  const asked: Array<{ bank: string; limit: number }> = []
  const src = (answers: Record<string, RecallResult>) => ({
    recall: async (bank: string, _q: string, limit: number) => {
      asked.push({ bank, limit })
      return answers[bank] ?? { ok: true as const, items: [] }
    },
  })
  const cfg = (o: Partial<MemorySettings> = {}): MemorySettings => ({ ...DEFAULT_MEMORY_SETTINGS, ...o })
  beforeEach(() => (asked.length = 0))

  it('makes no recall at all when recall is off', async () => {
    const out = await recallMemory(src({}), FOLDER, 'cart', cfg({ recallMode: 'off' }))
    expect(asked).toHaveLength(0)
    expect(out).toMatchObject({ items: [], error: expect.stringContaining('off') })
  })

  it('reads the Soul Bank and the project bank, soul first', async () => {
    const out = await recallMemory(src({ [SOUL_BANK]: { ok: true, items: ['prefers short replies'] }, [bankFor(FOLDER)]: { ok: true, items: ['cart uses cents'] } }), FOLDER, 'cart', cfg())
    expect(out.items).toEqual([
      { bank: 'soul', text: 'prefers short replies' },
      { bank: 'project', text: 'cart uses cents' },
    ])
    expect(out.text).toBe('prefers short replies\n\ncart uses cents')
  })

  it('leaves the Soul Bank out when includeSoul is off', async () => {
    await recallMemory(src({}), FOLDER, 'cart', cfg({ includeSoul: false }))
    expect(asked.map((a) => a.bank)).toEqual([bankFor(FOLDER)])
  })

  it('keeps to topK items and to the token budget, and says it truncated', async () => {
    const many = Array.from({ length: 8 }, (_, i) => `memory ${i} ${'y'.repeat(100)}`)
    const top = await recallMemory(src({ [bankFor(FOLDER)]: { ok: true, items: many } }), FOLDER, 'cart', cfg({ includeSoul: false, topK: 3, maxTokens: 10000 }))
    expect(top.items).toHaveLength(3)
    expect(top.truncated).toBe(true)
    expect(asked[0]!.limit).toBe(3)
    const tight = await recallMemory(src({ [bankFor(FOLDER)]: { ok: true, items: many } }), FOLDER, 'cart', cfg({ includeSoul: false, topK: 8, maxTokens: 60 }))
    expect(tight.items.length).toBeLessThan(3)
    expect(tight.truncated).toBe(true)
  })

  it('reports the error when every bank fails, and a partial answer without one', async () => {
    const failing = await recallMemory(src({ [SOUL_BANK]: { ok: false, error: 'connection refused' }, [bankFor(FOLDER)]: { ok: false, error: 'connection refused' } }), FOLDER, 'cart', cfg())
    expect(failing).toMatchObject({ items: [], error: 'connection refused' })
    const partial = await recallMemory(src({ [SOUL_BANK]: { ok: false, error: 'down' }, [bankFor(FOLDER)]: { ok: true, items: ['ok'] } }), FOLDER, 'cart', cfg())
    expect(partial).toMatchObject({ items: [{ bank: 'project', text: 'ok' }], error: '' })
  })
})

describe('memory admin: export, reset and diagnostics', () => {
  let store: Store
  let crewId: number
  let learn: LearnService
  const retained: string[] = []
  const deleted: string[] = []
  let hindsightDown = false

  let memDir = ''
  beforeEach(() => {
    store = new Store(':memory:')
    memDir = mkdtempSync(join(tmpdir(), 'operant-memtest-'))
    crewId = store.createCrew('shop', FOLDER).id
    retained.length = 0
    deleted.length = 0
    hindsightDown = false
    learn = new LearnService({
      store,
      db: new LessonsDb(store.db),
      hindsight: {
        retain: async () => ({ ok: true }),
        recall: async () => ({ ok: true, items: ['one'] }),
        status: async () => ({ url: 'http://127.0.0.1:9077', managed: true, state: hindsightDown ? 'stopped' : 'running', detail: '' }),
      },
      git: async () => '',
      model: async () => '[]',
      settings: () => ({ ...DEFAULT_LEARN_SETTINGS, mode: 'controlled' }),
      memory: new PersonalMemory(() => memDir),
    })
    new LessonsDb(store.db).addLesson({ crewId, text: 'Cart totals use cents', kind: 'convention', scope: 'project', files: [], symbols: [], sourceJobs: [], status: 'active' })
    new LessonsDb(store.db).addLesson({ crewId, text: 'The owner likes short answers', kind: 'convention', scope: 'user', files: [], symbols: [], sourceJobs: [], status: 'active' })
  })
  afterEach(() => {
    store.close()
    rmSync(memDir, { recursive: true, force: true })
  })

  const deps = (): MemoryAdminDeps => ({
    learn,
    hindsight: {
      recall: async () => ({ ok: true, items: ['entry'] }),
      status: async () => ({ url: 'http://127.0.0.1:9077', managed: true, state: hindsightDown ? 'stopped' : 'running', detail: 'ok' }),
      test: async () => ({ url: '', ok: true, reachable: true, auth: 'ok', latencyMs: 1, info: '2 banks', open: true, error: '' }) as never,
      deleteBank: async (bank: string) => {
        if (hindsightDown) return { ok: false as const, error: 'unreachable' }
        deleted.push(bank)
        return { ok: true as const }
      },
    },
    crews: () => store.listCrews().map((c) => ({ id: c.id, name: c.name, folder: c.folder })),
    memory: () => DEFAULT_MEMORY_SETTINGS,
    learnMode: () => 'controlled',
    aux: new AuxBudget({ now: () => Date.now(), sleep: async () => undefined, settings: () => ({ maxCallsPerDay: 10, maxUsdPerDay: 0, retryLimit: 0, backoffMs: 0, onLimit: 'stop' }) }),
    now: () => Date.UTC(2026, 9, 9),
  })

  it('exports the lessons and what Hindsight holds, as one JSON document', async () => {
    const out = await exportMemory(deps())
    expect(out.filename).toBe('operant-memory-2026-10-09.json')
    const doc = JSON.parse(out.text)
    expect(doc.format).toBe('operant-memory')
    expect(doc.lessons.map((l: { text: string }) => l.text).sort()).toEqual(['Cart totals use cents', 'The owner likes short answers'])
    expect(doc.hindsight.soul).toMatchObject({ ok: true, items: ['entry'] })
    expect(doc.hindsight.projects[0]).toMatchObject({ name: 'shop', ok: true })
  })

  it('refuses a reset without confirm: true and changes nothing', async () => {
    await expect(resetMemory(deps(), { scope: 'all', confirm: false as never })).rejects.toThrow(/confirm/)
    expect(deleted).toEqual([])
    expect(learn.lessons({ status: 'active' })).toHaveLength(2)
  })

  it('wipes the soul bank only, and reports each step on its own', async () => {
    const r = await resetMemory(deps(), { scope: 'soul', confirm: true })
    expect(deleted).toEqual([SOUL_BANK])
    expect(r.steps).toEqual([{ target: `Hindsight bank ${SOUL_BANK}`, ok: true, error: '' }])
    expect(learn.lessons({ status: 'active' })).toHaveLength(2)
  })

  it('a project reset removes the lessons even when Hindsight refuses, and names the failure', async () => {
    hindsightDown = true
    const r = await resetMemory(deps(), { scope: 'project', crewId, confirm: true })
    expect(r.steps[0]).toEqual({ target: 'Hindsight bank for shop', ok: false, error: 'unreachable' })
    expect(r.steps.at(-1)).toEqual({ target: '2 lessons of shop', ok: true, error: '' })
    expect(learn.lessons({ status: 'active' })).toHaveLength(0)
  })

  it('diagnostics name the bank sizes, the last run, the spend and a down Hindsight', async () => {
    hindsightDown = true
    const d = await memoryDiagnostics(deps(), await learn.status())
    expect(d.hindsight.state).toBe('stopped')
    expect(d.banks[0]).toMatchObject({ bank: SOUL_BANK, lessons: 1, hindsightEntries: 1 })
    expect(d.banks[1]).toMatchObject({ name: 'shop', lessons: 2 })
    expect(d.learnMode).toBe('controlled')
    expect(d.spend).toMatchObject({ total: { calls: 0 }, maxCallsPerDay: 10 })
    expect(DEFAULT_AUX_MODELS.extraction.cli).toBe('learn')
  })
})
