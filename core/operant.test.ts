import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IpcEvents } from '../shared/ipc'
import type { IndexStatus, CrewIndexes } from './codegraph'
import { Operant } from './operant'
import { SessionManager, type Pty, type PtyFactory } from './sessions'
import { Store } from './store'

class FakePty implements Pty {
  written: string[] = []
  exit: (e: { exitCode: number }) => void = () => {}
  data: (d: string) => void = () => {}
  write(d: string) {
    this.written.push(d)
  }
  resize() {}
  kill() {
    this.exit({ exitCode: 0 })
  }
  onData(cb: (d: string) => void) {
    this.data = cb
  }
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exit = cb
  }
}

const idle: IndexStatus = { initialized: false, indexing: false, files: 0, symbols: 0, edges: 0 }
const fakeIndexes = { status: () => idle, index: async () => ({ ...idle, initialized: true, files: 3 }) } as unknown as CrewIndexes

describe('Operant', () => {
  let store: Store
  let ptys: FakePty[]
  let op: Operant
  let pushed: Array<{ name: keyof IpcEvents; payload: unknown }>
  let transcripts: string

  beforeEach(() => {
    transcripts = mkdtempSync(join(tmpdir(), 'operant-tx-'))
    store = new Store(':memory:', () => Date.now())
    ptys = []
    const spawn: PtyFactory = () => {
      const p = new FakePty()
      ptys.push(p)
      return p
    }
    op = new Operant({
      store,
      sessions: new SessionManager(spawn),
      indexes: fakeIndexes,
      pluginDir: '/plugin',
      transcriptFile: (_cwd, id) => join(transcripts, `${id}.jsonl`),
    })
    pushed = []
    for (const name of ['event', 'operator:data', 'operator:status', 'index:status', 'usage', 'settings'] as const)
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

  it('creates a crew with squads and operators and logs events', async () => {
    const { crew } = await seedOperator()
    expect(crew.name).toBe('shop')
    const messages = store.recentEvents(10).map((e) => e.message)
    expect(messages).toEqual(['Operator lead@shop added', 'Crew shop created'])
    expect(store.recentEvents(10).every((e) => e.crewId === crew.id)).toBe(true)
  })

  it('starts an operator in the crew folder and marks it running, then stopped on exit', async () => {
    const { operator } = await seedOperator()
    await op.handlers['operators:start'](operator.id)
    expect(ptys).toHaveLength(1)
    expect(ptys[0]!.written[0]).toContain('claude --model opus --plugin-dir /plugin')
    expect(store.getOperator(operator.id)!.status).toBe('running')

    ptys[0]!.data('hi')
    expect(pushed).toContainEqual({ name: 'operator:data', payload: { operatorId: operator.id, data: 'hi' } })
    expect(await op.handlers['operators:buffer'](operator.id)).toBe('hi')

    await op.handlers['operators:stop'](operator.id)
    expect(store.getOperator(operator.id)!.status).toBe('stopped')
    expect(pushed.filter((p) => p.name === 'operator:status').map((p) => p.payload)).toEqual([
      { operatorId: operator.id, status: 'running' },
      { operatorId: operator.id, status: 'stopped' },
    ])
  })

  it('marks an operator as error when its shell exits non-zero', async () => {
    const { operator } = await seedOperator()
    await op.handlers['operators:start'](operator.id)
    ptys[0]!.exit({ exitCode: 1 })
    expect(store.getOperator(operator.id)!.status).toBe('error')
  })

  it('summarises operators, open tasks and spend for the dashboard', async () => {
    const { crew, operator } = await seedOperator()
    await op.handlers['operators:start'](operator.id)
    const t = await op.handlers['tasks:create']({ crewId: crew.id, title: 'A' })
    await op.handlers['tasks:create']({ crewId: crew.id, title: 'B' })
    await op.handlers['tasks:move'](t.id, 'done')
    store.addUsage({ operatorId: operator.id, at: Date.now(), inputTokens: 1, outputTokens: 1, cacheTokens: 0, costUsd: 0.42 })
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
    const sessionId = /--session-id (\S+)/.exec(ptys[0]!.written[0]!)![1]!
    const file = join(transcripts, `${sessionId}.jsonl`)
    const line = (id: string, output: number) =>
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date().toISOString(),
        message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 1_000, output_tokens: output, cache_read_input_tokens: 9_000 } },
      }) + '\n'

    op.pollUsage() // no transcript yet
    appendFileSync(file, line('m1', 100) + line('m1', 100) + line('m2', 50_000))
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
  })

  it('persists settings, pushes them, and applies the shell override to new operators', async () => {
    const saved = await op.handlers['settings:set']({ shell: { file: '/bin/zsh', args: '-l -i' }, dailyBudgetUsd: 5 })
    expect(saved.shell).toEqual({ file: '/bin/zsh', args: '-l -i' })
    expect(store.getJson('settings')).toEqual(saved)
    expect(pushed.some((p) => p.name === 'settings')).toBe(true)
    expect((await op.handlers['dashboard:summary']()).dailyBudgetUsd).toBe(5)

    const spawned: Array<{ file: string; args: string[] }> = []
    const op2 = new Operant({
      store,
      sessions: new SessionManager((file, args) => {
        spawned.push({ file, args })
        return new FakePty()
      }),
      indexes: fakeIndexes,
      pluginDir: '/p',
    })
    const { operator } = await seedOperator()
    await op2.handlers['operators:start'](operator.id)
    expect(spawned).toEqual([{ file: '/bin/zsh', args: ['-l', '-i'] }])
  })

  it('logs one budget warning per day once spend reaches the budget', async () => {
    await op.handlers['settings:set']({ dailyBudgetUsd: 0.5 })
    const { operator } = await seedOperator()
    await op.handlers['operators:start'](operator.id)
    const sessionId = /--session-id (\S+)/.exec(ptys[0]!.written[0]!)![1]!
    const file = join(transcripts, `${sessionId}.jsonl`)
    const line = (id: string) =>
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date().toISOString(),
        message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 0, output_tokens: 20_000 } },
      }) + '\n'
    appendFileSync(file, line('a')) // $0.40
    op.pollUsage()
    expect(store.recentEvents(50).filter((e) => e.kind === 'budget')).toHaveLength(0)
    appendFileSync(file, line('b') + line('c'))
    op.pollUsage()
    appendFileSync(file, line('d'))
    op.pollUsage()
    const warnings = store.recentEvents(50).filter((e) => e.kind === 'budget')
    expect(warnings.map((e) => e.message)).toEqual(['Daily budget of $0.50 reached ($1.20 spent today)'])
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
})
