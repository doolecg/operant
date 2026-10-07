import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MasterRuns } from './master-runs'
import { ApprovalMarker } from './runs'
import { Store } from './store'
import { encodeProjectDir } from './transcripts'
import { UsageIngest, ownerAt, runSegments, type OpenCodeTurn } from './usage-ingest'

const T0 = 1_700_000_000_000
const msg = (id: string, at: number, out = 100) =>
  JSON.stringify({ type: 'assistant', timestamp: new Date(at).toISOString(), message: { id, model: 'claude-sonnet-4-5', usage: { input_tokens: 10, output_tokens: out }, content: [{ type: 'text', text: 'x' }] } })

describe('usage of master-mode runs, by time window', () => {
  let clock: number
  let store: Store
  let runs: MasterRuns
  let crewId: number
  let masterId: number
  let a: number
  let b: number
  let dir: string

  const make = () => store.createRun({ crewId, task: 'x', masterCli: 'claude', mode: 'master' }).id
  const at = (ms: number) => {
    clock = T0 + ms
  }
  const deliver = (id: number) => {
    store.setRunStatus(id, 'working')
    store.addRunEvent(id, { kind: 'delivered', source: 'system', body: '{}' })
  }
  const spent = (): Record<string, number> => {
    const rows = store.db.prepare('SELECT COALESCE(CAST(run_id AS TEXT), \'none\') AS r, COUNT(*) AS n FROM usage GROUP BY r').all() as Array<{ r: string; n: number }>
    return Object.fromEntries(rows.map((x) => [x.r, Number(x.n)]))
  }

  beforeEach(() => {
    clock = T0
    dir = mkdtempSync(join(tmpdir(), 'operant-master-usage-'))
    store = new Store(':memory:', () => clock)
    runs = new MasterRuns({ store, approvals: new ApprovalMarker({ now: () => clock, inReview: () => [] }) }, () => clock)
    crewId = store.createCrew('shop', join(dir, 'shop')).id
    masterId = store.ensureMaster(crewId).id
    // A works, goes to review; B is delivered while A waits; B goes to review; A is approved, then B.
    a = make()
    deliver(a)
    at(100)
    runs.review(a, 'done a', crewId)
    at(200)
    b = make()
    deliver(b)
    at(300)
    runs.review(b, 'done b', crewId)
    at(400)
    runs.approve(a, 'owner-ui')
    at(500)
    runs.approve(b, 'owner-ui')
    at(100_000)
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('gives a moment to the run that was working, else to the latest run in review, else to none', () => {
    const segs = [a, b].flatMap((id) => runSegments(store.getRun(id)!, store.listRunEvents(id)))
    const owner = (ms: number) => ownerAt(segs, T0 + ms)
    expect([50, 150, 250, 350, 450, 600].map(owner)).toEqual([a, a, b, b, b, null])
    expect(segs.filter((s) => s.runId === a).map((s) => `${s.kind}:${s.start - T0}-${s.end - T0}`)).toEqual(['working:0-100', 'review:100-400'])
  })

  it('tags the Master operator rows and reads subagent files once, with no double counting', async () => {
    for (const [id, ms] of [['m1', 50], ['m2', 250], ['m3', 600]] as const) {
      store.upsertMessageUsage(id, { operatorId: masterId, at: T0 + ms, model: 'claude-sonnet-4-5', inputTokens: 5, outputTokens: 5, costUsd: 0.01 })
    }
    const projects = join(dir, 'projects')
    const sub = join(projects, encodeProjectDir(join(dir, 'shop')), 'sess1', 'subagents')
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, 'ag1.jsonl'), [msg('s1', T0 + 60), msg('s2', T0 + 260), msg('s3', T0 + 270)].join('\n') + '\n')
    writeFileSync(join(sub, 'ag1.meta.json'), JSON.stringify({ agentType: 'operant-master:seat-build' }))
    const ingest = new UsageIngest({ store, projectsDir: () => projects, now: () => clock })
    const sessions = [{ cli: 'claude' as const, sessionId: 'sess1' }]
    const rows = await ingest.syncMaster(crewId, join(dir, 'shop'), sessions)
    expect(rows).toBe(2 + 3)
    expect(spent()).toEqual({ [String(a)]: 2, [String(b)]: 3, none: 1 })
    expect(store.db.prepare("SELECT source FROM usage WHERE message_id = 'm2'").get()).toMatchObject({ source: 'master' })
    expect(store.listJobAgents(a)).toHaveLength(1)
    expect(store.listJobAgents(b)).toMatchObject([{ seat: 'operant-master:seat-build', status: 'done' }])
    const keys = store.db.prepare("SELECT ext_key FROM usage WHERE ext_key IS NOT NULL ORDER BY ext_key").all() as Array<{ ext_key: string }>
    expect(keys.map((k) => k.ext_key)).toEqual([`run:${a}:s1`, `run:${b}:s2`, `run:${b}:s3`].sort())
    // A second pass changes nothing: the crew spend before and after is the same.
    const total = () => Number((store.db.prepare('SELECT COALESCE(SUM(output_tokens), 0) AS t FROM usage').get() as { t: number }).t)
    const before = total()
    expect(await ingest.syncMaster(crewId, join(dir, 'shop'), sessions)).toBe(0)
    expect(total()).toBe(before)
  })

  it('reads an OpenCode Master and its child sessions from the database, keyed per run', async () => {
    const turn = (id: string, ms: number): OpenCodeTurn => ({ id, at: T0 + ms, model: 'glm-5.3-flash', provider: 'zai', inputTokens: 10, outputTokens: 20, cacheRead: 0, cacheWrite: 0, costUsd: 0.002 })
    const bySession: Record<string, OpenCodeTurn[]> = { oc1: [turn('o1', 50), turn('o2', 450)], kid1: [turn('k1', 260)] }
    const ingest = new UsageIngest({
      store,
      now: () => clock,
      openCodeTurns: ([id]) => bySession[id!] ?? [],
      openCodeChildren: async () => [{ id: 'kid1', title: 'build', agent: 'seat-build', directory: '', model: 'zai/glm-5.3-flash', done: true }],
    })
    const sessions = [{ cli: 'opencode' as const, sessionId: 'oc1' }]
    expect(await ingest.syncMaster(crewId, join(dir, 'shop'), sessions)).toBe(3)
    expect(await ingest.syncMaster(crewId, join(dir, 'shop'), sessions)).toBe(0)
    expect(spent()).toEqual({ [String(a)]: 1, [String(b)]: 2 })
    const cli = store.db.prepare("SELECT cli, source, seat FROM usage WHERE message_id = 'k1'").get()
    expect(cli).toMatchObject({ cli: 'opencode', source: 'agent', seat: 'seat-build' })
    expect(store.listJobAgents(b)).toMatchObject([{ seat: 'seat-build', transcriptRef: 'opencode:kid1' }])
  })
})
