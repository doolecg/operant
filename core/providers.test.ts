import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProviderAlert } from '../shared/types'
import {
  ProviderMonitor,
  parseOpenCodeStats,
  parsePlanUsage,
  parseZaiQuota,
  parseZaiTotals,
  readOpenCodeUsage,
  zaiOrigin,
  zaiTime,
  type FetchLike,
  type FetchResponse,
} from './providers'
import { Store } from './store'

const NOW = new Date(2026, 9, 7, 12, 0, 0).getTime()
const reply = (status: number, body: unknown, headers: Record<string, string> = {}): FetchResponse => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (n) => headers[n.toLowerCase()] ?? null },
  json: async () => body,
})

const PLAN_BODY = { five_hour: { utilization: 42.5, resets_at: '2026-10-07T15:00:00Z' }, seven_day: { utilization: 81, resets_at: '2026-10-10T00:00:00Z' }, seven_day_opus: null }
const CREDS = JSON.stringify({ claudeAiOauth: { accessToken: 'tok-SECRET-123', refreshToken: 'r', expiresAt: 1 } })

let store: Store
let now = NOW
let dir: string
beforeEach(() => {
  store = new Store(':memory:', () => NOW)
  now = NOW
  dir = mkdtempSync(join(tmpdir(), 'operant-prov-'))
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const monitor = (o: { fetch?: FetchLike; files?: Record<string, string>; envs?: Array<Record<string, string | undefined>>; db?: string; stats?: () => Promise<unknown>; onAlert?: (a: ProviderAlert) => void }) =>
  new ProviderMonitor({
    store,
    now: () => now,
    fetch: o.fetch ?? (async () => reply(500, null)),
    readFile: (p) => o.files?.[p.replace(/\\/g, '/')] ?? null,
    claudeDir: () => '/home/.claude',
    seatEnvs: () => o.envs ?? [],
    openCodeDb: () => o.db ?? join(dir, 'none.db'),
    openCodeStats: o.stats ?? (async () => null),
    onAlert: o.onAlert,
  })

describe('Claude plan limits', () => {
  it('parses the five-hour and weekly windows from the usage response', () => {
    const w = parsePlanUsage(PLAN_BODY)
    expect(w.map((x) => [x.id, x.usedPct, x.resetsAt])).toEqual([
      ['five_hour', 42.5, Date.parse('2026-10-07T15:00:00Z')],
      ['seven_day', 81, Date.parse('2026-10-10T00:00:00Z')],
    ])
    expect(parsePlanUsage('garbage')).toEqual([])
  })

  it('asks Anthropic with the Claude Code token, once per ten minutes, and never keeps the token', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    const m = monitor({ fetch: async (url, init) => (calls.push({ url, headers: init.headers }), reply(200, PLAN_BODY)), files: { '/home/.claude/.credentials.json': CREDS } })
    await m.pollPlan()
    await m.pollPlan()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ url: 'https://api.anthropic.com/api/oauth/usage', headers: { Authorization: 'Bearer tok-SECRET-123' } })
    const claude = m.status().providers.find((p) => p.id === 'claude')!
    expect(claude).toMatchObject({ state: 'ok', fetchedAt: NOW, nextPollAt: NOW + 600_000 })
    expect(claude.windows).toHaveLength(2)
    expect(JSON.stringify(m.status())).not.toContain('SECRET')
    now += 11 * 60_000
    await m.pollPlan()
    expect(calls).toHaveLength(2)
    await m.pollPlan(true)
    expect(calls).toHaveLength(3)
  })

  it('backs off on 429 (doubling, honouring Retry-After) and keeps the last reading', async () => {
    let n = 0
    const statuses = [200, 429, 429, 200]
    const m = monitor({ fetch: async () => reply(statuses[n++]!, PLAN_BODY, n === 3 ? { 'retry-after': '3600' } : {}), files: { '/home/.claude/.credentials.json': CREDS } })
    await m.pollPlan()
    now += 11 * 60_000
    await m.pollPlan()
    expect(m.status().providers[0]).toMatchObject({ state: 'rate-limited', note: expect.stringMatching(/last reading/) })
    expect(m.status().providers[0]!.windows).toHaveLength(2)
    // 2 minutes of back-off: forced polls still wait.
    now += 60_000
    await m.pollPlan(true)
    expect(n).toBe(2)
    now += 2 * 60_000
    await m.pollPlan(true)
    expect(n).toBe(3)
    // The second 429 carries Retry-After: an hour.
    now += 30 * 60_000
    await m.pollPlan(true)
    expect(n).toBe(3)
    now += 31 * 60_000
    await m.pollPlan(true)
    expect(n).toBe(4)
    expect(m.status().providers[0]!.state).toBe('ok')
  })

  it('degrades quietly: no login, an expired login, an error and a network failure', async () => {
    const none = monitor({ files: {} })
    await none.pollPlan()
    expect(none.status().providers[0]).toMatchObject({ state: 'signed-out' })
    const expired = monitor({ fetch: async () => reply(401, null), files: { '/home/.claude/.credentials.json': CREDS } })
    await expired.pollPlan()
    expect(expired.status().providers[0]).toMatchObject({ state: 'error', note: expect.stringMatching(/expired/) })
    const down = monitor({
      fetch: async () => {
        throw Object.assign(new Error('boom tok-SECRET-123'), { name: 'TypeError' })
      },
      files: { '/home/.claude/.credentials.json': CREDS },
    })
    await down.pollPlan()
    const s = down.status().providers[0]!
    expect(s.state).toBe('error')
    expect(JSON.stringify(s)).not.toContain('SECRET')
  })

  it('alerts once at 80% and once at 95% per window', async () => {
    const alerts: ProviderAlert[] = []
    let used = 81
    const m = monitor({
      fetch: async () => reply(200, { five_hour: { utilization: used, resets_at: '2026-10-07T15:00:00Z' } }),
      files: { '/home/.claude/.credentials.json': CREDS },
      onAlert: (a) => alerts.push(a),
    })
    const poll = async () => {
      now += 11 * 60_000
      await m.pollPlan()
    }
    await poll()
    await poll()
    expect(alerts.map((a) => a.thresholdPct)).toEqual([80])
    used = 96
    await poll()
    await poll()
    expect(alerts.map((a) => a.thresholdPct)).toEqual([80, 95])
    expect(m.status().alerts).toHaveLength(2)
  })
})

