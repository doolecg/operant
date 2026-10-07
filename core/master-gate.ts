import { randomUUID } from 'node:crypto'
import type { MasterState, Run } from '../shared/types'
import type { MasterRuns } from './master-runs'
import { fixedLine, isMasterCommandLine, type PointerKind } from './nudge'
import { RunError } from './runs'
import type { Store } from './store'

// The Master gate: gets each master-mode job (JOB#) of a project to its Master Terminal as ONE fixed pointer line
// (core/nudge.ts fixedLine) and keeps the run's status in step with the Master. Per project, clock-driven: `tick`
// decides, `poke` runs it after a change. Operant only ever types fixed lines; the Master reads everything else with
// `operant run show|answer` as data.
//
//   Master not running --queued job--> start it (once per job) --60 s no idle--> needs-you(master) "did not start"
//   starting --SessionStart / service idle--> idle
//   idle + owner quiet + no draft + no subagents + no line pending --> type: outbox line, else the next job
//        (queued -> working, event 'delivered') --> pending
//   pending --UserPromptSubmit with our line (Claude) / busy (OpenCode) / run start--> acknowledged
//           --8 s, still idle--> retype once (Ctrl+U first, event 'retry') --8 s--> needs-you(master) "did not pick up"
//   working --Notification permission / OpenCode permission / silent at a prompt--> needs-you(permission) --activity--> working
//   working --Master exits--> needs-you(master) "The Master stopped"; Resume (runs:resumeMaster) restarts it with
//        --resume / --continue and types the resume line. Never restarted on its own after that.

export interface GateConfig {
  // No owner keystroke on the Master's session for this long before Operant types.
  ownerQuietMs: number
  // No pty output for this long (the TUI has settled after Stop).
  outputQuietMs: number
  // Time for the Master to acknowledge a typed line before it is retyped (once), then given up.
  ackMs: number
  // Time for a started Master to report its first idle state.
  startMs: number
  // Busy with no output for this long while the screen shows a permission dialog counts as a permission wait.
  promptStuckMs: number
}

export const DEFAULT_GATE_CONFIG: GateConfig = { ownerQuietMs: 4000, outputQuietMs: 1000, ackMs: 8000, startMs: 60_000, promptStuckMs: 180_000 }

export const MSG = {
  didNotStart: 'The Master did not start',
  noSignOfLife: 'The Master did not start: no ready signal within 60 s (a trust or login prompt in the Master Terminal?)',
  notPickedUp: 'The Master did not pick up the task',
  stopped: 'The Master stopped',
  closed: 'The Master stopped: Operant was closed while it ran this job',
  permission: 'Waiting at a permission prompt in the Master Terminal: answer it there',
} as const

// What the gate needs from SessionManager (fakes in tests).
export interface GateSessions {
  isRunning(key: number): boolean
  typeFixed(key: number, line: string, opts?: { clearFirst?: boolean }): boolean
  ownerIdleMs(key: number): number | null
  ownerDraft(key: number): boolean
  idleMs(key: number): number | null
  buffer(key: number): string
}

export interface MasterGateDeps {
  store: Store
  runs: Pick<MasterRuns, 'nextQueued' | 'activeMaster'>
  states: { get(crewId: number): MasterState }
  sessions: GateSessions
  // The project's Master Terminal slot (operator id), or null when it has none yet.
  masterKey: (crewId: number) => number | null
  // Starts the project's Master (resume: the last conversation). Returns an error message, or null when it started.
  startMaster: (crewId: number, opts: { resume: boolean }) => string | null
  // A reason not to deliver the next job now (a spending cap), or ''.
  hold?: (run: Run) => string
  onChange?: (run: Run) => void
  // Gate decisions, for the Console (source 'master'). Only ids, kinds and fixed reasons: no free text.
  log?: (crewId: number, message: string) => void
  now?: () => number
  nonce?: () => string
  config?: Partial<GateConfig>
}

type OutboxKind = 'answer' | 'approved' | 'stopped'

interface Pending {
  runId: number
  kind: PointerKind
  line: string
  nonce: string
  typedAt: number
  attempts: number
  // A job line (new / sent back / resume): giving up moves the run to needs-you.
  task: boolean
  matched: boolean
}

