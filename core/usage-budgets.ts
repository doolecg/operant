import type { BudgetConfig, BudgetProgress, BudgetStatus, BudgetWindow } from '../shared/types'

export const BUDGETS_KEY = 'budgets'

export const BUDGET_WINDOWS: BudgetWindow[] = ['fiveHour', 'day', 'week']

export const WINDOW_LABEL: Record<BudgetWindow, string> = { fiveHour: '5-hour', day: 'daily', week: 'weekly' }

const FIVE_HOURS = 5 * 3_600_000
const WEEK = 7 * 86_400_000

const startOfDay = (t: number) => {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// Where a window begins: 5 hours and 7 days back from now, or local midnight.
export function windowStart(w: BudgetWindow, now: number): number {
  return w === 'fiveHour' ? now - FIVE_HOURS : w === 'week' ? now - WEEK : startOfDay(now)
}

const PROJECT_KEY: Record<BudgetWindow, keyof BudgetConfig> = { fiveHour: 'projectFiveHourUsd', day: 'projectDailyUsd', week: 'projectWeeklyUsd' }

const usd = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, 100_000) : 0)

function caps(v: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, n] of Object.entries(v as Record<string, unknown>)) if (/^\d+$/.test(k) && usd(n) > 0) out[k] = usd(n)
  }
  return out
}

// Fills in defaults and drops anything malformed (stored or incoming). Unknown keys from older versions are ignored.
export function sanitizeBudgets(raw: unknown): BudgetConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return { projectFiveHourUsd: caps(r.projectFiveHourUsd), projectDailyUsd: caps(r.projectDailyUsd), projectWeeklyUsd: caps(r.projectWeeklyUsd) }
}

export function mergeBudgets(current: BudgetConfig, patch: unknown): BudgetConfig {
  const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>
  const next: Record<string, unknown> = { ...current }
  for (const k of Object.values(PROJECT_KEY)) if (p[k] !== undefined) next[k] = p[k]
  return sanitizeBudgets(next)
}

// What the budgets decided: a warning per project (or for all projects together) per window. Data only: the host logs it.
export interface BudgetDecision {
  action: 'warn'
  scope: 'project' | 'global'
  window: BudgetWindow
  // The project; null for the all-projects cap.
  crewId: number | null
  spentUsd: number
  capUsd: number
  pct: number
}

export interface BudgetMonitorOptions {
  now: () => number
  config: () => BudgetConfig
  // The all-projects caps from settings; 0 = none.
  globalCaps: () => Record<BudgetWindow, number>
  warnPct: () => number
  crewIds: () => number[]
  // A project's spend since a timestamp (its tiles and imported rows).
  projectSpend: (crewId: number, since: number) => number
  // Spend of everything since a timestamp.
  globalSpend: (since: number) => number
}

export class BudgetMonitor {
  private day = 0
  private readonly warned = new Set<string>()

  constructor(private readonly o: BudgetMonitorOptions) {}

  private rollover(): void {
    const day = startOfDay(this.o.now())
    if (day === this.day) return
    this.day = day
    this.warned.clear()
  }

  // Every cap that is set, with what was spent in its window.
  private measure(): Array<BudgetProgress & { key: string; window: BudgetWindow; crewId: number | null }> {
    this.rollover()
    const now = this.o.now()
    const out: Array<BudgetProgress & { key: string; window: BudgetWindow; crewId: number | null }> = []
    const add = (window: BudgetWindow, crewId: number | null, capUsd: number, spentUsd: number) =>
      out.push({ key: `${window}:${crewId ?? 'all'}`, window, crewId, capUsd, spentUsd, pct: (spentUsd / capUsd) * 100 })
    const global = this.o.globalCaps()
    for (const w of BUDGET_WINDOWS) {
      const since = windowStart(w, now)
      if (global[w] > 0) add(w, null, global[w], this.o.globalSpend(since))
      for (const crewId of this.o.crewIds()) {
        const cap = this.o.config()[PROJECT_KEY[w]][String(crewId)] ?? 0
        if (cap > 0) add(w, crewId, cap, this.o.projectSpend(crewId, since))
      }
    }
    return out
  }

  // Warnings for the caps over their warning share (once per window; a rolling window warns again after it dips below).
  check(): BudgetDecision[] {
    const out: BudgetDecision[] = []
    const live = new Set<string>()
    for (const m of this.measure()) {
      live.add(m.key)
      if (m.pct < this.o.warnPct()) this.warned.delete(m.key)
      else if (!this.warned.has(m.key)) {
        this.warned.add(m.key)
        out.push({ action: 'warn', scope: m.crewId == null ? 'global' : 'project', window: m.window, crewId: m.crewId, spentUsd: m.spentUsd, capUsd: m.capUsd, pct: m.pct })
      }
    }
    for (const k of this.warned) if (!live.has(k)) this.warned.delete(k)
    return out
  }

  progress(): Pick<BudgetStatus, 'projects' | 'global'> {
    const projects: BudgetStatus['projects'] = []
    const global: BudgetStatus['global'] = []
    for (const m of this.measure()) {
      const p = { capUsd: m.capUsd, spentUsd: m.spentUsd, pct: m.pct, window: m.window }
      if (m.crewId == null) global.push(p)
      else projects.push({ ...p, crewId: m.crewId })
    }
    return { projects, global }
  }
}
