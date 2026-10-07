import { readFileSync } from 'node:fs'
import type { Run, RunEvent } from '../shared/types'
import type { LearnRunInfo } from '../shared/learn'
import { logLines, scrubLogLine } from './agents'
import type { HindsightService } from './hindsight'
import { RunError } from './runs'
import type { Store } from './store'
import type { MasterSession } from './usage-ingest'
import { retainOutcome, syncCodegraph, type Git } from './writeback'

// The close-out of an approved master-mode run, after the owner approved it (in the app, the terminal or Discord) and
// never after a send-back: Hindsight write-back with the diff's tags, a CodeGraph re-sync, then the learn step on the
// owner's chosen (cheap) Learning AI. Each step is tried on its own: a failing step never blocks the approval or the
// next task. Results are run events (kind 'closeout', source 'system', body JSON) and the run's closeoutState:
//   pending --start--> running --> done | partial | failed
//   done = no step failed (a skipped step is fine), failed = every step that ran failed, partial = some failed.

export const FALLBACK_MS = 120_000
const WAIT_MS = 120_000
const WINDOW_CAP = 9_000
const SUMMARY_CAP = 1_500
const TRANSCRIPT_TOTAL = 11_500

export type CloseoutStepName = 'hindsight' | 'codegraph' | 'learn'
export interface CloseoutStep {
  step: CloseoutStepName
  result: 'ok' | 'skipped' | 'failed'
  // The reason for a skipped or failed step; '' when it went fine.
  detail: string
  // The learn step's counts.
  extracted?: number
  written?: number
  merged?: number
  queued?: number
}

export interface CloseoutDeps {
  store: Store
  hindsight: Pick<HindsightService, 'retain'>
  git: Git
  reindex: (folder: string) => Promise<unknown>
  indexed: (folder: string) => boolean
  // False when the owner turned learning off.
  learnOn: () => boolean
  learn: (run: Run, transcript: string) => Promise<LearnRunInfo | null>
  // The run's window of the Master session as plain text (see windowTranscript).
  transcript: (run: Run) => Promise<string>
  // A last read of the run's usage before the step runs.
  settleUsage?: (run: Run) => Promise<void>
  // False when the project's Master Terminal is not running: the fallback then starts the close-out at once.
  masterLive?: (crewId: number) => boolean
  onChange?: (run: Run) => void
  onEvent?: (run: Run, e: RunEvent) => void
  log?: (message: string, crewId: number) => void
  now?: () => number
  fallbackMs?: number
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const why = (s: string): string => s.replace(/^skipped:\s*/, '')

export function summaryText(run: Run, state: string, steps: CloseoutStep[]): string {
  const ok: string[] = []
  const skipped: string[] = []
  const failed: string[] = []
  for (const s of steps) {
    const name = s.step === 'hindsight' ? 'Hindsight' : s.step === 'codegraph' ? 'CodeGraph' : 'Learning'
    if (s.result === 'skipped') skipped.push(`${name} (${s.detail})`)
    else if (s.result === 'failed') failed.push(`${name} (${s.detail})`)
    else if (s.step === 'hindsight') ok.push('Hindsight written')
    else if (s.step === 'codegraph') ok.push('CodeGraph synced')
    else {
      const parts = [s.queued ? `${s.queued} pending your review` : '', s.written ? `${s.written} written` : '', s.merged ? `${s.merged} merged` : ''].filter(Boolean)
      ok.push(s.extracted ? `${s.extracted} ${s.extracted === 1 ? 'lesson' : 'lessons'}${parts.length ? ` (${parts.join(', ')})` : ''}` : 'no new lessons')
    }
  }
  const tail = [skipped.length ? `skipped: ${skipped.join(', ')}` : '', failed.length ? `failed: ${failed.join(', ')}` : ''].filter(Boolean)
  return `Close-out JOB#${run.id} ${state}: ${[ok.join(', '), ...tail].filter(Boolean).join('; ') || 'nothing to do'}`
}

export class Closeout {
  private readonly inflight = new Map<number, Promise<string>>()
  private readonly now: () => number

  constructor(private readonly d: CloseoutDeps) {
    this.now = d.now ?? Date.now
  }

