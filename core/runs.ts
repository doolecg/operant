import type { ModelTier, Run, RunInput, Team, TeamLimits, TeamSeat } from '../shared/types'
import { MASTER_CLIS, validateLaunchSettings, validateMasterCli, validateModel } from './launch'
import type { MasterEvent, MasterMcp, MasterRegistry, MasterRun } from './master'
import type { Store } from './store'

export type RunErrorCode = 'BAD_ARGS' | 'NOT_FOUND' | 'LIMIT' | 'CONFLICT'

export class RunError extends Error {
  constructor(
    readonly code: RunErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'RunError'
  }
}

const TIERS: ModelTier[] = ['haiku', 'sonnet', 'opus']
const TASK_MAX = 20_000
const SEAT_COUNT_MAX = 50
export const DEFAULT_CONCURRENCY = 1
const CONCURRENCY_MAX = 10
const CONCURRENCY_KEY = 'runs.concurrency'

// Haiku < sonnet < opus; null for a model id that names none of them (never refused by a tier limit).
export function tierOf(model: string): ModelTier | null {
  const m = model.toLowerCase()
  return TIERS.find((t) => m.includes(t)) ?? null
}

export function cleanSeats(store: Store, seats: unknown): TeamSeat[] {
  if (!Array.isArray(seats)) throw new RunError('BAD_ARGS', 'Seats must be a list')
  return seats.map((s: Partial<TeamSeat>) => {
    if (!s || typeof s.presetId !== 'number') throw new RunError('BAD_ARGS', 'Each seat needs a preset')
    const preset = store.getPreset(s.presetId)
    if (!preset) throw new RunError('NOT_FOUND', `Preset ${s.presetId} not found`)
    if (!MASTER_CLIS.includes(preset.agent as never)) throw new RunError('BAD_ARGS', `Seat ${preset.name} must use claude or opencode`)
    if (!Number.isInteger(s.count) || (s.count as number) < 1 || (s.count as number) > SEAT_COUNT_MAX) {
      throw new RunError('BAD_ARGS', `Seat ${preset.name} needs a count from 1 to ${SEAT_COUNT_MAX}`)
    }
    const model = typeof s.model === 'string' && s.model.trim() ? s.model.trim() : preset.model
    validateModel(model, preset.agent)
    const effort = typeof s.effort === 'string' ? s.effort.trim() : ''
    return { presetId: s.presetId, count: s.count as number, model, ...(effort ? { effort } : {}) }
  })
}

export function cleanLimits(limits: unknown): Partial<TeamLimits> {
  if (limits === undefined) return {}
  const l = (limits ?? {}) as Partial<TeamLimits>
  const out: Partial<TeamLimits> = {}
  if (l.maxWorkers !== undefined) {
    if (!Number.isInteger(l.maxWorkers) || l.maxWorkers < 0 || l.maxWorkers > 1000) throw new RunError('BAD_ARGS', 'Max workers must be a whole number from 0 to 1000 (0 = no limit)')
    out.maxWorkers = l.maxWorkers
  }
  if (l.topTier !== undefined) {
    if (l.topTier !== '' && !TIERS.includes(l.topTier)) throw new RunError('BAD_ARGS', 'The top tier must be haiku, sonnet, opus or empty')
    out.topTier = l.topTier
  }
  if (l.tokenBudget !== undefined) {
    if (!Number.isInteger(l.tokenBudget) || l.tokenBudget < 0) throw new RunError('BAD_ARGS', 'The token budget must be a whole number (0 = no limit)')
    out.tokenBudget = l.tokenBudget
  }
  return out
}

// Throws a LIMIT error naming the first limit the seats break.
export function checkLimits(seats: TeamSeat[], limits: TeamLimits): void {
  const workers = seats.reduce((n, s) => n + s.count, 0)
  if (limits.maxWorkers > 0 && workers > limits.maxWorkers) {
    throw new RunError('LIMIT', `This team allows ${limits.maxWorkers} worker${limits.maxWorkers === 1 ? '' : 's'} and the run asks for ${workers}`)
  }
  if (limits.topTier) {
    const cap = TIERS.indexOf(limits.topTier)
    for (const s of seats) {
      const tier = tierOf(s.model)
      if (tier && TIERS.indexOf(tier) > cap) throw new RunError('LIMIT', `The model ${s.model} is above this team's top tier (${limits.topTier})`)
    }
  }
}

