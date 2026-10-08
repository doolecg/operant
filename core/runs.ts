import type { ModelTier, Run, RunInput, Team, TeamLimits, TeamSeat } from '../shared/types'
import { MASTER_CLIS, validateLaunchSettings, validateMasterCli, validateModel } from './launch'
import type { MasterEvent, MasterMcp, MasterRegistry, MasterRun } from './master'
import type { Store } from './store'

export type RunErrorCode = 'BAD_ARGS' | 'NOT_FOUND' | 'LIMIT' | 'CONFLICT' | 'FORBIDDEN'

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
    // OpenCode runs every seat on the Master's single model: nothing stored.
    if (preset.agent === 'opencode') {
      const eff = typeof s.effort === 'string' ? s.effort.trim() : ''
      return { presetId: s.presetId, count: s.count as number, model: '', ...(eff ? { effort: eff } : {}) }
    }
    const model = typeof s.model === 'string' && s.model.trim() ? s.model.trim() : preset.model
    // An empty model is the seat preset's "CLI default" (the OpenCode presets ship that way): nothing to validate.
    if (model) validateModel(model, preset.agent)
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
  // A master-mode run that had reached the Master was stopped: the gate tells the Master with the fixed stop line.
  onMasterStopped?: (run: Run) => void
}

export class RunManager {
  private readonly active = new Map<number, MasterRun>()
  private readonly starting = new Set<number>()
  private readonly stopping = new Set<number>()
  private readonly stopReason = new Map<number, string>()
  // Master-mode runs already moved to needs-you for their token budget (once each: Resume lets the Master go on).
  private readonly overBudget = new Set<number>()
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
    const wrong = seats.map((s) => store.getPreset(s.presetId)).find((p) => p && p.agent !== masterCli)
    if (wrong) throw new RunError('BAD_ARGS', `Seat ${wrong.name} runs on ${wrong.agent}, but this job's Master uses ${masterCli}. Pick seats for ${masterCli}, or change the Master CLI.`)
    const limits = { maxWorkers: 0, topTier: '' as const, tokenBudget: 0, ...team?.limits }
    checkLimits(seats, limits)

