import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { csvField, exportView, toCsv } from './usage-export'
import { UsageIngest, parseOpenCodeMessage, readOpenCodeTurns } from './usage-ingest'
import { jobUsage, queryUsage, querySeries, USAGE_GROUPS, type QueryDeps } from './usage-query'
import { MIGRATIONS, Store } from './store'
import { encodeProjectDir } from './transcripts'
import type { UsageGroupBy } from '../shared/types'

const DAY = 86_400_000
const NOW = new Date(2026, 9, 7, 12, 0, 0).getTime()

let store: Store
let deps: QueryDeps
beforeEach(() => {
  store = new Store(':memory:', () => NOW)
  deps = { store, now: () => NOW }
})
afterEach(() => store.close())

const line = (id: string, model: string, usage: Record<string, number>, at: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'assistant', timestamp: new Date(at).toISOString(), ...extra, message: { id, model, usage, content: [{ type: 'text', text: 'x' }] } })

describe('migration and attribution columns', () => {
  it('backfills cli and provider on usage written before the columns existed', () => {
    const raw = new DatabaseSync(':memory:')
    raw.exec('PRAGMA foreign_keys = ON')
    const usageStep = MIGRATIONS.findIndex((m) => m.includes('ADD COLUMN job_agent_id'))
    raw.exec(MIGRATIONS.slice(0, usageStep).join('\n'))
    raw.exec("INSERT INTO crews (name, folder, created_at, prj_number) VALUES ('a', '/a', 1, 1001)")
    raw.exec("INSERT INTO squads (crew_id, name) VALUES (1, 's')")
    raw.exec("INSERT INTO operators (squad_id, role, agent, model) VALUES (1, 'worker', 'claude', 'm')")
    raw.exec("INSERT INTO usage (operator_id, at, input_tokens, cost_usd, message_id) VALUES (1, 5, 10, 0.5, 'm1')")
    raw.exec(MIGRATIONS[usageStep]!)
    expect(raw.prepare('SELECT cli, provider, source, run_id, job_agent_id, ext_key FROM usage').get()).toEqual({
      cli: 'claude',
      provider: 'anthropic',
      source: 'operator',
      run_id: null,
      job_agent_id: null,
      ext_key: null,
    })
    raw.close()
  })
})

