import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { emptyChatState, reduceChat, type ChatOp, type ChatState } from '../shared/claude-chat'
import { ChatHub, ChatSession, cmdArg, coalesceOps, type ChatChild, type ChatLaunchSpec, type ChatSessionDeps } from './claude-chat'
import { parseStatusFile } from './claude-events'
import { resolveCli } from './proc'

const root = mkdtempSync(join(tmpdir(), 'operant-chat-'))
afterEach(() => undefined)
process.on('exit', () => rmSync(root, { recursive: true, force: true }))

const fixture = (name: string): Array<Record<string, unknown>> =>
  readFileSync(join(__dirname, 'fixtures', 'chat', `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)

class FakeChild extends EventEmitter {
  written: Array<Record<string, any>> = []
  killed = false
  closeOnEnd = true
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin = {
    write: (s: string) => {
      for (const l of s.split('\n')) if (l) this.written.push(JSON.parse(l))
      return true
    },
    end: () => {
      if (this.closeOnEnd) this.exit(0)
    },
    on: () => undefined,
  }
  kill() {
    this.killed = true
    this.exit(null, 'SIGTERM')
  }
  exit(code: number | null, signal: string | null = null) {
    this.emit('close', code, signal)
  }
  out(line: unknown) {
    this.stdout.emit('data', Buffer.from(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`))
  }
  last() {
    return this.written[this.written.length - 1]!
  }
  withType(type: string) {
    return this.written.filter((w) => w.type === type)
  }
}

function harness(over: Partial<ChatSessionDeps> = {}, transcript?: string) {
  const dir = mkdtempSync(join(root, 't-'))
  const children: FakeChild[] = []
  const pushed: ChatOp[] = []
  const timers: Array<{ id: number; fn: () => void; ms: number }> = []
  const exits: Array<{ code: number | null; expected: boolean }> = []
  const waiting: Array<{ type: string; message: string } | null> = []
  const launches: boolean[] = []
  let timerId = 0
  let t = 1_000_000
  const transcriptFile = transcript ?? join(dir, 'proj', 's1.jsonl')
  const session = new ChatSession({
    scratchId: 9,
    sessionId: 's1',
    cwd: dir,
    transcriptFile,
    statusFile: join(dir, 'events', 'status-s1.json'),
    launch: (resume): ChatLaunchSpec => {
      launches.push(resume)
      return { file: 'claude', args: ['-p'], cwd: dir, env: {}, shell: false }
    },
    emit: (ops) => pushed.push(...ops),
    spawn: () => {
      const c = new FakeChild()
      children.push(c)
      return c as unknown as ChatChild
    },
    now: () => (t += 5),
    setTimer: (fn, ms) => {
      const id = ++timerId
      timers.push({ id, fn, ms })
      return id
    },
    clearTimer: (h) => {
      const i = timers.findIndex((x) => x.id === h)
      if (i >= 0) timers.splice(i, 1)
    },
    onExit: (i) => exits.push(i),
    onWaiting: (w) => waiting.push(w),
    ...over,
  })
  const fire = (ms: number) => {
    for (const x of timers.filter((y) => y.ms === ms)) {
      timers.splice(timers.indexOf(x), 1)
      x.fn()
    }
  }
  const stream = (c: FakeChild, lines: unknown[]) => {
    for (const l of lines) c.out(l)
  }
  const mirror = (): ChatState => reduceChat(emptyChatState(9), pushed)
  return { session, children, pushed, timers, exits, waiting, launches, dir, fire, stream, mirror, advance: (ms: number) => (t += ms) }
}

const initResponse = () => fixture('mod').find((l) => l.type === 'control_response')!

