import { describe, expect, it } from 'vitest'
import { createOpenCodeAdapter, eventFor, findService, listChildSessions, type ChildLike, type OpenCodeDeps } from './opencode'

type FakeChild = ChildLike & { out(s: string): void; emit(ev: string, v?: unknown): void; killed: boolean }

function fakeChild(): FakeChild {
  const handlers: Record<string, ((v?: unknown) => void)[]> = {}
  const outs: ((d: string) => void)[] = []
  const c: FakeChild = {
    stdout: { on: (_e, cb) => outs.push(cb as (d: string) => void) },
    stderr: { on: () => undefined },
    on: ((ev: string, cb: (v?: unknown) => void) => void (handlers[ev] ||= []).push(cb)) as ChildLike['on'],
    kill() {
      c.killed = true
      c.emit('close', null)
      return true
    },
    killed: false,
    out: (s) => outs.forEach((f) => f(s)),
    emit: (ev, v) => (handlers[ev] || []).forEach((f) => f(v)),
  }
  return c
}

const svc = { url: 'http://127.0.0.1:9/', password: 'pw' }
const readJson = (f: string) => (f.includes('state') ? svc : null)
const base = (child: FakeChild, extra: Partial<OpenCodeDeps> = {}): Partial<OpenCodeDeps> => ({
  spawn: () => child,
  readJson: () => null,
  sleep: async () => undefined,
  newSessionId: () => 'ses_x',
  ...extra,
})

describe('opencode adapter', () => {
  it('finds the service and strips the trailing slash', () => {
    expect(findService({ readJson })?.url).toBe('http://127.0.0.1:9')
    expect(findService({ readJson })?.auth).toBe('Basic ' + Buffer.from('opencode:pw').toString('base64'))
    expect(findService({ readJson: () => null })).toBeNull()
  })

  it('runs a pinned session and resolves with the output', async () => {
    const child = fakeChild()
    let args: string[] = []
    const events: { kind: string; text?: string }[] = []
    const a = createOpenCodeAdapter(base(child, { spawn: (_c, ar) => ((args = ar), child) }))
    const h = await a.start({ cwd: '/p', prompt: 'do it', model: 'm/x', onEvent: (e) => events.push(e) })
    expect(args).toEqual(['run', '--session', 'ses_x', '--model', 'm/x', 'do it'])
    child.out('hello')
    child.emit('close', 0)
    expect(await h.done).toEqual({ ok: true, text: 'hello' })
    expect(events[0]).toEqual({ kind: 'session', text: 'ses_x' })
    expect(events[1]).toEqual({ kind: 'output', text: 'hello' })
  })

  it('passes the effort as the #variant suffix of --model', async () => {
    const child = fakeChild()
    let args: string[] = []
    await createOpenCodeAdapter(base(child, { spawn: (_c, ar) => ((args = ar), child) })).start({ cwd: '/p', prompt: 'x', model: 'm/x', effort: 'high', onEvent: () => undefined })
    expect(args).toEqual(['run', '--session', 'ses_x', '--model', 'm/x#high', 'x'])
  })

  it('adds --auto only for the permissive permission modes', async () => {
    const argsFor = async (permissionMode?: string) => {
      const child = fakeChild()
      let args: string[] = []
      await createOpenCodeAdapter(base(child, { spawn: (_c, ar) => ((args = ar), child) })).start({ cwd: '/p', prompt: 'x', permissionMode, onEvent: () => undefined })
      return args
    }
    expect(await argsFor('acceptEdits')).toEqual(['run', '--session', 'ses_x', '--auto', 'x'])
    expect(await argsFor('bypassPermissions')).toEqual(['run', '--session', 'ses_x', '--auto', 'x'])
    for (const mode of ['default', 'manual', 'dontAsk', 'plan', 'auto', '', undefined]) {
      expect(await argsFor(mode)).toEqual(['run', '--session', 'ses_x', 'x'])
    }
  })

  it('reports a failed exit as not ok', async () => {
    const child = fakeChild()
    const h = await createOpenCodeAdapter(base(child)).start({ cwd: '/p', prompt: 'x', onEvent: () => undefined })
    child.emit('close', 2)
    expect((await h.done).ok).toBe(false)
  })

  it('gives a clear error when opencode is missing', async () => {
    const child = fakeChild()
    const p = createOpenCodeAdapter(
      base(child, { sleep: async () => void child.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' })) }),
    ).start({ cwd: '/p', prompt: 'x', onEvent: () => undefined })
    await expect(p).rejects.toThrow(/not installed or not on PATH/)
  })

  it('stop interrupts the session through the service and kills the process', async () => {
    const child = fakeChild()
    const calls: string[] = []
    const a = createOpenCodeAdapter(
      base(child, {
        readJson,
        fetch: async (url, init) => {
          calls.push(`${init?.method ?? 'GET'} ${url}`)
          return { ok: true, status: 200, json: async () => ({}), body: null }
        },
      }),
    )
    const h = await a.start({ cwd: '/p', prompt: 'x', onEvent: () => undefined })
    await h.stop()
    expect(calls).toContain('POST http://127.0.0.1:9/api/session/ses_x/interrupt')
    expect(child.killed).toBe(true)
    expect((await h.done).ok).toBe(false)
  })

  it('maps service events', () => {
    const tools = new Map<string, string>()
    expect(eventFor('session.tool.input.started', { id: 't', name: 'bash' }, tools)).toBeNull()
    expect(eventFor('session.tool.called', { id: 't' }, tools)).toEqual({ kind: 'tool', text: 'bash' })
    expect(eventFor('session.tool.failed', { id: 't', error: { message: 'bad' } }, tools)).toEqual({ kind: 'tool-error', text: 'bad' })
    expect(eventFor('session.text.ended', { text: 'hi' }, tools)).toEqual({ kind: 'text', text: 'hi' })
    expect(eventFor('session.nope', {}, tools)).toBeNull()
  })

  it('lists child sessions', async () => {
    const fetch: OpenCodeDeps['fetch'] = async () => ({
      ok: true,
      status: 200,
      body: null,
      json: async () => ({ data: [{ id: 'c1', parentID: 'ses_x', title: 'Sub', agent: 'explore', model: { id: 'm', providerID: 'p', variant: 'high' }, outcome: 'succeeded', location: { directory: '/p' } }] }),
    })
    expect(await listChildSessions('ses_x', { readJson, fetch })).toEqual([
      { id: 'c1', title: 'Sub', agent: 'explore', directory: '/p', model: 'p/m', done: true },
    ])
    expect(await listChildSessions('ses_x', { readJson: () => null, fetch })).toEqual([])
  })
})
