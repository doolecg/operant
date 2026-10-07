import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RUN_TRANSITIONS, type RunStatus } from '../shared/types'
import { MasterRegistry, type MasterAdapter, type MasterEvent, type MasterStart } from './master'
import { RunError, RunManager, checkLimits, tierOf, type RunNotice } from './runs'
import { MIGRATIONS, RunTransitionError, Store } from './store'

// An adapter whose jobs the test finishes by hand.
class FakeAdapter implements MasterAdapter {
  starts: MasterStart[] = []
  private ends: Array<(r: { ok: boolean; text: string }) => void> = []
  stopped: number[] = []
  failStart: string | null = null

  async start(o: MasterStart) {
    if (this.failStart) throw new Error(this.failStart)
    const i = this.starts.push(o) - 1
    let end!: (r: { ok: boolean; text: string }) => void
    const done = new Promise<{ ok: boolean; text: string }>((r) => (end = r))
    this.ends[i] = end
    return {
      done,
      stop: async () => {
        this.stopped.push(i)
        end({ ok: false, text: 'killed' })
      },
    }
  }
  finish(i: number, ok = true, text = 'all done') {
    this.ends[i]!({ ok, text })
  }
  emit(i: number, e: MasterEvent) {
    this.starts[i]!.onEvent(e)
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('run store', () => {
  let store: Store
  beforeEach(() => {
    store = new Store(':memory:', () => 5_000)
  })
  afterEach(() => store.close())

  it('numbers runs from 20001 and never reuses a number', () => {
    const crew = store.createCrew('a', '/a')
    const first = store.createRun({ crewId: crew.id, task: 't', masterCli: 'claude' })
    expect(first.id).toBe(20001)
    const second = store.createRun({ crewId: crew.id, task: 't', masterCli: 'claude' })
    store.db.prepare('DELETE FROM runs WHERE id = ?').run(second.id)
    expect(store.createRun({ crewId: crew.id, task: 't', masterCli: 'claude' }).id).toBe(20003)
  })

  it('allows only the listed status transitions', () => {
    const crew = store.createCrew('a', '/a')
    const statuses = Object.keys(RUN_TRANSITIONS) as RunStatus[]
    for (const from of statuses) {
      for (const to of statuses) {
        const run = store.createRun({ crewId: crew.id, task: 't', masterCli: 'claude' })
        store.db.prepare('UPDATE runs SET status = ? WHERE id = ?').run(from, run.id)
        if (RUN_TRANSITIONS[from].includes(to)) expect(store.setRunStatus(run.id, to).status).toBe(to)
        else expect(() => store.setRunStatus(run.id, to), `${from} -> ${to}`).toThrow(RunTransitionError)
      }
    }
  })

  it('stamps started_at on the first working and finished_at on the end, and stores the outcome', () => {
    const crew = store.createCrew('a', '/a')
    const run = store.createRun({ crewId: crew.id, task: 't', masterCli: 'claude' })
    expect(run).toMatchObject({ status: 'queued', startedAt: null, finishedAt: null, outcome: '' })
    expect(store.setRunStatus(run.id, 'working')).toMatchObject({ startedAt: 5_000, finishedAt: null })
    const done = store.setRunStatus(run.id, 'done', 'It worked')
    expect(done).toMatchObject({ status: 'done', outcome: 'It worked', finishedAt: 5_000 })
  })

  it('keeps a run when its team is deleted, and lists its agents', () => {
    const crew = store.createCrew('a', '/a')
    const team = store.createTeam({ name: 't' })
    const run = store.createRun({ crewId: crew.id, task: 't', masterCli: 'opencode', teamId: team.id })
    store.addJobAgent(run.id, { seat: 'implementor', model: 'claude-sonnet-5-5' })
    store.deleteTeam(team.id)
    expect(store.getRun(run.id)!.teamId).toBeNull()
    expect(store.listJobAgents(run.id).map((a) => [a.seat, a.status])).toEqual([['implementor', 'working']])
  })
})

describe('teams, seats and projects', () => {
  let store: Store
  beforeEach(() => {
    store = new Store(':memory:', () => 5_000)
  })
  afterEach(() => store.close())

  it('creates, edits and deletes a team', () => {
    const team = store.createTeam({ name: 'crew', seats: [{ presetId: 1, count: 2, model: 'claude-sonnet-5-5' }], rules: 'be nice' })
    expect(team.limits).toEqual({ maxWorkers: 0, topTier: '', tokenBudget: 0 })
    const edited = store.updateTeam(team.id, { name: 'crew2', limits: { maxWorkers: 3, topTier: 'sonnet', tokenBudget: 100 } })
    expect(edited).toMatchObject({ name: 'crew2', rules: 'be nice', limits: { maxWorkers: 3, topTier: 'sonnet', tokenBudget: 100 } })
    expect(store.listTeams().filter((t) => !t.builtin)).toHaveLength(1)
    store.deleteTeam(team.id)
    expect(store.getTeam(team.id)).toBeNull()
    expect(() => store.updateTeam(team.id, { name: 'x' })).toThrow(/not found/)
  })

  it('saves and reloads the new preset fields, defaulting them on', () => {
    const plain = store.createPreset({ name: 'plain', agent: 'claude', model: 'sonnet', permissionMode: 'dontAsk' })
    expect(plain).toMatchObject({ skills: [], hindsight: true, codegraph: true })
    const seat = store.createPreset({ name: 'seat', agent: 'opencode', model: 'm', permissionMode: 'dontAsk', skills: ['a', 'b'], hindsight: false, codegraph: false })
    expect(store.getPreset(seat.id)).toMatchObject({ agent: 'opencode', skills: ['a', 'b'], hindsight: false, codegraph: false })
    const updated = store.updatePreset(seat.id, { skills: ['c'], codegraph: true })
    expect(updated).toMatchObject({ skills: ['c'], hindsight: false, codegraph: true })
    expect(store.duplicatePreset(seat.id)).toMatchObject({ skills: ['c'], hindsight: false, codegraph: true })
    expect(store.listPresets().filter((p) => p.builtin).every((p) => p.skills.length === 0 && p.hindsight && p.codegraph)).toBe(true)
  })

  it('gives each project a stable PRJ# and a saved order', () => {
    const a = store.createCrew('a', '/a')
    const b = store.createCrew('b', '/b')
    const c = store.createCrew('c', '/c')
    expect([a.prjNumber, b.prjNumber, c.prjNumber]).toEqual([1001, 1002, 1003])
    store.deleteCrew(c.id)
    expect(store.createCrew('d', '/d').prjNumber).toBe(1004)
    const order = store.reorderCrews([b.id, a.id]).sort((x, y) => x.sortOrder - y.sortOrder)
    expect(order.map((x) => x.name)).toEqual(['b', 'a', 'd'])
    expect(store.updateCrew(a.id, { discordChannels: ['12345'] }).discordChannels).toEqual(['12345'])
  })
})

describe('migration 7', () => {
  it('upgrades a v6 database without changing existing data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'operant-mig7-'))
    try {
      const file = join(dir, 'v6.db')
      const raw = new DatabaseSync(file)
      raw.exec(MIGRATIONS.slice(0, 6).join('\n'))
      raw.exec('PRAGMA user_version = 6')
      raw.exec(`INSERT INTO crews (id, name, folder, created_at) VALUES (4, 'shop', '/s', 5), (9, 'other', '/o', 6);
        INSERT INTO presets (id, name, agent, model, permission_mode, updated_at) VALUES (3, 'mine', 'claude', 'opus', 'dontAsk', 7);
        INSERT INTO squads (id, crew_id, name) VALUES (1, 4, 'dev');
        INSERT INTO operators (id, squad_id, role, agent, model) VALUES (7, 1, 'lead', 'claude', 'opus');
        INSERT INTO jobs (id, crew_id, title, state, created_at, updated_at) VALUES (3, 4, 'board job', 'doing', 10, 11)`)
      raw.close()
      const s = new Store(file)
      try {
        expect(s.schemaVersion).toBe(MIGRATIONS.length)
        expect(s.listCrews().map((c) => [c.id, c.name, c.folder, c.prjNumber, c.sortOrder, c.discordChannels])).toEqual([
          [4, 'shop', '/s', 1001, 4, []],
          [9, 'other', '/o', 1002, 9, []],
        ])
        expect(s.getPreset(3)).toMatchObject({ name: 'mine', agent: 'claude', model: 'opus', skills: [], hindsight: true, codegraph: true })
        expect(s.listJobs(4).map((j) => [j.id, j.title, j.state])).toEqual([[3, 'board job', 'doing']])
        expect(s.getOperator(7)!.role).toBe('lead')
        expect(s.createCrew('new', '/n').prjNumber).toBe(1003)
        expect(s.createRun({ crewId: 4, task: 't', masterCli: 'claude' }).id).toBe(20001)
      } finally {
        s.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('limits', () => {
  it('ranks model tiers', () => {
    expect(tierOf('claude-opus-5-5')).toBe('opus')
    expect(tierOf('claude-haiku-4-5')).toBe('haiku')
    expect(tierOf('gpt-5')).toBeNull()
  })

  it('refuses too many workers and a model above the top tier', () => {
    const seats = [
      { presetId: 1, count: 2, model: 'claude-sonnet-5-5' },
      { presetId: 2, count: 2, model: 'claude-haiku-4-5' },
    ]
    expect(() => checkLimits(seats, { maxWorkers: 3, topTier: '', tokenBudget: 0 })).toThrow(/allows 3 workers and the run asks for 4/)
    expect(() => checkLimits(seats, { maxWorkers: 4, topTier: 'haiku', tokenBudget: 0 })).toThrow(/above this team's top tier/)
    expect(() => checkLimits(seats, { maxWorkers: 4, topTier: 'sonnet', tokenBudget: 0 })).not.toThrow()
    expect(() => checkLimits(seats, { maxWorkers: 0, topTier: '', tokenBudget: 0 })).not.toThrow()
  })
})

describe('RunManager', () => {
  let store: Store
  let adapter: FakeAdapter
  let manager: RunManager
  let notices: RunNotice[]
  let crewId: number
  let other: number

  beforeEach(() => {
    store = new Store(':memory:')
    adapter = new FakeAdapter()
    notices = []
    manager = new RunManager({
      store,
      adapters: new MasterRegistry().register('claude', adapter).register('opencode', adapter),
      onChange: (n) => notices.push(n),
    })
    crewId = store.createCrew('a', '/work/a').id
    other = store.createCrew('b', '/work/b').id
  })
  afterEach(() => store.close())

  const submit = (task = 'do it', over: Partial<Parameters<RunManager['submit']>[0]> = {}) =>
    manager.submit({ crewId, task, masterCli: 'claude', ...over })
  const statuses = () => store.listRuns(crewId).map((r) => r.status)

  it('starts the first job at once and queues the second', async () => {
    const a = submit('one')
    const b = submit('two')
    await tick()
    expect(statuses()).toEqual(['working', 'queued'])
    expect(adapter.starts).toHaveLength(1)
    expect(adapter.starts[0]).toMatchObject({ cwd: '/work/a', prompt: 'one' })
    expect(store.getRun(a.id)!.startedAt).not.toBeNull()
    expect(store.getRun(b.id)!.startedAt).toBeNull()
  })

  it('hands the Master slot effort to the adapter and keeps a seat effort', async () => {
    const preset = store.createPreset({ name: 'p', agent: 'claude', model: 'claude-sonnet-5-5', permissionMode: 'dontAsk' })
    const master = store.ensureMaster(crewId)
    store.db.prepare('UPDATE operators SET model = ?, effort = ? WHERE id = ?').run('claude-opus-5-5', 'high', master.id)
    const run = submit('one', { seats: [{ presetId: preset.id, count: 1, model: 'claude-sonnet-5-5', effort: 'low' }, { presetId: preset.id, count: 1, model: 'x' }] })
    await tick()
    expect(adapter.starts[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
    expect(run.seats).toEqual([
      { presetId: preset.id, count: 1, model: 'claude-sonnet-5-5', effort: 'low' },
      { presetId: preset.id, count: 1, model: 'x' },
    ])
    expect(adapter.starts[0]!.prompt).toContain('(effort low)')
  })

  it('starts the next queued job in order when one finishes', async () => {
    submit('one')
    submit('two')
    submit('three')
    await tick()
    adapter.finish(0, true, 'first outcome')
    await tick()
    expect(statuses()).toEqual(['done', 'working', 'queued'])
    expect(store.listRuns(crewId)[0]).toMatchObject({ outcome: 'first outcome' })
    expect(adapter.starts.map((s) => s.prompt)).toEqual(['one', 'two'])
    adapter.finish(1, false, 'broke')
    await tick()
    expect(statuses()).toEqual(['done', 'failed', 'working'])
    expect(adapter.starts.map((s) => s.prompt)).toEqual(['one', 'two', 'three'])
  })

  it('stopping a working job fails it and starts the next', async () => {
    const a = submit('one')
    submit('two')
    await tick()
    const stopped = await manager.stop(a.id)
    await tick()
    expect(stopped).toMatchObject({ status: 'failed', outcome: 'Stopped by you' })
    expect(adapter.stopped).toEqual([0])
    expect(statuses()).toEqual(['failed', 'working'])
    expect(store.getRun(a.id)!.outcome).toBe('Stopped by you')
  })

  it('cancels a queued job without starting it', async () => {
    submit('one')
    const b = submit('two')
    await tick()
    await manager.stop(b.id)
    expect(store.getRun(b.id)).toMatchObject({ status: 'failed', outcome: 'Cancelled before it started' })
    expect(adapter.starts).toHaveLength(1)
    await expect(manager.stop(b.id)).rejects.toThrow(RunError)
  })

  it('keeps projects independent', async () => {
    submit('one')
    manager.submit({ crewId: other, task: 'elsewhere', masterCli: 'claude' })
    await tick()
    expect(adapter.starts.map((s) => s.cwd)).toEqual(['/work/a', '/work/b'])
  })

  it('honours the concurrency limit and applies a raised limit at once', async () => {
    expect(manager.concurrency).toBe(1)
    submit('one')
    submit('two')
    submit('three')
    await tick()
    expect(statuses()).toEqual(['working', 'queued', 'queued'])
    manager.setConcurrency(2)
    await tick()
    expect(statuses()).toEqual(['working', 'working', 'queued'])
    expect(() => manager.setConcurrency(0)).toThrow(RunError)
    expect(manager.concurrency).toBe(2)
  })

  it('moves to needs-you and back on events, still holding its slot', async () => {
    const a = submit('one')
    submit('two')
    await tick()
    adapter.emit(0, { kind: 'needs-you', text: 'Which database?' })
    expect(store.getRun(a.id)).toMatchObject({ status: 'needs-you', outcome: 'Which database?' })
    expect(statuses()).toEqual(['needs-you', 'queued'])
    adapter.emit(0, { kind: 'working' })
    expect(store.getRun(a.id)!.status).toBe('working')
    adapter.emit(0, { kind: 'working' })
    expect(store.getRun(a.id)!.status).toBe('working')
  })

  it('fails a job whose adapter cannot start and moves on', async () => {
    adapter.failStart = 'no binary'
    const a = submit('one')
    await tick()
    adapter.failStart = null
    expect(store.getRun(a.id)).toMatchObject({ status: 'failed', outcome: 'no binary' })
    submit('two')
    await tick()
    expect(statuses()).toEqual(['failed', 'working'])
  })

  it('refuses a run over its team limits with a clear error, and stores nothing', () => {
    const preset = store.listPresets()[0]!
    const team = store.createTeam({ name: 't', limits: { maxWorkers: 2, topTier: 'sonnet', tokenBudget: 0 } })
    expect(() => submit('x', { teamId: team.id, seats: [{ presetId: preset.id, count: 3, model: 'claude-sonnet-5-5' }] })).toThrow(/allows 2 workers and the run asks for 3/)
    expect(() => submit('x', { teamId: team.id, seats: [{ presetId: preset.id, count: 1, model: 'claude-opus-5-5' }] })).toThrow(/top tier/)
    expect(store.listRuns()).toEqual([])
    const ok = submit('x', { teamId: team.id, seats: [{ presetId: preset.id, count: 2, model: 'claude-sonnet-5-5' }] })
    expect(ok.seats).toEqual([{ presetId: preset.id, count: 2, model: 'claude-sonnet-5-5' }])
    expect(ok.limits.maxWorkers).toBe(2)
  })

  it('uses the team seats when none are given, and rejects bad input', () => {
    const preset = store.listPresets()[0]!
    const team = store.createTeam({ name: 't', seats: [{ presetId: preset.id, count: 1, model: 'claude-haiku-4-5' }], rules: 'r' })
    expect(submit('x', { teamId: team.id })).toMatchObject({ teamId: team.id, rules: 'r', seats: [{ count: 1, model: 'claude-haiku-4-5' }] })
    expect(() => submit('   ')).toThrow(/task/)
    expect(() => submit('x', { masterCli: 'codex' as never })).toThrow(/claude or opencode/)
    expect(() => submit('x', { teamId: 999 })).toThrow(/not found/)
    expect(() => manager.submit({ crewId: 999, task: 'x', masterCli: 'claude' })).toThrow(/not found/)
    const codex = store.createPreset({ name: 'cx', agent: 'codex', model: 'gpt-5', permissionMode: 'dontAsk' })
    expect(() => submit('x', { seats: [{ presetId: codex.id, count: 1, model: 'gpt-5' }] })).toThrow(/claude or opencode/)
    expect(() => submit('x', { seats: [{ presetId: preset.id, count: 0, model: 'sonnet' }] })).toThrow(/count/)
  })

  it('notifies on creation and every status change', async () => {
    const a = submit('one')
    await tick()
    adapter.finish(0)
    await tick()
    expect(notices.filter((n) => n.runId === a.id).map((n) => n.status)).toEqual(['queued', 'working', 'done'])
  })

  it('interruptAll ends working jobs as interrupted at once and starts nothing more', async () => {
    const a = submit('one')
    const b = submit('two')
    await tick()
    manager.interruptAll()
    expect(store.getRun(a.id)).toMatchObject({ status: 'failed', outcome: 'Interrupted: Operant was closed while it ran' })
    await tick()
    expect(store.getRun(b.id)!.status).toBe('queued')
    expect(adapter.starts).toHaveLength(1)
    expect(adapter.stopped).toEqual([0])
  })

  it('recovers jobs left running by a previous process and starts the queue', async () => {
    const stale = store.createRun({ crewId, task: 'stale', masterCli: 'claude' })
    store.setRunStatus(stale.id, 'working')
    const waiting = store.createRun({ crewId, task: 'waiting', masterCli: 'claude' })
    manager.recover()
    await tick()
    expect(store.getRun(stale.id)).toMatchObject({ status: 'failed' })
    expect(store.getRun(waiting.id)!.status).toBe('working')
  })

  it('hands the project Master permission mode to the adapter, or nothing when it has none', async () => {
    submit('one')
    await tick()
    expect(adapter.starts[0]!.permissionMode).toBeUndefined()
    adapter.finish(0)
    await tick()
    const master = store.ensureMaster(crewId)
    store.setOperatorLaunch(master.id, { permissionMode: 'bypassPermissions' })
    submit('two')
    await tick()
    expect(adapter.starts[1]!.permissionMode).toBe('bypassPermissions')
  })

  it('does not touch the board jobs', () => {
    const job = store.createJob({ crewId, title: 'board' })
    submit('one')
    expect(store.getJob(job.id)).toMatchObject({ id: job.id, state: 'todo' })
  })
})

describe('run edit, delete and Master choice', () => {
  let store: Store
  let adapter: FakeAdapter
  let mgr: RunManager
  let crewId: number
  beforeEach(() => {
    store = new Store(':memory:')
    adapter = new FakeAdapter()
    mgr = new RunManager({ store, adapters: new MasterRegistry().register('claude', adapter), brief: (r) => r.task })
    crewId = store.createCrew('a', '/a').id
  })
  afterEach(() => store.close())

  it('edits the task of a queued run only', async () => {
    const first = mgr.submit({ crewId, task: 'one', masterCli: 'claude' })
    const queued = mgr.submit({ crewId, task: 'two', masterCli: 'claude' })
    expect(queued.status).toBe('queued')
    expect(mgr.update(queued.id, { task: '  two, better ' }).task).toBe('two, better')
    expect(() => mgr.update(queued.id, { task: ' ' })).toThrow(/cannot be empty/)
    expect(() => mgr.update(first.id, { task: 'x' })).toThrow(RunError)
    expect(() => mgr.update(999, { task: 'x' })).toThrow(/not found/)
    await tick()
    adapter.finish(0)
    await tick()
    expect(store.getRun(queued.id)!.task).toBe('two, better')
    expect(adapter.starts[1]!.prompt).toBe('two, better')
  })

  it('deletes finished runs with their agents and refuses queued or working ones', async () => {
    const a = mgr.submit({ crewId, task: 'one', masterCli: 'claude' })
    const b = mgr.submit({ crewId, task: 'two', masterCli: 'claude' })
    await tick()
    expect(() => mgr.remove(a.id)).toThrow(/stop it before deleting/)
    expect(() => mgr.remove(b.id)).toThrow(/queued/)
    store.addJobAgent(a.id, { seat: 's' })
    adapter.finish(0)
    await tick()
    mgr.remove(a.id)
    expect(store.getRun(a.id)).toBeNull()
    expect(store.listJobAgents(a.id)).toEqual([])
    expect(() => mgr.remove(a.id)).toThrow(/not found/)
  })

  it('passes the run Master model and effort to the adapter and validates them', async () => {
    mgr.submit({ crewId, task: 't', masterCli: 'claude', masterModel: 'claude-opus-5-5', masterEffort: 'high' })
    await tick()
    expect(adapter.starts[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
    expect(store.listRuns(crewId)[0]).toMatchObject({ masterModel: 'claude-opus-5-5', masterEffort: 'high' })
    expect(() => mgr.submit({ crewId, task: 't', masterCli: 'claude', masterModel: 'bad model!' })).toThrow(RunError)
    expect(() => mgr.submit({ crewId, task: 't', masterCli: 'claude', masterEffort: 'extreme' })).toThrow(RunError)
  })
})

describe('team token budget', () => {
  let store: Store
  let adapter: FakeAdapter
  let manager: RunManager
  let tokens: Record<number, number>
  let crewId: number

  beforeEach(() => {
    store = new Store(':memory:')
    adapter = new FakeAdapter()
    tokens = {}
    manager = new RunManager({
      store,
      adapters: new MasterRegistry().register('claude', adapter).register('opencode', adapter),
      runTokens: (run) => tokens[run.id] ?? 0,
    })
    crewId = store.createCrew('a', '/work/a').id
  })
  afterEach(() => store.close())

  const submitWith = (tokenBudget: number) => {
    const team = store.createTeam({ name: `t${tokenBudget}`, limits: { maxWorkers: 0, topTier: '', tokenBudget } })
    return manager.submit({ crewId, task: 'do it', masterCli: 'claude', teamId: team.id })
  }

  it('stops a working run over its budget with a clear outcome and starts the next', async () => {
    const run = submitWith(1000)
    const next = manager.submit({ crewId, task: 'next', masterCli: 'claude' })
    await tick()
    tokens[run.id] = 1000
    expect(manager.enforceTokenBudgets()).toEqual([])
    tokens[run.id] = 1001
    expect(manager.enforceTokenBudgets()).toEqual([run.id])
    await tick()
    expect(store.getRun(run.id)).toMatchObject({ status: 'failed', outcome: "Stopped: the job used 1,001 tokens, over its team's budget of 1,000" })
    expect(adapter.stopped).toEqual([0])
    expect(store.getRun(next.id)!.status).toBe('working')
  })

  it('never stops a run whose team set no budget, a queued run, or an ended run', async () => {
    const free = submitWith(0)
    tokens[free.id] = 9_999_999
    const plain = manager.submit({ crewId, task: 'plain', masterCli: 'claude' })
    tokens[plain.id] = 9_999_999
    await tick()
    expect(manager.enforceTokenBudgets()).toEqual([])
    const capped = submitWith(5)
    tokens[capped.id] = 50
    expect(store.getRun(capped.id)!.status).toBe('queued')
    expect(manager.enforceTokenBudgets()).toEqual([])
  })

  it('does not stop the same run twice', async () => {
    const run = submitWith(10)
    await tick()
    tokens[run.id] = 11
    expect(manager.enforceTokenBudgets()).toEqual([run.id])
    expect(manager.enforceTokenBudgets()).toEqual([])
    await tick()
    expect(manager.enforceTokenBudgets()).toEqual([])
  })
})