describe('ChatSession: process and protocol', () => {
  it('sends initialize first, becomes ready on its answer, then asks for the context breakdown', () => {
    const h = harness()
    h.session.start()
    const c = h.children[0]!
    expect(c.written[0]).toEqual({ type: 'control_request', request_id: 'init', request: { subtype: 'initialize' } })
    expect(h.session.state.process).toBe('starting')
    c.out(initResponse())
    expect(h.session.state.process).toBe('ready')
    expect(h.session.state.models.length).toBeGreaterThan(0)
    expect(c.written[1]).toMatchObject({ type: 'control_request', request: { subtype: 'get_context_usage' } })
    expect(h.session.state.contextUsage).toBeNull()
    expect(h.launches).toEqual([false])
  })

  it('parses stdout robustly: partial lines, blank lines and garbage', () => {
    const h = harness()
    h.session.start()
    const c = h.children[0]!
    const text = fixture('perm')
      .map((l) => JSON.stringify(l))
      .join('\n')
    const noise = `\n\nnot json at all\n${text}\n`
    for (let i = 0; i < noise.length; i += 37) c.stdout.emit('data', noise.slice(i, i + 37))
    const kinds = h.session.state.items.map((i) => i.kind)
    expect(kinds).toContain('tool')
    expect(kinds).toContain('permission')
    expect(h.session.state.process).toBe('ready')
  })

  it('writes a user message with images first and marks later messages queued', () => {
    const h = harness()
    h.session.start()
    const c = h.children[0]!
    h.session.send({ text: ' look at this ', images: [{ mediaType: 'image/png', base64: 'AAAA' }, { mediaType: 'text/html', base64: 'x' }] })
    expect(c.last()).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }, { type: 'text', text: 'look at this' }] },
      parent_tool_use_id: null,
      session_id: 's1',
    })
    h.session.send({ text: 'and this' })
    const users = h.session.state.items.filter((i) => i.kind === 'user')
    expect(users.map((u) => (u.kind === 'user' ? [u.text, u.queued, u.images.length] : null))).toEqual([['look at this', false, 1], ['and this', true, 0]])
    h.session.send({ text: '   ' })
    expect(c.withType('user')).toHaveLength(2)
    expect(h.session.state.turn.phase).toBe('working')
  })

  it('answers a permission prompt with the control_response Claude Code expects', () => {
    const h = harness()
    h.session.start()
    const c = h.children[0]!
    const lines = fixture('perm')
    const at = lines.findIndex((l) => l.type === 'control_request')
    h.stream(c, lines.slice(0, at + 1))
    const req = lines[at]!
    expect(h.session.state.turn).toMatchObject({ phase: 'waiting', pendingCount: 1 })
    expect(h.waiting.at(-1)).toMatchObject({ type: 'permission_prompt' })
    expect(h.session.busy).toBe(true)
    expect(h.session.answer(req.request_id as string, { kind: 'allow' })).toBe(true)
    expect(c.last()).toEqual({
      type: 'control_response',
      response: { subtype: 'success', request_id: req.request_id, response: { behavior: 'allow', updatedInput: (req.request as { input: unknown }).input } },
    })
    expect(h.waiting.at(-1)).toBeNull()
    expect(h.session.answer(req.request_id as string, { kind: 'allow' })).toBe(false)
    h.stream(c, lines.slice(at + 1))
    expect(h.session.state.turn.phase).toBe('idle')
    expect(h.session.busy).toBe(false)
    expect(h.mirror().items.map((i) => i.kind)).toEqual(h.session.state.items.map((i) => i.kind))
  })

  it('answers a question and sends always/deny bodies', () => {
    const h = harness()
    h.session.start()
    const c = h.children[0]!
    const lines = fixture('ask')
    const at = lines.findIndex((l) => l.type === 'control_request')
    h.stream(c, lines.slice(0, at + 1))
    const id = lines[at]!.request_id as string
    h.session.answer(id, { kind: 'answer', answers: { 'Do you prefer red or blue?': 'Blue' } })
    expect(c.last().response.response).toMatchObject({ behavior: 'allow', updatedInput: { answers: { 'Do you prefer red or blue?': 'Blue' } } })
    const h2 = harness()
    h2.session.start()
    const c2 = h2.children[0]!
    const al = fixture('always')
    const reqs = al.filter((l) => l.type === 'control_request' && (l.request as { subtype?: string }).subtype === 'can_use_tool')
    const upTo = al.indexOf(reqs[0]!)
    h2.stream(c2, al.slice(0, upTo + 1))
    h2.session.answer(reqs[0]!.request_id as string, { kind: 'always', index: 0 })
    expect(c2.last().response.response).toMatchObject({ behavior: 'allow', updatedPermissions: [{ type: 'addRules', behavior: 'allow' }] })
    h2.stream(c2, al.slice(upTo + 1, al.indexOf(reqs[1]!) + 1))
    h2.session.answer(reqs[1]!.request_id as string, { kind: 'deny', message: 'nope' })
    expect(c2.last().response.response).toEqual({ behavior: 'deny', message: 'nope' })
  })

  it('interrupts: sends the request, clears the grace timer on the result, kills after 5 s otherwise', () => {
    const h = harness()
    h.session.start()
    const c = h.children[0]!
    h.session.send({ text: 'count' })
    h.session.interrupt()
    expect(c.last()).toMatchObject({ type: 'control_request', request: { subtype: 'interrupt' } })
    expect(h.timers.map((x) => x.ms)).toContain(5000)
    h.stream(c, fixture('interrupt').filter((l) => l.type === 'user' || l.type === 'result'))
    expect(h.timers.map((x) => x.ms)).not.toContain(5000)
    expect(h.session.state.items.filter((i) => i.kind === 'notice').map((n) => (n.kind === 'notice' ? n.text : ''))).toContain('Interrupted')

    const h2 = harness()
    h2.session.start()
    const c2 = h2.children[0]!
    h2.session.send({ text: 'count' })
    h2.session.interrupt()
    h2.fire(5000)
    expect(c2.killed).toBe(true)
    expect(h2.exits).toEqual([{ code: null, expected: true }])
    expect(h2.session.state.process).toBe('stopped')
    expect(h2.session.state.turn.phase).toBe('stopped')
    // the next message resumes the session in a new process
    h2.session.send({ text: 'again' })
    expect(h2.children).toHaveLength(2)
    expect(h2.children[1]!.withType('user')).toHaveLength(1)
  })

  it('shows a crash card with stderr and restarts on demand; three crashes in a minute stop the auto restart', () => {
    const h = harness()
    h.session.start()
    h.session.send({ text: 'work' })
    const c = h.children[0]!
    c.stderr.emit('data', 'line 1\nline 2\n')
    c.exit(1)
    const s = h.session.state
    expect(s.process).toBe('crashed')
    const crash = s.items.find((i) => i.kind === 'notice' && i.source === 'crash')!
    expect(crash).toMatchObject({ text: 'Claude Code stopped (exit 1)', detail: 'line 1\nline 2', actions: ['restart', 'terminal'] })
    expect(h.exits).toEqual([{ code: 1, expected: false }])
    h.session.restart()
    expect(h.children).toHaveLength(2)
    expect(h.session.state.process).toBe('starting')
    h.children[1]!.exit(2)
    h.session.send({ text: 'retry' })
    expect(h.children).toHaveLength(3)
    h.children[2]!.exit(3)
    h.advance(100)
    expect(h.session.crashLoop).toBe(false)
    h.session.send({ text: 'retry again' })
    expect(h.children).toHaveLength(4)
    h.children[3]!.exit(4)
    expect(h.session.crashLoop).toBe(true)
    h.session.send({ text: 'once more' })
    expect(h.children).toHaveLength(4)
    expect(h.session.state.items.at(-1)).toMatchObject({ kind: 'notice', text: expect.stringContaining('keeps stopping') })
  })

  it('stops by closing stdin, and kills after 3 s when the process does not exit', async () => {
    const h = harness()
    h.session.start()
    await h.session.stop()
    expect(h.exits).toEqual([{ code: 0, expected: true }])
    expect(h.session.state.process).toBe('stopped')
    expect(h.session.state.items.some((i) => i.kind === 'notice' && i.source === 'crash')).toBe(false)

    const h2 = harness()
    h2.session.start()
    h2.children[0]!.closeOnEnd = false
    const p = h2.session.stop()
    h2.fire(3000)
    await p
    expect(h2.children[0]!.killed).toBe(true)
  })

  it('writes mode, model and effort changes', () => {
    const h = harness()
    h.session.start()
    const c = h.children[0]!
    c.out(initResponse())
    h.session.setMode('acceptEdits')
    expect(c.last()).toMatchObject({ request: { subtype: 'set_permission_mode', mode: 'acceptEdits' } })
    h.session.setModel('claude-sonnet-5-5')
    expect(c.last()).toMatchObject({ request: { subtype: 'set_model', model: 'claude-sonnet-5-5' } })
    h.session.setMode('bad mode!')
    h.session.setModel('x y')
    const n = c.written.length
    h.session.setEffort('high')
    expect(c.last()).toEqual({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '/effort high' }] }, parent_tool_use_id: null, session_id: 's1' })
    expect(h.session.state.effort).toBe('high')
    expect(c.written.length).toBe(n + 1)
    expect(h.session.state.items.some((i) => i.kind === 'user')).toBe(false)
    h.session.setEffort('not valid')
    expect(c.written.length).toBe(n + 1)
    // the local reply becomes a notice, not a command card
    c.out({ type: 'assistant', message: { id: 'x', model: '<synthetic>', content: [{ type: 'text', text: 'Set effort level to medium (this session only): Balanced' }] }, local_command_source: '<local-command-stdout>Set effort level to medium (this session only)</local-command-stdout>' })
    expect(h.session.state.items.at(-1)).toMatchObject({ kind: 'notice', text: 'Effort set to Medium (this session)' })
    expect(h.session.state.effort).toBe('medium')
  })

  it('retries the start while the other view still holds the session id', () => {
    const h = harness()
    h.session.start()
    h.children[0]!.stderr.emit('data', 'Error: Session ID s1 is already in use.\n')
    h.children[0]!.exit(1)
    expect(h.session.state.process).toBe('starting')
    expect(h.exits).toEqual([])
    h.fire(1000)
    expect(h.children).toHaveLength(2)
    h.children[1]!.out(initResponse())
    expect(h.session.state.process).toBe('ready')
  })

  it('keeps an effort picked while no process runs, without starting one', () => {
    const h = harness()
    h.session.setEffort('high')
    expect(h.children).toHaveLength(0)
    expect(h.session.state.effort).toBe('high')
  })

  it('maps the context request: throttled, free of turns, and stored for the card', () => {
    const h = harness()
    h.session.start()
    const c = h.children[0]!
    c.out(initResponse())
    const ctx = () => c.written.filter((w) => w.request?.subtype === 'get_context_usage')
    expect(ctx()).toHaveLength(1)
    h.session.requestContext()
    expect(ctx()).toHaveLength(1)
    h.advance(6000)
    h.session.requestContext()
    expect(ctx()).toHaveLength(2)
    h.session.requestContext(true)
    expect(ctx()).toHaveLength(3)
    const resp = fixture('ctx').find((l) => l.type === 'control_response' && (l.response as { request_id?: string }).request_id === 'ctx-1')!
    c.out({ ...resp, response: { ...(resp.response as object), request_id: ctx().at(-1)!.request_id } })
    expect(h.session.state.contextUsage?.rows).toHaveLength(8)
    expect(h.session.state.contextUsage?.tickPct).toBeCloseTo(96.7)
  })

  it('does not start a missing or too old CLI', () => {
    const h = harness({ launch: () => ({ file: 'claude', args: [], cwd: '.', env: {}, shell: false, blocked: 'Claude Code was not found on PATH.' }) })
    h.session.start()
    expect(h.children).toHaveLength(0)
    expect(h.session.state.process).toBe('blocked')
    expect(h.session.state.items.at(-1)).toMatchObject({ kind: 'notice', text: 'Claude Code was not found on PATH.', actions: ['terminal'] })
    const h2 = harness({
      launch: () => {
        throw new Error('Chat needs Claude Code 2.1 or newer')
      },
    })
    h2.session.start()
    expect(h2.session.state.process).toBe('blocked')
  })
})