interface CrewGate {
  pending: Pending | null
  outbox: Array<{ kind: OutboxKind; runId: number }>
  // Fixed lines that are not about a job: the owner's Discord message pointer and Master commands (/compact, /clear, /cost).
  lines: Array<{ line: string; at: number }>
  // The run the Master is being started for, and when.
  starting: { runId: number; at: number } | null
  // Jobs that already used their one automatic Master start.
  autoStarted: Set<number>
  // needs-you(master) jobs the owner asked to retry or resume.
  armed: Set<number>
  // The Claude Master sends its prompt text with UserPromptSubmit: then only an exact match acknowledges a line.
  promptText: boolean
  lastLog: string
}

// A permission or choice dialog drawn by Claude Code or OpenCode (only used together with a long silence while busy).
const PROMPT_RE = /Do you want to (?:proceed|make this edit|create|allow|run)|Allow (?:once|always)|Permission required|\b1\. Yes\b/i
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?<>]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b./g

// A queued fixed line that was not typed within this long (the Master stayed busy) is dropped.
const LINE_TTL_MS = 10 * 60 * 1000

const isMaster = (r: Run | null | undefined): r is Run => !!r && r.mode === 'master'

export class MasterGate {
  private readonly crews = new Map<number, CrewGate>()
  private readonly cfg: GateConfig
  private readonly now: () => number
  private readonly dirty = new Set<number>()
  private running = false

  constructor(private readonly d: MasterGateDeps) {
    this.cfg = { ...DEFAULT_GATE_CONFIG, ...d.config }
    this.now = d.now ?? Date.now
  }

  private crew(crewId: number): CrewGate {
    let g = this.crews.get(crewId)
    if (!g) {
      g = { pending: null, outbox: [], lines: [], starting: null, autoStarted: new Set(), armed: new Set(), promptText: false, lastLog: '' }
      this.crews.set(crewId, g)
    }
    return g
  }

  private log(crewId: number, message: string, always = false): void {
    const g = this.crew(crewId)
    if (!always && g.lastLog === message) return
    g.lastLog = message
    this.d.log?.(crewId, message)
  }

  private changed(run: Run): Run {
    this.d.onChange?.(run)
    return run
  }

  private event(runId: number, kind: 'delivered' | 'retry' | 'giveup' | 'resume', body: Record<string, string | number>): void {
    this.d.store.addRunEvent(runId, { kind, source: 'system', body: JSON.stringify(body) })
  }

  // Runs `tick` for the project after a change; a change made by a tick queues another pass instead of nesting.
  poke(crewId: number): void {
    this.dirty.add(crewId)
    if (this.running) return
    this.running = true
    try {
      for (let guard = 0; this.dirty.size && guard < 50; guard++) {
        const id = this.dirty.values().next().value as number
        this.dirty.delete(id)
        this.tick(id)
      }
    } finally {
      this.dirty.clear()
      this.running = false
    }
  }

  // The timer: every project with a master-mode job in flight or gate work pending.
  tickAll(): void {
    const ids = new Set<number>()
    for (const r of this.d.store.listRuns()) if (r.mode === 'master' && (r.status === 'queued' || r.status === 'working' || r.status === 'needs-you')) ids.add(r.crewId)
    for (const [id, g] of this.crews) if (g.pending || g.outbox.length || g.lines.length || g.starting) ids.add(id)
    for (const id of ids) this.poke(id)
  }

  // A UserPromptSubmit from the Claude Master. True when it is the line Operant typed (an acknowledgement), so the
  // caller treats every other prompt as the owner's.
  onPrompt(crewId: number, prompt: string): boolean {
    const g = this.crew(crewId)
    const text = prompt.trim()
    if (text) g.promptText = true
    if (g.pending && text === g.pending.line) {
      g.pending.matched = true
      this.poke(crewId)
      return true
    }
    return false
  }

  // A line for a job that is not a delivery: the owner answered, approved, or stopped it. One per kind and job.
  notify(crewId: number, kind: OutboxKind, runId: number): void {
    const g = this.crew(crewId)
    if (kind === 'stopped' && g.pending?.runId === runId) g.pending = null
    if (kind === 'stopped') g.outbox = g.outbox.filter((o) => o.runId !== runId)
    const waiting = g.outbox.some((o) => o.kind === kind && o.runId === runId) || (g.pending?.kind === kind && g.pending.runId === runId)
    if (!waiting) g.outbox.push({ kind, runId })
    this.poke(crewId)
  }

