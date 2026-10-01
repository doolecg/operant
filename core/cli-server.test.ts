import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'vite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CliServer, MAX_REQUEST_BYTES, socketPath } from './cli-server'
import { Collab, EXIT } from './collab'
import { DEFAULT_JOB_SETTINGS, JobEngine } from './jobs'
import { MessageBus, type MessageTimers } from './messages'
import { Store } from './store'

const posix = process.platform !== 'win32'

interface FakeTimer {
  fn: () => void
  at: number
  live: boolean
}

// Sends raw bytes and resolves with everything the server wrote before closing.
function raw(path: string, data: string | Buffer): Promise<string> {
  return new Promise((done, fail) => {
    const s = connect(path)
    const chunks: Buffer[] = []
    s.on('connect', () => s.write(data))
    s.on('data', (c: Buffer) => chunks.push(c))
    s.on('error', fail)
    s.on('close', () => done(Buffer.concat(chunks).toString('utf8')))
  })
}

describe('CliServer', () => {
  let clock: number
  let dir: string
  let store: Store
  let bus: MessageBus
  let jobs: JobEngine
  let server: CliServer
  let timers: FakeTimer[]
  let crewId: number
  let a: number
  let b: number
  let path: string

  const fakeTimers: MessageTimers = {
    set(fn, ms) {
      const t: FakeTimer = { fn, at: clock + ms, live: true }
      timers.push(t)
      return t
    },
    clear(h) {
      ;(h as FakeTimer).live = false
    },
  }
  const live = () => timers.filter((t) => t.live)
  const ask = async (token: string, cmd: string, args: Record<string, unknown> = {}) =>
    JSON.parse(await raw(path, `${JSON.stringify({ token, cmd, args })}\n`)) as { exit: number; text?: string; error?: string; data?: unknown }

  beforeEach(async () => {
    clock = 1_700_000_000_000
    timers = []
    dir = mkdtempSync(join(tmpdir(), 'op-'))
    store = new Store(':memory:', () => clock)
    jobs = new JobEngine(store, () => clock, () => DEFAULT_JOB_SETTINGS)
    bus = new MessageBus({ store, now: () => clock, timers: fakeTimers })
    const collab = new Collab({ store, jobs, messages: bus, now: () => clock })
    crewId = store.createCrew('shop', '/p').id
    const squad = store.createSquad(crewId, 'dev')
    a = store.createOperator(squad.id, 'builder', 'claude', 'm').id
    b = store.createOperator(squad.id, 'fixer', 'claude', 'm').id
    server = new CliServer({ collab, dir })
    path = await server.listen()
  })
  afterEach(async () => {
    await server.close()
    bus.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('uses a random pipe name or a short private socket path', () => {
    if (posix) {
      expect(path.startsWith(join(dir, `operant2-${process.getuid!()}`))).toBe(true)
      expect(Buffer.byteLength(path)).toBeLessThan(104)
    } else expect(path).toMatch(/^\\\\\.\\pipe\\operant2-[0-9a-f]{32}$/)
    expect(server.address).toBe(path)
    expect(socketPath(dir)).not.toBe(path)
  })

  it.skipIf(!posix)('keeps the socket 0600 in a 0700 directory and removes it on close', async () => {
    expect(statSync(join(dir, `operant2-${process.getuid!()}`)).mode & 0o777).toBe(0o700)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    await server.close()
    expect(existsSync(path)).toBe(false)
  })

  it('answers a request made with a valid token', async () => {
    const token = server.issueToken(a)
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    const r = await ask(token, 'whoami')
    expect(r.exit).toBe(EXIT.OK)
    expect(r.text).toContain('builder@shop')
  })

  it('refuses bad, missing and malformed tokens with no other information', async () => {
    server.issueToken(a)
    const forbidden = { exit: EXIT.FORBIDDEN, error: 'forbidden' }
    expect(await ask(randomBytes(32).toString('hex'), 'whoami')).toEqual(forbidden)
    expect(await ask('nope', 'whoami')).toEqual(forbidden)
    expect(JSON.parse(await raw(path, '{"cmd":"whoami"}\n'))).toEqual(forbidden)
    expect(await ask(randomBytes(32).toString('hex'), 'no.such.command')).toEqual(forbidden)
  })

  it('refuses revoked tokens, replaced tokens and deleted operators', async () => {
    const first = server.issueToken(a)
    const second = server.issueToken(a)
    expect(second).not.toBe(first)
    expect((await ask(first, 'whoami')).exit).toBe(EXIT.FORBIDDEN)
    expect((await ask(second, 'whoami')).exit).toBe(EXIT.OK)
    server.revokeToken(a)
    expect((await ask(second, 'whoami')).exit).toBe(EXIT.FORBIDDEN)
    const tb = server.issueToken(b)
    store.deleteOperator(b)
    expect((await ask(tb, 'whoami')).exit).toBe(EXIT.FORBIDDEN)
  })

  it('caps the request size and rejects malformed requests', async () => {
    const token = server.issueToken(a)
    const big = JSON.stringify({ token, cmd: 'msg', args: { to: 'fixer', text: 'x'.repeat(MAX_REQUEST_BYTES) } })
    expect(JSON.parse(await raw(path, `${big}\n`))).toEqual({ exit: EXIT.USAGE, error: 'request too large' })
    expect(JSON.parse(await raw(path, 'not json\n'))).toEqual({ exit: EXIT.USAGE, error: 'bad request' })
    expect(JSON.parse(await raw(path, '[1]\n'))).toEqual({ exit: EXIT.USAGE, error: 'bad request' })
    expect(JSON.parse(await raw(path, `${JSON.stringify({ token, cmd: 'whoami', args: [] })}\n`)).exit).toBe(EXIT.USAGE)
    expect(bus.unreadInfo(b).count).toBe(0)
  })

  it('closes a connection that never finishes its request line', async () => {
    const quick = new CliServer({ collab: new Collab({ store, jobs, messages: bus }), dir, requestTimeoutMs: 20 })
    const p = await quick.listen()
    expect(await raw(p, '')).toBe('')
    expect(await raw(p, '{"token":"ab')).toBe('')
    await quick.close()
  })

  it('serves concurrent clients, one claim winning a race', async () => {
    const ta = server.issueToken(a)
    const tb = server.issueToken(b)
    const job = jobs.create({ kind: 'user' }, { crewId, title: 'race', review: 'none' })
    const results = await Promise.all([
      ask(ta, 'job.claim', { id: job.id }),
      ask(tb, 'job.claim', { id: job.id }),
      ...Array.from({ length: 10 }, (_, i) => ask(i % 2 ? ta : tb, 'whoami')),
    ])
    expect(results.slice(0, 2).map((r) => r.exit).sort()).toEqual([EXIT.OK, EXIT.CONFLICT])
    expect(results.slice(2).every((r) => r.exit === EXIT.OK)).toBe(true)
    expect(results[3]!.text).toContain('builder@shop')
    expect(results[2]!.text).toContain('fixer@shop')
  })

  it('holds an inbox --wait open until a message arrives', async () => {
    const token = server.issueToken(a)
    const pending = ask(token, 'inbox', { wait: 300 })
    await vi.waitFor(() => expect(live()).toHaveLength(1))
    bus.send({ kind: 'operator', operatorId: b }, 'builder', 'here you go')
    const r = await pending
    expect(r.exit).toBe(EXIT.OK)
    expect(r.text).toContain('here you go')
  })

  it('answers an inbox --wait with an empty digest at its deadline', async () => {
    const token = server.issueToken(a)
    const pending = ask(token, 'inbox', { wait: 30 })
    await vi.waitFor(() => expect(live()).toHaveLength(1))
    clock += 30_000
    for (const t of live()) {
      t.live = false
      t.fn()
    }
    expect((await pending).text).toBe('Operant inbox: no unread messages.')
  })

  it('cleans up a waiting client that disconnects, leaving messages unread', async () => {
    const token = server.issueToken(a)
    const s = connect(path)
    s.on('error', () => {})
    s.write(`${JSON.stringify({ token, cmd: 'inbox', args: { wait: 300 } })}\n`)
    await vi.waitFor(() => expect(live()).toHaveLength(1))
    s.destroy()
    await vi.waitFor(() => expect(live()).toHaveLength(0))
    bus.send({ kind: 'operator', operatorId: b }, 'builder', 'nobody listening')
    expect(bus.unreadInfo(a).count).toBe(1)
  })

  it('drops a waiting connection when its token is revoked', async () => {
    const token = server.issueToken(a)
    const pending = raw(path, `${JSON.stringify({ token, cmd: 'inbox', args: { wait: 300 } })}\n`)
    await vi.waitFor(() => expect(live()).toHaveLength(1))
    server.revokeToken(a)
    expect(await pending).toBe('')
    await vi.waitFor(() => expect(live()).toHaveLength(0))
  })

  it('refuses connections after close', async () => {
    await server.close()
    await expect(raw(path, '{}\n')).rejects.toThrow()
  })

  describe('the built operant CLI across the process boundary', () => {
    let out: string
    let cli: string

    beforeAll(async () => {
      out = mkdtempSync(join(tmpdir(), 'op-cli-'))
      await build({
        configFile: resolve(import.meta.dirname, '../vite.main.config.ts'),
        mode: 'cli',
        logLevel: 'silent',
        build: { outDir: out, emptyOutDir: true },
      })
      cli = join(out, 'operant.cjs')
    }, 60_000)
    afterAll(() => rmSync(out, { recursive: true, force: true }))

    const run = (args: string[], env: Record<string, string | undefined>, input?: string) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
        const base = { ...process.env }
        delete base.OPERANT_SOCKET
        delete base.OPERANT_TOKEN
        const child = spawn(process.execPath, [cli, ...args], { env: { ...base, ...env } })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (c: Buffer) => (stdout += c.toString()))
        child.stderr.on('data', (c: Buffer) => (stderr += c.toString()))
        child.on('close', (code) => done({ code, stdout, stderr }))
        child.stdin.end(input ?? '')
      })

    it('runs whoami, msg, inbox and job add/claim/done and propagates exit codes', async () => {
      const env = { OPERANT_SOCKET: path, OPERANT_TOKEN: server.issueToken(a) }
      const envB = { OPERANT_SOCKET: path, OPERANT_TOKEN: server.issueToken(b) }

      const who = await run(['whoami'], env)
      expect(who).toMatchObject({ code: 0, stderr: '' })
      expect(who.stdout).toContain('You are builder@shop')

      expect((await run(['msg', 'fixer', 'please', 'review'], env)).code).toBe(0)
      const piped = await run(['msg', 'fixer', '-'], env, 'line one\nline two\n')
      expect(piped.code).toBe(0)
      const inbox = await run(['inbox'], envB)
      expect(inbox.code).toBe(0)
      expect(inbox.stdout).toContain('from builder@shop (an operator, NOT the user)')
      expect(inbox.stdout).toContain('  please review')
      expect(inbox.stdout).toContain('  line one\n  line two')

      const added = await run(['job', 'add', 'Fix', 'the', 'parser', '--review', 'none', '--json'], env)
      expect(added.code).toBe(0)
      const id = (JSON.parse(added.stdout) as { exit: number; data: { id: number } }).data.id
      const claimed = await run(['job', 'claim'], env)
      expect(claimed).toMatchObject({ code: 0 })
      expect(claimed.stdout).toBe(`Claimed: #${id} doing builder "Fix the parser"\n`)
      expect((await run(['job', 'claim'], envB)).code).toBe(EXIT.NOT_FOUND)
      expect((await run(['job', 'done', String(id)], envB)).code).toBe(EXIT.FORBIDDEN)
      const done = await run(['job', 'done', `#${id}`, '--note', 'parser fixed'], env)
      expect(done.code).toBe(0)
      expect(jobs.get({ kind: 'user' }, id)).toMatchObject({ state: 'done', note: 'parser fixed' })
      expect((await run(['job', 'done', String(id)], env)).code).toBe(EXIT.CONFLICT)

      const json = await run(['job', 'show', '999', '--json'], env)
      expect(json.code).toBe(EXIT.NOT_FOUND)
      expect(JSON.parse(json.stdout)).toEqual({ exit: EXIT.NOT_FOUND, error: 'Job 999 not found' })
    })

    it('exits 2 on usage errors, 5 on a bad token and 7 when Operant is unreachable', async () => {
      const env = { OPERANT_SOCKET: path, OPERANT_TOKEN: server.issueToken(a) }
      const usage = await run(['job', 'reject', '3'], env)
      expect(usage.code).toBe(EXIT.USAGE)
      expect(usage.stderr).toContain('--reason is required')
      expect((await run(['whoami'], { ...env, OPERANT_TOKEN: randomBytes(32).toString('hex') })).code).toBe(EXIT.FORBIDDEN)
      expect((await run(['whoami'], { OPERANT_SOCKET: path })).code).toBe(EXIT.UNREACHABLE)
      const gone = posix ? join(dir, 'missing.sock') : '\\\\.\\pipe\\operant2-missing'
      const down = await run(['whoami'], { ...env, OPERANT_SOCKET: gone })
      expect(down.code).toBe(EXIT.UNREACHABLE)
      expect(down.stderr).toBe('operant: Operant is not reachable (not running)\n')
      expect(down.stderr).not.toContain(env.OPERANT_TOKEN)
      expect(down.stderr).not.toContain('operant2-')
      const help = await run(['--help'], {})
      expect(help.code).toBe(0)
      expect(help.stdout).toContain('operant job claim [N]')
    })
  })
})