    // The project's Master Terminal by default (the gate in core/master-gate.ts delivers it); 'background' is the opt-in headless runner.
    const mode = input.mode === 'background' ? 'background' : 'master'
    const run = store.createRun({ crewId: input.crewId, task, masterCli, masterModel, masterEffort, teamId: team?.id ?? null, seats, limits, rules: team?.rules ?? '', mode })
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
      // A master-mode run has no process of its own: the Master session keeps running and is told with a fixed line.
      if (run.mode === 'master') this.o.onMasterStopped?.(store.getRun(runId)!)
    }
    return store.getRun(runId)!
  }

  // Quit path: ends every working background run as interrupted without waiting for its CLI (the caller kills the
  // processes), and starts nothing more (no queue pump, no learn step). Master-mode runs wait for Resume (MasterGate.recover).
  interruptAll(): void {
    this.closing = true
    for (const run of this.o.store.listRuns()) {
      if (run.mode === 'background' && (run.status === 'working' || run.status === 'needs-you')) {
        const handle = this.active.get(run.id)
        void handle?.stop().catch(() => undefined)
        this.finish(run.id, 'failed', 'Interrupted: Operant was closed while it ran')
      }
    }
  }

  // Background runs left working by a previous process cannot be resumed: they end as failed, then queues start.
  // Master-mode runs are the gate's (MasterGate.recover).
  recover(): void {
    const { store } = this.o
    for (const run of store.listRuns()) {
      if (run.mode === 'background' && (run.status === 'working' || run.status === 'needs-you')) this.finish(run.id, 'failed', 'Interrupted: Operant was closed while it ran')
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

  // Stops every working background run whose tokens passed the token budget its team set (0 = no limit). A master-mode
  // run is not stopped (that would end the Master's turn mid-work): it goes to needs-you with the reason, once.
  // Returns the runs stopped or flagged.
  enforceTokenBudgets(): number[] {
    const { runTokens, store } = this.o
    if (!runTokens) return []
    const over: number[] = []
    for (const run of store.listRuns()) {
      const budget = run.limits.tokenBudget
      if (!budget || (run.status !== 'working' && run.status !== 'needs-you') || this.stopping.has(run.id)) continue
      if (run.mode === 'master' && (run.status !== 'working' || this.overBudget.has(run.id))) continue
      let used = 0
      try {
        used = runTokens(run)
      } catch (err) {
        this.o.onError?.(err)
      }
      if (used <= budget) continue
      over.push(run.id)
      if (run.mode === 'master') {
        this.overBudget.add(run.id)
        const msg = `Over budget: the job used ${used.toLocaleString('en-US')} tokens, over its team's budget of ${budget.toLocaleString('en-US')}. Stop it, or press Resume to let the Master go on`
        this.changed(store.transitionRun(run.id, 'needs-you', { waiting: 'master' }, msg))
        continue
      }
      void this.stop(run.id, `Stopped: the job used ${used.toLocaleString('en-US')} tokens, over its team's budget of ${budget.toLocaleString('en-US')}`).catch((err) => this.o.onError?.(err))
    }
    return over
  }

  private activeCount(crewId: number): number {
    return this.o.store.listRuns(crewId).filter((r) => r.mode === 'background' && (r.status === 'working' || r.status === 'needs-you')).length
  }

  private pump(crewId: number): void {
    const { store } = this.o
    for (;;) {
      if (this.activeCount(crewId) >= this.concurrency) return
      const next = store.listRuns(crewId).find((r) => r.mode === 'background' && r.status === 'queued' && !this.starting.has(r.id) && !this.held(r))
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

// Records that the owner typed an approval for a run in review (the Master Terminal path). The renderer's
// operators:write feeds every keystroke chunk into observeInput; only a whole typed line that is just an approval
// word (optionally with the JOB# or its number) counts, only while exactly one run of the project is in review
// (or the line names the run), and the mark is single-use and short-lived. Pasted text and agent output never count.
export const APPROVAL_TTL_MS = 10 * 60_000
const APPROVAL_LINE = /^(?:looks good[,.!]?\s+)?(?:i\s+)?(?:approve|approved|lgtm)(?:\s+(?:it|this)|\s+(?:job\s*)?#?(\d{5,9}))?\s*[.!]?$/i
const LINE_MAX = 80

export interface ApprovalMarkerOptions {
  now?: () => number
  ttlMs?: number
  // Ids of the project's runs that are in review now.
  inReview: (crewId: number) => number[]
}

export class ApprovalMarker {
  private readonly lines = new Map<number, string>()
  private readonly marks = new Map<number, number>()
  private readonly now: () => number
  private readonly ttl: number

  constructor(private readonly o: ApprovalMarkerOptions) {
    this.now = o.now ?? Date.now
    this.ttl = o.ttlMs ?? APPROVAL_TTL_MS
  }

  // Keystrokes the owner typed in the project's Master Terminal. Returns the run marked, if this chunk finished an approval line.
  observeInput(crewId: number, data: string): number | null {
    if (data.includes('\x1b[200~')) {
      this.lines.delete(crewId)
      return null
    }
    let line = this.lines.get(crewId) ?? ''
    let marked: number | null = null
    // Escape sequences (arrows, function keys) are dropped whole; their letters are never text.
    // eslint-disable-next-line no-control-regex
    for (const ch of data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b./g, '')) {
      if (ch === '\r' || ch === '\n') {
        marked = this.finishLine(crewId, line) ?? marked
        line = ''
      } else if (ch === '\x7f' || ch === '\b') line = line.slice(0, -1)
      else if (ch === '\x15' || ch === '\x03') line = ''
      else if (ch >= ' ' && line.length < LINE_MAX) line += ch
      else if (ch >= ' ') line = 'x'.repeat(LINE_MAX)
    }
    if (line) this.lines.set(crewId, line)
    else this.lines.delete(crewId)
    return marked
  }

  // The prompt the owner submitted in the Master Terminal (the UserPromptSubmit hook): marks a run only when the whole
  // prompt is a standalone approval line, as for typed keystrokes.
  observePrompt(crewId: number, prompt: string): number | null {
    return prompt.length <= LINE_MAX && !/[\r\n]/.test(prompt) ? this.finishLine(crewId, prompt) : null
  }

  private finishLine(crewId: number, line: string): number | null {
    const m = APPROVAL_LINE.exec(line.trim())
    if (!m) return null
    const review = this.o.inReview(crewId)
    const named = m[1] ? Number(m[1]) : null
    const id = named ?? (review.length === 1 ? review[0]! : null)
    if (id === null || !review.includes(id)) return null
    this.marks.set(id, this.now() + this.ttl)
    return id
  }

  // True once for a live mark; the mark is spent.
  consume(runId: number): boolean {
    const until = this.marks.get(runId)
    this.marks.delete(runId)
    return until !== undefined && until > this.now()
  }

  // A mark without spending it.
  has(runId: number): boolean {
    const until = this.marks.get(runId)
    return until !== undefined && until > this.now()
  }

  forget(runId: number): void {
    this.marks.delete(runId)
  }
}

export function defaultBrief(run: Run): string {
  const seats = run.seats.map((s) => `${s.count} x preset ${s.presetId} on ${s.model || "the Master's model"}${s.effort ? ` (effort ${s.effort})` : ''}`)
  const parts = [run.task]
  if (seats.length) parts.push(`Delegate the work to these seats as your own subagents (you coordinate, you do not do it yourself): ${seats.join('; ')}.`)
  if (run.rules) parts.push(`Team rules: ${run.rules}`)
  return parts.join('\n\n')
}
