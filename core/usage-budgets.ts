import type { BudgetConfig, BudgetProgress, BudgetStatus, BudgetTarget } from '../shared/types'

export const BUDGETS_KEY = 'budgets'

export const DEFAULT_BUDGETS: BudgetConfig = { projectDailyUsd: {}, jobDefaultUsd: 0, jobUsd: {}, pauseQueue: true, stopJobAtCap: false }

const usd = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, 100_000) : 0)

function caps(v: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, n] of Object.entries(v as Record<string, unknown>)) if (/^\d+$/.test(k) && usd(n) > 0) out[k] = usd(n)
  }
  return out
}

// Fills in defaults and drops anything malformed (stored or incoming).
export function sanitizeBudgets(raw: unknown): BudgetConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    projectDailyUsd: caps(r.projectDailyUsd),
    jobDefaultUsd: usd(r.jobDefaultUsd),
    jobUsd: caps(r.jobUsd),
    pauseQueue: typeof r.pauseQueue === 'boolean' ? r.pauseQueue : DEFAULT_BUDGETS.pauseQueue,
    stopJobAtCap: typeof r.stopJobAtCap === 'boolean' ? r.stopJobAtCap : DEFAULT_BUDGETS.stopJobAtCap,
  }
}

export function mergeBudgets(current: BudgetConfig, patch: unknown): BudgetConfig {
  const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>
  const next: Record<string, unknown> = { ...current }
  for (const k of ['jobDefaultUsd', 'pauseQueue', 'stopJobAtCap'] as const) if (p[k] !== undefined) next[k] = p[k]
  // A map patch replaces only the keys it names; a 0 removes one.
  for (const k of ['projectDailyUsd', 'jobUsd'] as const) {
    if (p[k] === undefined) continue
    const merged: Record<string, unknown> = { ...current[k] }
    for (const [id, v] of Object.entries((p[k] ?? {}) as Record<string, unknown>)) merged[id] = v
    next[k] = merged
  }
  return sanitizeBudgets(next)
}

// What the budgets decided. Data only: the host turns it into the queue hold, a stop, the log and the event.
export interface BudgetDecision {
  action: 'warn' | 'pause'
  scope: 'project' | 'job'
  crewId: number
  runId?: number
  spentUsd: number
  capUsd: number
  pct: number
}

export interface BudgetMonitorOptions {
  now: () => number
  config: () => BudgetConfig
  warnPct: () => number
  crewIds: () => number[]
  // A project's spend since a timestamp (all of its operators, scratch terminals and jobs).
  projectSpend: (crewId: number, since: number) => number
  // Jobs that are running now, with their project.
  liveRuns: () => Array<{ id: number; crewId: number }>
  // Everything a job has spent.
  jobSpend: (runId: number) => number
}

