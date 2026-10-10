import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ProviderAlert, ProviderStatus, ProviderUsageRow, ProviderWindow, ProvidersStatus } from '../shared/types'
import { claudeDir } from './paths'
import { costUsd, isPriced } from './pricing'
import { runHidden } from './proc'
import type { Store } from './store'
import { openCodeDbPath } from './opencode-usage'

// The slice of fetch the pollers use, so tests can hand in fake responses.
export interface FetchResponse {
  status: number
  ok: boolean
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
}
export type FetchLike = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<FetchResponse>

export const PLAN_POLL_MS = 10 * 60_000
const PLAN_BACKOFF_MAX_MIN = 30
const ALERT_AT = [80, 95]
const FETCH_TIMEOUT_MS = 10_000
const OPENCODE_DAYS = 30

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
// Anything a provider sends is data: numbers are clamped and text is cut, never trusted.
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null)
const clip = (v: unknown, n = 80): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').slice(0, n) : '')
const pct = (v: number | null): number | null => (v == null ? null : Math.max(0, Math.min(1000, v)))

const emptyWindow = (id: string, label: string, unit = ''): ProviderWindow => ({ id, label, usedPct: null, used: null, limit: null, remaining: null, unit, resetsAt: null })

// ---- Claude plan windows --------------------------------------------------------------------------------

const PLAN_WINDOWS: Array<[key: string, label: string]> = [
  ['five_hour', '5-hour session'],
  ['seven_day', 'Week'],
  ['seven_day_opus', 'Week (Opus)'],
  ['seven_day_sonnet', 'Week (Sonnet)'],
]

// The OAuth usage response: each window has `utilization` (percent) and `resets_at` (ISO time).
export function parsePlanUsage(body: unknown): ProviderWindow[] {
  const d = obj(body)
  const out: ProviderWindow[] = []
  for (const [key, label] of PLAN_WINDOWS) {
    const w = obj(d[key])
    const used = pct(num(w.utilization))
    if (used == null) continue
    const at = typeof w.resets_at === 'string' ? Date.parse(w.resets_at) : NaN
    out.push({ ...emptyWindow(key, label, 'percent'), usedPct: used, resetsAt: Number.isFinite(at) ? at : null })
  }
  return out
}

// ---- z.ai ----------------------------------------------------------------------------------------------

const ZAI_HOST = /(^|\.)(z\.ai|bigmodel\.cn)$/i

// The origin of a base URL when it is a z.ai (or bigmodel.cn) one, else null.
export function zaiOrigin(baseUrl: string | undefined): string | null {
  if (!baseUrl) return null
  try {
    const u = new URL(baseUrl)
    return u.protocol === 'https:' && ZAI_HOST.test(u.hostname) ? u.origin : null
  } catch {
    return null
  }
}

