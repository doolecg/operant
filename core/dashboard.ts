import type { Settings } from '../shared/settings'
import type {
  CapProgress,
  ColdCause,
  GraphData,
  GraphEdge,
  GraphNode,
  GraphWindow,
  JobUsage,
  KindCost,
  Operator,
  OperatorUsage,
  UsageBreakdownResult,
  UsageCell,
  UsagePeriod,
  WasteSignal,
} from '../shared/types'
import { rateOrFallback } from './pricing'
import type { Store } from './store'
import type { UsageTracker } from './usage'

type Row = Record<string, unknown>

const HOUR = 60 * 60 * 1000
const PERIOD_MS: Record<UsagePeriod, number> = { '24h': 24 * HOUR, '7d': 7 * 24 * HOUR, '30d': 30 * 24 * HOUR }

// Waste thresholds the spec leaves open: repeated cold events, a streak of turns without a tool call, and
// a context above this share of the role's cap. The output share and the 3x job rule follow the spec.
export const WASTE = { coldRepeated: 3, noToolStreak: 5, contextOfCap: 0.8, jobCostMultiple: 3 }

const startOfDay = (t: number) => {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

const emptyKinds = (): KindCost => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
const addKinds = (a: KindCost, b: KindCost): KindCost => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
})

// The kinds are priced from list prices; the stored per-turn total stays the truth for spend.
export function kindCost(model: string, t: { input: number; output: number; cacheRead: number; cacheW5m: number; cacheW1h: number }): KindCost {
  const r = rateOrFallback(model)
  return {
    input: (t.input * r.input) / 1e6,
    output: (t.output * r.output) / 1e6,
    cacheRead: (t.cacheRead * (r.cacheRead ?? r.input * 0.1)) / 1e6,
    cacheWrite: ((t.cacheW5m * 1.25 + t.cacheW1h * 2) * r.input) / 1e6,
  }
}

const CACHE_TTL_MS = { '5m': 5 * 60 * 1000, '1h': HOUR }

// The latest cold turn of the period and what set it off, judged against the turn before it (which may
// fall before the period).
function lastColdCause(db: Store['db'], operatorId: number, since: number): ColdCause | null {
  const cold = db
    .prepare('SELECT id, at, model, cache_w1h FROM usage WHERE operator_id = ? AND at >= ? AND cold = 1 AND legacy = 0 ORDER BY at DESC, id DESC LIMIT 1')
    .get(operatorId, since) as Row | undefined
  if (!cold) return null
  const prev = db
    .prepare('SELECT at, model FROM usage WHERE operator_id = ? AND legacy = 0 AND (at < ? OR (at = ? AND id < ?)) ORDER BY at DESC, id DESC LIMIT 1')
    .get(operatorId, Number(cold.at), Number(cold.at), Number(cold.id)) as Row | undefined
  if (!prev) return 'prompt'
  if (String(prev.model) !== String(cold.model)) return 'model'
  const ttl = Number(cold.cache_w1h) > 0 ? CACHE_TTL_MS['1h'] : CACHE_TTL_MS['5m']
  return Number(cold.at) - Number(prev.at) > ttl ? 'idle' : 'prompt'
}

export interface BreakdownDeps {
  store: Store
  usage: UsageTracker
  now: () => number
  settings: () => Settings
}

function capProgress(spent: number, cap: number, paused: boolean): CapProgress | null {
  return cap > 0 ? { capUsd: cap, spentUsd: spent, pct: (spent / cap) * 100, paused } : null
}