export interface RunNotice {
  crewId: number
  runId: number
  status: Run['status']
}

export interface RunManagerOptions {
  store: Store
  adapters: MasterRegistry
  now?: () => number
  // The first prompt of a run. Default: the task plus the seats to run as subagents.
  brief?: (run: Run) => string | Promise<string>
  // The MCP servers the run's seats picked, in the form the Master CLI takes them. A failure starts the run without.
  mcp?: (run: Run) => MasterMcp | undefined | Promise<MasterMcp | undefined>
  onChange?: (n: RunNotice) => void
  onEvent?: (run: Run, e: MasterEvent) => void
  // The Master CLI's session id, once it reports one (the subagent reader needs it).
  onSession?: (run: Run, sessionId: string) => void
  // After a run ends as done or failed, once its slot is freed. Errors go to onError.
  onFinished?: (run: Run) => unknown
  onError?: (err: unknown) => void
  // A reason to hold a queued run back (a spending budget), or '' to let it start. Held runs stay queued; `pumpAll`
  // starts them once the hold lifts.
  hold?: (run: Run) => string
  // Tokens spent so far by usage attributed to the run; with it, `enforceTokenBudgets` stops runs over their team's budget.
  runTokens?: (run: Run) => number
}

export class RunManager {
  private readonly active = new Map<number, MasterRun>()
  private readonly starting = new Set<number>()
  private readonly stopping = new Set<number>()
  private readonly stopReason = new Map<number, string>()
  private closing = false

  constructor(private readonly o: RunManagerOptions) {}

  get concurrency(): number {
    const v = this.o.store.getJson(CONCURRENCY_KEY)
    return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? Math.min(v, CONCURRENCY_MAX) : DEFAULT_CONCURRENCY
  }

  setConcurrency(n: number): number {
    if (!Number.isInteger(n) || n < 1 || n > CONCURRENCY_MAX) throw new RunError('BAD_ARGS', `The queue limit must be a whole number from 1 to ${CONCURRENCY_MAX}`)
    this.o.store.setJson(CONCURRENCY_KEY, n)
    for (const crew of this.o.store.listCrews()) this.pump(crew.id)
    return n
  }

  // Validates, stores the run as queued and starts it when its project has a free slot.
  submit(input: RunInput): Run {
    const { store } = this.o
    if (!input || typeof input.crewId !== 'number' || !store.getCrew(input.crewId)) throw new RunError('NOT_FOUND', `Project ${String(input?.crewId)} not found`)
    const task = typeof input.task === 'string' ? input.task.trim() : ''
    if (!task) throw new RunError('BAD_ARGS', 'The task cannot be empty')
    if (task.length > TASK_MAX) throw new RunError('BAD_ARGS', `The task is longer than ${TASK_MAX} characters`)
    let masterCli
    try {
      masterCli = validateMasterCli(input.masterCli)
    } catch (err) {
      throw new RunError('BAD_ARGS', (err as Error).message)
    }
    if (!this.o.adapters.has(masterCli)) throw new RunError('BAD_ARGS', `${masterCli} is not available as a Master`)
    const masterModel = typeof input.masterModel === 'string' ? input.masterModel.trim() : ''
    const masterEffort = typeof input.masterEffort === 'string' ? input.masterEffort.trim() : ''
    try {
      validateLaunchSettings({ agent: masterCli, model: masterModel, effort: masterEffort })
    } catch (err) {
      throw new RunError('BAD_ARGS', (err as Error).message)
    }

    let team: Team | null = null
    if (input.teamId != null) {
      team = store.getTeam(input.teamId)
      if (!team) throw new RunError('NOT_FOUND', `Team ${input.teamId} not found`)
    }
    const seats = cleanSeats(store, input.seats ?? team?.seats ?? [])
    const limits = { maxWorkers: 0, topTier: '' as const, tokenBudget: 0, ...team?.limits }
    checkLimits(seats, limits)

    const run = store.createRun({ crewId: input.crewId, task, masterCli, masterModel, masterEffort, teamId: team?.id ?? null, seats, limits, rules: team?.rules ?? '' })
    this.changed(run)
    this.pump(run.crewId)
    return store.getRun(run.id)!
  }

