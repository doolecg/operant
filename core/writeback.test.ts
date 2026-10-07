import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bankFor } from './hindsight'
import { Store } from './store'
import { diffInfo, writeBack, writebackTags, type Git } from './writeback'

const DIFF = `diff --git a/core/runs.ts b/core/runs.ts
@@ -10,2 +10,5 @@ export class RunManager {
+export function tierOf(model: string) {
+  return 1
+}
+const helper = 2
@@ -40,0 +44,1 @@ function defaultBrief(run: Run): string {
+  x()
diff --git a/a.py b/a.py
+def parse_it(x):
+    pass
+  if (x) {
`

const git: Git = async (_f, args) => {
  if (args[0] === 'diff' && args[1] === '--name-only') return 'core/runs.ts\na.py\n'
  if (args[0] === 'ls-files') return 'core/new.ts\n'
  if (args[0] === 'diff') return DIFF
  return ''
}

describe('write-back', () => {
  let store: Store
  beforeEach(() => {
    store = new Store(':memory:')
  })
  afterEach(() => store.close())

  const finished = () => {
    const crew = store.createCrew('shop', '/code/shop')
    const r = store.createRun({ crewId: crew.id, task: 'fix tierOf', masterCli: 'claude', teamId: null, seats: [], limits: { maxWorkers: 0, topTier: '', tokenBudget: 0 }, rules: '' })
    store.setRunStatus(r.id, 'working')
    return store.setRunStatus(r.id, 'done', 'Changed tierOf')
  }

  it('takes files and symbols from the git diff, untracked files included', async () => {
    const d = await diffInfo(git, '/code/shop')
    expect(d.files).toEqual(['core/runs.ts', 'a.py', 'core/new.ts'])
    expect(d.symbols).toEqual(expect.arrayContaining(['RunManager', 'tierOf', 'helper', 'defaultBrief', 'parse_it']))
    expect(d.symbols).not.toContain('if')
  })

  it('writes the outcome to the project bank tagged with files and symbols, then re-syncs CodeGraph', async () => {
    const run = finished()
    const retained: Array<{ bank: string; content: string; tags: string[] }> = []
    let reindexed = ''
    const r = await writeBack(
      { git, hindsight: { retain: async (bank, content, tags) => (retained.push({ bank, content, tags }), { ok: true }) }, reindex: async (f) => void (reindexed = f) },
      run,
      '/code/shop',
    )
    expect(r).toMatchObject({ hindsight: 'written', codegraph: 'synced' })
    expect(reindexed).toBe('/code/shop')
    expect(retained[0]!.bank).toBe(bankFor('/code/shop'))
    expect(retained[0]!.content).toContain('Outcome: Changed tierOf')
    expect(retained[0]!.tags).toEqual(expect.arrayContaining(['operant', `job:${run.id}`, 'status:done', 'file:core/runs.ts', 'symbol:tierOf', 'symbol:parse_it']))
    expect(r.tags).toEqual(retained[0]!.tags)
  })

  it('reports each skipped store without throwing', async () => {
    const run = finished()
    const r = await writeBack(
      { git: async () => { throw new Error('not a repo') }, hindsight: { retain: async () => ({ ok: false, error: 'down' }) }, reindex: async () => { throw new Error('no index') } },
      run,
      '/code/shop',
    )
    expect(r.hindsight).toBe('skipped: down')
    expect(r.codegraph).toBe('skipped: no index')
    expect(r.tags).toEqual(['operant', `job:${run.id}`, 'status:done'])
    expect(writebackTags(run, { files: [], symbols: [] })).toEqual(r.tags)
  })
})
