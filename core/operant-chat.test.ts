import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CrewIndexes, IndexStatus } from './codegraph'
import type { ChatChild } from './claude-chat'
import type { LearnService } from './learn'
import { Operant, type CliAccess, type Scheduler } from './operant'
import { SessionManager, type Pty, type PtyFactory } from './sessions'
import { Store } from './store'
import type { ChatOp } from '../shared/claude-chat'

class FakePty implements Pty {
  written: string[] = []
  exit: (e: { exitCode: number }) => void = () => {}
  constructor(
    readonly file: string,
    readonly opts: { cwd: string; env: Record<string, string> },
  ) {}
  write(d: string) {
    this.written.push(d)
    if (d.includes('/exit')) this.exit({ exitCode: 0 })
  }
  resize() {}
  kill() {
    this.exit({ exitCode: 0 })
  }
  onData() {}
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exit = cb
  }
}

class FakeChatChild extends EventEmitter {
  written: Array<Record<string, any>> = []
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin = {
    write: (s: string) => {
      for (const l of s.split('\n')) if (l) this.written.push(JSON.parse(l))
      return true
    },
    end: () => this.emit('close', 0, null),
    on: () => undefined,
  }
  kill() {
    this.emit('close', null, 'SIGTERM')
  }
  out(o: unknown) {
    this.stdout.emit('data', `${JSON.stringify(o)}\n`)
  }
}

const cli: CliAccess = { address: '/tmp/op.sock', issueToken: (id) => `t${id}`, revokeToken: () => undefined, listen: async () => '/tmp/op.sock', close: async () => undefined }
const scheduler: Scheduler = { every: () => ({}), cancel: () => undefined }
const idle: IndexStatus = { initialized: false, indexing: false, files: 0, symbols: 0, edges: 0 }
const indexes = { status: () => idle, index: async () => idle } as unknown as CrewIndexes