describe('feeding job transcripts into usage', () => {
  let dir: string
  let cwd: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'operant-ingest-'))
    cwd = join(dir, 'work')
    mkdirSync(cwd)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('attributes the Master, each agent and the front desk, and never double counts', () => {
    const crew = store.createCrew('proj', cwd)
    const run = store.createRun({ crewId: crew.id, task: 't', masterCli: 'claude' })
    const projects = join(dir, 'projects')
    const sessionDir = join(projects, encodeProjectDir(cwd), 'sess1')
    mkdirSync(join(sessionDir, 'subagents'), { recursive: true })
    const master = `${sessionDir}.jsonl`
    writeFileSync(master, [line('m1', 'claude-opus-5-5', { input_tokens: 100, output_tokens: 50 }, NOW), line('m1', 'claude-opus-5-5', { input_tokens: 100, output_tokens: 50 }, NOW)].join('\n') + '\n')
    writeFileSync(join(sessionDir, 'subagents', 'ag1.jsonl'), line('a1', 'claude-haiku-4-5', { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000 }, NOW) + '\n')
    const agent = store.addJobAgent(run.id, { seat: 'explore', model: 'claude-haiku-4-5', transcriptRef: 'claude:sess1:ag1' })
    const fd = join(projects, encodeProjectDir(join(dir, 'fd')))
    mkdirSync(fd, { recursive: true })
    writeFileSync(join(fd, 'fdsess.jsonl'), line('f1', 'claude-haiku-4-5', { input_tokens: 10, output_tokens: 5 }, NOW) + '\n')

    const ingest = new UsageIngest({ store, projectsDir: () => projects, frontDeskCwd: join(dir, 'fd') })
    const src = { cli: 'claude' as const, cwd, sessionId: 'sess1' }
    expect(ingest.syncRun(run, src)).toBe(3)
    expect(ingest.syncFrontDesk()).toBe(1)
    // A second pass reads nothing new; a fresh reader (restart) re-reads everything and adds nothing.
    expect(ingest.syncRun(run, src)).toBe(0)
    const again = new UsageIngest({ store, projectsDir: () => projects, frontDeskCwd: join(dir, 'fd') })
    again.syncRun(run, src)
    again.syncFrontDesk()
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM usage').get()).toEqual({ n: 3 })

    const job = jobUsage(deps, run.id)
    expect(job.agents.map((a) => [a.seat, a.agentId, a.turns])).toEqual([
      ['master', null, 1],
      ['explore', agent.id, 1],
    ])
    expect(job.totals.turns).toBe(2)
    expect(job.agents.reduce((n, a) => n + a.costUsd, 0)).toBeCloseTo(job.totals.costUsd, 10)
    const bySource = queryUsage(deps, { groupBy: ['source'] })
    expect(bySource.rows.map((r) => [r.keys[0], r.turns]).sort()).toEqual([['agent', 1], ['frontdesk', 1], ['master', 1]])
    expect(bySource.rows.find((r) => r.keys[0] === 'frontdesk')!.labels[0]).toBe('Discord front desk')
    // The project's spend counts the job's rows.
    expect(store.spendSince(0, crew.id)).toBeCloseTo(job.totals.costUsd, 10)
  })

  it('picks up agent lines that arrive later and old-format sidechain lines', () => {
    const crew = store.createCrew('proj', cwd)
    const run = store.createRun({ crewId: crew.id, task: 't', masterCli: 'claude' })
    const projects = join(dir, 'projects')
    const main = join(projects, encodeProjectDir(cwd), 's2.jsonl')
    mkdirSync(join(projects, encodeProjectDir(cwd)), { recursive: true })
    writeFileSync(main, line('s1', 'claude-sonnet-5-5', { input_tokens: 10, output_tokens: 1 }, NOW, { isSidechain: true, agentId: 'zz', agentType: 'fix' }) + '\n')
    const ingest = new UsageIngest({ store, projectsDir: () => projects })
    const src = { cli: 'claude' as const, cwd, sessionId: 's2' }
    expect(ingest.syncRun(run, src)).toBe(1)
    appendFileSync(main, line('s2', 'claude-sonnet-5-5', { input_tokens: 20, output_tokens: 2 }, NOW) + '\n')
    expect(ingest.syncRun(run, src)).toBe(1)
    const rows = queryUsage(deps, { filter: { runId: run.id }, groupBy: ['seat'] }).rows
    expect(rows.map((r) => [r.keys[0], r.turns]).sort()).toEqual([['fix', 1], ['master', 1]])
  })

  it('reads OpenCode runs from injected turns and from a real database', () => {
    const crew = store.createCrew('proj', cwd)
    const run = store.createRun({ crewId: crew.id, task: 't', masterCli: 'opencode' })
    store.addJobAgent(run.id, { seat: 'build', transcriptRef: 'opencode:ses_child' })
    const turn = (id: string) => ({ id, at: NOW, model: 'glm-5.3-flash', provider: 'zai-coding-plan', inputTokens: 100, outputTokens: 20, cacheRead: 1000, cacheWrite: 0, costUsd: 0 })
    const ingest = new UsageIngest({ store, openCodeTurns: (ids) => (ids[0] === 'ses_master' ? [turn('msg_a')] : [turn('msg_b'), turn('msg_c')]) })
    expect(ingest.syncRun(run, { cli: 'opencode', cwd, sessionId: 'ses_master' })).toBe(3)
    const r = queryUsage(deps, { groupBy: ['cli', 'provider'] })
    expect(r.rows[0]).toMatchObject({ keys: ['opencode', 'zai-coding-plan'], turns: 3 })

    const file = join(dir, 'opencode.db')
    const db = new DatabaseSync(file)
    db.exec('CREATE TABLE message (id text primary key, session_id text, time_created integer, time_updated integer, data text)')
    const ins = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)')
    ins.run('m1', 's1', 5, 5, JSON.stringify({ role: 'assistant', modelID: 'big-pickle', providerID: 'opencode', cost: 0, tokens: { input: 10, output: 5, reasoning: 3, cache: { read: 7, write: 0 } }, time: { created: 99 } }))
    ins.run('m2', 's1', 6, 6, JSON.stringify({ role: 'user' }))
    ins.run('m3', 's1', 7, 7, 'not json')
    db.close()
    expect(readOpenCodeTurns(file, ['s1'])).toEqual([{ id: 'm1', at: 99, model: 'big-pickle', provider: 'opencode', inputTokens: 10, outputTokens: 8, cacheRead: 7, cacheWrite: 0, costUsd: 0 }])
    expect(readOpenCodeTurns(join(dir, 'missing.db'), ['s1'])).toEqual([])
    expect(parseOpenCodeMessage('x', 1, '{"role":"assistant","modelID":"m","tokens":{"input":0,"output":0}}')).toBeNull()
  })
})