const pad = (n: number) => String(n).padStart(2, '0')
// z.ai wants local times as yyyy-MM-dd HH:mm:ss.
export const zaiTime = (t: number): string => {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// The quota/limit response (shape not documented, read defensively): data.limits[] with a type, the amount used
// (currentValue), the cap (usage), what is left, a percentage and the next reset time in ms.
export function parseZaiQuota(body: unknown): ProviderWindow[] {
  const data = obj(obj(body).data)
  const limits = Array.isArray(data.limits) ? data.limits : []
  const out: ProviderWindow[] = []
  for (const raw of limits.slice(0, 10)) {
    const l = obj(raw)
    const type = clip(l.type, 40) || 'limit'
    const limit = num(l.usage) ?? num(l.limit)
    const used = num(l.currentValue)
    const remaining = num(l.remaining) ?? (limit != null && used != null ? Math.max(0, limit - used) : null)
    const usedPct = pct(num(l.percentage) ?? (limit && used != null ? (used / limit) * 100 : null))
    const reset = num(l.nextResetTime)
    out.push({
      id: `zai-${type.toLowerCase()}`,
      label: type === 'TOKENS_LIMIT' ? 'Token quota' : type === 'TIME_LIMIT' ? 'Tool-call quota' : type,
      usedPct,
      used,
      limit,
      remaining,
      unit: type === 'TOKENS_LIMIT' ? 'tokens' : type === 'TIME_LIMIT' ? 'calls' : '',
      resetsAt: reset != null && reset > 0 ? reset : null,
    })
  }
  return out
}

// model-usage / tool-usage: totals over the asked window when the response carries them.
export function parseZaiTotals(model: unknown, tool: unknown): ProviderWindow[] {
  const out: ProviderWindow[] = []
  const m = obj(obj(obj(model).data).totalUsage)
  const calls = num(m.totalModelCallCount)
  const tokens = num(m.totalTokensUsage)
  if (tokens != null) out.push({ ...emptyWindow('zai-tokens-24h', 'Tokens, last 24 hours', 'tokens'), used: tokens })
  if (calls != null) out.push({ ...emptyWindow('zai-calls-24h', 'Model calls, last 24 hours', 'calls'), used: calls })
  const t = obj(obj(obj(tool).data).totalUsage)
  const search = num(t.totalNetworkSearchCount)
  if (search != null) out.push({ ...emptyWindow('zai-search-24h', 'Web searches, last 24 hours', 'calls'), used: search })
  return out
}

// ---- OpenCode ------------------------------------------------------------------------------------------

export interface OpenCodeRow {
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheWrite: number
  reportedCostUsd: number
  turns: number
}

// Per provider and model since a timestamp, straight from OpenCode's database (opened read-only).
export function readOpenCodeUsage(dbFile: string, since: number): OpenCodeRow[] | null {
  if (!existsSync(dbFile)) return null
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(dbFile, { readOnly: true })
    db.exec('PRAGMA busy_timeout = 2000')
    const rows = db
      .prepare(
        `SELECT COALESCE(json_extract(data, '$.providerID'), '') AS p, COALESCE(json_extract(data, '$.modelID'), '') AS m,
                COUNT(*) AS n,
                COALESCE(SUM(json_extract(data, '$.tokens.input')), 0) AS i,
                COALESCE(SUM(COALESCE(json_extract(data, '$.tokens.output'), 0) + COALESCE(json_extract(data, '$.tokens.reasoning'), 0)), 0) AS o,
                COALESCE(SUM(json_extract(data, '$.tokens.cache.read')), 0) AS r,
                COALESCE(SUM(json_extract(data, '$.tokens.cache.write')), 0) AS w,
                COALESCE(SUM(json_extract(data, '$.cost')), 0) AS c
         FROM message WHERE json_extract(data, '$.role') = 'assistant' AND json_extract(data, '$.tokens') IS NOT NULL AND time_created >= ?
         GROUP BY p, m`,
      )
      .all(since) as Obj[]
    return rows.map((r) => ({
      provider: clip(r.p, 60),
      model: clip(r.m, 80),
      turns: Number(r.n),
      inputTokens: Number(r.i),
      outputTokens: Number(r.o),
      cacheRead: Number(r.r),
      cacheWrite: Number(r.w),
      reportedCostUsd: Number(r.c),
    }))
  } catch {
    return null
  } finally {
    try {
      db?.close()
    } catch {
      /* already closed */
    }
  }
}

// `opencode stats --json`: models[] with { model: { id, providerID }, steps, tokens: { input, output, reasoning, cache: { read, write } }, cost }.
export function parseOpenCodeStats(body: unknown): OpenCodeRow[] {
  const models = Array.isArray(obj(body).models) ? (obj(body).models as unknown[]) : []
  const merged = new Map<string, OpenCodeRow>()
  for (const raw of models) {
    const m = obj(raw)
    const id = obj(m.model)
    const t = obj(m.tokens)
    const row: OpenCodeRow = {
      provider: clip(id.providerID, 60),
      model: clip(id.id, 80),
      turns: num(m.steps) ?? 0,
      inputTokens: num(t.input) ?? 0,
      outputTokens: (num(t.output) ?? 0) + (num(t.reasoning) ?? 0),
      cacheRead: num(obj(t.cache).read) ?? 0,
      cacheWrite: num(obj(t.cache).write) ?? 0,
      reportedCostUsd: num(m.cost) ?? 0,
    }
    // A model appears once per variant; the page shows it once.
    const key = `${row.provider}\u0000${row.model}`
    const have = merged.get(key)
    if (!have) merged.set(key, row)
    else for (const k of ['turns', 'inputTokens', 'outputTokens', 'cacheRead', 'cacheWrite', 'reportedCostUsd'] as const) have[k] += row[k]
  }
  return [...merged.values()]
}

export const runOpenCodeStats = async (days = OPENCODE_DAYS): Promise<unknown | null> => {
  const r = await runHidden('opencode', ['stats', '--json', '--days', String(days)], { timeoutMs: 30_000, source: 'providers' })
  if (r.code !== 0) return null
  try {
    return JSON.parse(r.stdout)
  } catch {
    return null
  }
}

