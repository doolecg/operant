import { describe, expect, it } from 'vitest'
import type { Operator } from '../shared/types'
import { SessionManager, type Pty, type PtyFactory } from './sessions'

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
  emitExit() {
    this.exitCb({ exitCode: 0 })
  }
}

const operator = (over: Partial<Operator> = {}): Operator => ({
  id: 1,
  squadId: 1,
  role: 'lead',
  agent: 'claude',
  model: 'opus',
  status: 'stopped',
  kind: 'worker',
  presetId: null,
  effort: '',
  permissionMode: 'default',
  tools: '',
  allow: [],
  deny: [],
  cacheTtl: 'auto',
  contextCap: 0,
  clearBetweenJobs: true,
  mcp: 'codegraph',
  roleText: null,
  dailyCapUsd: null,
  sessionId: null,
  modified: false,
  ...over,
})

function setup() {
  const clock = { t: 1_000 }
  const ptys: FakePty[] = []
  const spawn: PtyFactory = (file, _args, opts) => {
    const p = new FakePty(file, opts)
    ptys.push(p)
    return p
  }
  const mgr = new SessionManager(spawn, { platform: 'linux', home: '/h', env: {} }, () => clock.t, (fn) => fn())
  return { mgr, ptys, clock }
}

describe('SessionManager', () => {
  it('starts a shell in the crew folder, sets operator env and types the launch command and first input', () => {
    const { mgr, ptys } = setup()
    mgr.start({ operator: operator(), address: 'lead@shop', cwd: '/code/shop', command: 'claude --model opus', firstInput: 'Read /r.md and follow it as your role.' })
    const p = ptys[0]!
    expect(p.file).toBe('/bin/bash')
    expect(p.opts.cwd).toBe('/code/shop')
    expect(p.opts.env.OPERANT_OPERATOR).toBe('lead@shop')
    expect(p.written).toEqual(['claude --model opus\r', 'Read /r.md and follow it as your role.\r'])
    expect(mgr.isRunning(1)).toBe(true)
  })

  it('holds the first input of a launch that waits for its TUI until the screen has been drawn and gone quiet', () => {
    const clock = { t: 1_000 }
    const ptys: FakePty[] = []
    const timers: Array<() => void> = []
    const spawn: PtyFactory = (file, _args, opts) => {
      const p = new FakePty(file, opts)
      ptys.push(p)
      return p
    }
    const mgr = new SessionManager(spawn, { platform: 'linux', home: '/h', env: {} }, () => clock.t, (fn) => void timers.push(fn))
    const run = () => timers.splice(0).forEach((fn) => fn())
    mgr.start({ operator: operator(), address: 'm@shop', cwd: '/code/shop', command: 'opencode', firstInput: 'Read /r.md and follow it as your role.', firstInputWhenReady: true })
    const p = ptys[0]!
    expect(p.written).toEqual(['opencode\r'])
    // Only the shell echo so far: not ready.
    p.emitData('opencode\r\n')
    clock.t += 5_000
    run()
    expect(p.written).toEqual(['opencode\r'])
    // The TUI paints, then settles.
    p.emitData('x'.repeat(3000))
    clock.t += 200
    run()
    expect(p.written).toEqual(['opencode\r'])
    clock.t += 3_000
    run()
    run()
    expect(p.written).toEqual(['opencode\r', 'Read /r.md and follow it as your role.', '\r'])
  })

  describe('first input held for a TUI', () => {
    function waiting() {
      const clock = { t: 1_000 }
      const ptys: FakePty[] = []
      const timers: Array<() => void> = []
      const spawn: PtyFactory = (file, _args, opts) => {
        const p = new FakePty(file, opts)
        ptys.push(p)
        return p
      }
      const mgr = new SessionManager(spawn, { platform: 'linux', home: '/h', env: {} }, () => clock.t, (fn) => void timers.push(fn))
      const run = () => timers.splice(0).forEach((fn) => fn())
      return { mgr, ptys, clock, timers, run }
    }
    const spec = { operator: operator(), address: 'm@shop', cwd: '/code/shop', command: 'opencode', firstInput: 'Read /r.md and follow it as your role.', firstInputWhenReady: true }

    it('stops polling and types nothing when the session exits before the TUI is ready', () => {
      const { mgr, ptys, clock, timers, run } = waiting()
      mgr.start(spec)
      const p = ptys[0]!
      p.emitData('x'.repeat(3000))
      p.emitExit()
      clock.t += 10_000
      run()
      run()
      expect(p.written).toEqual(['opencode\r'])
      expect(timers).toHaveLength(0)
    })

    it('does not type into a new session that took over the key after the first one exited', () => {
      const { mgr, ptys, clock, run } = waiting()
      mgr.start(spec)
      ptys[0]!.emitExit()
      mgr.start({ ...spec, firstInput: undefined, firstInputWhenReady: false })
      clock.t += 10_000
      run()
      expect(ptys[0]!.written).toEqual(['opencode\r'])
    })

    it('types the line anyway after 30 seconds if the screen never settles', () => {
      const { mgr, ptys, clock, run } = waiting()
      mgr.start(spec)
      const p = ptys[0]!
      for (let i = 0; i < 40; i++) {
        p.emitData('.')
        clock.t += 1_000
        run()
      }
      run()
      expect(p.written.slice(0, 2)).toEqual(['opencode\r', 'Read /r.md and follow it as your role.'])
    })

    it('still refuses a non-pointer line when waiting for ready', () => {
      const { mgr, ptys } = waiting()
      expect(() => mgr.start({ ...spec, firstInput: 'rm -rf /' })).toThrow('not a fixed')
      expect(ptys).toHaveLength(0)
    })

    it('types the first line immediately when the launch does not wait (Claude, Codex)', () => {
      const { mgr, ptys } = waiting()
      mgr.start({ ...spec, command: 'claude', firstInputWhenReady: false })
      expect(ptys[0]!.written).toEqual(['claude\r', 'Read /r.md and follow it as your role.\r'])
    })
  })

  it('refuses a first input that is not a role-file pointer', () => {
    const { mgr, ptys } = setup()
    expect(() => mgr.start({ operator: operator(), address: 'a@b', cwd: '/', command: 'codex -m gpt-5', firstInput: 'rm -rf /' })).toThrow('not a fixed')
    expect(() => mgr.start({ operator: operator(), address: 'a@b', cwd: '/', command: 'codex', firstInput: 'Read /r.md and follow it as your role.\nrm x' })).toThrow('not a fixed')
    expect(ptys).toHaveLength(0)
  })

  it('uses a shell override for operators started after it is set', () => {
    const { mgr, ptys } = setup()
    mgr.setShell({ file: '/usr/bin/fish', args: [] })
    mgr.start({ operator: operator({ agent: 'shell' }), address: 'a@b', cwd: '/' })
    mgr.setShell(null)
    mgr.start({ operator: operator({ id: 2, agent: 'shell' }), address: 'c@b', cwd: '/' })
    expect(ptys.map((p) => p.file)).toEqual(['/usr/bin/fish', '/bin/bash'])
  })

  it('does not start an operator twice', () => {
    const { mgr, ptys } = setup()
    const spec = { operator: operator(), address: 'a@b', cwd: '/' }
    mgr.start(spec)
    mgr.start(spec)
    expect(ptys).toHaveLength(1)
  })

  it('types nothing for a plain shell operator', () => {
    const { mgr, ptys } = setup()
    mgr.start({ operator: operator({ agent: 'shell' }), address: 'a@b', cwd: '/' })
    expect(ptys[0]!.written).toEqual([])
  })

  it('emits data, buffers it for replay, and forwards writes and resizes', () => {
    const { mgr, ptys } = setup()
    const seen: string[] = []
    mgr.on('data', (_id, d) => seen.push(d))
    mgr.start({ operator: operator({ agent: 'shell' }), address: 'a@b', cwd: '/' })
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
    mgr.start({ operator: operator({ agent: 'shell' }), address: 'a@b', cwd: '/' })
    ptys[0]!.emitData('x'.repeat(300 * 1024))
    expect(mgr.buffer(1).length).toBe(256 * 1024)
  })

  it('emits exit and forgets the session when stopped', () => {
    const { mgr } = setup()
    const exits: number[] = []
    mgr.on('exit', (id) => exits.push(id))
    mgr.start({ operator: operator(), address: 'a@b', cwd: '/' })
    mgr.stop(1)
    expect(exits).toEqual([1])
    expect(mgr.isRunning(1)).toBe(false)
    expect(mgr.buffer(1)).toBe('')
  })

  it('accepts string keys, merges extra env and emits keys', () => {
    const { mgr, ptys } = setup()
    const all: [number | string, string][] = []
    const ops: number[] = []
    mgr.on('sessionData', (k, d) => all.push([k, d]))
    mgr.on('data', (id) => ops.push(id))
    mgr.start({ operator: operator({ agent: 'shell' }), address: 'a@b', cwd: '/', key: 'scratch:7', env: { OPERANT_SOCKET: 's' } })
    expect(ptys[0]!.opts.env.OPERANT_SOCKET).toBe('s')
    expect(mgr.isRunning('scratch:7')).toBe(true)
    expect(mgr.isRunning(1)).toBe(false)
    ptys[0]!.emitData('x')
    expect(all).toEqual([['scratch:7', 'x']])
    expect(ops).toEqual([])
    mgr.write('scratch:7', 'ls\r')
    expect(ptys[0]!.written).toEqual(['ls\r'])
    mgr.stop('scratch:7')
    expect(mgr.isRunning('scratch:7')).toBe(false)
  })

  it('tracks idle time from the last output', () => {
    const { mgr, ptys, clock } = setup()
    expect(mgr.idleMs(1)).toBeNull()
    mgr.start({ operator: operator({ agent: 'shell' }), address: 'a@b', cwd: '/' })
    clock.t += 3_000
    expect(mgr.idleMs(1)).toBe(3_000)
    expect(mgr.isIdle(1, 5)).toBe(false)
    clock.t += 2_000
    expect(mgr.isIdle(1, 5)).toBe(true)
    ptys[0]!.emitData('out')
    expect(mgr.idleMs(1)).toBe(0)
    expect(mgr.isIdle(1, 5)).toBe(false)
  })

  it('types only fixed lines, with Enter', () => {
    const { mgr, ptys } = setup()
    mgr.start({ operator: operator({ agent: 'shell' }), address: 'a@b', cwd: '/' })
    expect(mgr.typeFixed(1, '/clear')).toBe(true)
    expect(mgr.typeFixed(1, 'Operant: you have 2 unread messages. Run: operant inbox')).toBe(true)
    expect(() => mgr.typeFixed(1, 'ls')).toThrow()
    expect(mgr.typeFixed(9, '/clear')).toBe(false)
    expect(ptys[0]!.written).toEqual(['/clear', '\r', 'Operant: you have 2 unread messages. Run: operant inbox', '\r'])
    mgr.typeFixed(1, 'Operant: resume JOB#20003. Run: operant run show 20003', { clearFirst: true })
    expect(ptys[0]!.written.slice(-3)).toEqual(['\x15', 'Operant: resume JOB#20003. Run: operant run show 20003', '\r'])
  })

  it("tracks the owner's typing (not terminal replies) and their unsent draft", () => {
    const { mgr, clock } = setup()
    mgr.start({ operator: operator({ agent: 'shell' }), address: 'a@b', cwd: '/' })
    expect(mgr.ownerIdleMs(1)).toBeNull()
    mgr.write(1, '\x1b[I\x1b[12;5R')
    expect(mgr.ownerIdleMs(1)).toBeNull()
    mgr.write(1, 'fix the')
    expect(mgr.ownerDraft(1)).toBe(true)
    clock.t += 3_000
    expect(mgr.ownerIdleMs(1)).toBe(3_000)
    mgr.write(1, ' bug\r')
    expect(mgr.ownerDraft(1)).toBe(false)
    expect(mgr.ownerIdleMs(1)).toBe(0)
  })

  it('does not pass an outer OPERANT_* or ELECTRON_RUN_AS_NODE variables on, but keeps the per-session ones', () => {
    const saved = { ...process.env }
    process.env.OPERANT_TOKEN = 'outer-token'
    process.env.OPERANT_SOCKET = '/outer.sock'
    process.env.OPERANT_OPERATOR = 'outer@crew'
    process.env.ELECTRON_RUN_AS_NODE = '1'
    process.env.KEEP_ME = 'yes'
    try {
      const { mgr, ptys } = setup()
      mgr.start({ operator: operator(), address: 'lead@shop', cwd: '/', env: { OPERANT_TOKEN: 'mine' } })
      mgr.start({ key: 'scratch:1', cwd: '/' })
      const [op, scratch] = ptys.map((p) => p.opts.env)
      expect(op).toMatchObject({ OPERANT_OPERATOR: 'lead@shop', OPERANT_OPERATOR_ID: '1', OPERANT_TOKEN: 'mine', KEEP_ME: 'yes' })
      expect(op!.OPERANT_SOCKET).toBeUndefined()
      expect(op!.ELECTRON_RUN_AS_NODE).toBeUndefined()
      expect(Object.keys(scratch!).filter((k) => k.startsWith('OPERANT_') || k === 'ELECTRON_RUN_AS_NODE')).toEqual([])
      expect(scratch!.KEEP_ME).toBe('yes')
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
      Object.assign(process.env, saved)
    }
  })

  it('forceStop drops a session whose pty ignores kill, reports one exit and ignores a late real exit', () => {
    const { mgr, ptys } = setup()
    const exits: number[] = []
    mgr.on('exit', (id) => exits.push(id))
    mgr.start({ operator: operator(), address: 'a@b', cwd: '/' })
    const p = ptys[0]!
    p.kill = () => {}
    mgr.stop(1)
    expect(mgr.isRunning(1)).toBe(true)
    expect(mgr.forceStop(1)).toBe(true)
    expect(mgr.isRunning(1)).toBe(false)
    expect(exits).toEqual([1])
    p.emitExit()
    expect(exits).toEqual([1])
    expect(mgr.forceStop(1)).toBe(false)
  })
})
