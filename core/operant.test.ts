import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcEvents } from '../shared/ipc'
import type { IndexStatus, CrewIndexes } from './codegraph'
import { CORE_CHANNELS } from '../shared/ipc'
import { Operant, OperantError, type CliAccess, type Scheduler } from './operant'
import { MemorySecretStore } from './discord-secrets'
import type { Purger } from './purge'
import { SessionManager, type Pty, type PtyFactory } from './sessions'
import { Store } from './store'

class FakePty implements Pty {
  written: string[] = []
  killed = false
  exit: (e: { exitCode: number }) => void = () => {}
  data: (d: string) => void = () => {}
  constructor(
    readonly file = '',
    readonly opts: { cwd: string; env: Record<string, string> } = { cwd: '', env: {} },
  ) {}
  write(d: string) {
    this.written.push(d)
  }
  resize() {}
  kill() {
    this.killed = true
    this.exit({ exitCode: 0 })
  }
  onData(cb: (d: string) => void) {
    this.data = cb
  }
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exit = cb
  }
}

class FakeCli implements CliAccess {
  address = '/tmp/operant-test.sock'
  issued: number[] = []
  revoked: number[] = []
  listened = 0
  closed = 0
  async listen() {
    this.listened++
    return this.address
  }
  issueToken(id: number) {
    this.issued.push(id)
    return `token-${id}`
  }
  revokeToken(id: number) {
    this.revoked.push(id)
  }
  async close() {
    this.closed++
  }
}

class FakeScheduler implements Scheduler {
  jobs: Array<{ fn: () => void; ms: number; cancelled: boolean }> = []
  every(fn: () => void, ms: number) {
    const job = { fn, ms, cancelled: false }
    this.jobs.push(job)
    return job
  }
  cancel(h: unknown) {
    ;(h as { cancelled: boolean }).cancelled = true
  }
  run(ms: number) {
    this.jobs.find((j) => j.ms === ms)!.fn()
  }
}

const PUSH_NAMES = [
  'event',
  'operator:data',
  'operator:status',
  'operator:config',
  'scratch:data',
  'scratch:exit',
  'index:status',
  'usage',
  'caps',
  'message',
  'unread',
  'job',
  'purge',
  'settings',
] as const

const idle: IndexStatus = { initialized: false, indexing: false, files: 0, symbols: 0, edges: 0 }
const fakeIndexes = { status: () => idle, index: async () => ({ ...idle, initialized: true, files: 3 }) } as unknown as CrewIndexes
const indexedIndexes = { status: () => ({ ...idle, initialized: true }), index: async () => idle } as unknown as CrewIndexes

const assistantLine = (id: string, output: number, input = 0, cacheRead = 0) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: { id, model: 'claude-opus-5-5', usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead } },
  }) + '\n'

