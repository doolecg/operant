import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HookReport, MasterHookEvent } from '../shared/types'
import { MasterGate, MSG, type GateSessions } from './master-gate'
import { MasterRuns } from './master-runs'
import { MasterStates } from './master-state'
import { fixedLine, isFixedLine } from './nudge'
import { ApprovalMarker } from './runs'
import { Store } from './store'

class FakeSessions implements GateSessions {
  running = new Set<number>()
  typed: Array<{ line: string; clear: boolean }> = []
  owner: number | null = null
  draft = false
  quiet: number | null = 10_000
  screen = ''
  isRunning = (k: number) => this.running.has(k)
  typeFixed(k: number, line: string, o?: { clearFirst?: boolean }): boolean {
    if (!isFixedLine(line)) throw new Error('not a fixed Operant line')
    if (!this.running.has(k)) return false
    this.typed.push({ line, clear: !!o?.clearFirst })
    return true
  }
  ownerIdleMs = () => this.owner
  ownerDraft = () => this.draft
  idleMs = (k: number) => (this.running.has(k) ? this.quiet : null)
  buffer = () => this.screen
}

describe('MasterGate', () => {
  let clock: number
  let store: Store
  let states: MasterStates
  let runs: MasterRuns
  let approvals: ApprovalMarker
  let sessions: FakeSessions
  let gate: MasterGate
  let crewId: number
  let masterId: number
  let starts: Array<{ resume: boolean }>
  let startError: string | null
  let hold: string

  const hook = (event: MasterHookEvent, extra: Partial<HookReport> = {}) =>
    states.hook(crewId, { event, sessionId: 's1', transcriptPath: '', source: 'startup', message: '', notificationType: '', agentId: '', agentType: '', ...extra })
  const newRun = () => store.createRun({ crewId, task: 'Add a health check', masterCli: 'claude', mode: 'master' }).id
  const run = (id: number) => store.getRun(id)!
  const lines = () => sessions.typed.map((t) => t.line)
  const kinds = (id: number) => store.listRunEvents(id).map((e) => e.kind)
  const live = () => {
    sessions.running.add(masterId)
    states.started(crewId, 'claude', 's1')
    hook('SessionStart')
  }
  const tick = (ms = 0) => {
    clock += ms
    gate.tick(crewId)
  }

  beforeEach(() => {
    clock = 1_700_000_000_000
    store = new Store(':memory:', () => clock)
    crewId = store.createCrew('shop', '/code/shop').id
    masterId = store.ensureMaster(crewId).id
    states = new MasterStates({ now: () => clock })
    approvals = new ApprovalMarker({ now: () => clock, inReview: (c) => store.listRuns(c).filter((r) => r.status === 'review').map((r) => r.id) })
    runs = new MasterRuns({ store, approvals }, () => clock)
    sessions = new FakeSessions()
    starts = []
    startError = null
    hold = ''
    let n = 0
    gate = new MasterGate({
      store,
      runs,
      states,
      sessions,
      masterKey: () => masterId,
      startMaster: (_crew, o) => {
        starts.push(o)
        if (startError) return startError
        sessions.running.add(masterId)
        states.started(crewId, 'claude', 's1')
        return null
      },
      hold: () => hold,
      now: () => clock,
      nonce: () => `n${++n}`,
    })
  })
  afterEach(() => store.close())

  it('types the next job as one fixed line when the Master is idle, and the job is working', () => {
    live()
    const id = newRun()
    tick()
    expect(lines()).toEqual([fixedLine('new', id)])
    expect(run(id).status).toBe('working')
    expect(store.listRunEvents(id)[0]).toMatchObject({ kind: 'delivered', source: 'system', body: JSON.stringify({ nonce: 'n1', line: 'new' }) })
    // The UserPromptSubmit with exactly that line is the acknowledgement; nothing more is typed.
    expect(gate.onPrompt(crewId, fixedLine('new', id))).toBe(true)
    hook('UserPromptSubmit')
    tick(20_000)
    expect(lines()).toHaveLength(1)
    // Any other prompt is the owner's.
    expect(gate.onPrompt(crewId, 'approve')).toBe(false)
  })

  it('types the owner-message pointer and Master commands only when idle, one line at a time, and starts a stopped Master for a message', () => {
    expect(gate.command(crewId, '/compact')).toBe('The Master is not running')
    expect(gate.ownerMessage(crewId)).toBeNull()
    expect(starts).toEqual([{ resume: true }])
    hook('SessionStart')
    live()
    hook('UserPromptSubmit')
    expect(gate.ownerMessage(crewId)).toBeNull()
    expect(gate.command(crewId, '/compact')).toBeNull()
    expect(gate.command(crewId, '/model opus')).toBe('That is not a Master command')
    tick()
    expect(lines()).toEqual([])
    hook('Stop')
    tick(2000)
    expect(lines()).toEqual([fixedLine('owner')])
    hook('UserPromptSubmit')
    hook('Stop')
    tick(2000)
    expect(lines()).toEqual([fixedLine('owner'), '/compact'])
  })

  it('holds the line while the Master is busy, the owner types or has a draft, or subagents run', () => {
    live()
    const id = newRun()
    hook('UserPromptSubmit')
    tick()
    hook('Stop')
    hook('SubagentStart', { agentType: 'operant-master:seat-dev' })
    hook('Stop')
    tick()
    hook('SubagentStop', { agentType: 'operant-master:seat-dev' })
    sessions.owner = 1000
    tick()
    sessions.owner = 5000
    sessions.draft = true
    tick()
    sessions.draft = false
    sessions.quiet = 200
    tick()
    hold = 'the daily cap is reached'
    sessions.quiet = 5000
    tick()
    expect(lines()).toEqual([])
    expect(run(id).status).toBe('queued')
    hold = ''
    tick()
    expect(lines()).toEqual([fixedLine('new', id)])
  })

  it('retypes once (clearing the input first) when the Master does not pick the line up, then gives up', () => {
    live()
    const id = newRun()
    tick()
    tick(7_000)
    expect(sessions.typed).toHaveLength(1)
    tick(1_000)
    expect(sessions.typed).toEqual([
      { line: fixedLine('new', id), clear: false },
      { line: fixedLine('new', id), clear: true },
    ])
    tick(8_000)
    expect(run(id)).toMatchObject({ status: 'needs-you', waiting: 'master', outcome: MSG.notPickedUp })
    expect(kinds(id)).toEqual(['delivered', 'retry', 'giveup'])
    tick(60_000)
    expect(sessions.typed).toHaveLength(2)
  })

  it('counts `operant run start` (or a busy OpenCode session) as the pickup', () => {
    live()
    const id = newRun()
    tick()
    clock += 2_000
    runs.start(id, crewId)
    tick(10_000)
    expect(sessions.typed).toHaveLength(1)
    expect(run(id).status).toBe('working')
  })

  it('starts a Master that is not running (once per job), waits for its first idle, then delivers', () => {
    const id = newRun()
    tick()
    expect(starts).toEqual([{ resume: false }])
    tick(1_000)
    expect(lines()).toEqual([])
    hook('SessionStart')
    tick()
    expect(lines()).toEqual([fixedLine('new', id)])
  })

  it('treats an OpenCode Master with a settled TUI as ready: it has no session (so no event) until the first line, and is not parked as "did not start"', () => {
    sessions.running.add(masterId)
    sessions.screen = 'x'.repeat(3000)
    states.started(crewId, 'opencode', null)
    sessions.quiet = 200
    const id = newRun()
    tick()
    expect(lines()).toEqual([])
    sessions.quiet = 10_000
    tick(10_000)
    expect(lines()).toEqual([fixedLine('new', id)])
    expect(run(id).status).toBe('working')
    tick(60_000)
    expect(run(id).waiting).not.toBe('master')
  })

  it('parks the job when the Master fails to start or never gets ready, without starting it again', () => {
    startError = 'claude is not on PATH'
    const a = newRun()
    tick()
    expect(run(a)).toMatchObject({ status: 'needs-you', waiting: 'master', outcome: `${MSG.didNotStart}: claude is not on PATH` })
    tick(1_000)
    expect(starts).toHaveLength(1)

    store.transitionRun(a, 'failed')
    startError = null
    const b = newRun()
    tick()
    expect(starts).toHaveLength(2)
    tick(60_000)
    expect(run(b)).toMatchObject({ status: 'needs-you', waiting: 'master', outcome: MSG.noSignOfLife })
    sessions.running.delete(masterId)
    states.exited(crewId)
    tick(1_000)
    expect(starts).toHaveLength(2)
    expect(sessions.typed).toEqual([])
  })

  it('moves the job to needs-you when the Master exits mid-task; Resume restarts it with --resume and types the resume line', () => {
    live()
    const id = newRun()
    tick()
    runs.start(id, crewId)
    sessions.running.delete(masterId)
    states.exited(crewId)
    tick()
    expect(run(id)).toMatchObject({ status: 'needs-you', waiting: 'master', outcome: MSG.stopped })
    tick(120_000)
    expect(starts).toEqual([])

    gate.resume(id)
    expect(starts).toEqual([{ resume: true }])
    hook('SessionStart', { source: 'resume' })
    tick()
    expect(lines()).toEqual([fixedLine('new', id), fixedLine('resume', id)])
    expect(run(id).status).toBe('working')
    expect(kinds(id)).toEqual(['delivered', 'resume', 'delivered'])
  })

  it('never types at a permission prompt: the job waits for the owner and works again afterwards', () => {
    live()
    const a = newRun()
    const b = newRun()
    tick()
    hook('UserPromptSubmit')
    hook('Notification', { notificationType: 'permission_prompt', message: 'Claude needs your permission to use Bash' })
    tick()
    expect(run(a)).toMatchObject({ status: 'needs-you', waiting: 'permission', outcome: MSG.permission })
    tick(30_000)
    expect(lines()).toEqual([fixedLine('new', a)])
    hook('Stop')
    tick()
    expect(run(a)).toMatchObject({ status: 'working', waiting: '' })
    expect(run(b).status).toBe('queued')
    expect(lines()).toHaveLength(1)
  })

  it('treats a long silence at a permission dialog on screen as a permission wait', () => {
    live()
    const id = newRun()
    tick()
    hook('UserPromptSubmit')
    sessions.screen = '\x1b[1mDo you want to proceed?\x1b[0m\n❯ 1. Yes\n  2. No'
    sessions.quiet = 200_000
    tick()
    expect(run(id)).toMatchObject({ status: 'needs-you', waiting: 'permission' })
    sessions.quiet = 0
    tick()
    expect(run(id).status).toBe('working')
  })

  it('frees the slot at review, puts a sent-back job first, and never delivers a job twice', () => {
    live()
    const a = newRun()
    const b = newRun()
    tick()
    runs.start(a, crewId)
    runs.review(a, 'Done: health check added', crewId)
    hook('UserPromptSubmit')
    hook('Stop')
    tick()
    expect(lines()).toEqual([fixedLine('new', a), fixedLine('new', b)])
    runs.start(b, crewId)
    runs.sendBack(a, 'Also log the result')
    const c = newRun()
    runs.review(b, 'Done', crewId)
    hook('UserPromptSubmit')
    hook('Stop')
    tick()
    tick()
    expect(lines()).toEqual([fixedLine('new', a), fixedLine('new', b), fixedLine('sent-back', a)])
    expect(run(c).status).toBe('queued')
    // The Master took the next job itself (operant run next, run start): the gate does not type it again.
    runs.start(a, crewId)
    runs.review(a, 'Done again', crewId)
    runs.start(c, crewId)
    hook('UserPromptSubmit')
    hook('Stop')
    tick(10_000)
    expect(lines()).toHaveLength(3)
  })

  it('types the answer, approved and stopped lines once each when idle', () => {
    live()
    const id = newRun()
    tick()
    runs.start(id, crewId)
    gate.onPrompt(crewId, fixedLine('new', id))
    gate.notify(crewId, 'answer', id)
    gate.notify(crewId, 'answer', id)
    tick()
    gate.onPrompt(crewId, fixedLine('answer', id))
    runs.review(id, 'Done', crewId)
    runs.approve(id, 'owner-ui')
    gate.notify(crewId, 'approved', id)
    tick()
    gate.onPrompt(crewId, fixedLine('approved', id))
    tick()
    const s = newRun()
    tick()
    store.transitionRun(s, 'failed')
    // Stopping drops the job's pending line; the stop line goes out instead.
    gate.notify(crewId, 'stopped', s)
    gate.onPrompt(crewId, fixedLine('stopped', s))
    tick(20_000)
    expect(lines()).toEqual([fixedLine('new', id), fixedLine('answer', id), fixedLine('approved', id), fixedLine('new', s), fixedLine('stopped', s)])
  })

  it('after a restart keeps a job with a live Master working and parks one whose Master is gone', () => {
    const a = newRun()
    store.setRunStatus(a, 'working')
    gate.recover()
    expect(run(a)).toMatchObject({ status: 'needs-you', waiting: 'master', outcome: MSG.closed })

    live()
    const b = newRun()
    store.transitionRun(a, 'failed')
    store.setRunStatus(b, 'working')
    gate.recover()
    expect(run(b).status).toBe('working')
    tick()
    expect(sessions.typed).toEqual([])
  })
})
