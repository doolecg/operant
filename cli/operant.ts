// The `operant` command agents run. Parses argv, sends one JSON line to the app's local socket with the
// session token, prints the answer and exits with its code. Built on its own to out/cli/operant.cjs and
// run by the app binary as Node; it has no dependencies and imports nothing from the app.
import { connect } from 'node:net'

export const EXIT_USAGE = 2
export const EXIT_UNREACHABLE = 7

type Kind = 'bool' | 'int' | 'num' | 'str' | 'ids' | 'int?' | 'addr?'

interface CommandSpec {
  // Positional names; a trailing `...` takes the rest of the words joined by spaces; `?` = optional.
  pos: string[]
  flags: Record<string, Kind>
  // Flags that must be given.
  required?: string[]
  usage: string
}

const COMMANDS: Record<string, CommandSpec> = {
  whoami: { pos: [], flags: {}, usage: 'operant whoami' },
  who: { pos: [], flags: { squad: 'bool' }, usage: 'operant who [--squad]' },
  msg: { pos: ['to', 'text...'], flags: { job: 'int' }, usage: 'operant msg <to> <text|-> [--job N]' },
  ask: { pos: ['to', 'text...'], flags: { job: 'int' }, usage: 'operant ask user <text|-> [--job N]' },
  inbox: { pos: [], flags: { peek: 'bool', wait: 'num' }, usage: 'operant inbox [--peek] [--wait S]' },
  'job.list': { pos: [], flags: { open: 'bool' }, usage: 'operant job list [--open]' },
  'job.show': { pos: ['id'], flags: {}, usage: 'operant job show N' },
  'job.add': {
    pos: ['title...'],
    flags: { body: 'str', for: 'str', after: 'ids', review: 'str', priority: 'int', estimate: 'int' },
    usage: 'operant job add <title> [--body T] [--for ADDR] [--after N,N] [--review none|pm|ADDR|user] [--priority P] [--estimate M]',
  },
  'job.claim': { pos: ['id?'], flags: {}, usage: 'operant job claim [N]' },
  'job.done': { pos: ['id'], flags: { note: 'str' }, usage: 'operant job done N [--note T]' },
  'job.release': { pos: ['id'], flags: { note: 'str' }, usage: 'operant job release N [--note T]' },
  'job.handoff': { pos: ['id', 'to'], flags: { note: 'str' }, usage: 'operant job handoff N <to> [--note T]' },
  'job.approve': { pos: ['id'], flags: { note: 'str' }, usage: 'operant job approve N [--note T]' },
  'job.reject': { pos: ['id'], flags: { reason: 'str' }, required: ['reason'], usage: 'operant job reject N --reason T' },
  'job.escalate': { pos: ['id'], flags: { reason: 'str' }, required: ['reason'], usage: 'operant job escalate N --reason T' },
  'job.edit': {
    pos: ['id'],
    flags: {
      title: 'str',
      body: 'str',
      note: 'str',
      priority: 'int',
      estimate: 'int?',
      review: 'str',
      for: 'addr?',
      after: 'ids',
      'not-after': 'ids',
    },
    usage: 'operant job edit N [--title T] [--body T] [--note T] [--priority P] [--estimate M|none] [--review MODE] [--for ADDR|none] [--after N,N] [--not-after N,N]',
  },
}

// Text values that may be `-` (read from stdin).
const TEXT = new Set(['text', 'title', 'body', 'note', 'reason'])

export const HELP = [
  'Usage (exit codes: 0 ok, 1 error, 2 usage, 3 not found, 4 conflict, 5 forbidden, 6 limited/cap, 7 Operant not reachable):',
  ...Object.values(COMMANDS).map((c) => `  ${c.usage}`),
  'Add --json for machine output. A text value of - is read from stdin.',
].join('\n')

export type Parsed =
  | { kind: 'request'; cmd: string; args: Record<string, unknown>; json: boolean; stdin: string | null }
  | { kind: 'help'; text: string }
  | { kind: 'error'; message: string }

const camel = (s: string) => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())