const startOfDay = (t: number) => {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// Project caps count spend per local day, job caps count a job's whole run. One warning and one pause decision
// per window; a decision fires again after the day rolls over (project), a resume, or the spend falling back under.
export class BudgetMonitor {
  private day = 0
  private readonly warned = new Set<string>()
  private readonly paused = new Set<string>()
  private readonly resetAt = new Map<string, number>()
  private readonly offset = new Map<string, number>()

  constructor(private readonly o: BudgetMonitorOptions) {}

  private rollover(): void {
    const day = startOfDay(this.o.now())
    if (day === this.day) return
    this.day = day
    for (const set of [this.warned, this.paused]) for (const k of [...set]) if (k.startsWith('p:')) set.delete(k)
    for (const k of [...this.resetAt.keys()]) if (k.startsWith('p:')) this.resetAt.delete(k)
  }

  private since(crewId: number): number {
    return Math.max(this.day, this.resetAt.get(`p:${crewId}`) ?? 0)
  }

  projectCap(crewId: number): number {
    return this.o.config().projectDailyUsd[String(crewId)] ?? 0
  }

  jobCap(runId: number): number {
    const c = this.o.config()
    return c.jobUsd[String(runId)] ?? c.jobDefaultUsd
  }

  private projectSpent(crewId: number): number {
    return this.o.projectSpend(crewId, this.since(crewId))
  }

  private jobSpent(runId: number): number {
    return Math.max(0, this.o.jobSpend(runId) - (this.offset.get(`j:${runId}`) ?? 0))
  }

  check(): BudgetDecision[] {
    this.rollover()
    const out: BudgetDecision[] = []
    const live = new Map(this.o.liveRuns().map((r) => [r.id, r]))
    for (const k of [...this.paused, ...this.warned]) {
      if (k.startsWith('j:') && !live.has(Number(k.slice(2)))) {
        this.paused.delete(k)
        this.warned.delete(k)
        this.offset.delete(k)
      }
    }
    for (const crewId of this.o.crewIds()) {
      this.evaluate(out, `p:${crewId}`, 'project', crewId, undefined, this.projectCap(crewId), this.projectSpent(crewId))
    }
    for (const r of live.values()) this.evaluate(out, `j:${r.id}`, 'job', r.crewId, r.id, this.jobCap(r.id), this.jobSpent(r.id))
    return out
  }

  // The project's queue is held: its own cap, or a live job of it over its cap (when pausing is on).
  projectHeld(crewId: number): string {
    this.rollover()
    if (!this.o.config().pauseQueue) return ''
    if (this.paused.has(`p:${crewId}`)) return 'The project reached its daily budget'
    for (const r of this.o.liveRuns()) if (r.crewId === crewId && this.paused.has(`j:${r.id}`)) return `JOB#${r.id} reached its budget`
    return ''
  }

  // A live job over its own cap (to stop it when the config says so).
  jobOver(runId: number): boolean {
    return this.paused.has(`j:${runId}`)
  }

  heldProjects(): Array<{ crewId: number; reason: string }> {
    return this.o.crewIds().flatMap((crewId) => {
      const reason = this.projectHeld(crewId)
      return reason ? [{ crewId, reason }] : []
    })
  }

  // Counts spend from now on and lets the warning and pause fire again.
  resume(target: Exclude<BudgetTarget, { scope: 'day' }>): void {
    if (target.scope === 'project') {
      const key = `p:${target.crewId}`
      this.resetAt.set(key, this.o.now())
      this.warned.delete(key)
      this.paused.delete(key)
    } else {
      const key = `j:${target.runId}`
      this.offset.set(key, this.o.jobSpend(target.runId))
      this.warned.delete(key)
      this.paused.delete(key)
    }
  }

  progress(): Pick<BudgetStatus, 'projects' | 'jobs'> {
    this.rollover()
    const mk = (cap: number, spent: number, paused: boolean): BudgetProgress => ({ capUsd: cap, spentUsd: spent, pct: cap > 0 ? (spent / cap) * 100 : 0, paused })
    const projects = this.o.crewIds().flatMap((crewId) => {
      const cap = this.projectCap(crewId)
      return cap > 0 ? [{ crewId, ...mk(cap, this.projectSpent(crewId), this.paused.has(`p:${crewId}`)) }] : []
    })
    const jobs = this.o.liveRuns().flatMap((r) => {
      const cap = this.jobCap(r.id)
      return cap > 0 ? [{ runId: r.id, crewId: r.crewId, ...mk(cap, this.jobSpent(r.id), this.paused.has(`j:${r.id}`)) }] : []
    })
    return { projects, jobs }
  }

  private evaluate(out: BudgetDecision[], key: string, scope: BudgetDecision['scope'], crewId: number, runId: number | undefined, cap: number, spent: number): void {
    if (cap <= 0) {
      this.paused.delete(key)
      this.warned.delete(key)
      return
    }
    const pct = (spent / cap) * 100
    // Float sums can land an ulp short of the cap.
    const reached = (limit: number) => ((spent + 1e-9) / cap) * 100 >= limit
    const decision = (action: BudgetDecision['action']): BudgetDecision => ({ action, scope, crewId, ...(runId !== undefined ? { runId } : {}), spentUsd: spent, capUsd: cap, pct })
    if (reached(100)) {
      if (!this.paused.has(key)) {
        this.paused.add(key)
        this.warned.add(key)
        // Without queue pausing the cap is a warning at 100%; the job stop (when on) reads jobOver().
        out.push(decision(this.o.config().pauseQueue || (scope === 'job' && this.o.config().stopJobAtCap) ? 'pause' : 'warn'))
      }
      return
    }
    this.paused.delete(key)
    if (reached(this.o.warnPct()) && !this.warned.has(key)) {
      this.warned.add(key)
      out.push(decision('warn'))
    }
  }
}