// Reported cost wins; otherwise the price table when the model has a row; otherwise nothing is known.
export function openCodeProviderRows(rows: OpenCodeRow[]): ProviderUsageRow[] {
  const by = new Map<string, ProviderUsageRow>()
  for (const r of rows) {
    const key = r.provider || 'unknown'
    const row = by.get(key) ?? { provider: key, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, turns: 0, estimate: false }
    row.inputTokens += r.inputTokens
    row.outputTokens += r.outputTokens
    row.cacheRead += r.cacheRead
    row.cacheWrite += r.cacheWrite
    row.turns += r.turns
    if (r.reportedCostUsd > 0) row.costUsd += r.reportedCostUsd
    else {
      // OpenCode reported no cost for these tokens: it is figured here, or unknown (0).
      row.estimate = true
      if (isPriced(r.model)) {
        row.costUsd += costUsd(r.model, { inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheRead, cacheWrite5mTokens: r.cacheWrite, cacheWrite1hTokens: 0 })
      }
    }
    by.set(key, row)
  }
  return [...by.values()].sort((a, b) => b.costUsd - a.costUsd || b.turns - a.turns)
}

// ---- The monitor ---------------------------------------------------------------------------------------

export interface ProviderMonitorDeps {
  store: Store
  now?: () => number
  fetch?: FetchLike
  // The text of a file, or null when it cannot be read.
  readFile?: (path: string) => string | null
  claudeDir?: () => string
  // Environments a seat runs with: where a z.ai base URL and key would be.
  seatEnvs?: () => Array<Record<string, string | undefined>>
  openCodeDb?: () => string
  openCodeStats?: () => Promise<unknown | null>
  onAlert?: (a: ProviderAlert) => void
}

const realFetch: FetchLike = (url, init) => fetch(url, { headers: init.headers, signal: init.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS) }) as unknown as Promise<FetchResponse>
const realRead = (p: string): string | null => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

// Claude Code keeps its settings env in ~/.claude/settings.json; read here only to find a z.ai base URL and key.
function defaultSeatEnvs(read: (p: string) => string | null, dir: string): Array<Record<string, string | undefined>> {
  const out: Array<Record<string, string | undefined>> = [process.env]
  const text = read(join(dir, 'settings.json'))
  if (text) {
    try {
      const env = obj(obj(JSON.parse(text)).env)
      out.push(Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === 'string')) as Record<string, string>)
    } catch {
      /* unreadable settings */
    }
  }
  return out
}

export class ProviderMonitor {
  private readonly now: () => number
  private readonly fetchFn: FetchLike
  private readonly read: (p: string) => string | null
  private readonly claudeHome: () => string
  private readonly opencodeDb: () => string
  private readonly opencodeStats: () => Promise<unknown | null>
  private claude: ProviderStatus
  private zai: ProviderStatus
  private opencode: ProviderStatus
  private planGood: ProviderWindow[] | null = null
  private planBackoffUntil = 0
  private plan429 = 0
  private zaiBackoffUntil = 0
  private readonly alertKeys = new Set<string>()
  private readonly alerts: ProviderAlert[] = []

  constructor(private readonly d: ProviderMonitorDeps) {
    this.now = d.now ?? Date.now
    this.fetchFn = d.fetch ?? realFetch
    this.read = d.readFile ?? realRead
    this.claudeHome = d.claudeDir ?? (() => claudeDir())
    this.opencodeDb = d.openCodeDb ?? (() => openCodeDbPath(homedir()))
    this.opencodeStats = d.openCodeStats ?? (() => runOpenCodeStats())
    this.claude = this.blank('claude', 'Claude plan', 'off', 'Not read yet')
    this.zai = this.blank('zai', 'z.ai', 'off', 'No seat uses a z.ai base URL')
    this.opencode = this.blank('opencode', 'OpenCode', 'off', 'Not read yet')
  }

  private blank(id: string, name: string, state: ProviderStatus['state'], note: string): ProviderStatus {
    return { id, name, state, windows: [], balance: null, rows: [], estimate: false, note, fetchedAt: null, nextPollAt: null }
  }

  status(): ProvidersStatus {
    return { providers: [this.withEstimate(this.claude), this.zai, this.opencode], alerts: [...this.alerts] }
  }