describe('ChatSession: the status file', () => {
  it('writes what the status line wrote (model, context, cost) plus the breakdown, carrying earlier cost', () => {
    const h = harness()
    mkdirSync(join(h.dir, 'events'), { recursive: true })
    writeFileSync(join(h.dir, 'events', 'status-s1.json'), JSON.stringify({ cost: { total_cost_usd: 1.5, total_duration_ms: 1000 } }))
    h.session.start()
    const c = h.children[0]!
    c.out(initResponse())
    h.stream(c, fixture('perm').filter((l) => l.type !== 'control_request'))
    const resp = fixture('ctx').find((l) => l.type === 'control_response' && (l.response as { request_id?: string }).request_id === 'ctx-1')!
    c.out({ ...resp, response: { ...(resp.response as object), request_id: c.written.filter((w) => w.request?.subtype === 'get_context_usage').at(-1)!.request_id } })
    h.fire(250)
    const status = parseStatusFile(readFileSync(join(h.dir, 'events', 'status-s1.json'), 'utf8'))!
    expect(status.model).toBe('Haiku 5.5')
    expect(status.contextWindowSize).toBe(1_000_000)
    expect(status.costUsd).toBeCloseTo(1.5 + 0.0101331, 5)
    expect(status.currentUsage).toMatchObject({ inputTokens: 2, cacheReadTokens: 43090, cacheCreationTokens: 4239 })
    expect(status.usedPercentage).toBeGreaterThan(0)
    expect(status.breakdown?.rows).toHaveLength(8)
    expect(status.durationMs).toBeGreaterThan(1000)
  })
})