  // The owner wrote to the Master in Discord (the text is already stored, see MasterRuns.ownerMessage). Types the one
  // fixed pointer line when the Master is idle; one waits at a time. Starts a Master that is not running. Returns an
  // error text when it cannot be started, else null.
  ownerMessage(crewId: number): string | null {
    const g = this.crew(crewId)
    if (!this.alive(crewId)) {
      const err = this.d.startMaster(crewId, { resume: true })
      if (err) {
        this.log(crewId, 'the Master could not be started for an owner message', true)
        return `${MSG.didNotStart}: ${err}`
      }
      this.log(crewId, 'starting the Master for an owner message', true)
    }
    const line = fixedLine('owner')
    if (!g.lines.some((l) => l.line === line)) g.lines.push({ line, at: this.now() })
    this.poke(crewId)
    return null
  }

  // A Master command from the owner (closed vocabulary in core/nudge.ts), typed when the Master is idle. Never starts the
  // Master. Returns an error text, or null when it is queued.
  command(crewId: number, line: string): string | null {
    if (!isMasterCommandLine(line)) return 'That is not a Master command'
    if (!this.alive(crewId)) return 'The Master is not running'
    const g = this.crew(crewId)
    if (!g.lines.some((l) => l.line === line)) g.lines.push({ line, at: this.now() })
    this.poke(crewId)
    return null
  }

  // The owner's Retry / Resume (runs:resumeMaster).
  resume(runId: number): Run {
    const { store } = this.d
    const run = store.getRun(runId)
    if (!isMaster(run)) throw new RunError('NOT_FOUND', `Job ${String(runId)} is not a Master Terminal job`)
    const waiting = run.status === 'needs-you' && run.waiting === 'master'
    if (!waiting && run.status !== 'queued') throw new RunError('CONFLICT', `Job ${runId} is ${run.status}${run.waiting ? ` (waiting: ${run.waiting})` : ''}: nothing to resume`)
    const g = this.crew(run.crewId)
    if (waiting) g.armed.add(runId)
    this.event(runId, 'resume', { by: 'owner' })
    if (!this.alive(run.crewId)) {
      const err = this.d.startMaster(run.crewId, { resume: run.ackedAt != null })
      if (err) {
        g.armed.delete(runId)
        this.log(run.crewId, `JOB#${runId}: the Master could not be started for a resume`, true)
        throw new RunError('CONFLICT', `${MSG.didNotStart}: ${err}`)
      }
      g.starting = { runId, at: this.now() }
      this.log(run.crewId, `JOB#${runId}: starting the Master to resume`, true)
    }
    this.poke(run.crewId)
    return store.getRun(runId)!
  }

  // After an app restart: a job that was with a Master that is gone waits for Resume; one with a live Master stays.
  // Unread owner replies get their answer line again.
  recover(): void {
    for (const run of this.d.store.listRuns()) {
      if (run.mode !== 'master') continue
      const live = this.alive(run.crewId)
      if (!live && (run.status === 'working' || (run.status === 'needs-you' && run.waiting === 'permission'))) {
        this.toWaitingMaster(run, MSG.closed)
      }
      if ((run.status === 'working' || run.status === 'needs-you') && this.d.store.listRunEvents(run.id, { kind: 'reply', unread: true }).length) {
        const g = this.crew(run.crewId)
        if (!g.outbox.some((o) => o.runId === run.id && o.kind === 'answer')) g.outbox.push({ kind: 'answer', runId: run.id })
      }
    }
  }

  private alive(crewId: number): boolean {
    const key = this.d.masterKey(crewId)
    return key != null && this.d.sessions.isRunning(key) && this.d.states.get(crewId).phase !== 'exited'
  }

  private toWaitingMaster(run: Run, message: string): Run {
    const { store } = this.d
    let cur = run
    if (cur.status === 'queued') cur = store.setRunStatus(cur.id, 'working')
    if (cur.status === 'needs-you') cur = store.setRunStatus(cur.id, 'working')
    return this.changed(store.transitionRun(cur.id, 'needs-you', { waiting: 'master' }, message))
  }

  // Why Operant may not type into the Master now ('' = it may).
  private blocked(key: number, state: MasterState): string {
    if (state.phase !== 'idle') return `the Master is ${state.phase}`
    if (state.agents > 0) return `${state.agents} subagent${state.agents === 1 ? '' : 's'} still running`
    const owner = this.d.sessions.ownerIdleMs(key)
    if (owner !== null && owner < this.cfg.ownerQuietMs) return 'the owner is typing'
    if (this.d.sessions.ownerDraft(key)) return 'the owner has unsent text in the Master Terminal'
    const quiet = this.d.sessions.idleMs(key)
    if (quiet !== null && quiet < this.cfg.outputQuietMs) return 'the Master is still drawing'
    return ''
  }