describe('z.ai', () => {
  const quota = { code: 200, data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 37, nextResetTime: 1_790_000_000_000 }, { type: 'TIME_LIMIT', usage: 1000, currentValue: 250, remaining: 750, percentage: 25 }] } }

  it('matches only z.ai and bigmodel.cn hosts', () => {
    expect(zaiOrigin('https://api.z.ai/api/anthropic')).toBe('https://api.z.ai')
    expect(zaiOrigin('https://open.bigmodel.cn/api/anthropic')).toBe('https://open.bigmodel.cn')
    expect(zaiOrigin('https://z.ai.evil.com/x')).toBeNull()
    expect(zaiOrigin('https://evilz.ai/x')).toBeNull()
    expect(zaiOrigin('http://api.z.ai/x')).toBeNull()
    expect(zaiOrigin('not a url')).toBeNull()
    expect(zaiOrigin(undefined)).toBeNull()
    expect(zaiTime(new Date(2026, 0, 2, 3, 4, 5).getTime())).toBe('2026-01-02 03:04:05')
  })

  it('parses quota limits and totals defensively', () => {
    const w = parseZaiQuota(quota)
    expect(w[0]).toMatchObject({ id: 'zai-tokens_limit', label: 'Token quota', usedPct: 37, resetsAt: 1_790_000_000_000 })
    expect(w[1]).toMatchObject({ used: 250, limit: 1000, remaining: 750, usedPct: 25, unit: 'calls' })
    expect(parseZaiQuota({ data: { limits: 'no' } })).toEqual([])
    expect(parseZaiQuota({ data: { limits: [{ type: 'X'.repeat(500), percentage: 1e9, usage: 'NaN' }] } })[0]!.usedPct).toBe(1000)
    expect(parseZaiTotals({ data: { totalUsage: { totalModelCallCount: 7, totalTokensUsage: 900 } } }, null).map((x) => x.used)).toEqual([900, 7])
  })

  it('stays off until a seat base URL matches, then sends the key without Bearer', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    const fetchFn: FetchLike = async (url, init) => {
      calls.push({ url, headers: init.headers })
      return reply(200, url.includes('quota/limit') ? quota : { data: {} })
    }
    const off = monitor({ fetch: fetchFn, envs: [{ ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_AUTH_TOKEN: 'k' }] })
    await off.pollZai()
    expect(calls).toHaveLength(0)
    expect(off.status().providers.find((p) => p.id === 'zai')).toMatchObject({ state: 'off' })

    const on = monitor({ fetch: fetchFn, envs: [{ ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'zai-KEY-1' }] })
    await on.pollZai()
    expect(calls.map((c) => c.url.split('?')[0])).toEqual(
      expect.arrayContaining(['https://api.z.ai/api/monitor/usage/quota/limit', 'https://api.z.ai/api/monitor/usage/model-usage', 'https://api.z.ai/api/monitor/usage/tool-usage']),
    )
    expect(calls.every((c) => c.headers.Authorization === 'zai-KEY-1')).toBe(true)
    expect(calls.find((c) => c.url.includes('model-usage'))!.url).toMatch(/startTime=2026-10-06(%20| )11%3A00%3A00|startTime=2026-10-06%2012%3A00%3A00/)
    const z = on.status().providers.find((p) => p.id === 'zai')!
    expect(z.state).toBe('ok')
    expect(z.windows[0]).toMatchObject({ usedPct: 37 })
    expect(JSON.stringify(on.status())).not.toContain('zai-KEY-1')
  })

  it('degrades quietly on refusal, odd data, rate limits and network errors', async () => {
    const envs = [{ ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'zai-KEY-1' }]
    const stateOf = async (fetchFn: FetchLike) => {
      const m = monitor({ fetch: fetchFn, envs })
      await m.pollZai()
      return m.status().providers.find((p) => p.id === 'zai')!
    }
    expect((await stateOf(async () => reply(401, null))).state).toBe('error')
    expect((await stateOf(async () => reply(200, '<html>not json</html>'))).state).toBe('error')
    expect((await stateOf(async () => reply(429, null, { 'retry-after': '120' }))).state).toBe('rate-limited')
    const down = await stateOf(async () => {
      throw new Error('ECONNRESET zai-KEY-1')
    })
    expect(down.state).toBe('error')
    expect(JSON.stringify(down)).not.toContain('zai-KEY-1')
    expect((await stateOf(async () => reply(200, { data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 'x'.repeat(10) }] } }))).windows[0]!.usedPct).toBeNull()
  })

  it('reads the base URL and key from the Claude settings env when no seat env is given', async () => {
    const calls: string[] = []
    const m = new ProviderMonitor({
      store,
      now: () => now,
      fetch: async (url) => (calls.push(url), reply(200, quota)),
      readFile: (p) => (p.replace(/\\/g, '/').endsWith('.claude/settings.json') ? JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'k2' } }) : null),
      claudeDir: () => '/home/.claude',
      openCodeDb: () => join(dir, 'none.db'),
      openCodeStats: async () => null,
    })
    await m.pollZai()
    expect(calls.length).toBeGreaterThan(0)
  })
})