describe('ChatSession: history', () => {
  const user = (i: number) => JSON.stringify({ type: 'user', uuid: `u${i}`, message: { role: 'user', content: `message ${i}` } })

  it('rebuilds the conversation from the transcript, newest 300 first, and pages older items', () => {
    const dir = mkdtempSync(join(root, 'h-'))
    const file = join(dir, 's1.jsonl')
    writeFileSync(file, Array.from({ length: 350 }, (_, i) => user(i)).join('\n'))
    const h = harness({}, file)
    const snap = h.session.snapshot()
    expect(snap.items).toHaveLength(300)
    expect(snap).toMatchObject({ hasEarlier: true, historyStart: 50, process: 'stopped', sessionId: 's1' })
    expect(snap.items[0]).toMatchObject({ text: 'message 50' })
    const page = h.session.historyPage(snap.historyStart)
    expect(page.historyStart).toBe(0)
    expect(page.items).toHaveLength(50)
    expect(page.items[0]).toMatchObject({ text: 'message 0' })
    expect(h.session.state).toMatchObject({ hasEarlier: false, historyStart: 0 })
    expect(h.session.state.items).toHaveLength(350)
    expect(h.session.historyPage(0).items).toEqual([])
  })

  it('resumes after a restart: history first, then the live process continues it', () => {
    const dir = mkdtempSync(join(root, 'h-'))
    const file = join(dir, 's1.jsonl')
    writeFileSync(file, [user(1), JSON.stringify({ type: 'assistant', uuid: 'a', message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'hello' }] } })].join('\n'))
    const h = harness({}, file)
    h.session.start()
    expect(h.launches).toEqual([true])
    expect(h.session.state.items.map((i) => i.kind)).toEqual(['user', 'text'])
    h.session.send({ text: 'more' })
    expect(h.session.state.items.map((i) => i.kind)).toEqual(['user', 'text', 'user'])
  })

  it('reads a sub-agent conversation from its sidechain file', () => {
    const dir = mkdtempSync(join(root, 'h-'))
    const file = join(dir, 's1.jsonl')
    writeFileSync(file, '')
    const sub = join(dir, 's1', 'subagents')
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, 'agent-abc.meta.json'), JSON.stringify({ agentType: 'Explore', toolUseId: 'toolu_1' }))
    writeFileSync(
      join(sub, 'agent-abc.jsonl'),
      [
        JSON.stringify({ type: 'user', uuid: 's1', isSidechain: true, message: { role: 'user', content: 'Explore it' } }),
        JSON.stringify({ type: 'assistant', uuid: 's2', isSidechain: true, message: { id: 'sm', model: 'x', content: [{ type: 'text', text: 'Explored' }] } }),
      ].join('\n'),
    )
    const h = harness({}, file)
    const items = h.session.agentHistory('toolu_1')
    expect(items.map((i) => [i.kind, 'parent' in i ? i.parent : null])).toEqual([['user', 'toolu_1'], ['text', 'toolu_1']])
    expect(h.session.agentHistory('toolu_missing')).toEqual([])
  })
})