  // Busy, silent for minutes, and a permission dialog on screen: treated as a permission wait (never typed into).
  private stuckAtPrompt(key: number, state: MasterState): boolean {
    if (state.phase !== 'busy') return false
    const quiet = this.d.sessions.idleMs(key)
    if (quiet === null || quiet < this.cfg.promptStuckMs) return false
    return PROMPT_RE.test(this.d.sessions.buffer(key).slice(-4000).replace(ANSI_RE, ''))
  }

  private acked(p: Pending, g: CrewGate, state: MasterState): boolean {
    if (p.matched) return true
    if (p.task) {
      const run = this.d.store.getRun(p.runId)
      if (run?.ackedAt != null && run.ackedAt >= p.typedAt) return true
    }
    // OpenCode (and a Claude that sends no prompt text): the session went busy after the line was typed.
    if (state.cli === 'claude' && g.promptText) return false
    return state.lastPromptAt != null && state.lastPromptAt >= p.typedAt
  }

  // The job the gate would hand to the Master next: an armed waiting job, else the next queued one (if no job is active).
  private wanted(crewId: number, active: Run | null): Run | null {
    const g = this.crew(crewId)
    if (active) return active.status === 'needs-you' && active.waiting === 'master' && g.armed.has(active.id) ? active : null
    return this.d.runs.nextQueued(crewId)
  }