describe('OpenCode', () => {
  const STATS = {
    sessions: 3,
    tokens: { input: 1 },
    cost: 0,
    models: [
      { model: { id: 'glm-5.3-flash', providerID: 'zai-coding-plan', variant: 'high' }, steps: 201, tokens: { input: 941_608, output: 52_392, reasoning: 129_217, cache: { read: 20_508_800, write: 0 } }, cost: 0 },
      { model: { id: 'glm-5.3-flash', providerID: 'zai-coding-plan', variant: 'default' }, steps: 6, tokens: { input: 55_323, output: 33, reasoning: 78, cache: { read: 108_480, write: 0 } }, cost: 0 },
      { model: { id: 'big-pickle', providerID: 'opencode', variant: 'default' }, steps: 750, tokens: { input: 2_674_512, output: 149_463, reasoning: 51_474, cache: { read: 19_127_561, write: 0 } }, cost: 0 },
      { model: { id: 'claude-haiku-4-5', providerID: 'anthropic' }, steps: 2, tokens: { input: 1_000_000, output: 0, cache: {} }, cost: 0 },
      { model: { id: 'paid', providerID: 'openrouter' }, steps: 1, tokens: { input: 10, output: 10, cache: {} }, cost: 1.5 },
    ],
  }

  it('reads usage per provider from `opencode stats --json`, merging variants and flagging estimates', async () => {
    const rows = parseOpenCodeStats(STATS)
    expect(rows).toHaveLength(4)
    expect(rows.find((r) => r.model === 'glm-5.3-flash')).toMatchObject({ turns: 207, inputTokens: 996_931, outputTokens: 52_392 + 129_217 + 33 + 78 })
    const m = monitor({ stats: async () => STATS })
    await m.pollOpenCode()
    const oc = m.status().providers.find((p) => p.id === 'opencode')!
    expect(oc.state).toBe('estimate')
    expect(oc.estimate).toBe(true)
    const by = Object.fromEntries(oc.rows.map((r) => [r.provider, r]))
    expect(by.openrouter).toMatchObject({ costUsd: 1.5, estimate: false })
    // Unpriced free models: tokens shown, cost 0, flagged as an estimate. A priced model is estimated from tokens.
    expect(by['zai-coding-plan']).toMatchObject({ costUsd: 0, estimate: true, turns: 207 })
    expect(by.anthropic!.costUsd).toBeCloseTo(1, 9)
    expect(by.anthropic!.estimate).toBe(true)
  })

  it('reads its database read-only and groups by provider', async () => {
    const file = join(dir, 'opencode.db')
    const db = new DatabaseSync(file)
    db.exec('CREATE TABLE message (id text primary key, session_id text, time_created integer, time_updated integer, data text)')
    const ins = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)')
    const msg = (provider: string, model: string, input: number, cost: number) => JSON.stringify({ role: 'assistant', providerID: provider, modelID: model, cost, tokens: { input, output: 5, reasoning: 1, cache: { read: 2, write: 0 } } })
    ins.run('a', 's', NOW - 1000, 0, msg('zai-coding-plan', 'glm-5.3-flash', 100, 0))
    ins.run('b', 's', NOW - 2000, 0, msg('zai-coding-plan', 'glm-5.3-flash', 50, 0))
    ins.run('c', 's', NOW - 3000, 0, msg('openrouter', 'x', 10, 0.5))
    ins.run('old', 's', NOW - 90 * 86_400_000, 0, msg('openrouter', 'x', 10, 9))
    ins.run('u', 's', NOW, 0, JSON.stringify({ role: 'user' }))
    db.close()
    const rows = readOpenCodeUsage(file, NOW - 30 * 86_400_000)!
    expect(rows.find((r) => r.provider === 'zai-coding-plan')).toMatchObject({ turns: 2, inputTokens: 150, outputTokens: 12, cacheRead: 4 })
    expect(rows.find((r) => r.provider === 'openrouter')).toMatchObject({ turns: 1, reportedCostUsd: 0.5 })
    expect(readOpenCodeUsage(join(dir, 'nope.db'), 0)).toBeNull()
    const m = monitor({ db: file, stats: async () => { throw new Error('should not be used') } })
    await m.pollOpenCode()
    expect(m.status().providers.find((p) => p.id === 'opencode')!.rows.map((r) => r.provider).sort()).toEqual(['openrouter', 'zai-coding-plan'])
  })

  it('says so when OpenCode cannot be read', async () => {
    const m = monitor({})
    await m.pollOpenCode()
    expect(m.status().providers.find((p) => p.id === 'opencode')).toMatchObject({ state: 'off' })
  })
})

describe('Claude estimate rows', () => {
  it('shows what Operant recorded as an estimate and leaves imported rows out', async () => {
    store.upsertKeyedUsage({ extKey: 'a', at: NOW - 1000, model: 'claude-sonnet-5-5', inputTokens: 10, outputTokens: 5, costUsd: 0.2 }, false)
    store.upsertKeyedUsage({ extKey: 'b', at: NOW - 1000, model: 'claude-sonnet-5-5', inputTokens: 10, outputTokens: 5, costUsd: 5, legacy: true }, false)
    const m = monitor({})
    const claude = m.status().providers.find((p) => p.id === 'claude')!
    expect(claude.rows).toEqual([{ provider: 'anthropic', inputTokens: 10, outputTokens: 5, cacheRead: 0, cacheWrite: 0, costUsd: 0.2, turns: 1, estimate: true }])
    expect(claude.estimate).toBe(true)
  })
})
