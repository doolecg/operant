import type {
  JobAgentUsage,
  RunUsage,
  UsageFilter,
  UsageGroupBy,
  UsageQuery,
  UsageReport,
  UsageRowOut,
  UsageSeries,
  UsageSeriesQuery,
  UsageTotals,
  UsageTrend,
} from '../shared/types'
import type { Store } from './store'

type Row = Record<string, unknown>

// One usage row with the operator and scratch terminal it may belong to, so a row's project and seat resolve
// whether it came from an operator, a scratch terminal, a job agent, the front desk or an import.
const FROM = `FROM usage u
  LEFT JOIN operators o ON o.id = u.operator_id
  LEFT JOIN squads sq ON sq.id = o.squad_id
  LEFT JOIN scratch sc ON sc.id = u.scratch_id`

const CREW = 'COALESCE(u.crew_id, sq.crew_id, sc.crew_id)'
const SEAT = "CASE WHEN u.seat <> '' THEN u.seat WHEN o.id IS NOT NULL THEN o.role WHEN sc.id IS NOT NULL THEN 'scratch' ELSE '' END"
const LOCAL = "u.at / 1000, 'unixepoch', 'localtime'"

// The SQL text each grouping resolves to. A project with no crew keeps its imported label.
const GROUP_SQL: Record<UsageGroupBy, string> = {
  day: `strftime('%Y-%m-%d', ${LOCAL})`,
  hour: `strftime('%Y-%m-%d %H:00', ${LOCAL})`,
  project: `COALESCE(CAST(${CREW} AS TEXT), CASE WHEN u.project_label <> '' THEN 'label:' || u.project_label ELSE '' END)`,
  run: "COALESCE(CAST(u.run_id AS TEXT), '')",
  seat: SEAT,
  agent: "CASE WHEN u.job_agent_id IS NOT NULL THEN 'a' || u.job_agent_id WHEN u.source = 'master' THEN 'master' ELSE '' END",
  model: 'u.model',
  cli: 'u.cli',
  provider: "CASE WHEN u.provider <> '' THEN u.provider ELSE '' END",
  source: 'u.source',
}

const SOURCE_LABELS: Record<string, string> = {
  operator: 'Operator',
  scratch: 'Scratch terminal',
  master: 'Job Master',
  agent: 'Job agent',
  frontdesk: 'Discord front desk',
  import: 'Imported',
}

export const USAGE_GROUPS = Object.keys(GROUP_SQL) as UsageGroupBy[]

export const emptyTotals = (): UsageTotals => ({ inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, turns: 0, legacyTurns: 0 })

export function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    costUsd: a.costUsd + b.costUsd,
    turns: a.turns + b.turns,
    legacyTurns: a.legacyTurns + b.legacyTurns,
  }
}

export const sumRows = (rows: UsageTotals[]): UsageTotals => rows.reduce(addTotals, emptyTotals())

const finite = (v: unknown, fallback?: number): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

// Only the known filter keys survive, with the right types; anything else is dropped.
export function cleanFilter(f: unknown): UsageFilter {
  const r = (f && typeof f === 'object' ? f : {}) as Record<string, unknown>
  const out: UsageFilter = {}
  const num = (k: keyof UsageFilter) => {
    const v = finite(r[k])
    if (v !== undefined) (out as Record<string, unknown>)[k] = v
  }
  const str = (k: keyof UsageFilter) => {
    const v = text(r[k])
    if (v !== undefined) (out as Record<string, unknown>)[k] = v
  }
  num('from')
  num('to')
  num('crewId')
  num('runId')
  num('agentId')
  str('model')
  str('cli')
  str('provider')
  str('seat')
  str('source')
  if (r.legacy === 'include' || r.legacy === 'exclude' || r.legacy === 'only') out.legacy = r.legacy
  return out
}

export function cleanGroupBy(g: unknown): UsageGroupBy[] {
  if (g === undefined) return []
  if (!Array.isArray(g) || g.some((x) => !USAGE_GROUPS.includes(x as UsageGroupBy))) throw new Error(`Group by must be a list of: ${USAGE_GROUPS.join(', ')}`)
  return [...new Set(g as UsageGroupBy[])]
}