export function usageBreakdown(d: BreakdownDeps, crewId: number, period: UsagePeriod): UsageBreakdownResult {
  const { store, usage } = d
  const settings = d.settings()
  const since = d.now() - PERIOD_MS[period]
  const db = store.db

  const rows: UsageCell[] = store.usageBreakdown({ crewId }, since).map((r) => ({
    ...r,
    kindCostUsd: kindCost(r.model, { input: r.inputTokens, output: r.outputTokens, cacheRead: r.cacheRead, cacheW5m: r.cacheW5m, cacheW1h: r.cacheW1h }),
  }))
  const byModel = new Map<string, number>()
  let byKind = emptyKinds()
  let totalUsd = 0
  const scratch = { costUsd: 0, turns: 0 }
  for (const r of rows) {
    totalUsd += r.costUsd
    byKind = addKinds(byKind, r.kindCostUsd)
    byModel.set(r.model, (byModel.get(r.model) ?? 0) + r.costUsd)
    if (r.group === 'scratch') {
      scratch.costUsd += r.costUsd
      scratch.turns += r.turns
    }
  }

  const topology = store.topology(crewId)
  const master = store.getMaster(crewId)
  const operators: Operator[] = [...(topology?.squads.flatMap((s) => s.operators) ?? []), ...(master ? [master] : [])]
  const today = startOfDay(d.now())
  const perModel = db.prepare(
    `SELECT model, COALESCE(SUM(input_tokens), 0) AS i, COALESCE(SUM(output_tokens), 0) AS o, COALESCE(SUM(cache_read), 0) AS r,
            COALESCE(SUM(cache_w5m), 0) AS w5, COALESCE(SUM(cache_w1h), 0) AS w1
     FROM usage WHERE operator_id = ? AND at >= ? GROUP BY model`,
  )
  const spentToday = db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS t FROM usage WHERE operator_id = ? AND at >= ?')
  const operatorUsage: OperatorUsage[] = operators.map((op) => {
    const stats = usage.stats(op.id, since)
    let kinds = emptyKinds()
    let input = 0
    let output = 0
    let read = 0
    let write = 0
    for (const r of perModel.all(op.id, since) as Row[]) {
      const t = { input: Number(r.i), output: Number(r.o), cacheRead: Number(r.r), cacheW5m: Number(r.w5), cacheW1h: Number(r.w1) }
      kinds = addKinds(kinds, kindCost(String(r.model), t))
      input += t.input
      output += t.output
      read += t.cacheRead
      write += t.cacheW5m + t.cacheW1h
    }
    const cap = op.dailyCapUsd ?? settings.tokens.operatorDailyCapUsd
    const spent = Number((spentToday.get(op.id, today) as Row).t)
    const perJob = stats.costPerJob
    return {
      operatorId: op.id,
      address: store.operatorAddress(op.id) ?? op.role,
      kind: op.kind,
      model: op.model,
      costUsd: stats.costUsd,
      turns: stats.turns,
      inputTokens: input,
      outputTokens: output,
      cacheRead: read,
      cacheWrite: write,
      kindCostUsd: kinds,
      hitRatio: stats.cacheHitRatio,
      coldCount: stats.coldCount,
      lastColdCause: lastColdCause(db, op.id, since),
      outputShare: stats.outputShare,
      medianContext: stats.medianContext,
      avgCostPerJobUsd: perJob.length ? perJob.reduce((a, j) => a + j.costUsd, 0) / perJob.length : null,
      cap: capProgress(spent, cap, usage.caps.isPaused(op.id)),
      unpriced: stats.unpriced,
    }
  })

  // Per job: every operator of this project that spent on it.
  const byJob = new Map<number, JobUsage>()
  const jobRows = db
    .prepare(
      `SELECT u.job_id, u.operator_id, COUNT(*) AS n, SUM(u.cost_usd) AS c
       FROM usage u JOIN operators s ON s.id = u.operator_id JOIN squads p ON p.id = s.squad_id
       WHERE p.crew_id = ? AND u.at >= ? AND u.job_id IS NOT NULL GROUP BY u.job_id, u.operator_id`,
    )
    .all(crewId, since) as Row[]
  for (const r of jobRows) {
    const id = Number(r.job_id)
    const j = byJob.get(id) ?? { jobId: id, title: store.getJob(id)?.title ?? `job ${id}`, costUsd: 0, turns: 0, operators: [] }
    j.costUsd += Number(r.c)
    j.turns += Number(r.n)
    j.operators.push(Number(r.operator_id))
    byJob.set(id, j)
  }
  const allJobs = [...byJob.values()].sort((a, b) => b.costUsd - a.costUsd)
  const medianJobCostUsd = median(allJobs.map((j) => j.costUsd))

  const waste: WasteSignal[] = []
  const warnShare = settings.tokens.outputShareWarnPct
  const streaks = new Map<number, number>()
  const turnRows = db
    .prepare(
      `SELECT u.operator_id, u.tool_use FROM usage u JOIN operators s ON s.id = u.operator_id JOIN squads p ON p.id = s.squad_id
       WHERE p.crew_id = ? AND u.at >= ? AND u.legacy = 0 ORDER BY u.operator_id, u.at, u.id`,
    )
    .all(crewId, since) as Row[]
  let run = 0
  let runOwner = -1
  for (const r of turnRows) {
    const id = Number(r.operator_id)
    if (id !== runOwner) {
      runOwner = id
      run = 0
    }
    run = Number(r.tool_use) === 1 ? 0 : run + 1
    streaks.set(id, Math.max(streaks.get(id) ?? 0, run))
  }
  for (const o of operatorUsage) {
    const op = operators.find((x) => x.id === o.operatorId)!
    if (o.coldCount >= WASTE.coldRepeated) {
      waste.push({
        kind: 'cold-repeated',
        operatorId: o.operatorId,
        jobId: null,
        text: `${o.address} had ${o.coldCount} cold-cache turns`,
        value: o.coldCount,
        threshold: WASTE.coldRepeated,
      })
    }
    if (o.costUsd > 0 && o.outputShare * 100 > warnShare) {
      waste.push({
        kind: 'output-share',
        operatorId: o.operatorId,
        jobId: null,
        text: `${o.address}: output is ${Math.round(o.outputShare * 100)}% of its cost`,
        value: o.outputShare * 100,
        threshold: warnShare,
      })
    }
    const streak = streaks.get(o.operatorId) ?? 0
    if (streak >= WASTE.noToolStreak) {
      waste.push({
        kind: 'no-tool-streak',
        operatorId: o.operatorId,
        jobId: null,
        text: `${o.address} had ${streak} turns in a row without using a tool`,
        value: streak,
        threshold: WASTE.noToolStreak,
      })
    }
    if (op.contextCap > 0 && o.medianContext > op.contextCap * WASTE.contextOfCap) {
      waste.push({
        kind: 'context-high',
        operatorId: o.operatorId,
        jobId: null,
        text: `${o.address}: median context ${Math.round(o.medianContext / 1000)}k is over ${Math.round(WASTE.contextOfCap * 100)}% of its ${Math.round(op.contextCap / 1000)}k cap`,
        value: o.medianContext,
        threshold: op.contextCap * WASTE.contextOfCap,
      })
    }
  }
  if (medianJobCostUsd > 0) {
    for (const j of allJobs) {
      if (j.costUsd > medianJobCostUsd * WASTE.jobCostMultiple) {
        waste.push({
          kind: 'job-cost',
          operatorId: null,
          jobId: j.jobId,
          text: `Job ${j.jobId} cost $${j.costUsd.toFixed(2)}, over ${WASTE.jobCostMultiple}x the project's median job ($${medianJobCostUsd.toFixed(2)})`,
          value: j.costUsd,
          threshold: medianJobCostUsd * WASTE.jobCostMultiple,
        })
      }
    }
  }

  return {
    crewId,
    period,
    since,
    totalUsd,
    today: store.usageBreakdown({ crewId }, today).reduce((a, r) => a + r.costUsd, 0),
    rows,
    byKind,
    byModel: [...byModel].map(([model, costUsd]) => ({ model, costUsd })).sort((a, b) => b.costUsd - a.costUsd),
    scratch,
    operators: operatorUsage,
    jobs: allJobs.slice(0, 10),
    medianJobCostUsd,
    waste,
  }
}