describe('Operant', () => {
  let store: Store
  let ptys: FakePty[]
  let op: Operant
  let cli: FakeCli
  let scheduler: FakeScheduler
  let sessions: SessionManager
  let pushed: Array<{ name: keyof IpcEvents; payload: unknown }>
  let transcripts: string
  let written: Array<{ path: string; content: string }>
  let clock: number
  let codegraphOnPath: boolean
  let failSpawn: boolean

  const build = (over: Partial<ConstructorParameters<typeof Operant>[0]> = {}) =>
    new Operant({
      store,
      sessions,
      indexes: fakeIndexes,
      pluginDir: '/plugin',
      now: () => clock,
      transcriptFile: (_cwd, id) => join(transcripts, `${id}.jsonl`),
      cliServer: () => cli,
      scheduler,
      learnModel: async () => '[]',
      launch: {
        platform: 'linux',
        launchDir: '/data/launch',
        rolesDir: '/data/roles',
        cliDir: '/app/cli',
        operantNode: '/app/operant',
        baseEnv: { PATH: '/usr/bin' },
        readRole: (file) => (file === '_common.md' ? 'COMMON' : `ROLE:${file}`),
        writer: { mkdir: () => {}, writeFile: (path, content) => void written.push({ path, content }) },
        codegraphOnPath: () => codegraphOnPath,
      },
      ...over,
    })

  beforeEach(() => {
    clock = Date.now()
    transcripts = mkdtempSync(join(tmpdir(), 'operant-tx-'))
    store = new Store(':memory:', () => clock)
    ptys = []
    written = []
    codegraphOnPath = false
    failSpawn = false
    cli = new FakeCli()
    scheduler = new FakeScheduler()
    const spawn: PtyFactory = (file, _args, opts) => {
      if (failSpawn) throw new Error('spawn failed')
      const p = new FakePty(file, opts)
      ptys.push(p)
      return p
    }
    sessions = new SessionManager(spawn, undefined, () => clock)
    op = build()
    pushed = []
    for (const name of PUSH_NAMES)
      op.on(name, (payload) => pushed.push({ name, payload }))
  })
  afterEach(() => {
    store.close()
    rmSync(transcripts, { recursive: true, force: true })
  })

  async function seedOperator() {
    const h = op.handlers
    const crew = await h['crews:create']({ name: ' shop ', folder: '/code/shop' })
    const squad = await h['squads:create']({ crewId: crew.id, name: 'dev' })
    const operator = await h['operators:create']({ squadId: squad.id, role: 'lead', agent: 'claude', model: 'opus' })
    return { crew, squad, operator }
  }
  const sessionIdOf = (pty: FakePty) => /--session-id (\S+)/.exec(pty.written[0]!)![1]!

  it('creates a crew with squads and operators and logs events', async () => {
    const { crew } = await seedOperator()
    expect(crew.name).toBe('shop')
    const messages = store.recentEvents(10).map((e) => e.message)
    expect(messages).toEqual(['Operator lead@shop added', 'Squad dev added', 'Project shop created'])
    expect(store.recentEvents(10).every((e) => e.crewId === crew.id)).toBe(true)
  })

  it('issues a token, builds the launch line and the session env, then stops and revokes on exit', async () => {
    const { operator } = await seedOperator()
    await op.start()
    await op.handlers['operators:start'](operator.id)
    expect(ptys).toHaveLength(1)
    const line = ptys[0]!.written[0]!
    expect(line).toMatch(/^claude --model opus --permission-mode acceptEdits --settings \/data\/launch\/op-\d+\.json --append-system-prompt-file \/data\/roles\/op\d+-[0-9a-f]{12}\.md /)
    expect(line).toContain('--strict-mcp-config --mcp-config /data/launch/crew-')
    expect(line).toContain('--plugin-dir /plugin --session-id ')
    expect(line.endsWith('\r')).toBe(true)
    expect(store.getOperator(operator.id)!.status).toBe('running')
    expect(store.getOperator(operator.id)!.sessionId).toBe(sessionIdOf(ptys[0]!))

    const env = ptys[0]!.opts.env
    expect(cli.issued).toEqual([operator.id])
    expect(env.OPERANT_TOKEN).toBe(`token-${operator.id}`)
    expect(env.OPERANT_SOCKET).toBe(cli.address)
    expect(env.OPERANT_NODE).toBe('/app/operant')
    expect(env.OPERANT_OPERATOR).toBe('lead@shop')
    expect(env.PATH).toBe('/app/cli:/usr/bin')
    expect(env.DISABLE_AUTOUPDATER).toBe('1')
    // Free text never reaches the command line: the role text is in a file.
    expect(written.some((f) => f.path.startsWith('/data/roles/') && f.content.startsWith('COMMON'))).toBe(true)
    expect(JSON.parse(written.find((f) => f.path.endsWith('-mcp.json'))!.content)).toEqual({ mcpServers: {} })

    ptys[0]!.data('hi')
    expect(pushed).toContainEqual({ name: 'operator:data', payload: { operatorId: operator.id, data: 'hi' } })
    expect(await op.handlers['operators:buffer'](operator.id)).toBe('hi')

    await op.handlers['operators:stop'](operator.id)
    expect(cli.revoked).toEqual([operator.id])
    expect(store.getOperator(operator.id)!.status).toBe('stopped')
    expect(pushed.filter((p) => p.name === 'operator:status').map((p) => p.payload)).toEqual([
      { operatorId: operator.id, status: 'running' },
      { operatorId: operator.id, status: 'stopped' },
    ])
  })

  it('starts without a CLI when the socket is not open and leaves no token behind', async () => {
    cli.address = ''
    const { operator } = await seedOperator()
    await op.handlers['operators:start'](operator.id)
    expect(cli.issued).toEqual([])
    expect(ptys[0]!.opts.env.OPERANT_TOKEN).toBeUndefined()
    expect(ptys[0]!.opts.env.OPERANT_SOCKET).toBeUndefined()
  })

  it('uses the preset role file and offers CodeGraph only when it is on PATH and the crew is indexed', async () => {
    const { squad } = await seedOperator()
    const pm = store.getPresetByBuiltin('pm')!
    const planner = store.createOperatorFromPreset(squad.id, 'planner', pm.id)
    await op.handlers['operators:start'](planner.id)
    const role = written.find((f) => f.path.startsWith('/data/roles/pm-'))!
    expect(role.content).toBe('COMMON\n\nROLE:project-manager.md\n')
    expect(JSON.parse(written.find((f) => f.path.endsWith('-mcp.json'))!.content)).toEqual({ mcpServers: {} })

    codegraphOnPath = true
    const indexed = build({ indexes: indexedIndexes, sessions: new SessionManager((f, _a, o) => new FakePty(f, o), undefined, () => clock) })
    written.length = 0
    store.setOperatorStatus(planner.id, 'stopped')
    indexed.startOperator(planner.id)
    const mcp = JSON.parse(written.find((f) => f.path.endsWith('-mcp.json'))!.content)
    expect(mcp.mcpServers.codegraph).toEqual({ command: 'codegraph', args: ['serve', '--mcp'] })
  })

  it('marks an operator as error when its shell exits non-zero', async () => {
    const { operator } = await seedOperator()
    await op.handlers['operators:start'](operator.id)
    ptys[0]!.exit({ exitCode: 1 })
    expect(store.getOperator(operator.id)!.status).toBe('error')
  })

  it('reports a failed launch as an error event without a token', async () => {
    const { operator } = await seedOperator()
    store.setOperatorLaunch(operator.id, { permissionMode: 'auto' })
    await op.handlers['operators:start'](operator.id)
    expect(ptys).toHaveLength(0)
    expect(store.getOperator(operator.id)!.status).toBe('error')
    expect(store.recentEvents(5)[0]!.message).toContain('failed to start')
    expect(cli.revoked).toEqual([operator.id])
  })

  it('does not start a deleted operator', async () => {
    const { operator } = await seedOperator()
    store.deleteOperator(operator.id)
    await op.handlers['operators:start'](operator.id)
    expect(ptys).toHaveLength(0)
    expect(cli.issued).toEqual([])
  })

  it('releases the jobs of an exited operator back to todo, keeping them across a restart', async () => {
    const { crew, operator } = await seedOperator()
    await op.handlers['operators:start'](operator.id)
    const job = op.jobs.create({ kind: 'user' }, { crewId: crew.id, title: 'work' })
    op.jobs.claim({ kind: 'operator', id: operator.id }, job.id)
    expect(store.getJob(job.id)!.state).toBe('doing')

    await op.restartOperator(operator.id)
    expect(ptys).toHaveLength(2)
    expect(store.getJob(job.id)!.state).toBe('doing')
    expect(store.getJob(job.id)!.assigneeId).toBe(operator.id)

    ptys[1]!.exit({ exitCode: 0 })
    expect(store.getJob(job.id)!.state).toBe('todo')
    expect(store.getJob(job.id)!.assigneeId).toBeNull()
    expect(cli.revoked).toEqual([operator.id, operator.id])
  })

  it('summarises operators, open tasks and spend for the dashboard', async () => {
    const { crew, operator } = await seedOperator()
    await op.handlers['operators:start'](operator.id)
    const t = await op.handlers['jobs:create']({ crewId: crew.id, title: 'A' })
    await op.handlers['jobs:create']({ crewId: crew.id, title: 'B' })
    await op.handlers['jobs:move'](t.id, { state: 'done' })
    store.addUsage({ operatorId: operator.id, at: clock, inputTokens: 1, outputTokens: 1, cacheTokens: 0, costUsd: 0.42 })
    expect(await op.handlers['dashboard:summary']()).toEqual({
      operatorsRunning: 1,
      operatorsTotal: 1,
      tasksOpen: 1,
      spendToday: 0.42,
      dailyBudgetUsd: 0,
    })
  })

  it('indexes a crew and pushes index status', async () => {
    const { crew } = await seedOperator()
    const status = await op.handlers['index:run'](crew.id)
    expect(status).toMatchObject({ initialized: true, files: 3 })
    const statuses = pushed.filter((p) => p.name === 'index:status').map((p) => (p.payload as { status: IndexStatus }).status)
    expect(statuses.map((s) => s.indexing)).toEqual([true, false])
  })

  it('records spend and context from a Claude operator transcript', async () => {
    const { crew, operator } = await seedOperator()
    await op.handlers['operators:start'](operator.id)
    const file = join(transcripts, `${sessionIdOf(ptys[0]!)}.jsonl`)

    op.pollUsage() // no transcript yet
    appendFileSync(file, assistantLine('m1', 100, 1_000, 9_000) + assistantLine('m1', 100, 1_000, 9_000) + assistantLine('m2', 50_000, 1_000, 9_000))
    op.pollUsage()

    // m1: 1000*4 + 100*20 + 9000*0.2 = 7800; m2: 4000 + 1_000_000 + 1800 = 1_005_800 (per million)
    expect((await op.handlers['dashboard:summary']()).spendToday).toBeCloseTo(1_013_600 / 1e6, 8)
    expect(await op.handlers['operators:context']()).toEqual({
      [operator.id]: expect.objectContaining({ model: 'claude-opus-5-5', contextTokens: 10_000 }),
    })
    expect(pushed.some((p) => p.name === 'usage')).toBe(true)

    const series = await op.handlers['usage:series'](crew.id)
    expect(series).toHaveLength(1)
    expect(series[0]!.buckets).toHaveLength(24)
    expect(series[0]!.buckets[23]).toBeCloseTo(series[0]!.total, 8)
  })

  it('does not follow transcripts for non-Claude operators', async () => {
    const { squad } = await seedOperator()
    const sh = await op.handlers['operators:create']({ squadId: squad.id, role: 'sh', agent: 'shell', model: '-' })
    await op.handlers['operators:start'](sh.id)
    expect(ptys[0]!.written).toEqual([])
    expect(cli.issued).toEqual([])
  })

  it('launches the Master Terminal with the model, effort and mode saved on its slot', async () => {
    const { crew } = await seedOperator()
    const master = store.ensureMaster(crew.id)
    await op.handlers['operators:applyChange'](master.id, { model: 'claude-opus-5-5', effort: 'high', permissionMode: 'plan' })
    op.startMaster(crew.id)
    expect(ptys[0]!.written[0]).toMatch(/^claude --model claude-opus-5-5 --effort high --permission-mode plan --plugin-dir \/plugin --session-id /)
    // A running Master restarts with the new setting.
    await op.handlers['operators:applyChange'](master.id, { permissionMode: '' })
    expect(ptys).toHaveLength(2)
    expect(ptys[1]!.written[0]).not.toContain('--permission-mode')
    expect(ptys[1]!.written[0]).toContain('--model claude-opus-5-5')
  })

  it('starts the Master Terminal without a preset or role file, with a token', async () => {
    const { crew } = await seedOperator()
    const master = op.startMaster(crew.id)
    expect(master.kind).toBe('master')
    expect(ptys[0]!.written[0]).toMatch(/^claude --plugin-dir \/plugin --session-id [0-9a-f-]{36}\r$/)
    expect(ptys[0]!.opts.env.OPERANT_TOKEN).toBe(`token-${master.id}`)
    expect(written).toEqual([])
  })

  it('persists settings, pushes them, and applies the shell override to new operators', async () => {
    const saved = await op.handlers['settings:set']({ shell: { file: '/bin/zsh', args: '-l -i' }, dailyBudgetUsd: 5 })
    expect(saved.shell).toEqual({ file: '/bin/zsh', args: '-l -i' })
    expect(store.getJson('settings')).toEqual(saved)
    expect(pushed.some((p) => p.name === 'settings')).toBe(true)
    expect((await op.handlers['dashboard:summary']()).dailyBudgetUsd).toBe(5)

    const spawned: Array<{ file: string; args: string[] }> = []
    const op2 = build({
      sessions: new SessionManager((file, args) => {
        spawned.push({ file, args })
        return new FakePty()
      }),
    })
    const { operator } = await seedOperator()
    await op2.handlers['operators:start'](operator.id)
    expect(spawned).toEqual([{ file: '/bin/zsh', args: ['-l', '-i'] }])
  })

  it('keeps permission rule text off the command line, with a PowerShell shell configured', async () => {
    await op.handlers['settings:set']({ shell: { file: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', args: '' } })
    const { squad } = await seedOperator()
    const hard = store.createOperator(squad.id, 'hard', 'claude', 'opus')
    store.setOperatorLaunch(hard.id, { permissionMode: 'acceptEdits', allow: ["Bash(it's *)"] })
    await op.handlers['operators:start'](hard.id)
    // The rule goes to a file; only the validated settings path is on the command line.
    expect(written.find((f) => f.path.includes('op-'))!.content).toContain("it's")
    expect(ptys[0]!.written[0]).not.toContain("it's")
  })

  describe('caps', () => {
    it('warns, then pauses without killing the session, nudging or letting it claim', async () => {
      await op.handlers['settings:set']({ tokens: { operatorDailyCapUsd: 0.5 } })
      const { crew, operator } = await seedOperator()
      await op.handlers['operators:start'](operator.id)
      const file = join(transcripts, `${sessionIdOf(ptys[0]!)}.jsonl`)
      const capEvents: unknown[] = []
      op.notices.on('cap', (d) => capEvents.push(d))

      appendFileSync(file, assistantLine('a', 20_000)) // $0.40 = 80%
      op.pollUsage()
      expect(store.recentEvents(50).filter((e) => e.kind === 'budget').map((e) => e.message)).toEqual(['lead@shop is at 80% ($0.40 of $0.50)'])
      expect(op.usage.caps.isPaused(operator.id)).toBe(false)

      appendFileSync(file, assistantLine('b', 20_000) + assistantLine('c', 20_000))
      op.pollUsage()
      const budget = store.recentEvents(50).filter((e) => e.kind === 'budget')
      expect(budget[0]!.message).toMatch(/^Paused: lead@shop reached its cap \(\$1\.20 of \$0\.50\)/)
      expect(capEvents).toHaveLength(2)
      expect(op.usage.caps.isPaused(operator.id)).toBe(true)
      // Never killed, never typed into, still running.
      expect(ptys[0]!.killed).toBe(false)
      expect(store.getOperator(operator.id)!.status).toBe('running')
      expect(ptys[0]!.written).toHaveLength(1)

      op.messages.send({ kind: 'user', crewId: crew.id }, 'lead', 'hello')
      clock += 60_000
      expect(op.nudgeTick()).toEqual([])
      expect(ptys[0]!.written).toHaveLength(1)

      const job = op.jobs.create({ kind: 'user' }, { crewId: crew.id, title: 'x' })
      const res = await op.collab.run({ kind: 'operator', operatorId: operator.id }, { cmd: 'job.claim', args: { id: job.id } })
      expect(res.exit).toBe(6)

      // Raising the cap resumes it.
      await op.handlers['settings:set']({ tokens: { operatorDailyCapUsd: 5 } })
      expect(op.usage.caps.isPaused(operator.id)).toBe(false)
    })

    it('pauses on the daily budget and resumes through resetCap', async () => {
      await op.handlers['settings:set']({ dailyBudgetUsd: 0.5 })
      const { operator } = await seedOperator()
      await op.handlers['operators:start'](operator.id)
      appendFileSync(join(transcripts, `${sessionIdOf(ptys[0]!)}.jsonl`), assistantLine('a', 30_000))
      op.pollUsage()
      expect(store.recentEvents(50).filter((e) => e.kind === 'budget')[0]!.message).toMatch(/^Paused: The daily budget reached its cap/)
      expect(op.usage.caps.isPaused(operator.id)).toBe(true)
      clock += 60_000
      op.resetCap('daily')
      expect(op.usage.caps.isPaused(operator.id)).toBe(false)
    })

    it('rebuilds pause state from stored spend at startup', async () => {
      await op.handlers['settings:set']({ tokens: { operatorDailyCapUsd: 1 } })
      const { operator } = await seedOperator()
      store.addUsage({ operatorId: operator.id, at: clock, inputTokens: 1, outputTokens: 1, cacheTokens: 0, costUsd: 2 })
      await op.start()
      expect(op.usage.caps.isPaused(operator.id)).toBe(true)
    })
  })

  describe('nudges', () => {
    it('types the fixed nudge once per batch and again only after the re-nudge delay', async () => {
      const { crew, operator } = await seedOperator()
      await op.handlers['operators:start'](operator.id)
      op.messages.send({ kind: 'user', crewId: crew.id }, 'lead', 'ping')
      expect(op.nudgeTick()).toEqual([]) // not idle long enough
      clock += 20_000
      expect(op.nudgeTick()).toEqual([{ key: operator.id, kind: 'nudge', line: 'Operant: you have 1 unread message. Run: operant inbox' }])
      expect(ptys[0]!.written.at(-1)).toBe('Operant: you have 1 unread message. Run: operant inbox\r')
      expect(op.nudgeTick()).toEqual([])
      clock += 130_000
      expect(op.nudgeTick()).toHaveLength(1)
    })

    it('reads the nudge timing from settings, live', async () => {
      const { crew, operator } = await seedOperator()
      await op.handlers['operators:start'](operator.id)
      await op.handlers['settings:set']({ collab: { nudgeIdleSeconds: 1, nudgeBatchSeconds: 0 } })
      op.messages.send({ kind: 'user', crewId: crew.id }, 'lead', 'ping')
      clock += 1_500
      expect(op.nudgeTick()).toHaveLength(1)
    })

    it('types /clear once after a job finishes when the operator clears between jobs', async () => {
      const { crew, operator } = await seedOperator()
      store.setOperatorLaunch(operator.id, { clearBetweenJobs: true })
      await op.handlers['operators:start'](operator.id)
      const job = op.jobs.create({ kind: 'user' }, { crewId: crew.id, title: 'w', review: 'none' })
      const actor = { kind: 'operator' as const, id: operator.id }
      op.jobs.claim(actor, job.id)
      clock += 20_000
      expect(op.nudgeTick()).toEqual([])
      op.jobs.done(actor, job.id)
      clock += 10_000
      expect(op.nudgeTick().map((a) => a.line)).toEqual(['/clear'])
      expect(op.nudgeTick()).toEqual([])
    })

    it('never nudges scratch terminals, the Master Terminal or shell operators', async () => {
      const { crew, squad } = await seedOperator()
      const sh = await op.handlers['operators:create']({ squadId: squad.id, role: 'sh', agent: 'shell', model: '-' })
      await op.handlers['operators:start'](sh.id)
      const master = op.startMaster(crew.id)
      op.messages.send({ kind: 'user', crewId: crew.id }, 'sh', 'a')
      op.messages.send({ kind: 'user', crewId: crew.id }, `${master.role}`, 'b')
      clock += 60_000
      expect(op.nudgeTick()).toEqual([])
    })
  })

  describe('timers', () => {
    it('registers usage, nudge, lease and purge timers and sweeps purge at startup', async () => {
      let sweeps = 0
      const purger = { sweep: () => void sweeps++ } as unknown as Purger
      const timed = build({ purger })
      await timed.start()
      expect(cli.listened).toBe(1)
      expect(sweeps).toBe(1)
      expect(scheduler.jobs.map((j) => j.ms)).toEqual([2_000, 1_000, 30_000, 3_600_000, 10_000, 30_000])
      scheduler.run(3_600_000)
      expect(sweeps).toBe(2)
      await timed.start() // idempotent
      expect(scheduler.jobs).toHaveLength(6)
      timed.stopTimers()
      expect(scheduler.jobs.every((j) => j.cancelled)).toBe(true)
    })

    it('start() ends jobs left working by a crash and runs their finish step', async () => {
      const crew = store.createCrew('a', '/a')
      const run = store.createRun({ crewId: crew.id, task: 't', masterCli: 'claude' })
      store.setRunStatus(run.id, 'working')
      const finished: number[] = []
      const runServices = { onFinished: async (r: { id: number }) => void finished.push(r.id), sweepStaleLaunchFiles: () => {} } as never
      const o = build({ runServices })
      await o.start()
      await new Promise((r) => setTimeout(r, 0))
      expect(store.getRun(run.id)!.status).toBe('failed')
      expect(finished).toEqual([run.id])
      o.stopTimers()
    })

    it('start() deletes stale MCP launch files', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'operant-launch-'))
      const mcpDir = join(dir, 'mcp')
      mkdirSync(mcpDir)
      writeFileSync(join(mcpDir, 'run-20001-mcp.json'), '{"secret":1}')
      writeFileSync(join(mcpDir, 'keep.txt'), 'x')
      const o = build({ launch: { platform: 'linux', launchDir: dir, baseEnv: { PATH: '/usr/bin' }, writer: { mkdir: () => {}, writeFile: () => {} } } })
      await o.start()
      expect(existsSync(join(mcpDir, 'run-20001-mcp.json'))).toBe(false)
      expect(existsSync(join(mcpDir, 'keep.txt'))).toBe(true)
      o.stopTimers()
      rmSync(dir, { recursive: true, force: true })
    })

    it('the 30 s sweep puts an expired lease back to todo', async () => {
      const { crew, operator } = await seedOperator()
      await op.start()
      const job = op.jobs.create({ kind: 'user' }, { crewId: crew.id, title: 'w' })
      op.jobs.claim({ kind: 'operator', id: operator.id }, job.id)
      clock += 61 * 60_000
      scheduler.run(30_000)
      expect(store.getJob(job.id)!.state).toBe('todo')
      expect(store.recentEvents(20).some((e) => e.kind === 'job' && e.message.includes('lease'))).toBe(true)
    })

    it('shutdown revokes live tokens, stops timers and closes the socket', async () => {
      const { operator } = await seedOperator()
      await op.start()
      await op.handlers['operators:start'](operator.id)
      await op.shutdown()
      expect(cli.revoked).toContain(operator.id)
      expect(cli.closed).toBe(1)
      expect(scheduler.jobs.every((j) => j.cancelled)).toBe(true)
    })
  })

  it('shutdown finishes within its step limit when Discord and the CLI socket never answer', async () => {
    await op.start()
    const never = () => new Promise<void>(() => {})
    vi.spyOn(op.discord, 'stop').mockImplementation(never)
    cli.close = never
    op.shutdownStepMs = 50
    const t0 = Date.now()
    await op.shutdown()
    expect(Date.now() - t0).toBeLessThan(1500)
  })

  it('logs one event per job notice and tells the pre-assigned operator', async () => {
    const { crew, operator } = await seedOperator()
    op.jobs.create({ kind: 'user' }, { crewId: crew.id, title: 'build it', for: operator.id })
    expect(store.recentEvents(20).some((e) => e.kind === 'job')).toBe(true)
    const unread = op.messages.unreadInfo(operator.id).count
    expect(unread).toBe(store.listMessages(crew.id, { toKind: 'operator', toId: operator.id }).length)
  })

  describe('applyChange and restartOperator', () => {
    it('restarts a running Claude operator fresh when the model changes', async () => {
      const { operator } = await seedOperator()
      await op.handlers['operators:start'](operator.id)
      const first = sessionIdOf(ptys[0]!)
      const { plan, operator: after } = await op.applyChange(operator.id, { model: 'claude-sonnet-5-5' })
      expect(plan).toMatchObject({ requiresRestart: true, model: 'cache-lost', canResume: false })
      expect(after.model).toBe('claude-sonnet-5-5')
      expect(ptys).toHaveLength(2)
      expect(ptys[0]!.killed).toBe(true)
      expect(ptys[1]!.written[0]).toContain('--model claude-sonnet-5-5')
      expect(sessionIdOf(ptys[1]!)).not.toBe(first)
      expect(ptys[1]!.written[0]).not.toContain('--resume')
      expect(store.getOperator(operator.id)!.status).toBe('running')
    })

    it('restarts for an effort change, applies live fields without restarting, and saves while stopped', async () => {
      const { operator } = await seedOperator()
      await op.handlers['operators:start'](operator.id)
      const effort = await op.applyChange(operator.id, { effort: 'high' })
      expect(effort.plan).toMatchObject({ requiresRestart: true, effort: 'conversation-lost' })
      expect(ptys).toHaveLength(2)
      expect(ptys[1]!.written[0]).toContain('--effort high')

      const live = await op.applyChange(operator.id, { role: 'captain', dailyCapUsd: 3, clearBetweenJobs: true })
      expect(live.plan.requiresRestart).toBe(false)
      expect(ptys).toHaveLength(2)
      expect(live.operator).toMatchObject({ role: 'captain', dailyCapUsd: 3, clearBetweenJobs: true })

      await op.handlers['operators:stop'](operator.id)
      const stopped = await op.applyChange(operator.id, { contextCap: 150_000 })
      expect(stopped.plan.requiresRestart).toBe(false)
      expect(ptys).toHaveLength(2)
      expect(stopped.operator.contextCap).toBe(150_000)
    })

    it('rejects a change for an operator that does not exist', async () => {
      await expect(op.applyChange(999, { model: 'x' })).rejects.toThrow('not found')
    })
  })

  describe('final review fixes', () => {
    it('starts the timers when the CLI socket cannot be opened, and operators then get no CLI environment', async () => {
      const failing: CliAccess = {
        address: '',
        listen: async () => {
          throw new Error('EADDRINUSE /secret/pipe')
        },
        issueToken: () => {
          throw new Error('no token without a socket')
        },
        revokeToken: () => {},
        close: async () => {},
      }
      const timed = build({ cliServer: () => failing })
      await timed.start()
      expect(scheduler.jobs.map((j) => j.ms)).toEqual([2_000, 1_000, 30_000, 3_600_000, 10_000, 30_000])
      const errors = store.recentEvents(20).filter((e) => e.kind === 'error')
      expect(errors).toHaveLength(1)
      expect(errors[0]!.message).toContain('without the operant CLI')
      expect(errors[0]!.message).not.toContain('/secret/pipe')
      const h = timed.handlers
      const crew = await h['crews:create']({ name: 'shop', folder: '/code/shop' })
      const squad = await h['squads:create']({ crewId: crew.id, name: 'dev' })
      const operator = await h['operators:create']({ squadId: squad.id, role: 'lead', agent: 'claude', model: 'opus' })
      await h['operators:start'](operator.id)
      expect(ptys[0]!.opts.env.OPERANT_TOKEN).toBeUndefined()
      expect(ptys[0]!.opts.env.OPERANT_SOCKET).toBeUndefined()
      expect(store.getOperator(operator.id)!.status).toBe('running')
    })

    it('a new operator that reuses a deleted crew\'s id inherits no pause, token or usage feed', async () => {
      await op.handlers['settings:set']({ tokens: { operatorDailyCapUsd: 0.5 } })
      const { crew, operator } = await seedOperator()
      await op.handlers['operators:start'](operator.id)
      const file = join(transcripts, `${sessionIdOf(ptys[0]!)}.jsonl`)
      appendFileSync(file, assistantLine('a', 60_000))
      op.pollUsage()
      expect(op.usage.caps.isPaused(operator.id)).toBe(true)
      expect(cli.issued).toEqual([operator.id])

      await op.handlers['crews:delete'](crew.id)
      expect(cli.revoked).toContain(operator.id)

      const crew2 = await op.handlers['crews:create']({ name: 'shop2', folder: '/code/shop2' })
      const squad2 = await op.handlers['squads:create']({ crewId: crew2.id, name: 'dev' })
      const reused = await op.handlers['operators:create']({ squadId: squad2.id, role: 'lead', agent: 'claude', model: 'opus' })
      expect(reused.id).toBe(operator.id)
      expect(op.usage.caps.isPaused(reused.id)).toBe(false)

      appendFileSync(file, assistantLine('b', 60_000))
      op.pollUsage()
      const rows = store.db.prepare('SELECT COUNT(*) AS n FROM usage WHERE operator_id = ?').get(reused.id) as { n: number }
      expect(Number(rows.n)).toBe(0)
      const job = op.jobs.create({ kind: 'user' }, { crewId: crew2.id, title: 'x' })
      const res = await op.collab.run({ kind: 'operator', operatorId: reused.id }, { cmd: 'job.claim', args: { id: job.id } })
      expect(res.exit).not.toBe(6)
    })

    it('deleting one operator revokes its token and clears its cap state', async () => {
      await op.handlers['settings:set']({ tokens: { operatorDailyCapUsd: 0.5 } })
      const { operator } = await seedOperator()
      await op.handlers['operators:start'](operator.id)
      appendFileSync(join(transcripts, `${sessionIdOf(ptys[0]!)}.jsonl`), assistantLine('a', 60_000))
      op.pollUsage()
      expect(op.usage.caps.isPaused(operator.id)).toBe(true)
      await op.handlers['operators:delete'](operator.id)
      expect(cli.revoked).toContain(operator.id)
      expect(op.usage.caps.isPaused(operator.id)).toBe(false)
      expect(op.usage.caps.pausedOperators()).toEqual([])
    })

    it('a restart whose old session exits late waits, kills it, then starts the new session and keeps its jobs', async () => {
      vi.useFakeTimers()
      try {
        const { crew, operator } = await seedOperator()
        await op.handlers['operators:start'](operator.id)
        const job = op.jobs.create({ kind: 'user' }, { crewId: crew.id, title: 'w' })
        op.jobs.claim({ kind: 'operator', id: operator.id }, job.id)
        ptys[0]!.kill = () => {}
        let done = false
        const change = op.applyChange(operator.id, { model: 'claude-sonnet-5-5' }).then((r) => {
          done = true
          return r
        })
        await vi.advanceTimersByTimeAsync(6_000)
        expect(done).toBe(false)
        expect(ptys).toHaveLength(1)
        await vi.advanceTimersByTimeAsync(10_000)
        const result = await change
        expect(result.operator.status).toBe('running')
        expect(ptys).toHaveLength(2)
        expect(ptys[1]!.written[0]).toContain('--model claude-sonnet-5-5')
        expect(store.getJob(job.id)!.state).toBe('doing')
        expect(store.getJob(job.id)!.assigneeId).toBe(operator.id)
        // The old pty finally exits: nothing changes for the new session.
        ptys[0]!.exit({ exitCode: 0 })
        expect(sessions.isRunning(operator.id)).toBe(true)
        expect(store.getOperator(operator.id)!.status).toBe('running')
        expect(store.getJob(job.id)!.state).toBe('doing')
      } finally {
        vi.useRealTimers()
      }
    })

    it('a restart whose new session cannot start throws a CONFLICT instead of reporting success', async () => {
      const { crew, operator } = await seedOperator()
      await op.handlers['operators:start'](operator.id)
      const job = op.jobs.create({ kind: 'user' }, { crewId: crew.id, title: 'w' })
      op.jobs.claim({ kind: 'operator', id: operator.id }, job.id)
      failSpawn = true
      await expect(op.applyChange(operator.id, { model: 'claude-sonnet-5-5' })).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('could not start again') })
      expect(store.getOperator(operator.id)!.status).toBe('error')
      expect(store.getJob(job.id)!.state).toBe('doing')
    })

    it('deleting an operator closes its open consent requests so they no longer block its purge', async () => {
      const { operator } = await seedOperator()
      await op.handlers['operators:start'](operator.id)
      const sent = op.messages.ask({ kind: 'operator', operatorId: operator.id }, 'may I deploy?')
      const askId = sent.messages[0]!.id
      expect(store.getMessage(askId)!.readAt).toBeNull()
      await op.handlers['operators:delete'](operator.id)
      expect(store.getMessage(askId)!.readAt).not.toBeNull()
      expect(op.purger.eligible(operator.id, true)).toEqual({ ok: true, blockers: [] })
    })
  })

  describe('scratch terminals', () => {
    it('starts a Claude tile with no token or plugin and stops it', async () => {
      const { crew } = await seedOperator()
      const scratch = store.createScratch({ crewId: crew.id, title: 'try', agent: 'claude', model: 'sonnet', cwd: '/code/shop' })
      op.startScratch(scratch.id)
      expect(ptys).toHaveLength(1)
      expect(sessions.isRunning(`scratch:${scratch.id}`)).toBe(true)
      expect(ptys[0]!.written[0]).toMatch(/^claude --model sonnet --session-id [0-9a-f-]{36}\r$/)
      expect(ptys[0]!.opts.env.OPERANT_TOKEN).toBeUndefined()
      expect(cli.issued).toEqual([])
      expect(store.getScratch(scratch.id)!.sessionId).toBe(sessionIdOf(ptys[0]!))

      op.stopScratch(scratch.id)
      expect(sessions.isRunning(`scratch:${scratch.id}`)).toBe(false)
      expect(ptys[0]!.killed).toBe(true)
    })

    it('resumes the previous conversation on request and stops with the crew', async () => {
      const { crew } = await seedOperator()
      const scratch = store.createScratch({ crewId: crew.id, title: 'try', agent: 'claude', model: 'sonnet', cwd: '/code/shop' })
      op.startScratch(scratch.id)
      const sid = sessionIdOf(ptys[0]!)
      op.stopScratch(scratch.id)
      op.startScratch(scratch.id, { resume: true })
      expect(ptys[1]!.written[0]).toContain(`--resume ${sid}`)
      await op.handlers['crews:delete'](crew.id)
      expect(ptys[1]!.killed).toBe(true)
    })

    it('starts a plain shell tile without typing anything', async () => {
      const { crew } = await seedOperator()
      const scratch = store.createScratch({ crewId: crew.id, title: 'sh', agent: 'shell', cwd: '/code/shop' })
      op.startScratch(scratch.id)
      expect(ptys[0]!.written).toEqual([])
    })
  })

  it('resets operators left running by a previous crash', async () => {
    const { operator } = await seedOperator()
    store.setOperatorStatus(operator.id, 'running')
    op.resetStaleOperators()
    expect(store.getOperator(operator.id)!.status).toBe('stopped')
  })

  it('stops a crew’s operators when the crew is deleted', async () => {
    const { crew, operator } = await seedOperator()
    await op.handlers['operators:start'](operator.id)
    await op.handlers['crews:delete'](crew.id)
    expect(store.listCrews()).toEqual([])
    expect(await op.handlers['operators:buffer'](operator.id)).toBe('')
  })

  // Step 10b: the dashboard calls

  const h = () => op.handlers
  const failure = async (fn: () => unknown): Promise<OperantError> => {
    try {
      await fn()
    } catch (err) {
      expect(err).toBeInstanceOf(OperantError)
      return err as OperantError
    }
    throw new Error('expected the call to be refused')
  }
  const pushesOf = (name: keyof IpcEvents) => pushed.filter((p) => p.name === name).map((p) => p.payload)
  const sonnet = 'claude-sonnet-5-5'

  async function seedCrew() {
    const crew = await h()['crews:create']({ name: 'shop', folder: '/code/shop' })
    const squad = await h()['squads:create']({ crewId: crew.id, name: 'dev' })
    const pm = await h()['operators:createFromPreset']({ squadId: squad.id, role: 'boss', presetId: store.getPresetByBuiltin('pm')!.id })
    const impl = await h()['operators:createFromPreset']({ squadId: squad.id, role: 'builder', presetId: store.getPresetByBuiltin('implementor')!.id })
    return { crew, squad, pm, impl }
  }

  it('has a handler for every core channel and none extra', () => {
    expect(Object.keys(op.handlers).sort()).toEqual([...CORE_CHANNELS].sort())
    expect(new Set(CORE_CHANNELS).size).toBe(CORE_CHANNELS.length)
  })

  describe('errors', () => {
    it('refuses with a code the renderer can branch on', async () => {
      expect((await failure(() => h()['crews:update'](999, { name: 'x' }))).code).toBe('NOT_FOUND')
      await h()['crews:create']({ name: 'shop', folder: '/a' })
      expect((await failure(() => h()['crews:create']({ name: 'shop', folder: '/b' }))).code).toBe('CONFLICT')
      expect((await failure(() => h()['crews:create']({ name: '  ', folder: '/b' }))).code).toBe('BAD_ARGS')
    })

    it('maps job, message and launch errors', async () => {
      const { crew, impl } = await seedCrew()
      const job = await h()['jobs:create']({ crewId: crew.id, title: 'x' })
      expect((await failure(() => h()['jobs:approve'](job.id))).code).toBe('CONFLICT')
      expect((await failure(() => h()['jobs:get'](9999))).code).toBe('NOT_FOUND')
      expect((await failure(() => h()['messages:send']({ crewId: crew.id, to: 'nobody', body: 'hi' }))).code).toBe('NOT_FOUND')
      expect((await failure(() => h()['operators:applyChange'](impl.id, { model: 'rm -rf /' }))).code).toBe('BAD_ARGS')
      expect((await failure(() => h()['operators:applyChange'](impl.id, { bogus: 1 } as never))).message).toContain('Unknown field')
      expect(store.getOperator(impl.id)!.model).toBe(sonnet)
    })
  })

  describe('crews and squads', () => {
    it('renames a crew, refuses a folder change while an operator runs, and reports counts', async () => {
      const { crew, impl } = await seedCrew()
      expect((await h()['crews:update'](crew.id, { name: 'store' })).name).toBe('store')
      await h()['operators:start'](impl.id)
      expect((await failure(() => h()['crews:update'](crew.id, { folder: '/elsewhere' }))).code).toBe('CONFLICT')
      await h()['operators:stop'](impl.id)
      expect((await h()['crews:update'](crew.id, { folder: '/elsewhere' })).folder).toBe('/elsewhere')
      await h()['jobs:create']({ crewId: crew.id, title: 'a' })
      store.createScratch({ crewId: crew.id, title: 't', agent: 'shell', cwd: '/x' })
      expect(await h()['crews:counts'](crew.id)).toMatchObject({ squads: 1, operators: 2, running: 0, jobs: 1, openJobs: 1, scratch: 1 })
      expect((await h()['crews:update'](crew.id, { pmId: impl.id })).pmId).toBe(impl.id)
      expect((await failure(() => h()['crews:update'](crew.id, { pmId: 12345 }))).code).toBe('BAD_ARGS')
    })

    it('deleting a crew stops its sessions and returns what it removed', async () => {
      const { crew, impl } = await seedCrew()
      await h()['operators:start'](impl.id)
      op.startMaster(crew.id)
      const counts = await h()['crews:delete'](crew.id)
      expect(counts).toMatchObject({ squads: 1, operators: 2 })
      expect(ptys.every((p) => p.killed)).toBe(true)
      expect(store.listCrews()).toEqual([])
    })

    it('renames a squad and deletes it with its operators, stopping them first', async () => {
      const { crew, squad, impl } = await seedCrew()
      expect((await h()['squads:update'](squad.id, { name: 'build' })).name).toBe('build')
      expect((await failure(() => h()['squads:update'](999, { name: 'x' }))).code).toBe('NOT_FOUND')
      await h()['operators:start'](impl.id)
      const result = await h()['squads:delete'](squad.id)
      expect(result).toEqual({ operators: 2 })
      expect(ptys[0]!.killed).toBe(true)
      expect(store.getOperator(impl.id)).toBeNull()
      expect(store.topology(crew.id)!.squads).toEqual([])
      expect(store.recentEvents(5).map((e) => e.message)).toContain('Squad build deleted')
      const system = store.ensureMaster(crew.id)
      expect((await failure(() => h()['operators:delete'](system.id))).message).toContain('Master Terminal')
    })
  })

  describe('operators', () => {
    it('creates from a preset with its settings and tracks "modified"', async () => {
      const { impl } = await seedCrew()
      const preset = store.getPresetByBuiltin('implementor')!
      expect(impl).toMatchObject({ presetId: preset.id, model: sonnet, permissionMode: 'acceptEdits', modified: false })
      expect(pushesOf('operator:config')).toContainEqual({ operatorId: impl.id, crewId: expect.any(Number), removed: false })
      expect((await failure(() => h()['operators:createFromPreset']({ squadId: impl.squadId, role: 'builder', presetId: preset.id }))).code).toBe('CONFLICT')
      expect((await failure(() => h()['operators:createFromPreset']({ squadId: impl.squadId, role: 'x y', presetId: preset.id }))).code).toBe('BAD_ARGS')
      expect((await failure(() => h()['operators:createFromPreset']({ squadId: impl.squadId, role: 'z', presetId: 999 }))).code).toBe('NOT_FOUND')
    })

    it('previews a change without saving, then applies it: running operators restart fresh', async () => {
      const { impl } = await seedCrew()
      await h()['operators:start'](impl.id)
      const plan = await h()['operators:previewChange'](impl.id, { model: 'claude-opus-5-5' })
      expect(plan).toMatchObject({ requiresRestart: true, model: 'cache-lost', canResume: false })
      expect(store.getOperator(impl.id)!.model).toBe(sonnet)
      expect(ptys).toHaveLength(1)
      const first = sessionIdOf(ptys[0]!)

      const { operator, plan: applied } = await h()['operators:applyChange'](impl.id, { model: 'claude-opus-5-5' })
      expect(applied.requiresRestart).toBe(true)
      expect(operator).toMatchObject({ model: 'claude-opus-5-5', modified: true })
      expect(ptys).toHaveLength(2)
      expect(sessionIdOf(ptys[1]!)).not.toBe(first)
      expect(pushesOf('operator:config').length).toBeGreaterThan(1)

      // Role, cap, clearBetweenJobs and squad apply live.
      const live = await h()['operators:applyChange'](impl.id, { role: 'smith', dailyCapUsd: 2 })
      expect(live.plan).toMatchObject({ requiresRestart: false, liveFields: ['role', 'dailyCapUsd'] })
      expect(ptys).toHaveLength(2)
      expect((await failure(() => h()['operators:applyChange'](impl.id, { dailyCapUsd: -1 }))).code).toBe('BAD_ARGS')
      expect((await failure(() => h()['operators:applyChange'](impl.id, { squadId: 999 }))).code).toBe('BAD_ARGS')
    })

    it('updates role, squad and cap, and restarts on request', async () => {
      const { crew, impl, pm } = await seedCrew()
      const squad2 = await h()['squads:create']({ crewId: crew.id, name: 'ops' })
      const updated = await h()['operators:update'](impl.id, { role: 'maker', squadId: squad2.id, dailyCapUsd: 4 })
      expect(updated).toMatchObject({ role: 'maker', squadId: squad2.id, dailyCapUsd: 4 })
      expect((await failure(() => h()['operators:update'](impl.id, { role: pm.role }))).code).toBe('CONFLICT')
      await h()['operators:start'](impl.id)
      await h()['operators:restart'](impl.id)
      expect(ptys).toHaveLength(2)
      expect(store.getOperator(impl.id)!.status).toBe('running')
      await h()['operators:stop'](impl.id)
      await h()['operators:restart'](impl.id)
      expect(ptys).toHaveLength(3)
    })

    it('soft-deletes a running operator end to end', async () => {
      const { crew, impl, pm } = await seedCrew()
      const other = await h()['operators:createFromPreset']({ squadId: impl.squadId, role: 'tester', presetId: store.getPresetByBuiltin('tester')!.id })
      await h()['crews:update'](crew.id, { pmId: impl.id })
      await h()['operators:start'](impl.id)
      const job = await h()['jobs:create']({ crewId: crew.id, title: 'work', for: impl.id, review: 'operator', reviewerId: impl.id })
      op.jobs.claim({ kind: 'operator', id: impl.id }, job.id)
      const reviewed = await h()['jobs:create']({ crewId: crew.id, title: 'to review', review: 'operator', reviewerId: impl.id })
      await h()['messages:send']({ crewId: crew.id, to: impl.id, body: 'unread for the deleted one' })
      store.createLink(crew.id, impl.id, pm.id, 'asks')
      store.createLink(crew.id, pm.id, other.id, 'keeps')

      await h()['operators:delete'](impl.id)

      expect(ptys[0]!.killed).toBe(true)
      expect(cli.revoked).toContain(impl.id)
      expect(store.getOperator(impl.id)).toBeNull()
      expect(store.db.prepare('SELECT deleted_at FROM operators WHERE id = ?').get(impl.id)).toEqual({ deleted_at: clock })
      expect(store.getJob(job.id)).toMatchObject({ state: 'todo', assigneeId: null })
      expect(store.getJob(reviewed.id)).toMatchObject({ review: 'user', reviewerId: null })
      expect(store.getCrew(crew.id)!.pmId).toBeNull()
      expect(store.listLinks(crew.id).map((l) => l.label)).toEqual(['keeps'])
      expect(store.listMessages(crew.id, { toId: impl.id, unreadOnly: true })).toEqual([])
      expect(store.recentEvents(10).map((e) => e.message)).toContain('Operator builder@shop deleted')
      expect(pushesOf('operator:config')).toContainEqual({ operatorId: impl.id, crewId: crew.id, removed: true })
      expect((await failure(() => h()['operators:delete'](impl.id))).code).toBe('NOT_FOUND')
      // Its role is free again.
      await h()['operators:create']({ squadId: impl.squadId, role: 'builder', agent: 'shell', model: '-' })
    })

    it('starts and stops the Master Terminal per crew, and cannot delete it', async () => {
      const { crew } = await seedCrew()
      expect(await h()['master:get'](crew.id)).toBeNull()
      const master = await h()['master:start'](crew.id)
      expect(master).toMatchObject({ kind: 'master', role: 'master' })
      expect((await h()['master:get'](crew.id))!.id).toBe(master.id)
      expect(sessions.isRunning(master.id)).toBe(true)
      await h()['master:stop'](crew.id)
      expect(sessions.isRunning(master.id)).toBe(false)
    })
  })

  describe('presets', () => {
    it('creates, edits, duplicates and validates', async () => {
      const preset = await h()['presets:create']({ name: 'fast', agent: 'claude', model: 'claude-haiku-4-5', permissionMode: 'dontAsk', tools: 'Read,Grep' })
      expect(preset).toMatchObject({ builtin: null, tools: 'Read,Grep', clearBetweenJobs: true })
      expect((await h()['presets:update'](preset.id, { name: 'faster', effort: 'high', roleText: 'be quick' })).name).toBe('faster')
      const copy = await h()['presets:duplicate'](preset.id)
      expect(copy).toMatchObject({ name: 'faster copy', roleText: 'be quick', builtin: null })
      expect((await failure(() => h()['presets:create']({ name: 'faster', agent: 'claude', model: 'x', permissionMode: 'dontAsk' }))).code).toBe('CONFLICT')
      expect((await failure(() => h()['presets:create']({ name: 'bad', agent: 'claude', model: 'x', permissionMode: 'auto' }))).code).toBe('BAD_ARGS')
      expect((await failure(() => h()['presets:update'](preset.id, { tools: 'Bash;rm' }))).code).toBe('BAD_ARGS')
      expect((await failure(() => h()['presets:update'](999, { name: 'x' }))).code).toBe('NOT_FOUND')
    })

    it('duplicates a built-in with its shipped role text and shows it', async () => {
      const impl = store.getPresetByBuiltin('implementor')!
      expect(await h()['presets:shippedRole'](impl.id)).toBe('ROLE:implementor.md')
      const copy = await h()['presets:duplicate'](impl.id, 'my implementor')
      expect(copy).toMatchObject({ builtin: null, name: 'my implementor', roleText: 'ROLE:implementor.md' })
      expect(await h()['presets:shippedRole'](copy.id)).toBe('')
    })

    it('applies an edit to unmodified operators only, and reverts or saves a modified one', async () => {
      const { crew, impl, squad } = await seedCrew()
      const preset = store.getPresetByBuiltin('implementor')!
      const second = await h()['operators:createFromPreset']({ squadId: squad.id, role: 'builder2', presetId: preset.id })
      await h()['operators:applyChange'](second.id, { effort: 'low' })
      expect(store.getOperator(second.id)!.modified).toBe(true)

      await h()['presets:update'](preset.id, { effort: 'high', contextCap: 250_000 }, true)
      expect(store.getOperator(impl.id)).toMatchObject({ effort: 'high', contextCap: 250_000, modified: false })
      expect(store.getOperator(second.id)).toMatchObject({ effort: 'low', modified: true })

      // Without `apply`, operators keep their copy and show "modified".
      await h()['presets:update'](preset.id, { effort: 'max' })
      expect(store.getOperator(impl.id)).toMatchObject({ effort: 'high', modified: true })

      const reverted = await h()['presets:revertOperator'](second.id)
      expect(reverted).toMatchObject({ effort: 'max', modified: false })
      const saved = await h()['presets:saveFromOperator'](impl.id, 'tuned implementor')
      expect(saved).toMatchObject({ builtin: null, effort: 'high', contextCap: 250_000 })
      expect(store.getOperator(impl.id)).toMatchObject({ presetId: saved.id, modified: false })
      expect((await failure(() => h()['presets:revertOperator'](store.ensureMaster(crew.id).id))).code).toBe('BAD_ARGS')
    })

    it('reverting restarts a running operator when its launch changes', async () => {
      const { impl } = await seedCrew()
      await h()['operators:applyChange'](impl.id, { model: 'claude-opus-5-5' })
      await h()['operators:start'](impl.id)
      await h()['presets:revertOperator'](impl.id)
      expect(ptys).toHaveLength(2)
      expect(ptys[1]!.written[0]).toContain(`--model ${sonnet}`)
    })

    it('applies a preset to chosen operators, but not to the Master Terminal', async () => {
      const { crew, impl, pm } = await seedCrew()
      const reviewer = store.getPresetByBuiltin('reviewer')!
      const updated = await h()['presets:applyToOperators'](reviewer.id, [impl.id])
      expect(updated[0]).toMatchObject({ id: impl.id, presetId: reviewer.id, permissionMode: 'dontAsk', effort: 'high' })
      expect((await h()['presets:applyToOperators'](reviewer.id)).map((o) => o.id)).toEqual([impl.id])
      const master = store.ensureMaster(crew.id)
      expect((await failure(() => h()['presets:applyToOperators'](reviewer.id, [master.id]))).code).toBe('BAD_ARGS')
      expect(pm.presetId).toBe(store.getPresetByBuiltin('pm')!.id)
    })

    it('deleting a preset keeps its operators; built-ins reset and restore', async () => {
      const { impl } = await seedCrew()
      const preset = store.getPresetByBuiltin('implementor')!
      await h()['presets:update'](preset.id, { name: 'edited', effort: 'low' })
      expect((await h()['presets:reset'](preset.id)).effort).toBe('medium')
      expect(store.getPreset(preset.id)!.name).toBe('implementor')

      await h()['presets:delete'](preset.id)
      expect(store.getPresetByBuiltin('implementor')).toBeNull()
      expect(store.getOperator(impl.id)).toMatchObject({ presetId: null, model: sonnet, modified: false })
      expect(pushesOf('operator:config')).toContainEqual({ operatorId: impl.id, crewId: expect.any(Number), removed: false })
      const restored = await h()['presets:restoreBuiltins']()
      expect(restored.map((p) => p.builtin)).toEqual(['implementor'])
      expect(await h()['presets:restoreBuiltins']()).toEqual([])
      const user = await h()['presets:create']({ name: 'mine', agent: 'claude', model: 'opus', permissionMode: 'dontAsk' })
      expect((await failure(() => h()['presets:reset'](user.id))).code).toBe('BAD_ARGS')
      await h()['presets:delete'](user.id)
      expect(await h()['presets:list']()).toHaveLength(7)
    })
  })

  describe('jobs (the user)', () => {
    it('creates, edits every field, sets dependencies and overrides the state', async () => {
      const { crew, impl } = await seedCrew()
      const a = await h()['jobs:create']({ crewId: crew.id, title: 'first', priority: 2, review: 'none' })
      const b = await h()['jobs:create']({ crewId: crew.id, title: 'second', deps: [a.id], review: 'none' })
      expect(b).toMatchObject({ deps: [a.id], blocked: true })

      const edited = await h()['jobs:update'](b.id, { title: 'second!', body: 'details', priority: 5, estimateMinutes: 30, review: 'operator', reviewerId: impl.id, note: 'n', deps: [] })
      expect(edited).toMatchObject({ title: 'second!', body: 'details', priority: 5, estimateMinutes: 30, review: 'operator', reviewerId: impl.id, note: 'n', deps: [], blocked: false })
      const moved = await h()['jobs:update'](b.id, { state: 'doing', assigneeId: impl.id })
      expect(moved).toMatchObject({ state: 'doing', assigneeId: impl.id })
      expect(await h()['jobs:move'](b.id, { state: 'review' })).toMatchObject({ state: 'review' })
      expect(await h()['jobs:update'](a.id, { assigneeId: impl.id })).toMatchObject({ assigneeId: impl.id })
      expect((await h()['jobs:list'](crew.id)).map((j) => j.id)).toEqual([a.id, b.id])
      expect((await h()['jobs:list'](crew.id, true)).map((j) => j.id)).toEqual([a.id, b.id])
      await h()['jobs:delete'](a.id)
      expect(store.getJob(a.id)).toBeNull()
      expect(pushesOf('job').length).toBeGreaterThan(3)
    })

    it('a refused part leaves the job as it was', async () => {
      const { crew } = await seedCrew()
      const a = await h()['jobs:create']({ crewId: crew.id, title: 'a', review: 'none' })
      const b = await h()['jobs:create']({ crewId: crew.id, title: 'b', deps: [a.id], review: 'none' })
      const err = await failure(() => h()['jobs:update'](a.id, { title: 'changed', deps: [b.id] }))
      expect(err.code).toBe('CONFLICT')
      expect(store.getJob(a.id)!.title).toBe('a')
      expect(store.db.isTransaction).toBe(false)
    })

    it('holds a long job until the user approves it to start, then runs the review flow', async () => {
      const { crew, impl } = await seedCrew()
      const long = await h()['jobs:create']({ crewId: crew.id, title: 'big', estimateMinutes: 180, for: impl.id })
      expect(long).toMatchObject({ state: 'held', review: 'user', escalation: expect.stringContaining('approve to start') })
      expect(await h()['jobs:approveStart'](long.id)).toMatchObject({ state: 'todo', escalation: '' })
      expect((await failure(() => h()['jobs:approveStart'](long.id))).code).toBe('CONFLICT')

      op.jobs.claim({ kind: 'operator', id: impl.id }, long.id)
      op.jobs.done({ kind: 'operator', id: impl.id }, long.id)
      expect(store.getJob(long.id)!.state).toBe('review')
      expect(await h()['jobs:reject'](long.id, 'redo the tests')).toMatchObject({ state: 'doing', note: 'redo the tests', rejects: 1 })
      op.jobs.done({ kind: 'operator', id: impl.id }, long.id)
      expect(await h()['jobs:approve'](long.id, 'good')).toMatchObject({ state: 'done', note: 'good' })

      const open = await h()['jobs:create']({ crewId: crew.id, title: 'risky', review: 'none' })
      expect(await h()['jobs:escalate'](open.id, 'touches billing')).toMatchObject({ review: 'user', escalation: 'touches billing' })
      expect((await failure(() => h()['jobs:reject'](open.id, 'x'))).code).toBe('CONFLICT')
    })
  })

  describe('links', () => {
    it('creates, edits, lists and deletes', async () => {
      const { crew, impl, pm } = await seedCrew()
      const link = await h()['links:create']({ crewId: crew.id, fromId: pm.id, toId: impl.id, label: 'delegates' })
      expect(link).toMatchObject({ fromId: pm.id, toId: impl.id, label: 'delegates' })
      expect((await h()['links:update'](link.id, { label: 'reviews', fromId: impl.id, toId: pm.id }))).toMatchObject({ label: 'reviews', fromId: impl.id })
      expect(await h()['links:list'](crew.id)).toHaveLength(1)
      expect((await failure(() => h()['links:create']({ crewId: crew.id, fromId: pm.id, toId: pm.id }))).code).toBe('BAD_ARGS')
      expect((await failure(() => h()['links:update'](999, { label: 'x' }))).code).toBe('NOT_FOUND')
      await h()['links:delete'](link.id)
      expect(await h()['links:list'](crew.id)).toEqual([])
      expect(store.recentEvents(3).map((e) => e.kind)).toContain('link')
    })
  })

  describe('messages (the user)', () => {
    it('sends to an operator, edits and deletes under the rules, and keeps counts', async () => {
      const { crew, impl, pm } = await seedCrew()
      const [sent] = await h()['messages:send']({ crewId: crew.id, to: impl.id, body: 'start with the tests' })
      expect(sent).toMatchObject({ fromKind: 'user', toKind: 'operator', toId: impl.id, body: 'start with the tests' })
      expect(pushesOf('message')).toContainEqual({ crewId: crew.id, messageId: sent!.id, change: 'created' })
      expect(pushesOf('unread')).toContainEqual({ crewId: crew.id, to: impl.id, count: 1 })
      expect(await h()['messages:unread'](crew.id)).toEqual({ user: 0, master: 0, operators: { [impl.id]: 1 } })

      expect((await h()['messages:edit'](sent!.id, 'start with lint')).body).toBe('start with lint')
      op.messages.inbox(impl.id)
      expect((await failure(() => h()['messages:edit'](sent!.id, 'too late'))).code).toBe('FORBIDDEN')
      expect((await failure(() => h()['messages:edit'](999, 'x'))).code).toBe('NOT_FOUND')

      const fan = await h()['messages:send']({ crewId: crew.id, to: 'squad:dev', body: 'standup' })
      expect(fan.map((m) => m.toId).sort()).toEqual([impl.id, pm.id].sort())
      await h()['messages:delete'](sent!.id)
      expect(store.getMessage(sent!.id)).toBeNull()
      expect(pushesOf('message')).toContainEqual({ crewId: crew.id, messageId: sent!.id, change: 'deleted' })
      const master = store.ensureMaster(crew.id)
      expect((await h()['messages:send']({ crewId: crew.id, to: master.id, body: 'hi master' }))[0]).toMatchObject({ toKind: 'master' })
      expect(await h()['messages:list'](crew.id, { toId: impl.id })).toHaveLength(1)
    })

    it('answers consent cards, marks the rest read and refuses a foreign crew', async () => {
      const { crew, impl } = await seedCrew()
      const ask = op.messages.ask({ kind: 'operator', operatorId: impl.id }, 'push to origin?').messages[0]!
      op.messages.send({ kind: 'operator', operatorId: impl.id }, 'user', 'fyi')
      expect((await h()['messages:unread'](crew.id)).user).toBe(2)
      expect(await h()['messages:markRead'](crew.id)).toBe(1)
      expect((await h()['messages:unread'](crew.id)).user).toBe(1)

      const reply = await h()['messages:answer'](ask.id, true, 'go ahead')
      expect(reply[0]).toMatchObject({ kind: 'answer', toId: impl.id, fromKind: 'user' })
      expect(reply[0]!.body).toContain('Approved')
      expect((await h()['messages:unread'](crew.id)).user).toBe(0)
      expect((await failure(() => h()['messages:answer'](ask.id, false))).code).toBe('BAD_ARGS')
      expect((await failure(() => h()['messages:send']({ crewId: 999, to: 'x', body: 'y' }))).code).toBe('NOT_FOUND')
    })
  })

  describe('views and tiles', () => {
    it('saves the view and the tile layout per crew, across a restart of Operant', async () => {
      const { crew } = await seedCrew()
      expect(await h()['views:get'](crew.id)).toBe('cards')
      expect((await h()['views:set'](crew.id, 'tiles')).view).toBe('tiles')
      expect((await failure(() => h()['views:set'](crew.id, 'floor' as never))).code).toBe('BAD_ARGS')
      const layout = { dir: 'row', ratio: 0.4, children: ['scratch:1', 'scratch:2'] }
      await h()['tiles:saveLayout'](crew.id, layout)
      const again = build({ sessions: new SessionManager((f, _a, o) => new FakePty(f, o)) })
      expect(await again.handlers['views:get'](crew.id)).toBe('tiles')
      expect(await again.handlers['tiles:getLayout'](crew.id)).toEqual(layout)
      expect((await failure(() => h()['tiles:saveLayout'](crew.id, { big: 'x'.repeat(200_000) }))).code).toBe('BAD_ARGS')
      expect((await failure(() => h()['tiles:getLayout'](999))).code).toBe('NOT_FOUND')
    })
  })

  describe('scratch terminals', () => {
    it('creates, edits, opens, closes and deletes, with spend that outlives the tile', async () => {
      const { crew } = await seedCrew()
      const t = await h()['scratch:create']({ crewId: crew.id, title: 'try', agent: 'claude', model: sonnet, effort: 'high' })
      expect(t).toMatchObject({ cwd: '/code/shop', title: 'try' })
      expect(await h()['scratch:list'](crew.id)).toHaveLength(1)
      expect((await failure(() => h()['scratch:create']({ crewId: crew.id, title: 'x', agent: 'claude', model: 'a b' }))).code).toBe('BAD_ARGS')
      expect((await failure(() => h()['scratch:create']({ crewId: crew.id, title: 'x', agent: 'vim' as never }))).code).toBe('BAD_ARGS')

      await h()['scratch:start'](t.id)
      expect(sessions.isRunning(`scratch:${t.id}`)).toBe(true)
      expect(ptys[0]!.written[0]).toContain('--effort high')
      ptys[0]!.data('hello')
      expect(pushesOf('scratch:data')).toContainEqual({ scratchId: t.id, data: 'hello' })
      expect(await h()['scratch:buffer'](t.id)).toBe('hello')
      await h()['scratch:write'](t.id, 'ls\r')
      expect(ptys[0]!.written.at(-1)).toBe('ls\r')

      // Edits apply on the next open.
      expect((await h()['scratch:update'](t.id, { title: 'renamed', effort: 'low', cwd: '/tmp/x' }))).toMatchObject({ title: 'renamed', effort: 'low' })
      expect(sessions.isRunning(`scratch:${t.id}`)).toBe(true)

      const file = join(transcripts, `${store.getScratch(t.id)!.sessionId}.jsonl`)
      appendFileSync(file, assistantLine('s1', 1_000))
      op.pollUsage()
      expect(store.spendSince(0)).toBeCloseTo(0.02, 8)

      await h()['scratch:stop'](t.id)
      expect(sessions.isRunning(`scratch:${t.id}`)).toBe(false)
      expect(pushesOf('scratch:exit')).toContainEqual({ scratchId: t.id, exitCode: 0 })
      await h()['scratch:start'](t.id, true)
      expect(ptys[1]!.written[0]).toContain(`--resume ${store.getScratch(t.id)!.sessionId}`)
      expect(ptys[1]!.written[0]).toContain('--effort low')

      await h()['scratch:delete'](t.id)
      expect(ptys[1]!.killed).toBe(true)
      expect(store.getScratch(t.id)).toBeNull()
      expect(store.spendSince(0)).toBeCloseTo(0.02, 8)
      expect((await failure(() => h()['scratch:start'](t.id))).code).toBe('NOT_FOUND')
    })

    it('counts scratch spend toward the daily budget and shows it as its own group', async () => {
      await h()['settings:set']({ dailyBudgetUsd: 0.5 })
      const { crew } = await seedCrew()
      const t = await h()['scratch:create']({ crewId: crew.id, title: 'big', agent: 'claude', model: 'opus' })
      await h()['scratch:start'](t.id)
      appendFileSync(join(transcripts, `${store.getScratch(t.id)!.sessionId}.jsonl`), assistantLine('a', 30_000))
      op.pollUsage()
      expect(store.recentEvents(20).some((e) => e.kind === 'budget' && e.message.startsWith('Paused: The daily budget'))).toBe(true)
      expect(pushesOf('caps')).toContainEqual(expect.objectContaining({ action: 'pause', scope: 'daily' }))
      expect((await h()['caps:status']()).daily).toMatchObject({ paused: true, capUsd: 0.5 })
      const breakdown = await h()['usage:breakdown'](crew.id, '24h')
      expect(breakdown.scratch.costUsd).toBeCloseTo(0.6, 8)
      expect(breakdown.rows.map((r) => r.group)).toEqual(['scratch'])
      expect(breakdown.operators.every((o) => o.costUsd === 0)).toBe(true)
    })

    it('start never restarts a running session and returns its state; status and spend query it', async () => {
      const { crew } = await seedCrew()
      const t = await h()['scratch:create']({ crewId: crew.id, title: 'one', agent: 'claude', model: sonnet })
      expect(await h()['scratch:status'](t.id)).toEqual({ scratchId: t.id, running: false, sessionId: null })
      const first = await h()['scratch:start'](t.id)
      expect(first).toMatchObject({ scratchId: t.id, running: true })
      expect(first.sessionId).toBe(store.getScratch(t.id)!.sessionId)
      expect(await h()['scratch:start'](t.id)).toEqual(first)
      expect(await h()['scratch:start'](t.id, true)).toEqual(first)
      expect(ptys).toHaveLength(1)
      expect(await h()['scratch:status'](t.id)).toEqual(first)

      const other = await h()['scratch:create']({ crewId: crew.id, title: 'two', agent: 'claude', model: sonnet })
      await h()['scratch:start'](other.id)
      appendFileSync(join(transcripts, `${first.sessionId}.jsonl`), assistantLine('s1', 1_000))
      op.pollUsage()
      expect(await h()['scratch:spend'](crew.id)).toEqual([{ scratchId: t.id, costUsd: expect.closeTo(0.02, 8), turns: 1 }])

      await h()['scratch:stop'](t.id)
      expect(await h()['scratch:status'](t.id)).toMatchObject({ running: false })
      expect((await failure(() => h()['scratch:status'](999))).code).toBe('NOT_FOUND')
    })

    it('a launch that cannot happen rejects with a typed error and logs it', async () => {
      const { crew } = await seedCrew()
      const t = store.createScratch({ crewId: crew.id, title: 'bad', agent: 'claude', model: sonnet, cwd: '/code/shop' })
      const err = await failure(() => h()['scratch:start'](t.id))
      expect(err.code).toBe('BAD_ARGS')
      expect(sessions.isRunning(`scratch:${t.id}`)).toBe(false)
      expect(store.recentEvents(20).some((e) => e.kind === 'error' && e.message.includes('failed to start'))).toBe(true)
    })

    it('a shell tile needs no transcript and works under any shell', async () => {
      const { crew } = await seedCrew()
      const t = await h()['scratch:create']({ crewId: crew.id, title: 'sh', agent: 'shell' })
      await h()['settings:set']({ shell: { file: 'C:\\Windows\\System32\\cmd.exe', args: '' } })
      await h()['scratch:start'](t.id)
      expect(sessions.isRunning(`scratch:${t.id}`)).toBe(true)
      expect(ptys[0]!.written).toEqual([])
    })
  })

  describe('usage breakdown', () => {
    const row = (operatorId: number, over: Record<string, unknown> = {}) =>
      store.addUsage({
        operatorId,
        at: clock - 1_000,
        model: sonnet,
        inputTokens: 1_000,
        outputTokens: 500,
        cacheRead: 9_000,
        cacheW5m: 0,
        cacheW1h: 1_000,
        costUsd: 0.0128,
        contextTokens: 11_000,
        ...over,
      } as never)

    it('splits spend by kind and model, per operator, per job, with hit ratio, cold turns and caps', async () => {
      const { crew, impl, pm } = await seedCrew()
      const job1 = await h()['jobs:create']({ crewId: crew.id, title: 'cheap', review: 'none' })
      const job2 = await h()['jobs:create']({ crewId: crew.id, title: 'costly', review: 'none' })
      row(impl.id, { jobId: job1.id, toolUse: true })
      row(impl.id, { jobId: job2.id, costUsd: 0.5, cold: true, toolUse: true })
      row(pm.id, { model: 'claude-opus-5-5', costUsd: 0.1, outputTokens: 4_000, cacheRead: 0, cacheW1h: 0, inputTokens: 100, contextTokens: 100 })
      store.addUsage({ operatorId: impl.id, at: clock - 40 * 86_400_000, model: sonnet, inputTokens: 1, outputTokens: 1, costUsd: 9 })
      await h()['operators:applyChange'](impl.id, { dailyCapUsd: 1 })

      const b = await h()['usage:breakdown'](crew.id, '24h')
      expect(b.totalUsd).toBeCloseTo(0.6128, 8)
      expect(b.rows.map((r) => `${r.group}/${r.model}`).sort()).toEqual(['operator/claude-opus-5-5', 'operator/claude-sonnet-5-5'])
      const sonnetRow = b.rows.find((r) => r.model === sonnet)!
      expect(sonnetRow).toMatchObject({ inputTokens: 2_000, outputTokens: 1_000, cacheRead: 18_000, cacheW1h: 2_000, turns: 2 })
      // 2000 input at $2, 1000 output at $10, 18000 read at $0.2, 2000 1h-writes at $4 (per million).
      expect(sonnetRow.kindCostUsd.input).toBeCloseTo(0.004, 8)
      expect(sonnetRow.kindCostUsd.output).toBeCloseTo(0.01, 8)
      expect(sonnetRow.kindCostUsd.cacheRead).toBeCloseTo(0.0036, 8)
      expect(sonnetRow.kindCostUsd.cacheWrite).toBeCloseTo(0.008, 8)
      expect(b.byModel.map((m) => m.model)).toEqual([sonnet, 'claude-opus-5-5'])
      expect(b.scratch).toEqual({ costUsd: 0, turns: 0 })

      const o = b.operators.find((x) => x.operatorId === impl.id)!
      expect(o).toMatchObject({ turns: 2, coldCount: 1, address: 'builder@shop', inputTokens: 2_000, cacheRead: 18_000, cacheWrite: 2_000 })
      expect(o.costUsd).toBeCloseTo(0.5128, 8)
      expect(o.hitRatio).toBeCloseTo(18_000 / 22_000, 8)
      expect(o.medianContext).toBe(11_000)
      expect(o.avgCostPerJobUsd).toBeCloseTo(0.2564, 8)
      expect(o.cap).toMatchObject({ capUsd: 1, paused: false })
      expect(o.cap!.spentUsd).toBeCloseTo(0.5128, 8)
      expect(o.cap!.pct).toBeCloseTo(51.28, 6)
      expect(b.operators.find((x) => x.operatorId === pm.id)!.cap).toBeNull()

      expect(b.jobs.map((j) => [j.jobId, j.title, j.turns])).toEqual([[job2.id, 'costly', 1], [job1.id, 'cheap', 1]])
      expect(b.medianJobCostUsd).toBeCloseTo((0.0128 + 0.5) / 2, 8)

      const week = await h()['usage:breakdown'](crew.id, '30d')
      expect(week.totalUsd).toBeCloseTo(0.6128, 8)
      expect(store.spendSince(0)).toBeCloseTo(9.6128, 8)
      expect((await failure(() => h()['usage:breakdown'](crew.id, '1y' as never))).code).toBe('BAD_ARGS')
    })

    it('reports the exact spend since midnight and the cause of the latest cold turn per operator', async () => {
      const { crew, impl, pm } = await seedCrew()
      clock = new Date(2026, 5, 15, 12, 0, 0).getTime()
      const midnight = new Date(2026, 5, 15).getTime()
      const hour = 3_600_000
      row(impl.id, { at: midnight - hour, costUsd: 3 })
      row(impl.id, { at: clock - 2 * hour, costUsd: 0.25 })
      row(impl.id, { at: clock - 1_000, costUsd: 0.5, cold: true })
      row(pm.id, { at: clock - 3 * hour, model: sonnet, costUsd: 0.1 })
      row(pm.id, { at: clock - 2 * hour, model: 'claude-opus-5-5', costUsd: 0.1, cold: true })
      row(pm.id, { at: clock - 1_000, model: 'claude-opus-5-5', costUsd: 0.1 })
      const b = await h()['usage:breakdown'](crew.id, '24h')
      expect(b.today).toBeCloseTo(1.05, 8)
      expect(b.totalUsd).toBeCloseTo(4.05, 8)
      // impl's cold turn followed a gap of two hours, longer than even the 1h cache lifetime.
      expect(b.operators.find((o) => o.operatorId === impl.id)!.lastColdCause).toBe('idle')
      expect(b.operators.find((o) => o.operatorId === pm.id)!.lastColdCause).toBe('model')
      row(impl.id, { at: clock - 500, costUsd: 0.1, cold: true })
      expect((await h()['usage:breakdown'](crew.id, '24h')).operators.find((o) => o.operatorId === impl.id)!.lastColdCause).toBe('prompt')
    })

    it('flags waste: repeated cold turns, output share, no-tool streaks, high context, an outsized job', async () => {
      const { crew, impl } = await seedCrew()
      store.setOperatorLaunch(impl.id, { contextCap: 100_000 })
      for (let i = 0; i < 3; i++) row(impl.id, { cold: true, outputTokens: 4_000, costUsd: 0.05, contextTokens: 95_000, at: clock - 5_000 + i })
      for (let i = 0; i < 5; i++) row(impl.id, { toolUse: false, costUsd: 0.05, outputTokens: 4_000, contextTokens: 95_000, at: clock - 4_000 + i })
      const cheap = await h()['jobs:create']({ crewId: crew.id, title: 'c1', review: 'none' })
      const cheap2 = await h()['jobs:create']({ crewId: crew.id, title: 'c2', review: 'none' })
      const huge = await h()['jobs:create']({ crewId: crew.id, title: 'huge', review: 'none' })
      row(impl.id, { jobId: cheap.id, costUsd: 0.01, toolUse: true, outputTokens: 0 })
      row(impl.id, { jobId: cheap2.id, costUsd: 0.01, toolUse: true, outputTokens: 0 })
      row(impl.id, { jobId: huge.id, costUsd: 0.5, toolUse: true, outputTokens: 0 })

      const b = await h()['usage:breakdown'](crew.id, '24h')
      const kinds = b.waste.map((w) => w.kind).sort()
      expect(kinds).toEqual(['cold-repeated', 'context-high', 'job-cost', 'no-tool-streak', 'output-share'])
      expect(b.waste.find((w) => w.kind === 'job-cost')).toMatchObject({ jobId: huge.id, operatorId: null })
      expect(b.waste.find((w) => w.kind === 'no-tool-streak')).toMatchObject({ operatorId: impl.id, value: 8 })
      expect(b.waste.find((w) => w.kind === 'cold-repeated')).toMatchObject({ value: 3, threshold: 3 })
      // A stricter output-share threshold in Settings is honoured.
      await h()['settings:set']({ tokens: { outputShareWarnPct: 100 } })
      expect((await h()['usage:breakdown'](crew.id, '24h')).waste.map((w) => w.kind)).not.toContain('output-share')
    })
  })

  describe('caps', () => {
    it('reports progress and resumes through caps:reset', async () => {
      const { impl } = await seedCrew()
      await h()['settings:set']({ tokens: { operatorDailyCapUsd: 1 } })
      store.addUsage({ operatorId: impl.id, at: clock, inputTokens: 1, outputTokens: 1, costUsd: 1.5 })
      op.usage.checkCaps()
      let status = await h()['caps:status']()
      expect(status.operators[impl.id]).toMatchObject({ capUsd: 1, spentUsd: 1.5, paused: true })
      expect(status.daily).toBeNull()
      clock += 1_000
      status = await h()['caps:reset'](impl.id)
      expect(status.operators[impl.id]).toMatchObject({ paused: false, spentUsd: 0, pct: 0 })
      expect((await failure(() => h()['caps:reset'](999))).code).toBe('NOT_FOUND')
      await h()['settings:set']({ dailyBudgetUsd: 10 })
      expect((await h()['caps:reset']('daily')).daily).toMatchObject({ capUsd: 10, paused: false })
    })
  })

  describe('purge', () => {
    it('lists deleted operators with blockers and purges on request without changing spend', async () => {
      const { crew, impl } = await seedCrew()
      store.addUsage({ operatorId: impl.id, at: clock, model: sonnet, inputTokens: 100, outputTokens: 10, costUsd: 0.25 })
      await h()['operators:delete'](impl.id)

      let status = await h()['purge:status']()
      expect(status).toMatchObject({ enabled: true, retentionDays: 30 })
      expect(status.candidates).toEqual([
        expect.objectContaining({ operatorId: impl.id, label: 'builder@shop', crewId: crew.id, eligible: false, blockers: [expect.stringContaining('retention')] }),
      ])
      const before = store.spendSince(0, crew.id)
      const outcome = await h()['purge:now'](impl.id)
      expect(outcome[0]).toMatchObject({ purged: true })

      // The manual path ignores retention, so it purged at once; spend is unchanged and the label kept.
      expect(store.spendSince(0, crew.id)).toBeCloseTo(before, 8)
      expect(store.listSpendArchive(crew.id)[0]).toMatchObject({ label: 'builder@shop', costUsd: 0.25 })
      expect(pushesOf('purge')).toContainEqual({ kind: 'operator-purged', crewId: crew.id, operatorId: impl.id, squadId: null, label: 'builder@shop' })
      status = await h()['purge:status']()
      expect(status.candidates).toEqual([])
    })

    it('never lifts the data-safety blockers, and the setting makes a sweep eligible', async () => {
      const { crew, impl, pm } = await seedCrew()
      op.messages.send({ kind: 'operator', operatorId: pm.id }, 'builder', 'ping')
      await h()['operators:delete'](impl.id)
      op.messages.send({ kind: 'user', crewId: crew.id }, 'boss', 'hi')
      // Unread messages from the deleted operator hold it back.
      store.createMessage({ crewId: crew.id, fromKind: 'operator', fromId: impl.id, toKind: 'user', body: 'last words' })
      await h()['settings:set']({ collab: { purgeRetentionDays: 0 } })
      expect((await h()['purge:status']()).candidates[0]).toMatchObject({ eligible: false, blockers: ['1 unread message'] })
      expect((await h()['purge:now']('all'))[0]).toMatchObject({ purged: false, blockers: ['1 unread message'] })
      await h()['messages:markRead'](crew.id)
      expect((await h()['purge:status']()).candidates[0]).toMatchObject({ eligible: true })
      expect((await h()['purge:now']('all'))[0]).toMatchObject({ purged: true })
    })
  })

  describe('graph', () => {
    it('shows the Master node with its membership edge and message edges before the Master was ever started', async () => {
      const { crew, impl } = await seedCrew()
      expect(store.getMaster(crew.id)).toBeNull()
      const g = await h()['graph:get'](crew.id, 'all')
      const master = store.getMaster(crew.id)!
      expect(g.nodes.find((n) => n.key === `op:${master.id}`)).toMatchObject({ type: 'master', operatorId: master.id })
      expect(g.edges.find((e) => e.id === `member:crew>op:${master.id}`)).toMatchObject({ kind: 'member' })
      op.messages.send({ kind: 'master', operatorId: master.id }, 'builder', 'hello')
      op.messages.send({ kind: 'user', crewId: crew.id }, 'master', 'status?')
      const g2 = await h()['graph:get'](crew.id, 'all')
      expect(g2.edges.find((e) => e.id === `message:op:${master.id}>op:${impl.id}`)).toMatchObject({ kind: 'message', count: 1 })
      expect(g2.edges.find((e) => e.id === `message:user>op:${master.id}`)).toMatchObject({ kind: 'message', count: 1 })
      expect(g2.nodes.filter((n) => n.type === 'master')).toHaveLength(1)
    })

    it('returns nodes, aggregated edges and positions, and saves and clears positions', async () => {
      const { crew, squad, impl, pm } = await seedCrew()
      const master = store.ensureMaster(crew.id)
      op.messages.send({ kind: 'user', crewId: crew.id }, 'builder', 'a')
      op.messages.send({ kind: 'user', crewId: crew.id }, 'builder', 'b')
      op.messages.send({ kind: 'operator', operatorId: pm.id }, 'builder', 'c')
      const link = store.createLink(crew.id, pm.id, impl.id, 'delegates')
      const g = await h()['graph:get'](crew.id, 'all')
      expect(g.nodes.map((n) => n.key).sort()).toEqual(['crew', `op:${impl.id}`, `op:${master.id}`, `op:${pm.id}`, `squad:${squad.id}`, 'user'].sort())
      expect(g.nodes.find((n) => n.key === `op:${master.id}`)!.type).toBe('master')
      expect(g.edges.find((e) => e.id === `message:user>op:${impl.id}`)).toMatchObject({ kind: 'message', count: 2, label: '2' })
      expect(g.edges.find((e) => e.id === `message:op:${pm.id}>op:${impl.id}`)).toMatchObject({ count: 1 })
      expect(g.edges.find((e) => e.kind === 'link')).toMatchObject({ linkId: link.id, label: 'delegates' })
      expect(g.edges.filter((e) => e.kind === 'member')).toHaveLength(4)

      clock += 2 * 3_600_000
      expect((await h()['graph:get'](crew.id, '1h')).edges.some((e) => e.kind === 'message')).toBe(false)
      expect((await h()['graph:get'](crew.id, '24h')).edges.some((e) => e.kind === 'message')).toBe(true)

      await h()['graph:savePositions'](crew.id, [{ nodeKey: `op:${impl.id}`, x: 10, y: 20 }, { nodeKey: 'crew', x: 0, y: 0 }])
      expect((await h()['graph:get'](crew.id)).positions).toEqual([
        { crewId: crew.id, nodeKey: 'crew', x: 0, y: 0 },
        { crewId: crew.id, nodeKey: `op:${impl.id}`, x: 10, y: 20 },
      ])
      expect((await failure(() => h()['graph:savePositions'](crew.id, [{ nodeKey: 'x;drop', x: 1, y: 1 }]))).code).toBe('BAD_ARGS')
      expect((await failure(() => h()['graph:savePositions'](crew.id, [{ nodeKey: 'crew', x: NaN, y: 1 }]))).code).toBe('BAD_ARGS')
      await h()['graph:clear'](crew.id)
      expect((await h()['graph:get'](crew.id)).positions).toEqual([])
      expect((await failure(() => h()['graph:get'](crew.id, '1w' as never))).code).toBe('BAD_ARGS')
    })
  })

  describe('settings and launch', () => {
    it('resets a section to its defaults and pushes it', async () => {
      await h()['settings:set']({ tokens: { operatorDailyCapUsd: 3, capWarnPct: 50 }, dailyBudgetUsd: 9 })
      const next = await h()['settings:reset']('tokens')
      expect(next.tokens.operatorDailyCapUsd).toBe(0)
      expect(next.dailyBudgetUsd).toBe(9)
      expect(pushesOf('settings').length).toBe(2)
      expect((await failure(() => h()['settings:reset']('nope' as never))).code).toBe('BAD_ARGS')
    })

    it('passes the cache TTL defaults and the version pin to new launches', async () => {
      const { impl } = await seedCrew()
      await h()['settings:set']({ tokens: { defaultCacheTtl: '1h', subagentCacheTtl: '1h', pinClaudeVersion: false } })
      // The dev machine's own environment is merged under the launch env.
      const inherited = process.env.DISABLE_AUTOUPDATER
      delete process.env.DISABLE_AUTOUPDATER
      try {
        await h()['operators:start'](impl.id)
      } finally {
        if (inherited !== undefined) process.env.DISABLE_AUTOUPDATER = inherited
      }
      const env = ptys[0]!.opts.env
      expect(env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('1h')
      expect(env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL).toBe('1h')
      expect(env.DISABLE_AUTOUPDATER).toBeUndefined()
    })

    it('refuses to launch an agent under cmd.exe with a clear error, but still opens a shell operator', async () => {
      const { crew, squad, impl } = await seedCrew()
      await h()['settings:set']({ shell: { file: 'C:\\Windows\\System32\\cmd.exe', args: '' } })
      await h()['operators:start'](impl.id)
      expect(ptys).toHaveLength(0)
      expect(store.getOperator(impl.id)!.status).toBe('error')
      expect(store.recentEvents(3).find((e) => e.kind === 'error')!.message).toMatch(/cmd\.exe is not supported.*PowerShell or sh/)
      op.startMaster(crew.id)
      expect(ptys).toHaveLength(0)
      const sh = await h()['operators:create']({ squadId: squad.id, role: 'plain', agent: 'shell', model: '-' })
      await h()['operators:start'](sh.id)
      expect(ptys).toHaveLength(1)
    })
  })

  describe('project groups and tools', () => {
    const h = () => op.handlers
    const refused = async (run: () => unknown) => {
      try {
        await run()
      } catch (e) {
        return (e as OperantError).code
      }
      return 'ok'
    }

    it('creates, renames, moves, collapses and deletes groups through the handlers, with codes the dashboard can show', async () => {
      const a = await h()['crews:create']({ name: 'a', folder: '/code/a' })
      const b = await h()['crews:create']({ name: 'b', folder: '/code/b' })
      const g = await h()['groups:create']()
      expect(g.name).toBe('New group')
      expect(await refused(() => h()['groups:create']('new GROUP'))).toBe('CONFLICT')
      expect(await refused(() => h()['groups:rename'](g.id, ' '))).toBe('BAD_ARGS')
      expect(await refused(() => h()['groups:rename'](999, 'x'))).toBe('NOT_FOUND')
      expect((await h()['groups:rename'](g.id, 'Work')).name).toBe('Work')
      const moved = await h()['groups:move'](b.id, g.id, a.id)
      expect(moved.map((c) => [c.name, c.groupId])).toEqual([['b', g.id], ['a', null]])
      expect(await refused(() => h()['groups:move'](b.id, 999))).toBe('NOT_FOUND')
      expect(await refused(() => h()['groups:move'](999, null))).toBe('NOT_FOUND')
      expect((await h()['groups:collapse'](g.id, true)).collapsed).toBe(true)
      expect((await h()['groups:list']())[0]!.collapsed).toBe(true)
      expect((await h()['groups:reorder']([g.id])).map((x) => x.id)).toEqual([g.id])
      await h()['groups:delete'](g.id)
      expect(await h()['groups:list']()).toEqual([])
      expect((await h()['crews:list']()).map((c) => c.groupId)).toEqual([null, null])
    })

    it('deleting a project removes its runs, jobs and tiles but not its group or any folder', async () => {
      const a = await h()['crews:create']({ name: 'a', folder: '/code/a' })
      const g = await h()['groups:create']('Work')
      await h()['groups:move'](a.id, g.id)
      await h()['crews:delete'](a.id)
      expect(await h()['crews:list']()).toEqual([])
      expect((await h()['groups:list']()).map((x) => x.name)).toEqual(['Work'])
    })

    it('opens a shell tile in the project folder and an agent tile with the same call', async () => {
      const a = await h()['crews:create']({ name: 'a', folder: '/code/a' })
      const sh = await h()['scratch:create']({ crewId: a.id, title: 'Shell', agent: 'shell' })
      expect(sh.cwd).toBe('/code/a')
      await h()['scratch:start'](sh.id)
      expect(ptys).toHaveLength(1)
      expect(ptys[0]!.opts.cwd).toBe('/code/a')
    })

    it('git:changes and ide:open refuse an unknown project; ide:list always ends with Custom', async () => {
      expect(await refused(() => h()['git:changes'](999))).toBe('NOT_FOUND')
      expect(await refused(() => h()['ide:open'](999))).toBe('NOT_FOUND')
      const list = await h()['ide:list']()
      expect(list.at(-1)!.id).toBe('custom')
      await h()['settings:set']({ ide: { default: 'custom', custom: 'myide' } })
      expect((await h()['ide:list']()).at(-1)!.available).toBe(true)
    })
  })

  describe('seedFromEnv', () => {
    const FAKE = 'fake-token-for-test'
    it('moves a token into the store for the one bot without one, once, and never over a stored token', () => {
      const secrets = new MemorySecretStore()
      const o = build({ discord: { secrets } })
      const bot = store.createDiscordBot({ name: 'desk' })
      o.seedFromEnv({ DISCORD_BOT_TOKEN: FAKE })
      const stored = store.getDiscordBot(bot.id)!
      expect(secrets.get(stored.tokenRef)).toBe(FAKE)
      const notes = store.recentEvents(50).filter((e) => /imported into the encrypted store/.test(e.message))
      expect(notes).toHaveLength(1)
      expect(notes.some((e) => e.message.includes(FAKE))).toBe(false)
      o.seedFromEnv({ DISCORD_BOT_TOKEN: 'another-fake' })
      expect(secrets.get(stored.tokenRef)).toBe(FAKE)
      expect(store.recentEvents(50).filter((e) => /imported into the encrypted store/.test(e.message))).toHaveLength(1)
    })

    it('keeps the token unused with no bot, or with several bots lacking one', () => {
      const secrets = new MemorySecretStore()
      const o = build({ discord: { secrets } })
      o.seedFromEnv({ DISCORD_BOT_TOKEN: FAKE })
      store.createDiscordBot({ name: 'a' })
      store.createDiscordBot({ name: 'b' })
      o.seedFromEnv({ DISCORD_BOT_TOKEN: FAKE })
      expect(store.listDiscordBots().every((b) => !b.tokenRef)).toBe(true)
    })

    it('seeds the Hindsight URL and key only while those are unset', () => {
      const secrets = new MemorySecretStore()
      const o = build({ discord: { secrets } })
      o.seedFromEnv({ HINDSIGHT_URL: 'http://127.0.0.1:9077', HINDSIGHT_API_KEY: 'fake-key' })
      expect(o.currentSettings.hindsight).toMatchObject({ mode: 'remote', url: 'http://127.0.0.1:9077' })
      expect(secrets.get('hindsight-remote-key')).toBe('fake-key')
      o.seedFromEnv({ HINDSIGHT_URL: 'http://other:1', HINDSIGHT_API_KEY: 'second' })
      expect(o.currentSettings.hindsight.url).toBe('http://127.0.0.1:9077')
      expect(secrets.get('hindsight-remote-key')).toBe('fake-key')
    })
  })
})