describe('usage queries', () => {
  const add = (o: { at: number; cost: number; model?: string; cli?: string; runId?: number; seat?: string; crewId?: number; source?: string; input?: number; legacy?: boolean }, i: number) =>
    store.upsertKeyedUsage(
      {
        extKey: `k${i}`,
        at: o.at,
        model: o.model ?? 'claude-sonnet-5-5',
        cli: o.cli ?? 'claude',
        runId: o.runId ?? null,
        seat: o.seat ?? '',
        crewId: o.crewId ?? null,
        source: o.source ?? 'agent',
        inputTokens: o.input ?? 100,
        outputTokens: 10,
        cacheRead: 5,
        cacheW5m: 3,
        cacheW1h: 1,
        costUsd: o.cost,
        legacy: o.legacy,
      },
      false,
    )

  it('totals equal the sum of the rows under every grouping and filter', () => {
    const a = store.createCrew('alpha', '/a')
    const b = store.createCrew('beta', '/b')
    const run1 = store.createRun({ crewId: a.id, task: 't', masterCli: 'claude' })
    const run2 = store.createRun({ crewId: b.id, task: 't', masterCli: 'opencode' })
    const rows = [
      { at: NOW, cost: 0.1, runId: run1.id, crewId: a.id, seat: 'master', source: 'master' },
      { at: NOW - 3_600_000, cost: 0.2, runId: run1.id, crewId: a.id, seat: 'fix' },
      { at: NOW - DAY, cost: 0.4, runId: run2.id, crewId: b.id, cli: 'opencode', model: 'glm-5.3-flash', seat: 'build' },
      { at: NOW - 2 * DAY, cost: 0.8, crewId: b.id, source: 'import', legacy: true },
      { at: NOW - 3 * DAY, cost: 1.6, source: 'frontdesk', seat: 'front desk' },
    ]
    rows.forEach(add)
    const filters = [{}, { crewId: a.id }, { cli: 'opencode' }, { runId: run1.id }, { from: NOW - 2 * DAY, to: NOW + 1 }, { model: 'glm-5.3-flash' }, { seat: 'fix' }, { legacy: 'exclude' as const }, { legacy: 'only' as const }]
    for (const filter of filters) {
      const all = queryUsage(deps, { filter })
      for (const g of USAGE_GROUPS) {
        const r = queryUsage(deps, { filter, groupBy: [g as UsageGroupBy] })
        expect(r.totals.costUsd).toBeCloseTo(all.totals.costUsd, 9)
        expect(r.totals.turns).toBe(all.totals.turns)
        expect(r.totals.cacheWrite).toBe(all.totals.cacheWrite)
        expect(r.rows.reduce((n, x) => n + x.costUsd, 0)).toBeCloseTo(r.totals.costUsd, 9)
        expect(r.rows.reduce((n, x) => n + x.inputTokens, 0)).toBe(r.totals.inputTokens)
      }
      const two = queryUsage(deps, { filter, groupBy: ['project', 'model'] })
      expect(two.totals.costUsd).toBeCloseTo(all.totals.costUsd, 9)
    }
    expect(queryUsage(deps, {}).totals.costUsd).toBeCloseTo(3.1, 9)
    expect(queryUsage(deps, { filter: { legacy: 'only' } }).totals).toMatchObject({ turns: 1, legacyTurns: 1 })
    const byProject = queryUsage(deps, { groupBy: ['project'] })
    expect(byProject.rows.map((r) => [r.labels[0], r.turns]).sort()).toEqual([['No project', 1], ['alpha', 2], ['beta', 2]])
    const byRun = queryUsage(deps, { groupBy: ['run'] })
    expect(byRun.rows.map((r) => r.labels[0]).sort()).toEqual(['JOB#20001', 'JOB#20002', 'No job'])
  })

  it('groups by local day, filters by date and reports a trend against the previous period', () => {
    ;[
      { at: NOW, cost: 1 },
      { at: NOW - DAY, cost: 2 },
      { at: NOW - 8 * DAY, cost: 4 },
    ].forEach(add)
    const days = queryUsage(deps, { groupBy: ['day'] })
    expect(days.rows.map((r) => r.keys[0])).toEqual(['2026-09-29', '2026-10-06', '2026-10-07'])
    const week = queryUsage(deps, { filter: { from: NOW - 7 * DAY, to: NOW + 1 }, trend: true })
    expect(week.totals.costUsd).toBe(3)
    expect(week.trend).toMatchObject({ deltaUsd: -1, deltaPct: -25 })
    expect(week.trend!.previous.costUsd).toBe(4)
    expect(queryUsage(deps, { filter: { from: NOW - 30 * DAY }, trend: true }).trend!.deltaPct).toBeNull()
    const series = querySeries(deps, { bucket: 'day', split: 'model' })
    expect(series.points.map((p) => [p.bucket, p.costUsd])).toEqual([['2026-09-29', 4], ['2026-10-06', 2], ['2026-10-07', 1]])
    expect(series.totals.costUsd).toBe(7)
  })

  it('rejects an unknown grouping', () => {
    expect(() => queryUsage(deps, { groupBy: ['nope' as UsageGroupBy] })).toThrow(/Group by/)
  })

  it('lists every agent of a job, including ones that spent nothing, and sums to the job total', () => {
    const crew = store.createCrew('a', '/a')
    const run = store.createRun({ crewId: crew.id, task: 'build it', masterCli: 'claude' })
    const quiet = store.addJobAgent(run.id, { seat: 'docs' })
    const busy = store.addJobAgent(run.id, { seat: 'fix' })
    ;[
      { at: NOW, cost: 1, runId: run.id, crewId: crew.id, source: 'master', seat: 'master' },
    ].forEach(add)
    store.upsertKeyedUsage({ extKey: 'x', at: NOW, runId: run.id, crewId: crew.id, jobAgentId: busy.id, source: 'agent', seat: 'fix', inputTokens: 1, outputTokens: 1, costUsd: 2 }, false)
    store.upsertKeyedUsage({ extKey: 'y', at: NOW, runId: run.id, crewId: crew.id, jobAgentId: 999, source: 'agent', seat: 'gone', inputTokens: 1, outputTokens: 1, costUsd: 4 }, false)
    const job = jobUsage(deps, run.id)
    expect(job.agents.map((a) => [a.seat, a.costUsd])).toEqual([['master', 1], ['docs', 0], ['fix', 2], ['agent 999', 4]])
    expect(job.agents.find((a) => a.agentId === quiet.id)!.turns).toBe(0)
    expect(job.agents.reduce((n, a) => n + a.costUsd, 0)).toBe(job.totals.costUsd)
    expect(job.totals.costUsd).toBe(7)
  })
})

