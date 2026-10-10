import type { AuxModel, AuxSettings, AuxTask } from '../shared/aux-settings'
import type { LearnSettings } from '../shared/learn'

// The model one aux task asks: its own CLI and model, or the learn settings when it follows them ('learn', the default).
export interface AuxResolved {
  cli: LearnSettings['cli']
  model: string
  effort: string
  localUrl: string
}

export function resolveAux(task: AuxTask, models: Record<AuxTask, AuxModel>, learn: Pick<LearnSettings, 'cli' | 'model' | 'effort' | 'localUrl'>): AuxResolved {
  const m = models[task]
  if (!m || m.cli === 'learn') return { cli: learn.cli, model: learn.model, effort: learn.effort, localUrl: learn.localUrl }
  return { cli: m.cli, model: m.model, effort: m.effort, localUrl: m.localUrl || learn.localUrl }
}

export type { AuxStatus, AuxUsage } from '../shared/ops'
import type { AuxStatus, AuxUsage } from '../shared/ops'

export interface AuxResult {
  text: string
  tokens?: number
  usd?: number
}

export class AuxLimitError extends Error {
  constructor(
    readonly label: 'local limit' | 'provider limit',
    message: string,
    readonly needsConfirm: boolean,
  ) {
    super(message)
  }
}

export interface AuxStore {
  load(): unknown
  save(value: unknown): void
}

export interface AuxBudgetDeps {
  now: () => number
  sleep: (ms: number) => Promise<void>
  settings: () => AuxSettings
  store?: AuxStore
}

interface State {
  day: string
  total: AuxUsage
  features: Record<string, AuxUsage>
  providerLimit: string
}

const QUOTA = /rate.?limit|too many requests|\b429\b|quota|usage limit|insufficient (credit|balance|funds)/i
const empty = (): AuxUsage => ({ calls: 0, tokens: 0, usd: 0 })
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// The one path every learn and memory model call takes: daily counts and spend per feature, bounded retries with
// exponential backoff, and no retry for a rate or quota limit or for the same failure twice in a row.
export class AuxBudget {
  private state: State
  private lastError = ''

  constructor(private readonly d: AuxBudgetDeps) {
    this.state = this.fresh(this.restore(d.store?.load()))
  }

  private restore(raw: unknown): State | null {
    const r = raw && typeof raw === 'object' ? (raw as Partial<State>) : null
    if (!r || typeof r.day !== 'string' || !r.total) return null
    return { day: r.day, total: { ...empty(), ...r.total }, features: r.features ?? {}, providerLimit: r.providerLimit ?? '' }
  }

  private today(): string {
    const t = new Date(this.d.now())
    const p = (n: number) => String(n).padStart(2, '0')
    return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`
  }

  // A new day starts from zero; the provider's limit clears with it.
  private fresh(prev: State | null): State {
    const day = this.today()
    if (prev && prev.day === day) return prev
    return { day, total: empty(), features: {}, providerLimit: '' }
  }

  private cur(): State {
    this.state = this.fresh(this.state)
    return this.state
  }

  private persist(): void {
    try {
      this.d.store?.save(this.state)
    } catch {
      // the counts stay in memory for this run
    }
  }

  private blockReason(): { label: 'local limit' | 'provider limit'; message: string } | null {
    const s = this.cur()
    const cfg = this.d.settings()
    if (s.providerLimit) return { label: 'provider limit', message: `The provider reported a limit today: ${s.providerLimit}` }
    if (cfg.maxCallsPerDay > 0 && s.total.calls >= cfg.maxCallsPerDay) {
      return { label: 'local limit', message: `Operant's daily limit of ${cfg.maxCallsPerDay} model calls is reached` }
    }
    if (cfg.maxUsdPerDay > 0 && s.total.usd >= cfg.maxUsdPerDay) {
      return { label: 'local limit', message: `Operant's daily spend limit of $${cfg.maxUsdPerDay} is reached` }
    }
    return null
  }

  status(): AuxStatus {
    const s = this.cur()
    const cfg = this.d.settings()
    const block = this.blockReason()
    return {
      day: s.day,
      total: { ...s.total },
      maxCallsPerDay: cfg.maxCallsPerDay,
      maxUsdPerDay: cfg.maxUsdPerDay,
      features: Object.fromEntries(Object.entries(s.features).map(([k, v]) => [k, { ...v }])),
      blocked: block?.message ?? null,
      label: block?.label ?? null,
      lastError: this.lastError,
    }
  }

  // Why the daily limits forbid another call (null: allowed). For callers that make their own call, like keep-warm.
  blocked(): string | null {
    return this.blockReason()?.message ?? null
  }

  // Counts a call that was made outside `call` (keep-warm's ping goes through the tile's own session).
  record(feature: string, usage: { tokens: number; usd: number }): void {
    const s = this.cur()
    const f = (s.features[feature] ??= empty())
    const tokens = Math.max(0, Math.round(usage.tokens))
    const usd = Math.max(0, usage.usd)
    s.total.calls++
    f.calls++
    s.total.tokens += tokens
    f.tokens += tokens
    s.total.usd += usd
    f.usd += usd
    this.persist()
  }

  // Runs one model call for a feature. `confirm` lets a call through a limit that was set to ask first.
  async call(feature: string, fn: (attempt: number) => Promise<AuxResult>, opts: { confirm?: boolean } = {}): Promise<AuxResult> {
    const cfg = this.d.settings()
    const block = this.blockReason()
    if (block && !(opts.confirm && cfg.onLimit === 'confirm')) {
      throw new AuxLimitError(block.label, block.message, cfg.onLimit === 'confirm')
    }
    const attempts = 1 + Math.max(0, cfg.retryLimit)
    let previous = ''
    for (let i = 0; i < attempts; i++) {
      const s = this.cur()
      const f = (s.features[feature] ??= empty())
      s.total.calls++
      f.calls++
      this.persist()
      try {
        const r = await fn(i)
        const tokens = Math.max(0, Math.round(r.tokens ?? 0))
        const usd = Math.max(0, r.usd ?? 0)
        s.total.tokens += tokens
        f.tokens += tokens
        s.total.usd += usd
        f.usd += usd
        this.persist()
        return r
      } catch (err) {
        const msg = errText(err)
        this.lastError = msg
        if (QUOTA.test(msg)) {
          this.cur().providerLimit = msg.slice(0, 300)
          this.persist()
          throw new AuxLimitError('provider limit', msg, false)
        }
        // The same failure twice in a row will not change with a retry.
        if (msg === previous || i === attempts - 1) throw new Error(msg)
        previous = msg
        await this.d.sleep(cfg.backoffMs * 2 ** i)
      }
    }
    throw new Error(this.lastError)
  }
}