  tick(crewId: number): void {
    const { store, sessions } = this.d
    const g = this.crew(crewId)
    const now = this.now()
    const state = this.d.states.get(crewId)
    const key = this.d.masterKey(crewId)
    const alive = this.alive(crewId)
    let active = this.d.runs.activeMaster(crewId)
    g.lines = g.lines.filter((l) => now - l.at < LINE_TTL_MS)

    // The Master went away: nothing is pending any more, and the job it was on waits for Resume.
    if (!alive) {
      g.pending = null
      if (active && (active.status === 'working' || active.waiting === 'permission') && !g.starting) {
        active = this.toWaitingMaster(active, MSG.stopped)
        this.log(crewId, `JOB#${active.id}: the Master stopped; waiting for Resume`, true)
      }
    }

    // Permission prompts: the job waits for the owner, and works again once the Master moves on.
    if (alive && key != null && active) {
      const atPrompt = state.phase === 'needs-input' || this.stuckAtPrompt(key, state)
      if (active.status === 'working' && atPrompt) {
        active = this.changed(store.transitionRun(active.id, 'needs-you', { waiting: 'permission' }, MSG.permission))
        this.log(crewId, `JOB#${active.id}: waiting at a permission prompt; nothing is typed`, true)
      } else if (active.status === 'needs-you' && active.waiting === 'permission' && !atPrompt && (state.phase === 'busy' || state.phase === 'idle')) {
        active = this.changed(store.transitionRun(active.id, 'working'))
        this.log(crewId, `JOB#${active.id}: the permission prompt was answered`, true)
      }
    }

    // A line waits for its acknowledgement: retyped once, then given up.
    if (g.pending && alive && key != null) {
      const p = g.pending
      if (this.acked(p, g, state)) {
        g.pending = null
        this.log(crewId, `JOB#${p.runId}: the Master picked up the ${p.kind} line`, true)
      } else if (now - p.typedAt >= this.cfg.ackMs) {
        if (p.attempts < 2) {
          if (!this.blocked(key, state) && sessions.typeFixed(key, p.line, { clearFirst: true })) {
            p.attempts++
            p.typedAt = now
            if (p.task) this.event(p.runId, 'retry', { nonce: p.nonce, line: p.kind })
            this.log(crewId, `JOB#${p.runId}: no pickup in ${this.cfg.ackMs / 1000} s; the ${p.kind} line was typed again`, true)
          }
        } else {
          g.pending = null
          const run = store.getRun(p.runId)
          if (p.task) this.event(p.runId, 'giveup', { nonce: p.nonce, line: p.kind })
          if (p.task && run && run.status === 'working' && (run.ackedAt == null || run.ackedAt < p.typedAt)) this.toWaitingMaster(run, MSG.notPickedUp)
          this.log(crewId, `JOB#${p.runId}: the Master did not pick up the ${p.kind} line; stopped retrying`, true)
        }
      }
      if (g.pending) return
    }

    const want = this.wanted(crewId, active)

    // No Master: start it for the next job (once per job); a start that fails or never gets ready parks the job.
    if (!alive) {
      if (g.starting) {
        const run = store.getRun(g.starting.runId)
        g.starting = null
        if (isMaster(run) && (run.status === 'queued' || run.status === 'needs-you')) {
          this.toWaitingMaster(run, MSG.didNotStart)
          this.log(crewId, `JOB#${run.id}: the Master closed while starting`, true)
        }
        return
      }
      if (!want || want.status !== 'queued' || g.autoStarted.has(want.id)) return
      const held = this.d.hold?.(want) ?? ''
      if (held) return this.log(crewId, `JOB#${want.id} held: ${held}`)
      g.autoStarted.add(want.id)
      const err = this.d.startMaster(crewId, { resume: false })
      if (err) {
        this.toWaitingMaster(want, `${MSG.didNotStart}: ${err}`)
        this.log(crewId, `JOB#${want.id}: the Master could not be started`, true)
        return
      }
      g.starting = { runId: want.id, at: now }
      this.log(crewId, `JOB#${want.id}: starting the Master`, true)
      return
    }
    if (key == null) return

    // Started (by Operant or the owner) but not ready yet.
    if (state.phase === 'starting' || state.phase === 'unknown') {
      if (!want) return
      if (!g.starting) g.starting = { runId: want.id, at: now }
      else if (now - g.starting.at >= this.cfg.startMs) {
        const run = store.getRun(g.starting.runId)
        g.starting = null
        if (isMaster(run) && (run.status === 'queued' || run.status === 'needs-you')) this.toWaitingMaster(run, MSG.noSignOfLife)
        g.armed.delete(run?.id ?? -1)
        this.log(crewId, `JOB#${run?.id ?? '?'}: the Master gave no ready signal in ${this.cfg.startMs / 1000} s`, true)
      }
      return
    }
    g.starting = null

    if (!want && !g.outbox.length && !g.lines.length) return
    const why = this.blocked(key, state)
    if (why) return this.log(crewId, `waiting to type: ${why}`)

    // Lines about jobs come first (only while still meaningful), then the next job.
    while (g.outbox.length) {
      const o = g.outbox.shift()!
      const run = store.getRun(o.runId)
      const live = !!run && (o.kind === 'answer' ? run.status === 'working' || run.status === 'needs-you' : o.kind === 'approved' ? run.status === 'done' : run.status === 'failed')
      if (!live) continue
      this.type(crewId, key, o.kind, o.runId, false)
      return
    }
    const next = g.lines.shift()
    if (next) {
      if (this.d.sessions.typeFixed(key, next.line)) this.log(crewId, `typed the ${next.line.startsWith('/') ? next.line : 'owner message'} line`, true)
      return
    }
    if (!want) return
    const held = want.status === 'queued' ? (this.d.hold?.(want) ?? '') : ''
    if (held) return this.log(crewId, `JOB#${want.id} held: ${held}`)
    const kind: PointerKind = want.status === 'needs-you' && want.ackedAt != null ? 'resume' : want.sendBacks > 0 ? 'sent-back' : 'new'
    g.armed.delete(want.id)
    // The status moves first, so `run next` / `run start` and a second tick see the slot taken: one delivery per round.
    this.changed(store.transitionRun(want.id, 'working'))
    this.type(crewId, key, kind, want.id, true)
  }

  private type(crewId: number, key: number, kind: PointerKind, runId: number, task: boolean): void {
    const g = this.crew(crewId)
    const line = fixedLine(kind, runId)
    const nonce = this.d.nonce?.() ?? randomUUID()
    const now = this.now()
    if (task) this.event(runId, 'delivered', { nonce, line: kind })
    if (!this.d.sessions.typeFixed(key, line)) {
      const run = this.d.store.getRun(runId)
      if (task && run?.status === 'working') this.toWaitingMaster(run, MSG.stopped)
      return
    }
    g.pending = { runId, kind, line, nonce, typedAt: now, attempts: 1, task, matched: false }
    this.log(crewId, `JOB#${runId}: typed the ${kind} line`, true)
  }
}