  // Claude's rows come from what Operant recorded: priced from the table, so an estimate and not a bill.
  private withEstimate(s: ProviderStatus): ProviderStatus {
    const since = this.now() - OPENCODE_DAYS * 86_400_000
    const r = this.d.store.db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(input_tokens), 0) AS i, COALESCE(SUM(output_tokens), 0) AS o, COALESCE(SUM(cache_read), 0) AS r,
                COALESCE(SUM(cache_w5m + cache_w1h), 0) AS w, COALESCE(SUM(cost_usd), 0) AS c
         FROM usage WHERE provider = 'anthropic' AND legacy = 0 AND at >= ?`,
      )
      .get(since) as Obj
    const rows: ProviderUsageRow[] = Number(r.n) > 0 ? [{ provider: 'anthropic', inputTokens: Number(r.i), outputTokens: Number(r.o), cacheRead: Number(r.r), cacheWrite: Number(r.w), costUsd: Number(r.c), turns: Number(r.n), estimate: true }] : []
    return { ...s, rows, estimate: rows.length > 0 }
  }

  // Polls what is due. `force` skips the 10-minute wait but never a back-off.
  async refresh(force = false): Promise<ProvidersStatus> {
    await Promise.all([this.pollPlan(force), this.pollZai(force), this.pollOpenCode()])
    return this.status()
  }

  // Claude: the five-hour and weekly windows, with the login Claude Code keeps. The token is read into a local
  // variable for the one request and never stored or logged; Operant never refreshes the login.
  async pollPlan(force = false): Promise<void> {
    const now = this.now()
    const cur = this.claude
    if (cur.fetchedAt != null && !force && now - cur.fetchedAt < PLAN_POLL_MS - 5000) return
    if (now < this.planBackoffUntil) return
    const set = (p: Partial<ProviderStatus>) => {
      this.claude = { ...this.claude, ...p, fetchedAt: this.now(), nextPollAt: Math.max(this.now() + PLAN_POLL_MS, this.planBackoffUntil) }
    }
    let token: string | undefined
    try {
      const text = this.read(join(this.claudeHome(), '.credentials.json'))
      token = text ? (obj(obj(JSON.parse(text)).claudeAiOauth).accessToken as string | undefined) : undefined
    } catch {
      token = undefined
    }
    if (!token || typeof token !== 'string') return set({ state: 'signed-out', windows: [], note: 'Sign in to Claude Code to see your plan limits' })
    try {
      const r = await this.fetchFn('https://api.anthropic.com/api/oauth/usage', {
        headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'Operant2' },
      })
      token = undefined
      if (r.status === 401) return set({ state: 'error', note: 'Claude login expired: open Claude Code to refresh it' })
      if (r.status === 429) {
        this.plan429++
        const wait = Math.max((Number(r.headers.get('retry-after')) || 0) * 1000, Math.min(PLAN_BACKOFF_MAX_MIN, 2 ** this.plan429) * 60_000)
        this.planBackoffUntil = this.now() + wait
        return set({ state: 'rate-limited', windows: this.planGood ?? [], note: this.planGood ? 'Plan limits are busy: showing the last reading' : 'Plan limits are busy: trying again shortly' })
      }
      if (!r.ok) return set({ state: 'error', note: `Could not read plan limits (${r.status})` })
      const windows = parsePlanUsage(await r.json())
      this.plan429 = 0
      this.planBackoffUntil = 0
      this.planGood = windows
      set({ state: windows.length ? 'ok' : 'error', windows, note: windows.length ? '' : 'The plan limits response had no windows' })
      this.alertOn('claude', windows)
    } catch (e) {
      token = undefined
      set({ state: 'error', note: `Could not read plan limits (${e instanceof Error && e.name === 'TimeoutError' ? 'timed out' : 'network error'})` })
    }
  }

  // One alert per window per threshold, per reset of that window.
  private alertOn(providerId: string, windows: ProviderWindow[]): void {
    for (const w of windows) {
      if (w.usedPct == null) continue
      const hit = [...ALERT_AT].reverse().find((t) => w.usedPct! >= t)
      if (hit == null) continue
      for (const t of ALERT_AT.filter((x) => x <= hit)) {
        const key = `${providerId}|${w.id}|${w.resetsAt ?? ''}|${t}`
        if (this.alertKeys.has(key)) continue
        this.alertKeys.add(key)
        if (t < hit) continue
        const alert: ProviderAlert = { providerId, windowId: w.id, thresholdPct: t, usedPct: w.usedPct, resetsAt: w.resetsAt, at: this.now() }
        this.alerts.push(alert)
        if (this.alerts.length > 50) this.alerts.shift()
        try {
          this.d.onAlert?.(alert)
        } catch {
          /* a listener never breaks polling */
        }
      }
    }
  }

  // z.ai: only when some seat's ANTHROPIC_BASE_URL is a z.ai or bigmodel.cn one. Failures degrade quietly to a note.
  async pollZai(force = false): Promise<void> {
    const envs = (this.d.seatEnvs ?? (() => defaultSeatEnvs(this.read, this.claudeHome())))()
    const target = envs.map((e) => ({ origin: zaiOrigin(e.ANTHROPIC_BASE_URL), key: e.ANTHROPIC_AUTH_TOKEN || e.ANTHROPIC_API_KEY })).find((t) => t.origin && t.key)
    if (!target) {
      const any = envs.some((e) => zaiOrigin(e.ANTHROPIC_BASE_URL))
      this.zai = this.blank('zai', 'z.ai', any ? 'signed-out' : 'off', any ? 'A z.ai base URL is set but no key was found' : 'No seat uses a z.ai base URL')
      return
    }
    const now = this.now()
    if (this.zai.fetchedAt != null && !force && now - this.zai.fetchedAt < PLAN_POLL_MS - 5000) return
    if (now < this.zaiBackoffUntil) return
    const { origin, key } = target as { origin: string; key: string }
    const end = now
    const q = `?startTime=${encodeURIComponent(zaiTime(end - 86_400_000))}&endTime=${encodeURIComponent(zaiTime(end))}`
    const get = async (path: string): Promise<{ status: number; body: unknown; retryAfter: number }> => {
      // The key goes in the Authorization header as is (no Bearer) and nowhere else.
      const r = await this.fetchFn(`${origin}/api/monitor/usage/${path}`, { headers: { Authorization: key, 'Accept-Language': 'en-US,en', 'Content-Type': 'application/json' } })
      return { status: r.status, body: r.ok ? await r.json().catch(() => null) : null, retryAfter: Number(r.headers.get('retry-after')) || 0 }
    }
    const done = (p: Partial<ProviderStatus>) => {
      this.zai = { ...this.blank('zai', 'z.ai', 'ok', ''), ...p, fetchedAt: this.now(), nextPollAt: Math.max(this.now() + PLAN_POLL_MS, this.zaiBackoffUntil) }
    }
    try {
      const quota = await get('quota/limit')
      if (quota.status === 429) {
        this.zaiBackoffUntil = this.now() + Math.max(quota.retryAfter * 1000, 5 * 60_000)
        return done({ state: 'rate-limited', windows: this.zai.windows, note: 'z.ai asked to slow down: trying again later' })
      }
      if (quota.status === 401 || quota.status === 403) return done({ state: 'error', note: 'z.ai refused the key' })
      if (quota.status !== 200 || quota.body == null) return done({ state: 'error', note: `z.ai usage is not available (${quota.status})` })
      const [model, tool] = await Promise.all([get(`model-usage${q}`).catch(() => null), get(`tool-usage${q}`).catch(() => null)])
      const windows = [...parseZaiQuota(quota.body), ...parseZaiTotals(model?.body, tool?.body)]
      done({ state: windows.length ? 'ok' : 'error', windows, note: windows.length ? 'Read from z.ai; the response format is not documented' : 'z.ai replied but nothing could be read from it' })
      this.alertOn('zai', windows)
    } catch (e) {
      done({ state: 'error', note: `z.ai could not be reached (${e instanceof Error && e.name === 'TimeoutError' ? 'timed out' : 'network error'})` })
    }
  }

  // OpenCode: usage per provider from its database (read-only), else from `opencode stats --json`. OpenCode keeps
  // no limits, so the cost is what it reported or an estimate from tokens, and says which.
  async pollOpenCode(): Promise<void> {
    const since = this.now() - OPENCODE_DAYS * 86_400_000
    let rows = readOpenCodeUsage(this.opencodeDb(), since)
    let source = 'its database'
    if (rows == null) {
      const stats = await this.opencodeStats().catch(() => null)
      rows = stats ? parseOpenCodeStats(stats) : null
      source = '`opencode stats`'
    }
    if (rows == null) {
      this.opencode = { ...this.blank('opencode', 'OpenCode', 'off', 'OpenCode usage could not be read'), fetchedAt: this.now() }
      return
    }
    const out = openCodeProviderRows(rows)
    const estimate = out.some((r) => r.estimate)
    this.opencode = {
      ...this.blank('opencode', 'OpenCode', estimate ? 'estimate' : 'ok', `Last ${OPENCODE_DAYS} days from ${source}${estimate ? '; cost not reported by some providers is estimated from tokens (0 when the model has no price)' : ''}`),
      rows: out,
      estimate,
      fetchedAt: this.now(),
    }
  }
}