  // `run closeout` (Master, the owner's retry): starts the close-out of an approved run. Running it twice does nothing:
  // a running one is joined, a finished one answers with its result (`force` runs it again). Returns the summary when
  // `wait`, else a short note; a wait ends after two minutes with the note that it still runs.
  async request(runId: number, o: { wait?: boolean; force?: boolean } = {}): Promise<string> {
    const { store } = this.d
    const run = store.getRun(runId)
    if (!run) throw new RunError('NOT_FOUND', `Job ${runId} not found`)
    if (run.mode !== 'master' || run.status !== 'done' || !run.approvedBy) {
      throw new RunError('CONFLICT', `JOB#${runId} is not approved, so there is nothing to close out. The owner approves it in Operant, Discord or this terminal.`)
    }
    let p = this.inflight.get(runId)
    const joined = !!p
    if (!p) {
      if (!o.force && (run.closeoutState === 'done' || run.closeoutState === 'partial' || run.closeoutState === 'failed')) return this.lastText(run)
      p = this.execute(run).finally(() => this.inflight.delete(runId))
      this.inflight.set(runId, p)
    }
    if (!o.wait) {
      void p.catch(() => undefined)
      return joined ? `Close-out of JOB#${runId} is already running.` : `Close-out of JOB#${runId} started. It runs in the background; nothing more to do.`
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve(`Close-out of JOB#${runId} is still running; it will finish on its own.`), WAIT_MS)
      timer.unref?.()
    })
    try {
      return await Promise.race([p, late])
    } finally {
      clearTimeout(timer)
    }
  }

  // The summary a finished close-out stored.
  lastText(run: Run): string {
    const events = this.d.store.listRunEvents(run.id, { kind: 'closeout' })
    for (let i = events.length - 1; i >= 0; i--) {
      try {
        const o = JSON.parse(events[i]!.body) as { step?: string; text?: string }
        if (o.step === 'summary' && o.text) return o.text
      } catch {
        // not ours
      }
    }
    return `Close-out of JOB#${run.id}: ${run.closeoutState || 'not started'}`
  }

  // Fallback: a pending close-out the Master has not started two minutes after the approval (at once if its terminal
  // is not running) is started here. Called on the 1 s timer.
  tick(): void {
    const at = this.now()
    for (const run of this.d.store.listRuns()) {
      if (run.mode !== 'master' || run.closeoutState !== 'pending' || run.approvedAt == null || this.inflight.has(run.id)) continue
      const down = this.d.masterLive ? !this.d.masterLive(run.crewId) : false
      if (!down && at - run.approvedAt < (this.d.fallbackMs ?? FALLBACK_MS)) continue
      this.d.log?.(`JOB#${run.id} close-out started by Operant (${down ? 'the Master is not running' : 'the Master did not start it'})`, run.crewId)
      void this.request(run.id).catch(() => undefined)
    }
  }

  // After a restart nothing runs: an interrupted close-out starts over.
  recover(): void {
    for (const run of this.d.store.listRuns()) if (run.mode === 'master' && run.closeoutState === 'running' && !this.inflight.has(run.id)) this.changed(this.d.store.updateRun(run.id, { closeoutState: 'pending' }))
  }

  private changed(run: Run): Run {
    try {
      this.d.onChange?.(run)
    } catch {
      // a listener never breaks the close-out
    }
    return run
  }

  private event(run: Run, body: object): void {
    const e = this.d.store.addRunEvent(run.id, { kind: 'closeout', source: 'system', body: JSON.stringify(body) })
    try {
      this.d.onEvent?.(run, e)
    } catch {
      // a listener never breaks the close-out
    }
  }

  private async execute(first: Run): Promise<string> {
    const { store } = this.d
    const run = this.changed(store.updateRun(first.id, { closeoutState: 'running' }))
    const steps: CloseoutStep[] = []
    const add = (s: CloseoutStep): void => {
      steps.push(s)
      this.event(run, s)
    }
    try {
      const crew = store.getCrew(run.crewId)
      if (!crew) throw new Error('the project is gone')
      await this.d.settleUsage?.(run).catch(() => undefined)
      let window = ''
      try {
        window = await this.d.transcript(run)
      } catch {
        // learning then works from the review summary alone
      }
      const summary = scrubLogLine(run.reviewSummary || run.outcome).slice(0, SUMMARY_CAP)

      try {
        const h = await retainOutcome({ hindsight: this.d.hindsight, git: this.d.git }, run, crew.folder, { summary })
        add(h.result === 'written' ? { step: 'hindsight', result: 'ok', detail: '' } : { step: 'hindsight', result: 'skipped', detail: why(h.result) })
      } catch (err) {
        add({ step: 'hindsight', result: 'failed', detail: scrubLogLine(errText(err)) })
      }

      if (!this.d.indexed(crew.folder)) add({ step: 'codegraph', result: 'skipped', detail: 'this project has no CodeGraph index' })
      else {
        const c = await syncCodegraph(this.d.reindex, crew.folder)
        add(c === 'synced' ? { step: 'codegraph', result: 'ok', detail: '' } : { step: 'codegraph', result: 'failed', detail: why(c) })
      }

      if (!this.d.learnOn()) add({ step: 'learn', result: 'skipped', detail: 'learning is turned off' })
      else {
        try {
          const l = await this.d.learn(run, window)
          if (!l) add({ step: 'learn', result: 'failed', detail: 'the learn step did not run' })
          else {
            const counts = { extracted: l.extracted, written: l.written, merged: l.merged, queued: l.queued }
            if (l.error) add({ step: 'learn', result: 'failed', detail: scrubLogLine(l.error), ...counts })
            else {
              add({ step: 'learn', result: 'ok', detail: '', ...counts })
              for (const s of l.skipped) add({ step: 'learn', result: 'skipped', detail: `${s.store}: ${s.reason}` })
            }
          }
        } catch (err) {
          add({ step: 'learn', result: 'failed', detail: scrubLogLine(errText(err)) })
        }
      }
    } catch (err) {
      add({ step: 'hindsight', result: 'failed', detail: scrubLogLine(errText(err)) })
    }
    const failed = steps.filter((s) => s.result === 'failed').length
    const worked = steps.filter((s) => s.result === 'ok').length
    const state = failed === 0 ? 'done' : worked === 0 ? 'failed' : 'partial'
    const text = summaryText(run, state, steps)
    this.event(run, { step: 'summary', state, text })
    const final = store.updateRun(run.id, { closeoutState: state })
    this.changed(final)
    this.d.log?.(text, run.crewId)
    return text
  }
}

