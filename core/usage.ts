import { EventEmitter } from 'node:events'
import type { OperatorContext } from '../shared/types'
import { isPriced, rateOrFallback } from './pricing'
import type { Store } from './store'
import { JsonlTail, parseLine } from './transcripts'

export interface UsageConfig {
  dailyBudgetUsd: number
  operatorDailyCapUsd: number
  capWarnPct: number
  coldThresholdPct: number
}

export const DEFAULT_USAGE_CONFIG: UsageConfig = {
  dailyBudgetUsd: 0,
  operatorDailyCapUsd: 0,
  capWarnPct: 80,
  coldThresholdPct: 50,
}

const startOfDay = (t: number) => {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// Ruling R2: a turn is cold when cache writes exceed the threshold share of its context, it is not the
// session's first turn (`prevContext` null), and the context did not fall by more than half against the
// previous turn (that looks like a compaction, whose transcript marker is unknown).
export function isColdTurn(
  turn: { contextTokens: number; cacheWriteTokens: number },
  prevContext: number | null,
  thresholdPct = DEFAULT_USAGE_CONFIG.coldThresholdPct,
): boolean {
  if (prevContext == null || turn.contextTokens <= 0) return false
  if (turn.contextTokens < prevContext * 0.5) return false
  return turn.cacheWriteTokens * 100 > turn.contextTokens * thresholdPct
}

export interface StatRow {
  model: string
  jobId: number | null
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheW5m: number
  cacheW1h: number
  costUsd: number
  contextTokens: number
  cold: boolean
  legacy: boolean
}

export interface JobCost {
  jobId: number
  costUsd: number
  turns: number
}

export interface OperatorStats {
  turns: number
  costUsd: number
  // read / (read + writes + input); null when no exact (non-legacy) turn exists.
  cacheHitRatio: number | null
  coldCount: number
  // Output tokens' cost over total cost, 0..1.
  outputShare: number
  medianContext: number
  costPerJob: JobCost[]
  unattributedUsd: number
  // Some turn used a model with no price row (costed at the fallback rate).
  unpriced: boolean
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

// Legacy rows (before the kind split) count toward spend but not toward hit ratios or cold counts.
export function computeStats(rows: StatRow[]): OperatorStats {
  let read = 0
  let write = 0
  let input = 0
  let outputCost = 0
  let exactCost = 0
  let cold = 0
  let unattributedUsd = 0
  let unpriced = false
  const byJob = new Map<number, JobCost>()
  const contexts: number[] = []
  let costUsd = 0
  for (const r of rows) {
    costUsd += r.costUsd
    if (!isPriced(r.model)) unpriced = true
    if (r.jobId == null) unattributedUsd += r.costUsd
    else {
      const j = byJob.get(r.jobId) ?? { jobId: r.jobId, costUsd: 0, turns: 0 }
      j.costUsd += r.costUsd
      j.turns++
      byJob.set(r.jobId, j)
    }
    if (r.legacy) continue
    read += r.cacheRead
    write += r.cacheW5m + r.cacheW1h
    input += r.inputTokens
    exactCost += r.costUsd
    outputCost += (rateOrFallback(r.model).output * r.outputTokens) / 1_000_000
    if (r.cold) cold++
    contexts.push(r.contextTokens)
  }
  const denom = read + write + input
  return {
    turns: rows.length,
    costUsd,
    cacheHitRatio: denom > 0 ? read / denom : null,
    coldCount: cold,
    outputShare: exactCost > 0 ? outputCost / exactCost : 0,
    medianContext: median(contexts),
    costPerJob: [...byJob.values()].sort((a, b) => b.costUsd - a.costUsd),
    unattributedUsd,
    unpriced,
  }
}

// What the caps decided. Data only: the host turns it into nudge/claim blocking, the badge and fixed text.
export interface CapDecision {
  action: 'warn' | 'pause'
  scope: 'operator' | 'daily'
  // null for the daily cap: it pauses every operator.
  operatorId: number | null
  spentUsd: number
  capUsd: number
  pct: number
  windowStart: number
}

export interface CapMonitorOptions {
  now: () => number
  config: () => UsageConfig
  // Spend since a timestamp; the daily figure includes scratch terminals.
  operatorSpend: (operatorId: number, since: number) => number
  totalSpend: (since: number) => number
  // The operator's own cap, null = use the settings default.
  operatorCap: (operatorId: number) => number | null
}

// Windows are local days. One warning and one pause decision per window; a decision fires again only
// after the day rolls over, a reset, or (pause) the spend having dropped back under the cap.
export class CapMonitor {
  private day = 0
  private readonly warned = new Set<string>()
  private readonly paused = new Set<string>()
  private readonly resetAt = new Map<string, number>()

  constructor(private readonly opts: CapMonitorOptions) {}

  check(operatorId?: number): CapDecision[] {
    this.rollover()
    const out: CapDecision[] = []
    const cfg = this.opts.config()
    if (operatorId != null) {
      const cap = this.opts.operatorCap(operatorId) ?? cfg.operatorDailyCapUsd
      const since = this.since(`op:${operatorId}`)
      this.evaluate(out, `op:${operatorId}`, 'operator', operatorId, cap, since, this.opts.operatorSpend(operatorId, since))
    }
    const since = this.since('daily')
    this.evaluate(out, 'daily', 'daily', null, cfg.dailyBudgetUsd, since, this.opts.totalSpend(since))
    return out
  }

  isPaused(operatorId: number): boolean {
    this.rollover()
    return this.paused.has('daily') || this.paused.has(`op:${operatorId}`)
  }

  pausedOperators(): number[] {
    this.rollover()
    return [...this.paused].filter((k) => k.startsWith('op:')).map((k) => Number(k.slice(3)))
  }

  dailyPaused(): boolean {
    this.rollover()
    return this.paused.has('daily')
  }

  // Start of the window the cap counts spend from: midnight, or the last reset when later. 'daily' is the budget.
  windowStart(target: number | 'daily'): number {
    this.rollover()
    return this.since(target === 'daily' ? 'daily' : `op:${target}`)
  }

  // Counts the operator's spend from now on and lets its warning and pause fire again.
  resetOperator(operatorId: number): void {
    this.reset(`op:${operatorId}`)
  }

  resetDaily(): void {
    this.reset('daily')
  }

  // Drops everything remembered for an operator that no longer exists (its id may be reused).
  forget(operatorId: number): void {
    const key = `op:${operatorId}`
    this.warned.delete(key)
    this.paused.delete(key)
    this.resetAt.delete(key)
  }

  private reset(key: string): void {
    this.resetAt.set(key, this.opts.now())
    this.warned.delete(key)
    this.paused.delete(key)
  }

  private since(key: string): number {
    return Math.max(this.day, this.resetAt.get(key) ?? 0)
  }

  private rollover(): void {
    const day = startOfDay(this.opts.now())
    if (day === this.day) return
    this.day = day
    this.warned.clear()
    this.paused.clear()
    this.resetAt.clear()
  }

  private evaluate(
    out: CapDecision[],
    key: string,
    scope: CapDecision['scope'],
    operatorId: number | null,
    cap: number,
    since: number,
    spent: number,
  ): void {
    if (cap <= 0) {
      this.paused.delete(key)
      return
    }
    const pct = (spent / cap) * 100
    // Float sums can land an ulp short of the cap.
    const reached = (limitPct: number) => ((spent + 1e-9) / cap) * 100 >= limitPct
    const decision = (action: CapDecision['action']): CapDecision => ({
      action,
      scope,
      operatorId,
      spentUsd: spent,
      capUsd: cap,
      pct,
      windowStart: since,
    })
    if (reached(100)) {
      if (!this.paused.has(key)) {
        this.paused.add(key)
        this.warned.add(key)
        out.push(decision('pause'))
      }
      return
    }
    this.paused.delete(key)
    if (reached(this.opts.config().capWarnPct) && !this.warned.has(key)) {
      this.warned.add(key)
      out.push(decision('warn'))
    }
  }
}

interface OperatorFeed {
  tail: JsonlTail
  sessionId: string
  // Context of the turn before the current message (null on a session's first turn).
  prevContext: number | null
  current: { messageId: string; toolUse: boolean } | null
  currentContext: number
}

interface UsageEvents {
  usage: [{ operatorId: number; context: OperatorContext }]
  cost: [{ operatorId: number; costUsd: number; operatorSpendToday: number; totalSpendToday: number }]
  cap: [CapDecision]
}

export interface UsageTrackerOptions {
  store: Store
  now?: () => number
  config?: Partial<UsageConfig>
  // The operator's `doing` job at ingest time.
  currentJob?: (operatorId: number) => number | null
}

// Follows each Claude operator's transcript, writes one usage row per assistant message and watches
// the caps. Never touches a session: pausing is a decision the host acts on.
export class UsageTracker extends EventEmitter<UsageEvents> {
  readonly caps: CapMonitor
  private readonly store: Store
  private readonly now: () => number
  private readonly currentJob: (operatorId: number) => number | null
  private readonly feeds = new Map<number, OperatorFeed>()
  private config: UsageConfig

  constructor(opts: UsageTrackerOptions) {
    super()
    this.store = opts.store
    this.now = opts.now ?? Date.now
    this.currentJob = opts.currentJob ?? (() => null)
    this.config = { ...DEFAULT_USAGE_CONFIG, ...opts.config }
    this.caps = new CapMonitor({
      now: this.now,
      config: () => this.config,
      operatorSpend: (id, since) => this.operatorSpendSince(id, since),
      totalSpend: (since) => this.store.spendSince(since),
      operatorCap: (id) => this.store.getOperator(id)?.dailyCapUsd ?? null,
    })
  }

  setConfig(patch: Partial<UsageConfig>): CapDecision[] {
    this.config = { ...this.config, ...patch }
    return this.checkCaps()
  }

  // A new session id starts a fresh feed, so its first turn is never cold.
  attach(operatorId: number, file: string, sessionId: string): void {
    this.feeds.set(operatorId, { tail: new JsonlTail(file), sessionId, prevContext: null, current: null, currentContext: 0 })
  }

  // Reads what is left, then forgets the operator.
  detach(operatorId: number): void {
    this.pollOperator(operatorId)
    this.feeds.delete(operatorId)
  }

  // Drops the feed and the cap state without reading: for an operator that is deleted.
  forget(operatorId: number): void {
    this.feeds.delete(operatorId)
    this.caps.forget(operatorId)
  }

  poll(): void {
    for (const id of this.feeds.keys()) this.pollOperator(id)
  }

  pollOperator(operatorId: number): void {
    const feed = this.feeds.get(operatorId)
    if (!feed) return
    let latest: OperatorContext | null = null
    let cost = 0
    for (const line of feed.tail.read()) {
      const u = parseLine(line)
      if (!u) continue
      if (feed.current?.messageId !== u.messageId) {
        feed.prevContext = feed.current ? feed.currentContext : null
        feed.current = { messageId: u.messageId, toolUse: false }
        cost += u.costUsd
      }
      feed.current.toolUse ||= u.toolUse
      feed.currentContext = u.contextTokens
      this.store.upsertMessageUsage(u.messageId, {
        operatorId,
        sessionId: feed.sessionId,
        model: u.model,
        at: u.at,
        // A message re-read after a restart keeps the job it was first attributed to.
        jobId: this.jobFor(operatorId, u.messageId),
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheRead: u.cacheReadTokens,
        cacheW5m: u.cacheWrite5mTokens,
        cacheW1h: u.cacheWrite1hTokens,
        costUsd: u.costUsd,
        contextTokens: u.contextTokens,
        cold: isColdTurn(
          { contextTokens: u.contextTokens, cacheWriteTokens: u.cacheWrite5mTokens + u.cacheWrite1hTokens },
          feed.prevContext,
          this.config.coldThresholdPct,
        ),
        toolUse: feed.current.toolUse,
      })
      latest = { model: u.model, contextTokens: u.contextTokens, at: u.at }
    }
    if (!latest) return
    this.emit('usage', { operatorId, context: latest })
    const day = startOfDay(this.now())
    this.emit('cost', {
      operatorId,
      costUsd: cost,
      operatorSpendToday: this.operatorSpendSince(operatorId, day),
      totalSpendToday: this.store.spendSince(day),
    })
    this.checkCaps(operatorId)
  }

  checkCaps(operatorId?: number): CapDecision[] {
    const ids = operatorId != null ? [operatorId] : this.liveOperatorIds()
    const decisions = ids.length ? ids.flatMap((id) => this.caps.check(id)) : this.caps.check()
    for (const d of decisions) this.emit('cap', d)
    return decisions
  }

  stats(operatorId: number, since: number): OperatorStats {
    const rows = this.store.db
      .prepare(
        `SELECT model, job_id, input_tokens, output_tokens, cache_read, cache_w5m, cache_w1h, cost_usd, context_tokens, cold, legacy
         FROM usage WHERE operator_id = ? AND at >= ?`,
      )
      .all(operatorId, since) as Array<Record<string, unknown>>
    return computeStats(
      rows.map((r) => ({
        model: String(r.model),
        jobId: r.job_id == null ? null : Number(r.job_id),
        inputTokens: Number(r.input_tokens),
        outputTokens: Number(r.output_tokens),
        cacheRead: Number(r.cache_read),
        cacheW5m: Number(r.cache_w5m),
        cacheW1h: Number(r.cache_w1h),
        costUsd: Number(r.cost_usd),
        contextTokens: Number(r.context_tokens),
        cold: Number(r.cold) === 1,
        legacy: Number(r.legacy) === 1,
      })),
    )
  }

  // Pause state is derived from stored spend, so the host calls `checkCaps()` at startup and on a timer.
  private liveOperatorIds(): number[] {
    return (this.store.db.prepare('SELECT id FROM operators WHERE deleted_at IS NULL').all() as Array<{ id: number }>).map((r) => Number(r.id))
  }

  private operatorSpendSince(operatorId: number, since: number): number {
    const r = this.store.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage WHERE operator_id = ? AND at >= ?').get(operatorId, since) as {
      total: number
    }
    return Number(r.total)
  }

  // The job already recorded for a message (null = recorded without one), undefined for a new message.
  private jobFor(operatorId: number, messageId: string): number | null {
    const r = this.store.db.prepare('SELECT job_id FROM usage WHERE operator_id = ? AND message_id = ?').get(operatorId, messageId) as
      | { job_id: number | null }
      | undefined
    if (!r) return this.currentJob(operatorId)
    return r.job_id == null ? null : Number(r.job_id)
  }
}