describe('export', () => {
  it('quotes csv fields and defuses formulas', () => {
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
    expect(csvField('=1+1')).toBe("'=1+1")
    expect(csvField(-3)).toBe('-3')
    expect(csvField(null)).toBe('')
    expect(toCsv(['a', 'b'], [[1, 'x\ny']])).toBe('a,b\r\n1,"x\ny"\r\n')
  })

  it('exports any view as csv and json with a total row', () => {
    store.upsertKeyedUsage({ extKey: 'e1', at: NOW, model: 'claude-sonnet-5-5', source: 'agent', seat: 'a,b', inputTokens: 10, outputTokens: 5, cacheRead: 2, cacheW5m: 1, costUsd: 0.25 }, false)
    store.upsertKeyedUsage({ extKey: 'e2', at: NOW, model: 'claude-haiku-4-5', source: 'agent', seat: 'c', inputTokens: 1, outputTokens: 1, costUsd: 0.5 }, false)
    const csv = exportView(deps, { kind: 'report', query: { groupBy: ['seat'] } }, 'csv')
    expect(csv.filename).toBe('usage-seat-2026-10-07.csv')
    const lines = csv.text.trim().split('\r\n')
    expect(lines[0]).toBe('seat,seat_label,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_usd,turns,legacy_turns')
    expect(lines).toHaveLength(4)
    expect(lines[3]).toMatch(/^TOTAL,,11,6,2,1,0.75,2,0$/)
    expect(lines.some((l) => l.startsWith('"a,b","a,b"'))).toBe(true)
    const json = JSON.parse(exportView(deps, { kind: 'report', query: { groupBy: ['seat'] } }, 'json').text)
    expect(json.totals.costUsd).toBe(0.75)
    expect(json.rows).toHaveLength(2)
    expect(exportView(deps, { kind: 'series', query: { bucket: 'day' } }, 'csv').text).toContain('bucket,cost_usd,tokens,turns')
    expect(() => exportView(deps, { kind: 'report', query: {} }, 'xml' as 'csv')).toThrow(/format/)
  })
})