  // Edits the task of a run that has not started.
  update(runId: number, patch: { task?: string }): Run {
    const { store } = this.o
    const run = store.getRun(runId)
    if (!run) throw new RunError('NOT_FOUND', `Job ${runId} not found`)
    if (run.status !== 'queued') throw new RunError('CONFLICT', `Job ${runId} has already started, so its task can no longer be edited`)
    const task = typeof patch?.task === 'string' ? patch.task.trim() : ''
    if (!task) throw new RunError('BAD_ARGS', 'The task cannot be empty')
    if (task.length > TASK_MAX) throw new RunError('BAD_ARGS', `The task is longer than ${TASK_MAX} characters`)
    const next = store.setRunTask(runId, task)
    this.changed(next)
    return next
  }

  // Removes a finished run and its agents. A queued or working one has to be stopped first.
  remove(runId: number): void {
    const { store } = this.o
    const run = store.getRun(runId)
    if (!run) throw new RunError('NOT_FOUND', `Job ${runId} not found`)
    if (run.status !== 'done' && run.status !== 'failed') throw new RunError('CONFLICT', `Job ${runId} is ${run.status}: stop it before deleting it`)
    store.deleteRun(runId)
    this.changed(run)
  }

  // A queued run is cancelled; a running one is stopped. Either ends as failed and frees its slot.
  async stop(runId: number, reason?: string): Promise<Run> {
    const { store } = this.o
    const run = store.getRun(runId)
    if (!run) throw new RunError('NOT_FOUND', `Job ${runId} not found`)
    if (run.status === 'done' || run.status === 'failed') throw new RunError('CONFLICT', `Job ${runId} already ended`)
    if (run.status === 'queued') {
      this.finish(runId, 'failed', reason ?? 'Cancelled before it started')
    } else {
      this.stopping.add(runId)
      if (reason) this.stopReason.set(runId, reason)
      const handle = this.active.get(runId)
      try {
        await handle?.stop()
      } catch (err) {
        this.o.onError?.(err)
      }
      this.finish(runId, 'failed', reason ?? 'Stopped by you')
    }
    return store.getRun(runId)!
  }

  // Quit path: ends every working run as interrupted without waiting for its CLI (the caller kills the processes),
  // and starts nothing more (no queue pump, no learn step).
  interruptAll(): void {
    this.closing = true
    for (const run of this.o.store.listRuns()) {
      if (run.status === 'working' || run.status === 'needs-you') {
        const handle = this.active.get(run.id)
        void handle?.stop().catch(() => undefined)
        this.finish(run.id, 'failed', 'Interrupted: Operant was closed while it ran')
      }
    }
  }

  // Runs left working by a previous process cannot be resumed: they end as failed, then queues start.
  recover(): void {
    const { store } = this.o
    for (const run of store.listRuns()) {
      if (run.status === 'working' || run.status === 'needs-you') this.finish(run.id, 'failed', 'Interrupted: Operant was closed while it ran')
    }
    for (const crew of store.listCrews()) this.pump(crew.id)
  }

  private held(run: Run): string {
    try {
      return this.o.hold?.(run) ?? ''
    } catch {
      return ''
    }
  }

  // Starts whatever a lifted hold (or a new budget) lets start, in every project.
  pumpAll(): void {
    for (const crew of this.o.store.listCrews()) this.pump(crew.id)
  }

  // Stops every working run whose tokens passed the token budget its team set (0 = no limit). Returns the runs stopped.
  enforceTokenBudgets(): number[] {
    const { runTokens } = this.o
    if (!runTokens) return []
    const over: number[] = []
    for (const run of this.o.store.listRuns()) {
      const budget = run.limits.tokenBudget
      if (!budget || (run.status !== 'working' && run.status !== 'needs-you') || this.stopping.has(run.id)) continue
      let used = 0
      try {
        used = runTokens(run)
      } catch (err) {
        this.o.onError?.(err)
      }
      if (used <= budget) continue
      over.push(run.id)
      void this.stop(run.id, `Stopped: the job used ${used.toLocaleString('en-US')} tokens, over its team's budget of ${budget.toLocaleString('en-US')}`).catch((err) => this.o.onError?.(err))
    }
    return over
  }