function where(f: UsageFilter): { sql: string; args: Array<string | number> } {
  const parts: string[] = []
  const args: Array<string | number> = []
  const add = (sql: string, ...a: Array<string | number>) => {
    parts.push(sql)
    args.push(...a)
  }
  if (f.from !== undefined) add('u.at >= ?', f.from)
  if (f.to !== undefined) add('u.at < ?', f.to)
  if (f.crewId !== undefined) add(`${CREW} = ?`, f.crewId)
  if (f.model !== undefined) add('u.model = ?', f.model)
  if (f.cli !== undefined) add('u.cli = ?', f.cli)
  if (f.provider !== undefined) add('u.provider = ?', f.provider)
  if (f.runId !== undefined) add('u.run_id = ?', f.runId)
  if (f.seat !== undefined) add(`${SEAT} = ?`, f.seat)
  if (f.agentId !== undefined) add('u.job_agent_id = ?', f.agentId)
  if (f.source !== undefined) add('u.source = ?', f.source)
  if (f.legacy === 'exclude') add('u.legacy = 0')
  if (f.legacy === 'only') add('u.legacy = 1')
  return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', args }
}

const AGG = `COUNT(*) AS n, COALESCE(SUM(u.legacy), 0) AS legacy_n,
  COALESCE(SUM(u.input_tokens), 0) AS i, COALESCE(SUM(u.output_tokens), 0) AS o, COALESCE(SUM(u.cache_read), 0) AS r,
  COALESCE(SUM(u.cache_w5m + u.cache_w1h), 0) AS w, COALESCE(SUM(u.cost_usd), 0) AS c, MIN(u.at) AS first_at, MAX(u.at) AS last_at`

const totalsOf = (r: Row): UsageTotals => ({
  inputTokens: Number(r.i),
  outputTokens: Number(r.o),
  cacheRead: Number(r.r),
  cacheWrite: Number(r.w),
  costUsd: Number(r.c),
  turns: Number(r.n),
  legacyTurns: Number(r.legacy_n),
})

export interface QueryDeps {
  store: Store
  now: () => number
}

// Human text for the key of one grouping.
function labeller(store: Store): (g: UsageGroupBy, key: string) => string {
  const crews = new Map(store.listCrews().map((c) => [String(c.id), c.name]))
  const agents = new Map<string, string>()
  const label = (g: UsageGroupBy, key: string): string => {
    switch (g) {
      case 'project':
        return key.startsWith('label:') ? key.slice(6) : key ? (crews.get(key) ?? `project ${key}`) : 'No project'
      case 'run':
        return key ? `JOB#${key}` : 'No job'
      case 'agent': {
        if (key === 'master') return 'Master'
        if (!key) return 'No agent'
        if (!agents.has(key)) {
          const a = store.getJobAgent(Number(key.slice(1)))
          agents.set(key, a ? `${a.seat}${a.model ? ` (${a.model})` : ''}` : `agent ${key.slice(1)}`)
        }
        return agents.get(key)!
      }
      case 'seat':
        return key || 'No seat'
      case 'source':
        return SOURCE_LABELS[key] ?? (key || 'unknown')
      case 'provider':
        return key || 'unknown'
      default:
        return key || 'unknown'
    }
  }
  return label
}

