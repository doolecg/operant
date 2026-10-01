import { describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import { HELP, failureReason, main, parseArgs, readStdin, render } from './operant'

const req = (argv: string[]) => {
  const p = parseArgs(argv)
  if (p.kind !== 'request') throw new Error(`expected a request, got ${JSON.stringify(p)}`)
  return p
}
const err = (argv: string[]) => {
  const p = parseArgs(argv)
  if (p.kind !== 'error') throw new Error(`expected an error, got ${JSON.stringify(p)}`)
  return p.message
}

describe('parseArgs', () => {
  it('parses every command into its request', () => {
    expect(req(['whoami'])).toEqual({ kind: 'request', cmd: 'whoami', args: {}, json: false, stdin: null })
    expect(req(['who', '--squad']).args).toEqual({ squad: true })
    expect(req(['msg', 'lead@shop', 'tests', 'pass', '--job', '7'])).toMatchObject({ cmd: 'msg', args: { to: 'lead@shop', text: 'tests pass', job: 7 } })
    expect(req(['ask', 'user', 'may I push?']).args).toEqual({ to: 'user', text: 'may I push?' })
    expect(req(['inbox', '--peek', '--wait', '90']).args).toEqual({ peek: true, wait: 90 })
    expect(req(['job', 'list', '--open'])).toMatchObject({ cmd: 'job.list', args: { open: true } })
    expect(req(['job', 'show', '#12']).args).toEqual({ id: 12 })
    expect(
      req(['job', 'add', 'Fix', 'it', '--body', 'b', '--for', 'fixer', '--after', '3,4', '--review', 'pm', '--priority', '-5', '--estimate', '30']).args,
    ).toEqual({ title: 'Fix it', body: 'b', for: 'fixer', after: [3, 4], review: 'pm', priority: -5, estimate: 30 })
    expect(req(['job', 'claim']).args).toEqual({})
    expect(req(['job', 'claim', '4']).args).toEqual({ id: 4 })
    expect(req(['job', 'done', '4', '--note=all green']).args).toEqual({ id: 4, note: 'all green' })
    expect(req(['job', 'release', '4']).cmd).toBe('job.release')
    expect(req(['job', 'handoff', '4', 'fixer', '--note', 'yours']).args).toEqual({ id: 4, to: 'fixer', note: 'yours' })
    expect(req(['job', 'approve', '4']).cmd).toBe('job.approve')
    expect(req(['job', 'reject', '4', '--reason', 'fails']).args).toEqual({ id: 4, reason: 'fails' })
    expect(req(['job', 'escalate', '4', '--reason', 'risky']).cmd).toBe('job.escalate')
    expect(req(['job', 'edit', '4', '--estimate', 'none', '--for', 'none', '--not-after', '2']).args).toEqual({
      id: 4,
      estimate: null,
      for: null,
      notAfter: [2],
    })
  })

  it('takes --json anywhere and keeps words after -- as text', () => {
    expect(req(['--json', 'whoami']).json).toBe(true)
    expect(req(['msg', 'lead', '--', '--json', '-x']).args).toEqual({ to: 'lead', text: '--json -x' })
  })

  it('treats --json only as an option and -h after a positional as text', () => {
    expect(req(['job', 'list', '--json'])).toMatchObject({ cmd: 'job.list', json: true })
    expect(req(['job', 'done', '3', '--note', '--json'])).toMatchObject({ json: false, args: { id: 3, note: '--json' } })
    expect(req(['msg', 'pm', 'use', '-h', 'here']).args).toEqual({ to: 'pm', text: 'use -h here' })
    expect(req(['msg', 'pm', 'see', '--help']).args).toEqual({ to: 'pm', text: 'see --help' })
    expect(parseArgs(['--json', '--help']).kind).toBe('help')
  })

  it('marks one stdin value', () => {
    expect(req(['msg', 'lead', '-']).stdin).toBe('text')
    expect(req(['job', 'add', 'T', '--body', '-']).stdin).toBe('body')
    expect(err(['job', 'add', '-', '--body', '-'])).toContain('Only one value')
  })

  it('reports usage errors', () => {
    expect(err(['frob'])).toContain('Unknown command "frob"')
    expect(err(['job', 'frob'])).toContain('Unknown command "job frob"')
    expect(err(['job', 'toString'])).toContain('Unknown command')
    expect(err(['--squad', 'who'])).toContain('command first')
    expect(err(['who', '--bogus'])).toContain('Unknown option --bogus')
    expect(err(['who', '-x'])).toContain('Unknown option "-x"')
    expect(err(['who', '--squad=1'])).toContain('takes no value')
    expect(err(['msg', 'lead'])).toContain('Missing <text>')
    expect(err(['job', 'show', 'abc'])).toContain('not a job id')
    expect(err(['job', 'show', '0'])).toContain('not a job id')
    expect(err(['job', 'show', '1', '2'])).toContain('Unexpected "2"')
    expect(err(['job', 'reject', '1'])).toContain('--reason is required')
    expect(err(['job', 'done', '1', '--note'])).toContain('needs a value')
    expect(err(['job', 'done', '1', '--note', 'a', '--note', 'b'])).toContain('given twice')
    expect(err(['job', 'add', 't', '--priority', 'high'])).toContain('whole number')
    expect(err(['job', 'add', 't', '--after', '3,x'])).toContain('job ids')
    expect(err(['inbox', '--wait', '-1'])).toContain('seconds')
  })

  it('shows help', () => {
    expect(parseArgs([])).toEqual({ kind: 'help', text: HELP })
    expect(parseArgs(['job', 'add', '--help']).kind).toBe('help')
  })
})

describe('render', () => {
  it('prints text on success and the reason on failure', () => {
    expect(render({ exit: 0, text: 'ok', data: { a: 1 } }, false)).toEqual({ stdout: 'ok\n', stderr: '', code: 0 })
    expect(render({ exit: 4, error: 'Job 3 is done' }, false)).toEqual({ stdout: '', stderr: 'operant: Job 3 is done\n', code: 4 })
  })

  it('prints JSON with --json', () => {
    expect(render({ exit: 0, text: 'ok', data: { a: 1 } }, true).stdout).toBe('{"exit":0,"data":{"a":1}}\n')
    expect(render({ exit: 5, error: 'forbidden' }, true)).toEqual({ stdout: '{"exit":5,"error":"forbidden"}\n', stderr: '', code: 5 })
  })

  it('turns an unknown exit code into 1', () => {
    expect(render({ exit: 99, error: 'x' }, false).code).toBe(1)
    expect(render({ exit: 'x' as unknown as number }, false).code).toBe(1)
  })
})

describe('connection failures and stdin', () => {
  it('never shows Node’s message, which names the socket path', () => {
    const e = (code: string) => Object.assign(new Error(`connect ${code} /tmp/operant2-1000/ab.sock`), { code })
    expect(failureReason(e('ENOENT'))).toBe('not running')
    expect(failureReason(e('ECONNREFUSED'))).toBe('not running')
    expect(failureReason(e('EACCES'))).toBe('access denied')
    expect(failureReason(e('EPIPE'))).toBe('connection failed')
    expect(failureReason(null)).toBe('connection failed')
  })

  it('refuses a terminal and stops at 64 KB', async () => {
    await expect(readStdin(Object.assign(Readable.from([]), { isTTY: true }))).rejects.toThrow('nothing is piped')
    await expect(readStdin(Readable.from([Buffer.alloc(70 * 1024, 97)]))).rejects.toThrow('over 64 KB')
    expect(await readStdin(Readable.from([Buffer.from('hi\n')]))).toBe('hi')
  })
})

describe('main', () => {
  it('exits 7 without the socket or token in the environment, and 2 on usage', async () => {
    expect((await main(['whoami'], {})).code).toBe(7)
    expect((await main(['whoami'], { OPERANT_SOCKET: 'x' })).code).toBe(7)
    expect((await main(['nope'], {})).code).toBe(2)
    expect((await main(['--help'], {})).code).toBe(0)
  })
})