describe('Operant: Chat view tiles', () => {
  let store: Store
  let op: Operant
  let ptys: FakePty[]
  let children: Array<{ spawn: { file: string; args: string[]; env: Record<string, string>; shell: boolean }; child: FakeChatChild }>
  let bin: string
  let learned: Array<[number, string | null]>
  let pushed: Array<{ scratchId: number; ops: ChatOp[] }>

  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), 'operant-bin-'))
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'claude'), '')
    store = new Store(':memory:')
    ptys = []
    children = []
    learned = []
    pushed = []
    const spawn: PtyFactory = (file, _args, opts) => {
      const p = new FakePty(file, opts)
      ptys.push(p)
      return p
    }
    op = new Operant({
      store,
      sessions: new SessionManager(spawn),
      indexes,
      pluginDir: '/plugin',
      transcriptFile: (_cwd, id) => join(bin, `${id}.jsonl`),
      cliServer: () => cli,
      scheduler,
      learnModel: async () => '[]',
      learn: { learnNow: async (crewId: number, sessionId: string | null) => void learned.push([crewId, sessionId]) } as unknown as LearnService,
      launch: { platform: 'linux', launchDir: '/data/launch', rolesDir: '/data/roles', cliDir: '/app/cli', operantNode: '/app/operant', baseEnv: { PATH: bin }, writer: { mkdir: () => {}, writeFile: () => {} } },
      chatSpawn: (spec) => {
        const child = new FakeChatChild()
        children.push({ spawn: spec, child })
        return child as unknown as ChatChild
      },
    })
    op.on('chat:ops', (e) => pushed.push(e))
    op.handlers['settings:set']({ learn: { mode: 'suggest' } })
  })
  afterEach(() => {
    store.close()
    rmSync(bin, { recursive: true, force: true })
  })

  const makeTile = (agent: 'claude' | 'shell' = 'claude') => {
    const crew = store.listCrews().find((c) => c.name === 'shop') ?? store.createCrew('shop', '/code/shop')
    return op.handlers['scratch:create']({ crewId: crew.id, title: 'work', agent, model: 'claude-sonnet-5-5' }) as { id: number; view: string }
  }
  const lastChild = () => children.at(-1)!

  it('opens new Claude tiles in the Chat view, other tiles in the Terminal view', () => {
    expect(makeTile().view).toBe('chat')
    expect(makeTile('shell').view).toBe('terminal')
  })

  it('starts one stream-json process with the tile launch flags and the cleaned environment', () => {
    const t = makeTile()
    const status = op.startScratch(t.id)
    expect(status).toMatchObject({ running: true, view: 'chat' })
    expect(ptys).toHaveLength(0)
    const { spawn, child } = lastChild()
    expect(spawn.file).toBe(join(bin, 'claude'))
    expect(spawn.shell).toBe(false)
    expect(spawn.args.slice(0, 5)).toEqual(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json'])
    expect(spawn.args).toContain('--session-id')
    expect(spawn.env.OPERANT_SOCKET).toBe('/tmp/op.sock')
    expect(spawn.env.OPERANT_TOKEN).toBe(`t${t.id}`)
    expect(child.written[0]).toMatchObject({ request: { subtype: 'initialize' } })
    expect(op.handlers['chat:snapshot'](t.id)).toMatchObject({ scratchId: t.id, process: 'starting' })
    // already running: left alone
    op.startScratch(t.id)
    expect(children).toHaveLength(1)
  })

  it('blocks the tile when Claude Code is not on PATH', () => {
    rmSync(join(bin, 'claude'))
    const t = makeTile()
    op.startScratch(t.id)
    expect(children).toHaveLength(0)
    expect(op.handlers['chat:snapshot'](t.id)).toMatchObject({ process: 'blocked' })
  })

  it('pushes batched ops, takes messages and prompt answers through the handlers', () => {
    const t = makeTile()
    op.startScratch(t.id)
    const { child } = lastChild()
    op.handlers['chat:send'](t.id, { text: 'hello' })
    expect(child.written.at(-1)).toMatchObject({ type: 'user', message: { content: [{ type: 'text', text: 'hello' }] } })
    child.out({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'tu' } })
    op.chat.flush()
    expect(pushed.length).toBeGreaterThan(0)
    expect(pushed.flatMap((p) => p.ops).some((o) => o.op === 'upsert' && o.item.kind === 'permission')).toBe(true)
    op.handlers['chat:permission'](t.id, 'r1', { kind: 'allow' })
    expect(child.written.at(-1)).toMatchObject({ type: 'control_response', response: { request_id: 'r1', response: { behavior: 'allow' } } })
    expect(() => op.handlers['chat:permission'](t.id, 'r1', { kind: 'allow' })).toThrow(/no longer waiting/)
    expect(() => op.handlers['chat:send'](t.id, { text: 5 as unknown as string })).toThrow()
    op.handlers['chat:setEffort'](t.id, 'high')
    expect(store.getScratch(t.id)!.effort).toBe('high')
    expect(() => op.handlers['chat:setEffort'](t.id, 'galaxy')).toThrow()
  })

  it('closing the tile ends the process and runs the learn step once', async () => {
    const t = makeTile()
    op.startScratch(t.id)
    const sessionId = store.getScratch(t.id)!.sessionId
    op.stopScratch(t.id)
    await op.chat.stop(t.id)
    expect(op.scratchStatus(t.id).running).toBe(false)
    expect(learned).toEqual([[store.getScratch(t.id)!.crewId, sessionId]])
  })

  it('switches Chat -> Terminal -> Chat between turns on the same session, without learning', async () => {
    const t = makeTile()
    op.startScratch(t.id)
    const sessionId = store.getScratch(t.id)!.sessionId!
    const first = lastChild()
    first.child.out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-opus-5-5', permissionMode: 'default' })
    op.handlers['chat:send'](t.id, { text: 'busy' })
    await expect(op.handlers['scratch:setView'](t.id, 'terminal')).rejects.toMatchObject({ code: 'CONFLICT' })
    first.child.out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 5, total_cost_usd: 0.01 })
    writeFileSync(join(bin, `${sessionId}.jsonl`), '{}') // Claude has saved the turn

    const status = await op.handlers['scratch:setView'](t.id, 'terminal')
    expect(status).toMatchObject({ running: true, view: 'terminal', sessionId })
    expect(store.getScratch(t.id)!.view).toBe('terminal')
    expect(ptys).toHaveLength(1)
    expect(ptys[0]!.written.join('')).toContain(`--resume ${sessionId}`)
    expect(op.chat.has(t.id)).toBe(false)

    const back = await op.handlers['scratch:setView'](t.id, 'chat')
    expect(back).toMatchObject({ running: true, view: 'chat', sessionId })
    expect(ptys[0]!.written.join('')).toContain('/exit\r')
    expect(children).toHaveLength(2)
    expect(children[1]!.spawn.args).toContain('--resume')
    expect(learned).toEqual([])
  })

  it('switches a fresh tile (no turn yet, no transcript) with the same session id, never --resume', async () => {
    const t = makeTile()
    op.startScratch(t.id)
    const sessionId = store.getScratch(t.id)!.sessionId!
    lastChild().child.out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-opus-5-5', permissionMode: 'default' })

    const status = await op.handlers['scratch:setView'](t.id, 'terminal')
    expect(status).toMatchObject({ running: true, view: 'terminal', sessionId })
    const cmd = ptys[0]!.written.join('')
    expect(cmd).toContain(`--session-id ${sessionId}`)
    expect(cmd).not.toContain('--resume')

    const back = await op.handlers['scratch:setView'](t.id, 'chat')
    expect(back).toMatchObject({ running: true, view: 'chat', sessionId })
    expect(children).toHaveLength(2)
    expect(children[1]!.spawn.args).toContain('--session-id')
    expect(children[1]!.spawn.args).not.toContain('--resume')
    expect(store.getScratch(t.id)!.sessionId).toBe(sessionId)
  })

  it('keeps the old view and clears the switching flag when the other side cannot start', async () => {
    const t = makeTile()
    op.startScratch(t.id)
    lastChild().child.out({ type: 'system', subtype: 'init', session_id: store.getScratch(t.id)!.sessionId, model: 'claude-opus-5-5', permissionMode: 'default' })
    store.updateScratch(t.id, { model: 'bad model;' })
    await expect(op.handlers['scratch:setView'](t.id, 'terminal')).rejects.toBeTruthy()
    expect(store.getScratch(t.id)!.view).toBe('chat')
    store.updateScratch(t.id, { model: 'claude-sonnet-5-5' })
    await expect(op.handlers['scratch:setView'](t.id, 'terminal')).resolves.toMatchObject({ view: 'terminal' })
    await expect(op.handlers['scratch:setView'](t.id, 'chat')).resolves.toMatchObject({ view: 'chat' })
  })

  it('refuses a view switch for tiles that are not Claude Code', async () => {
    const t = makeTile('shell')
    await expect(op.handlers['scratch:setView'](t.id, 'chat')).rejects.toMatchObject({ code: 'BAD_ARGS' })
  })

  it('keeps the old conversation items when a closed tile is reopened with resume', async () => {
    const t = makeTile()
    op.startScratch(t.id)
    op.handlers['chat:send'](t.id, { text: 'first question' })
    op.stopScratch(t.id)
    await op.chat.stop(t.id)
    op.startScratch(t.id, { resume: true })
    expect(children).toHaveLength(2)
    const texts = (await op.handlers['chat:snapshot'](t.id)).items.map((i) => (i.kind === 'user' ? i.text : i.kind))
    expect(texts).toContain('first question')
    expect(children[1]!.spawn.args).toContain('--session-id')
  })

  it('stops chat processes on quit', async () => {
    const t = makeTile()
    op.startScratch(t.id)
    await op.shutdown()
    expect(op.chat.isRunning(t.id)).toBe(false)
  })
})

void vi