  private activeCount(crewId: number): number {
    return this.o.store.listRuns(crewId).filter((r) => r.status === 'working' || r.status === 'needs-you').length
  }

  private pump(crewId: number): void {
    const { store } = this.o
    for (;;) {
      if (this.activeCount(crewId) >= this.concurrency) return
      const next = store.listRuns(crewId).find((r) => r.status === 'queued' && !this.starting.has(r.id) && !this.held(r))
      if (!next) return
      this.begin(next)
    }
  }

  private begin(queued: Run): void {
    const { store } = this.o
    const crew = store.getCrew(queued.crewId)!
    const run = store.setRunStatus(queued.id, 'working')
    this.changed(run)
    this.starting.add(run.id)
    void (async () => {
      try {
        const prompt = await (this.o.brief ?? defaultBrief)(run)
        const projectMaster = store.getMaster(crew.id)
        const master = run.masterCli === 'claude' ? projectMaster : undefined
        const model = run.masterModel || master?.model || undefined
        const effort = run.masterEffort || master?.effort || undefined
        const mcp = await Promise.resolve(this.o.mcp?.(run)).catch(() => undefined)
        const handle = await this.o.adapters.get(run.masterCli).start({
          cwd: crew.folder,
          prompt,
          model,
          effort,
          mcp,
          permissionMode: projectMaster?.permissionMode || undefined,
          onEvent: (e) => this.event(run.id, e),
        })
        this.starting.delete(run.id)
        if (this.stopping.has(run.id) || store.getRun(run.id)?.status === 'failed') {
          await handle.stop().catch(() => undefined)
          return
        }
        this.active.set(run.id, handle)
        const result = await handle.done
        if (this.stopping.has(run.id)) this.finish(run.id, 'failed', this.stopReason.get(run.id) ?? 'Stopped by you')
        else this.finish(run.id, result.ok ? 'done' : 'failed', result.text)
      } catch (err) {
        this.starting.delete(run.id)
        this.finish(run.id, 'failed', err instanceof Error ? err.message : String(err))
      }
    })()
  }

  private event(runId: number, e: MasterEvent): void {
    const { store } = this.o
    const run = store.getRun(runId)
    if (!run) return
    if (e.kind === 'needs-you' && run.status === 'working') this.changed(store.setRunStatus(runId, 'needs-you', e.text ?? run.outcome))
    else if (e.kind === 'working' && run.status === 'needs-you') this.changed(store.setRunStatus(runId, 'working'))
    if (e.kind === 'session' && e.text) this.o.onSession?.(run, e.text)
    this.o.onEvent?.(run, e)
  }

  // Ends a run once; a second call (the adapter's done after a stop) is ignored.
  private finish(runId: number, status: 'done' | 'failed', outcome: string): void {
    const { store } = this.o
    const run = store.getRun(runId)
    if (!run || run.status === 'done' || run.status === 'failed') return
    this.active.delete(runId)
    this.stopping.delete(runId)
    this.stopReason.delete(runId)
    const ended = store.setRunStatus(runId, status, outcome)
    this.changed(ended)
    if (this.closing) return
    this.pump(run.crewId)
    if (ended.startedAt != null && this.o.onFinished) {
      try {
        void Promise.resolve(this.o.onFinished(ended)).catch((err) => this.o.onError?.(err))
      } catch (err) {
        this.o.onError?.(err)
      }
    }
  }

  private changed(run: Run): void {
    this.o.onChange?.({ crewId: run.crewId, runId: run.id, status: run.status })
  }
}

export function defaultBrief(run: Run): string {
  const seats = run.seats.map((s) => `${s.count} x preset ${s.presetId} on ${s.model}${s.effort ? ` (effort ${s.effort})` : ''}`)
  const parts = [run.task]
  if (seats.length) parts.push(`Run these seats as your own subagents: ${seats.join('; ')}.`)
  if (run.rules) parts.push(`Team rules: ${run.rules}`)
  return parts.join('\n\n')
}
