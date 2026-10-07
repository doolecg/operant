// The `operant` command agents run. Parses argv, sends one JSON line to the app's local socket with the
// session token, prints the answer and exits with its code. Built on its own to out/cli/operant.cjs and
// run by the app binary as Node; it has no dependencies and imports nothing from the app.
import { readFileSync } from 'node:fs'
import { connect } from 'node:net'

export const EXIT_USAGE = 2
export const EXIT_UNREACHABLE = 7

// 'strs' may be given more than once and arrives as a list.
type Kind = 'bool' | 'int' | 'num' | 'str' | 'strs' | 'ids' | 'int?' | 'addr?'

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
  // Master Terminal only: the dashboard job (JOB#) it works on. Text from the owner or agents comes back as data.
  'run.show': { pos: ['id'], flags: {}, usage: 'operant run show N' },
  'run.start': { pos: ['id'], flags: {}, usage: 'operant run start N' },
  'run.progress': { pos: ['id'], flags: { text: 'str' }, required: ['text'], usage: 'operant run progress N --text <text|->' },
  'run.ask': { pos: ['id'], flags: { text: 'str', option: 'strs' }, required: ['text'], usage: 'operant run ask N --text <text|-> [--option A --option B ...]' },
  'run.answer': { pos: ['id'], flags: {}, usage: 'operant run answer N' },
  'run.review': { pos: ['id'], flags: { summary: 'str' }, required: ['summary'], usage: 'operant run review N --summary <markdown|@file|->' },
  'run.approve': { pos: ['id'], flags: { note: 'str' }, usage: 'operant run approve N [--note T]' },
  'run.fail': { pos: ['id'], flags: { text: 'str' }, required: ['text'], usage: 'operant run fail N --text <reason|->' },
  'run.next': { pos: [], flags: {}, usage: 'operant run next' },
  'run.inbox': { pos: [], flags: {}, usage: 'operant run inbox' },
  'run.closeout': { pos: ['id'], flags: { wait: 'bool' }, usage: 'operant run closeout N [--wait]' },
  // Internal: the Master plugin's hooks call it; the hook JSON arrives on stdin. Always silent and exits 0.
  hook: { pos: ['event'], flags: {}, usage: 'operant hook <event>' },
}

// Text values that may be `-` (read from stdin).
const TEXT = new Set(['text', 'title', 'body', 'note', 'reason', 'summary'])

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
    case 'strs':
      return v
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
  const group = first === 'job' || first === 'run'
  const name = group ? `${first}.${words[1] ?? ''}` : first
  const spec = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined
  if (!spec) return { kind: 'error', message: `Unknown command "${group ? `${first} ${words[1] ?? ''}`.trim() : first}". Run: operant --help` }
  const args: Record<string, unknown> = {}
  const pos: string[] = []
  try {
    for (let i = group ? 2 : 1; i < words.length; i++) {
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
      if (key in args && kind !== 'strs') throw new Error(`--${flag} given twice`)
      if (kind === 'bool') {
        if (eq > 0) throw new Error(`--${flag} takes no value`)
        args[key] = true
        continue
      }
      const value: string | undefined = eq > 0 ? a.slice(eq + 1) : words[++i]
      if (value === undefined) throw new Error(`--${flag} needs a value`)
      if (kind === 'strs') args[key] = [...((args[key] as string[] | undefined) ?? []), value]
      else args[key] = convert(kind, flag, value)
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

// The hook JSON fields `operant hook` forwards (Claude Code's own names on the left).
const HOOK_FIELDS: Record<string, string> = {
  session_id: 'sessionId',
  transcript_path: 'transcriptPath',
  source: 'source',
  message: 'message',
  notification_type: 'notificationType',
  agent_id: 'agentId',
  agent_type: 'agentType',
  prompt: 'prompt',
}

// What the hook sends: the event name from argv plus the known fields of the JSON on stdin (text only, capped).
export function hookArgs(event: string, stdin: string): Record<string, unknown> {
  const args: Record<string, unknown> = { event }
  try {
    const body = JSON.parse(stdin) as Record<string, unknown>
    for (const [from, to] of Object.entries(HOOK_FIELDS)) {
      // The prompt only from UserPromptSubmit: Operant compares it with its own pointer line and an approval word.
      if (from === 'prompt' && event !== 'UserPromptSubmit') continue
      const v = body[from]
      if (typeof v === 'string') args[to] = v.slice(0, 600)
    }
  } catch {
    // no JSON on stdin: the event name alone still tells the app what happened
  }
  return args
}

// A hook must never disturb Claude Code: no output, exit 0, whatever happens.
async function hookMain(event: string, env: NodeJS.ProcessEnv, input: NodeJS.ReadableStream & { isTTY?: boolean }): Promise<{ stdout: string; stderr: string; code: number }> {
  const quiet = { stdout: '', stderr: '', code: 0 }
  const socketPath = env.OPERANT_SOCKET
  const token = env.OPERANT_TOKEN
  if (!socketPath || !token) return quiet
  try {
    const stdin = await readStdin(input).catch(() => '')
    await request(socketPath, JSON.stringify({ token, cmd: 'hook', args: hookArgs(event, stdin) }), 5000)
  } catch {
    // Operant is not reachable: nothing to tell
  }
  return quiet
}

// `--summary @file` reads the file (up to 64 KB); `@@x` is the text `@x`.
export function readAtFile(v: string, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): string {
  if (v.startsWith('@@')) return v.slice(1)
  if (!v.startsWith('@') || v.length === 1) return v
  const text = read(v.slice(1))
  if (text.length > STDIN_MAX) throw new Error('The file is over 64 KB')
  return text
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin): Promise<{ stdout: string; stderr: string; code: number }> {
  const parsed = parseArgs(argv)
  if (parsed.kind === 'request' && parsed.cmd === 'hook') return hookMain(String(parsed.args.event), env, input)
  if (parsed.kind === 'help') return { stdout: `${parsed.text}\n`, stderr: '', code: 0 }
  if (parsed.kind === 'error') return render({ exit: EXIT_USAGE, error: parsed.message }, argv.includes('--json'))
  const socketPath = env.OPERANT_SOCKET
  const token = env.OPERANT_TOKEN
  if (!socketPath || !token) return unreachable('OPERANT_SOCKET or OPERANT_TOKEN is not set', parsed.json)
  try {
    if (parsed.stdin) parsed.args[parsed.stdin] = await readStdin(input)
    if (typeof parsed.args.summary === 'string') parsed.args.summary = readAtFile(parsed.args.summary)
  } catch (err) {
    return render({ exit: EXIT_USAGE, error: (err as Error).message }, parsed.json)
  }
  const wait = typeof parsed.args.wait === 'number' ? parsed.args.wait : parsed.args.wait === true ? 125 : 0
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
