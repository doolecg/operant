import { describe, expect, it } from 'vitest'
import type { Operator } from '../shared/types'
import { agentCommand, SessionManager, type Pty, type PtyFactory } from './sessions'

class FakePty implements Pty {
  written: string[] = []
  size = [0, 0]
  private dataCb: (d: string) => void = () => {}
  private exitCb: (e: { exitCode: number }) => void = () => {}
  constructor(
    readonly file: string,
    readonly opts: Parameters<PtyFactory>[2],
  ) {}
  write(d: string) {
    this.written.push(d)
  }
  resize(c: number, r: number) {
    this.size = [c, r]
  }
  kill() {
    this.exitCb({ exitCode: 0 })
  }
  onData(cb: (d: string) => void) {
    this.dataCb = cb
  }
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exitCb = cb
  }
  emitData(d: string) {
    this.dataCb(d)
  }
}

const operator = (over: Partial<Operator> = {}): Operator => ({
  id: 1,
  squadId: 1,
  role: 'lead',
  agent: 'claude',
  model: 'opus',
  status: 'stopped',
  ...over,
})

function setup() {
  const ptys: FakePty[] = []
  const spawn: PtyFactory = (file, _args, opts) => {
    const p = new FakePty(file, opts)
    ptys.push(p)
    return p
  }
  const mgr = new SessionManager(spawn, { platform: 'linux', home: '/h', env: {} })
  return { mgr, ptys }
}

describe('agentCommand', () => {
  it('builds per-agent launch lines', () => {
    expect(agentCommand('claude', 'opus', '/p/plugin')).toBe('claude --model opus --plugin-dir /p/plugin')
    expect(agentCommand('claude', 'opus', 'C:\\Program Files\\op')).toBe(
      'claude --model opus --plugin-dir "C:\\Program Files\\op"',
    )
    expect(agentCommand('claude', 'opus', '/p', 'abc-123')).toBe('claude --model opus --plugin-dir /p --session-id abc-123')
    expect(agentCommand('codex', 'gpt-5', '/p')).toBe('codex -m gpt-5')
    expect(agentCommand('shell', '-', '/p')).toBeNull()
  })
})

describe('SessionManager', () => {
  it('starts a shell in the crew folder, sets operator env and types the agent command', () => {
    const { mgr, ptys } = setup()
    mgr.start({ operator: operator(), address: 'lead@shop', cwd: '/code/shop', pluginDir: '/plug' })
    const p = ptys[0]!
    expect(p.file).toBe('/bin/bash')
    expect(p.opts.cwd).toBe('/code/shop')
    expect(p.opts.env.OPERANT_OPERATOR).toBe('lead@shop')
    expect(p.written).toEqual(['claude --model opus --plugin-dir /plug\r'])
    expect(mgr.isRunning(1)).toBe(true)
  })

  it('uses a shell override for operators started after it is set', () => {
    const { mgr, ptys } = setup()
    mgr.setShell({ file: '/usr/bin/fish', args: [] })
    mgr.start({ operator: operator({ agent: 'shell' }), address: 'a@b', cwd: '/', pluginDir: '/p' })
    mgr.setShell(null)
    mgr.start({ operator: operator({ id: 2, agent: 'shell' }), address: 'c@b', cwd: '/', pluginDir: '/p' })
    expect(ptys.map((p) => p.file)).toEqual(['/usr/bin/fish', '/bin/bash'])
  })

  it('does not start an operator twice', () => {
    const { mgr, ptys } = setup()
    const spec = { operator: operator(), address: 'a@b', cwd: '/', pluginDir: '/p' }
    mgr.start(spec)
    mgr.start(spec)
    expect(ptys).toHaveLength(1)
  })

  it('types nothing for a plain shell operator', () => {
    const { mgr, ptys } = setup()
    mgr.start({ operator: operator({ agent: 'shell' }), address: 'a@b', cwd: '/', pluginDir: '/p' })
    expect(ptys[0]!.written).toEqual([])
  })

  it('emits data, buffers it for replay, and forwards writes and resizes', () => {
    const { mgr, ptys } = setup()
    const seen: string[] = []
    mgr.on('data', (_id, d) => seen.push(d))
    mgr.start({ operator: operator({ agent: 'shell' }), address: 'a@b', cwd: '/', pluginDir: '/p' })
    ptys[0]!.emitData('hello ')
    ptys[0]!.emitData('world')
    expect(seen).toEqual(['hello ', 'world'])
    expect(mgr.buffer(1)).toBe('hello world')
    mgr.write(1, 'ls\r')
    mgr.resize(1, 100, 40)
    mgr.resize(1, 0, 0)
    expect(ptys[0]!.written).toEqual(['ls\r'])
    expect(ptys[0]!.size).toEqual([100, 40])
  })

  it('caps the replay buffer', () => {
    const { mgr, ptys } = setup()
    mgr.start({ operator: operator({ agent: 'shell' }), address: 'a@b', cwd: '/', pluginDir: '/p' })
    ptys[0]!.emitData('x'.repeat(300 * 1024))
    expect(mgr.buffer(1).length).toBe(256 * 1024)
  })

  it('emits exit and forgets the session when stopped', () => {
    const { mgr } = setup()
    const exits: number[] = []
    mgr.on('exit', (id) => exits.push(id))
    mgr.start({ operator: operator(), address: 'a@b', cwd: '/', pluginDir: '/p' })
    mgr.stop(1)
    expect(exits).toEqual([1])
    expect(mgr.isRunning(1)).toBe(false)
    expect(mgr.buffer(1)).toBe('')
  })
})