// Rows grouped by the given keys, ordered by the first key (days oldest first) or by cost, biggest first.
export function queryUsage(d: QueryDeps, q: UsageQuery): UsageReport {
  const filter = cleanFilter(q.filter)
  const groupBy = cleanGroupBy(q.groupBy)
  const { sql, args } = where(filter)
  const cols = groupBy.map((g, i) => `${GROUP_SQL[g]} AS k${i}`)
  const select = [...cols, AGG].join(', ')
  const group = groupBy.length ? `GROUP BY ${groupBy.map((_, i) => `k${i}`).join(', ')}` : ''
  const timeOrder = groupBy[0] === 'day' || groupBy[0] === 'hour'
  const order = groupBy.length ? `ORDER BY ${timeOrder ? 'k0, c DESC' : 'c DESC, k0'}` : ''
  const raw = d.store.db.prepare(`SELECT ${select} ${FROM} ${sql} ${group} ${order}`).all(...args) as Row[]
  const label = labeller(d.store)
  const rows: UsageRowOut[] = raw.map((r) => {
    const keys = groupBy.map((_, i) => String(r[`k${i}`] ?? ''))
    return {
      ...totalsOf(r),
      keys,
      labels: groupBy.map((g, i) => label(g, keys[i]!)),
      firstAt: r.first_at == null ? null : Number(r.first_at),
      lastAt: r.last_at == null ? null : Number(r.last_at),
    }
  })
  const totals = sumRows(rows)
  let trend: UsageTrend | null = null
  if (q.trend && filter.from !== undefined) {
    const to = filter.to ?? d.now()
    const span = to - filter.from
    const prevFrom = filter.from - span
    const prev = where({ ...filter, from: prevFrom, to: filter.from })
    const r = d.store.db.prepare(`SELECT ${AGG} ${FROM} ${prev.sql}`).get(...prev.args) as Row
    const previous = totalsOf(r)
    trend = {
      previousFrom: prevFrom,
      previousTo: filter.from,
      previous,
      deltaUsd: totals.costUsd - previous.costUsd,
      deltaPct: previous.costUsd > 0 ? ((totals.costUsd - previous.costUsd) / previous.costUsd) * 100 : null,
    }
  }
  return { query: { filter, groupBy, trend: q.trend }, rows, totals, trend }
}

export function querySeries(d: QueryDeps, q: UsageSeriesQuery): UsageSeries {
  if (q.bucket !== 'hour' && q.bucket !== 'day') throw new Error('The bucket must be hour or day')
  const split = q.split
  if (split !== undefined && !USAGE_GROUPS.includes(split)) throw new Error(`The split must be one of: ${USAGE_GROUPS.join(', ')}`)
  const report = queryUsage(d, { filter: q.filter, groupBy: split ? [q.bucket, split] : [q.bucket] })
  const points = report.rows
    .map((r) => ({
      bucket: r.keys[0]!,
      split: r.keys[1] ?? '',
      splitLabel: r.labels[1] ?? '',
      costUsd: r.costUsd,
      tokens: r.inputTokens + r.outputTokens + r.cacheRead + r.cacheWrite,
      turns: r.turns,
    }))
    .sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : a.split < b.split ? -1 : 1))
  return { query: { filter: report.query.filter, bucket: q.bucket, split }, points, totals: report.totals }
}

// What one job spent, per agent: the Master, then every agent of the job (those that spent nothing show zeros).
export function jobUsage(d: QueryDeps, runId: number): RunUsage {
  const { store } = d
  const run = store.getRun(runId)
  const report = queryUsage(d, { filter: { runId }, groupBy: ['agent'] })
  const byKey = new Map(report.rows.map((r) => [r.keys[0]!, r]))
  const pick = (key: string): UsageTotals => {
    const r = byKey.get(key)
    byKey.delete(key)
    return r ? { ...r } : emptyTotals()
  }
  const strip = (t: UsageTotals & Partial<UsageRowOut>): UsageTotals => ({
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    cacheRead: t.cacheRead,
    cacheWrite: t.cacheWrite,
    costUsd: t.costUsd,
    turns: t.turns,
    legacyTurns: t.legacyTurns,
  })
  const agents: JobAgentUsage[] = [{ agentId: null, seat: 'master', model: run?.masterModel ?? '', status: run?.status ?? '', ...strip(pick('master')) }]
  for (const a of run ? store.listJobAgents(runId) : []) agents.push({ agentId: a.id, seat: a.seat, model: a.model, status: a.status, ...strip(pick(`a${a.id}`)) })
  // Usage tied to an agent row that no longer exists, or to none: listed so the rows still add up to the total.
  for (const [key, r] of byKey) agents.push({ agentId: null, seat: key ? r.labels[0]! : 'unattributed', model: '', status: '', ...strip(r) })
  return { runId, crewId: run?.crewId ?? null, task: run?.task ?? '', totals: report.totals, agents }
}