function jobId(v: string): number | null {
  const m = /^#?(\d{1,15})$/.exec(v)
  const n = m ? Number(m[1]) : NaN
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

function convert(kind: Kind, name: string, v: string): unknown {
  switch (kind) {
    case 'int':
    case 'int?': {
      if (kind === 'int?' && v === 'none') return null
      if (!/^-?\d{1,15}$/.test(v)) throw new Error(`--${name} must be a whole number`)
      return Number(v)
    }
    case 'num': {
      const n = Number(v)
      if (!v.trim() || !Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a number of seconds`)
      return n
    }
    case 'ids': {
      const ids = v.split(',').map((s) => jobId(s.trim()))
      if (ids.some((x) => x === null)) throw new Error(`--${name} takes job ids like 3,4`)
      return ids
    }
    case 'addr?':
      return v === 'none' ? null : v
    default:
      return v
  }
}

// argv (without node and the script) to a request. Pure: stdin is only named, never read here.
// Options follow the command; a flag's value is the next word whatever it looks like (so `--priority -5`
// and `--body -` work); everything after `--` is positional. `--json` counts only where an option could
// stand, and `--help`/`-h` only before the first positional word (so `msg pm use -h` is text).
export function parseArgs(argv: string[]): Parsed {
  const dd = argv.indexOf('--')
  const head = dd < 0 ? argv : argv.slice(0, dd)
  const tail = dd < 0 ? [] : argv.slice(dd + 1)
  let json = false
  const words = [...head]
  while (words[0]?.startsWith('-') && ['--json', '--help', '-h'].includes(words[0])) {
    if (words.shift() !== '--json') return { kind: 'help', text: HELP }
    json = true
  }
  const first = words[0]
  if (first === undefined) return tail.length ? { kind: 'error', message: 'Missing command. Run: operant --help' } : { kind: 'help', text: HELP }
  if (first.startsWith('-')) return { kind: 'error', message: 'Put the command first. Run: operant --help' }
  const name = first === 'job' ? `job.${words[1] ?? ''}` : first
  const spec = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined
  if (!spec) return { kind: 'error', message: `Unknown command "${first === 'job' ? `job ${words[1] ?? ''}`.trim() : first}". Run: operant --help` }
  const args: Record<string, unknown> = {}
  const pos: string[] = []
  try {
    for (let i = first === 'job' ? 2 : 1; i < words.length; i++) {
      const a = words[i]!
      if (a === '--json') {
        json = true
        continue
      }
      if ((a === '--help' || a === '-h') && pos.length === 0) return { kind: 'help', text: HELP }
      if (a === '-h' || a === '--help') {
        pos.push(a)
        continue
      }
      if (!a.startsWith('--')) {
        if (a.startsWith('-') && a !== '-') throw new Error(`Unknown option "${a}". Usage: ${spec.usage}`)
        pos.push(a)
        continue
      }
      const eq = a.indexOf('=')
      const flag = eq > 0 ? a.slice(2, eq) : a.slice(2)
      const kind = Object.hasOwn(spec.flags, flag) ? spec.flags[flag] : undefined
      if (!kind) throw new Error(`Unknown option --${flag}. Usage: ${spec.usage}`)
      const key = camel(flag)
      if (key in args) throw new Error(`--${flag} given twice`)
      if (kind === 'bool') {
        if (eq > 0) throw new Error(`--${flag} takes no value`)
        args[key] = true
        continue
      }
      const value: string | undefined = eq > 0 ? a.slice(eq + 1) : words[++i]
      if (value === undefined) throw new Error(`--${flag} needs a value`)
      args[key] = convert(kind, flag, value)
    }
  } catch (err) {
    return { kind: 'error', message: (err as Error).message }
  }
  pos.push(...tail)
  for (const p of spec.pos) {
    const many = p.endsWith('...')
    const optional = p.endsWith('?')
    const key = p.replace(/(\.\.\.|\?)$/, '')
    const value = many ? pos.splice(0).join(' ') : pos.shift()
    if (value === undefined || value === '') {
      if (optional) continue
      return { kind: 'error', message: `Missing <${key}>. Usage: ${spec.usage}` }
    }
    if (key === 'id') {
      const n = jobId(value)
      if (n === null) return { kind: 'error', message: `"${value}" is not a job id. Usage: ${spec.usage}` }
      args.id = n
    } else args[key] = value
  }
  if (pos.length) return { kind: 'error', message: `Unexpected "${pos[0]}". Usage: ${spec.usage}` }
  for (const r of spec.required ?? []) {
    if (!(r in args)) return { kind: 'error', message: `--${r} is required. Usage: ${spec.usage}` }
  }
  const dashes = Object.keys(args).filter((k) => args[k] === '-' && TEXT.has(k))
  if (dashes.length > 1) return { kind: 'error', message: 'Only one value can be read from stdin' }
  return { kind: 'request', cmd: name, args, json, stdin: dashes[0] ?? null }
}

export interface Reply {
  exit: number
  text?: string
  data?: unknown
  error?: string
}

// What to print and the exit code. Unknown codes become 1.
export function render(reply: Reply, json: boolean): { stdout: string; stderr: string; code: number } {
  const code = Number.isInteger(reply.exit) && reply.exit >= 0 && reply.exit <= 7 ? reply.exit : 1
  if (json) {
    const body = code === 0 ? { exit: 0, data: reply.data ?? null } : { exit: code, error: reply.error ?? 'error' }
    return { stdout: `${JSON.stringify(body)}\n`, stderr: '', code }
  }
  if (code === 0) return { stdout: reply.text ? `${reply.text}\n` : '', stderr: '', code }
  return { stdout: '', stderr: `operant: ${reply.error ?? 'error'}\n`, code }
}

export function unreachable(why: string, json: boolean): { stdout: string; stderr: string; code: number } {
  return render({ exit: EXIT_UNREACHABLE, error: `Operant is not reachable (${why})` }, json)
}

// A fixed phrase for a connection failure: Node's own message names the socket path, which is never shown.
export function failureReason(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  if (code === 'ENOENT' || code === 'ECONNREFUSED') return 'not running'
  if (code === 'EACCES' || code === 'EPERM') return 'access denied'
  if (code === 'ETIMEDOUT') return 'timed out'
  return 'connection failed'
}

// Sends one request line and resolves with the one reply line, or rejects (with a message that never
// contains the socket path) when Operant can't be reached.
export function request(socketPath: string, line: string, timeoutMs: number): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    const chunks: Buffer[] = []
    let settled = false
    const finish = (err: Error | null, reply?: Reply) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (err) reject(err)
      else resolve(reply!)
    }
    socket.setTimeout(timeoutMs, () => finish(new Error('timed out')))
    socket.on('connect', () => socket.write(`${line}\n`))
    socket.on('data', (c: Buffer) => {
      chunks.push(c)
      const all = Buffer.concat(chunks)
      const nl = all.indexOf(0x0a)
      if (nl < 0) return
      try {
        finish(null, JSON.parse(all.subarray(0, nl).toString('utf8')) as Reply)
      } catch {
        finish(new Error('bad reply'))
      }
    })
    socket.on('error', (e) => finish(new Error(failureReason(e))))
    socket.on('close', () => finish(new Error('connection closed')))
  })
}

// The server refuses requests over 64 KB anyway, so reading stops there.
const STDIN_MAX = 64 * 1024

export async function readStdin(input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin): Promise<string> {
  if (input.isTTY) throw new Error('"-" reads stdin, but nothing is piped in')
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of input) {
    const b = typeof c === 'string' ? Buffer.from(c) : (c as Buffer)
    size += b.length
    if (size > STDIN_MAX) throw new Error('stdin is over 64 KB')
    chunks.push(b)
  }
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
}

export async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number }> {
  const parsed = parseArgs(argv)
  if (parsed.kind === 'help') return { stdout: `${parsed.text}\n`, stderr: '', code: 0 }
  if (parsed.kind === 'error') return render({ exit: EXIT_USAGE, error: parsed.message }, argv.includes('--json'))
  const socketPath = env.OPERANT_SOCKET
  const token = env.OPERANT_TOKEN
  if (!socketPath || !token) return unreachable('OPERANT_SOCKET or OPERANT_TOKEN is not set', parsed.json)
  if (parsed.stdin) {
    try {
      parsed.args[parsed.stdin] = await readStdin()
    } catch (err) {
      return render({ exit: EXIT_USAGE, error: (err as Error).message }, parsed.json)
    }
  }
  const wait = typeof parsed.args.wait === 'number' ? parsed.args.wait : 0
  try {
    const reply = await request(socketPath, JSON.stringify({ token, cmd: parsed.cmd, args: parsed.args }), (Math.min(wait, 600) + 30) * 1000)
    return render(reply, parsed.json)
  } catch (err) {
    return unreachable((err as Error).message, parsed.json)
  }
}

declare const module: { id?: string } | undefined
if (typeof module !== 'undefined' && typeof require !== 'undefined' && require.main === module) {
  void main(process.argv.slice(2), process.env).then(({ stdout, stderr, code }) => {
    if (stderr) process.stderr.write(stderr)
    process.stdout.write(stdout, () => process.exit(code))
  })
}