const GRAPH_WINDOW_MS: Record<Exclude<GraphWindow, 'all'>, number> = { '1h': HOUR, '24h': 24 * HOUR }

// Nodes, aggregated edges and saved positions for the graph view.
export function graphData(store: Store, now: () => number, crewId: number, window: GraphWindow): GraphData {
  const topology = store.topology(crewId)
  if (!topology) throw new Error(`Project ${crewId} not found`)
  const since = window === 'all' ? 0 : now() - GRAPH_WINDOW_MS[window]
  const nodes: GraphNode[] = [{ key: 'crew', type: 'crew', label: topology.name }, { key: 'user', type: 'user', label: 'user' }]
  const edges: GraphEdge[] = []
  const keys = new Set(['crew', 'user'])
  const push = (n: GraphNode) => {
    nodes.push(n)
    keys.add(n.key)
  }
  for (const squad of topology.squads) {
    push({ key: `squad:${squad.id}`, type: 'squad', label: squad.name, squadId: squad.id })
    edges.push({ id: `member:crew>squad:${squad.id}`, from: 'crew', to: `squad:${squad.id}`, kind: 'member', label: '', count: 1 })
    for (const op of squad.operators) {
      push({ key: `op:${op.id}`, type: 'operator', label: op.role, status: op.status, operatorId: op.id, squadId: squad.id })
      edges.push({ id: `member:squad:${squad.id}>op:${op.id}`, from: `squad:${squad.id}`, to: `op:${op.id}`, kind: 'member', label: '', count: 1 })
    }
  }
  // The Master slot is created on first use; the graph shows it from the start so it can be messaged and linked.
  const master = store.ensureMaster(crewId)
  push({ key: `op:${master.id}`, type: 'master', label: master.role, status: master.status, operatorId: master.id })
  edges.push({ id: `member:crew>op:${master.id}`, from: 'crew', to: `op:${master.id}`, kind: 'member', label: '', count: 1 })

  const keyOf = (kind: unknown, id: unknown): string | null => (kind === 'user' ? 'user' : id == null ? null : `op:${Number(id)}`)
  const rows = store.db
    .prepare(
      `SELECT from_kind, from_id, to_kind, to_id, COUNT(*) AS c FROM messages
       WHERE crew_id = ? AND created_at >= ? GROUP BY from_kind, from_id, to_kind, to_id`,
    )
    .all(crewId, since) as Row[]
  const pairs = new Map<string, number>()
  for (const r of rows) {
    const from = keyOf(r.from_kind, r.from_id)
    const to = keyOf(r.to_kind, r.to_id)
    if (!from || !to || from === to || !keys.has(from) || !keys.has(to)) continue
    pairs.set(`${from}>${to}`, (pairs.get(`${from}>${to}`) ?? 0) + Number(r.c))
  }
  for (const [pair, count] of pairs) {
    const [from, to] = pair.split('>') as [string, string]
    edges.push({ id: `message:${pair}`, from, to, kind: 'message', label: String(count), count })
  }

  const jobs = store.db
    .prepare(
      `SELECT created_by, assignee_id, COUNT(*) AS c FROM jobs
       WHERE crew_id = ? AND created_by IS NOT NULL AND assignee_id IS NOT NULL AND created_by <> assignee_id AND updated_at >= ?
       GROUP BY created_by, assignee_id`,
    )
    .all(crewId, since) as Row[]
  for (const r of jobs) {
    const from = `op:${Number(r.created_by)}`
    const to = `op:${Number(r.assignee_id)}`
    if (keys.has(from) && keys.has(to)) edges.push({ id: `job:${from}>${to}`, from, to, kind: 'job', label: String(r.c), count: Number(r.c) })
  }

  for (const l of store.listLinks(crewId)) {
    const from = `op:${l.fromId}`
    const to = `op:${l.toId}`
    if (keys.has(from) && keys.has(to)) edges.push({ id: `link:${l.id}`, from, to, kind: 'link', label: l.label, count: 1, linkId: l.id })
  }
  return { crewId, window, nodes, edges, positions: store.getNodePositions(crewId) }
}