export interface WindowDeps {
  store: Store
  sessions: (crewId: number) => MasterSession[]
  transcriptFile: (cwd: string, sessionId: string) => string
  read?: (path: string) => string | null
  // The messages of an OpenCode session (the service's API).
  messages?: (sessionId: string) => Promise<unknown[]>
  now?: () => number
}

const time = (o: unknown): number | null => {
  const r = (o && typeof o === 'object' ? o : {}) as Record<string, any>
  const t = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : typeof r.time?.created === 'number' ? r.time.created : typeof r.info?.time?.created === 'number' ? r.info.time.created : NaN
  return Number.isFinite(t) ? t : null
}

// The run's part of the Master session as plain scrubbed text: from the run's first delivered line to its approval,
// then the review summary last (the learn step keeps the tail). Master-mode runs have no process of their own.
export async function windowTranscript(d: WindowDeps, run: Run): Promise<string> {
  const crew = d.store.getCrew(run.crewId)
  const events = d.store.listRunEvents(run.id)
  const start = events.find((e) => e.kind === 'delivered')?.at ?? run.startedAt ?? run.createdAt
  const end = run.approvedAt ?? (d.now ?? Date.now)()
  const lines: string[] = []
  const take = (entry: unknown): void => {
    const t = time(entry)
    if (t != null && (t < start || t > end)) return
    lines.push(...logLines(entry))
  }
  if (crew) {
    for (const s of d.sessions(run.crewId)) {
      if (s.cli === 'claude') {
        const raw = (d.read ?? defaultRead)(d.transcriptFile(crew.folder, s.sessionId))
        for (const l of (raw ?? '').split(/\r?\n/)) {
          if (!l.trim()) continue
          try {
            take(JSON.parse(l))
          } catch {
            // a half-written line
          }
        }
      } else {
        for (const m of (await d.messages?.(s.sessionId).catch(() => [])) ?? []) take(m)
      }
    }
  }
  const body = lines.join('\n').slice(-WINDOW_CAP)
  const summary = scrubLogLine(run.reviewSummary).slice(0, SUMMARY_CAP)
  const outcome = scrubLogLine(run.outcome).slice(0, SUMMARY_CAP)
  const out = [body, summary ? `Review summary:\n${summary}` : '', outcome && outcome !== summary ? `Outcome:\n${outcome}` : ''].filter(Boolean).join('\n\n')
  return out.slice(-TRANSCRIPT_TOTAL)
}

function defaultRead(p: string): string | null {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}