describe('batching', () => {
  const text = (id: string, md: string) => ({ kind: 'text' as const, id, parent: null, md, streaming: true })

  it('coalesces upserts, appends and meta in order', () => {
    const ops: ChatOp[] = [
      { op: 'meta', patch: { model: 'a' } },
      { op: 'upsert', item: text('t1', 'He') },
      { op: 'append', id: 't1', text: 'llo' },
      { op: 'append', id: 'old', text: 'x' },
      { op: 'append', id: 'old', text: 'y' },
      { op: 'upsert', item: text('t2', '') },
      { op: 'upsert', item: { ...text('t1', 'Hello world'), streaming: false } },
      { op: 'meta', patch: { permissionMode: 'plan' } },
    ]
    const out = coalesceOps(ops)
    expect(out).toEqual([
      { op: 'meta', patch: { model: 'a', permissionMode: 'plan' } },
      { op: 'upsert', item: { ...text('t1', 'Hello world'), streaming: false } },
      { op: 'append', id: 'old', text: 'xy' },
      { op: 'upsert', item: text('t2', '') },
    ])
    expect(reduceChat(emptyChatState(1), ops)).toEqual(reduceChat(emptyChatState(1), out))
  })

  it('pushes once per batch from a one-shot timer, merged', () => {
    const pushes: Array<{ id: number; ops: ChatOp[] }> = []
    const timers: Array<() => void> = []
    const hub = new ChatHub({ push: (id, ops) => pushes.push({ id, ops }), setTimer: (fn) => (timers.push(fn), timers.length), clearTimer: () => undefined })
    let emit!: (ops: ChatOp[]) => void
    const stub = new ChatSession({ scratchId: 3, sessionId: 's', cwd: '.', transcriptFile: join(root, 'none.jsonl'), launch: () => ({ file: 'claude', args: [], cwd: '.', env: {}, shell: false }), emit: () => undefined })
    const s = hub.ensure(3, (e) => {
      emit = e
      return stub
    })
    expect(hub.ensure(3, () => stub)).toBe(s)
    emit([{ op: 'upsert', item: text('t', 'a') }])
    emit([{ op: 'append', id: 't', text: 'b' }])
    emit([{ op: 'meta', patch: { model: 'm' } }])
    expect(timers).toHaveLength(1)
    expect(pushes).toHaveLength(0)
    timers[0]!()
    expect(pushes).toEqual([{ id: 3, ops: [{ op: 'upsert', item: text('t', 'ab') }, { op: 'meta', patch: { model: 'm' } }] }])
    emit([{ op: 'meta', patch: { model: 'n' } }])
    expect(timers).toHaveLength(2)
    expect(hub.isRunning(3)).toBe(false)
    hub.forget(3)
    expect(hub.has(3)).toBe(false)
  })
})

describe('spawn helpers', () => {
  it('quotes shell arguments and refuses what cannot be quoted', () => {
    expect(cmdArg('stream-json')).toBe('stream-json')
    expect(cmdArg('C:\\Users\\Some One\\file.json')).toBe('"C:\\Users\\Some One\\file.json"')
    expect(() => cmdArg('a"b')).toThrow()
    expect(() => cmdArg('a&b')).toThrow()
    expect(() => cmdArg('C:\\dir\\')).toThrow()
  })

  it('starts a native exe directly and a .cmd through the shell', () => {
    const env = { PATH: 'C:\\a;C:\\b' }
    const has = (set: string[]) => (p: string) => set.includes(p.replace(/\//g, '\\'))
    expect(resolveCli('claude', env, 'win32', has(['C:\\b\\claude.exe']))).toMatchObject({ shell: false })
    expect(resolveCli('claude', env, 'win32', has(['C:\\a\\claude.cmd']))).toMatchObject({ shell: true })
    expect(resolveCli('claude', env, 'win32', has([]))).toBeNull()
    expect(resolveCli('claude', { PATH: '/usr/bin' }, 'linux', (p) => p.endsWith('claude'))).toMatchObject({ shell: false })
  })
})
