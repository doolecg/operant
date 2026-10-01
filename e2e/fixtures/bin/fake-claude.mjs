// Stands in for Claude Code in e2e runs, without spending tokens:
// - writes a transcript for --session-id in the real format under CLAUDE_CONFIG_DIR (usage tests),
// - logs the launch (selected args, OPERANT_* env names, never values) to CLAUDE_CONFIG_DIR/fake-claude-launches.jsonl,
// - stays alive reading stdin like a tiny REPL: a typed `Run: operant inbox` nudge runs `operant inbox`,
//   `/clear` and `/exit` behave, and `/fake spend <in> <out> <cacheRead>` / `/fake run operant ...` are test hooks,
// - runs FAKE_CLAUDE_SCRIPT (one `operant ...` command per line, at start) and FAKE_CLAUDE_ON_INBOX (after each
//   inbox read). A line may start with `[role]` to apply to that role only; output is echoed and logged to
//   CLAUDE_CONFIG_DIR/fake-claude-commands.jsonl.
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const sessionId = flag('--session-id') ?? flag('--resume')
const modelArg = flag('--model') ?? ''
const model = modelArg.startsWith('claude-') ? modelArg : modelArg.includes('opus') ? 'claude-opus-5-5' : 'claude-sonnet-5-5'
const operator = process.env.OPERANT_OPERATOR ?? ''
const role = operator.split('@')[0]
const configDir = process.env.CLAUDE_CONFIG_DIR
const dir = join(configDir, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'))
mkdirSync(dir, { recursive: true })

const record = (file, entry) => appendFileSync(join(configDir, file), JSON.stringify(entry) + '\n')

record('fake-claude-launches.jsonl', {
  operator,
  cwd: process.cwd(),
  model: flag('--model') ?? null,
  effort: flag('--effort') ?? null,
  permissionMode: flag('--permission-mode') ?? null,
  settings: flag('--settings') ?? null,
  appendSystemPromptFile: flag('--append-system-prompt-file') ?? null,
  strictMcpConfig: args.includes('--strict-mcp-config'),
  sessionId: sessionId ?? null,
  argv: args.map((a) => (/^[0-9a-f]{64}$/i.test(a) ? '<redacted>' : a)),
  envNames: Object.keys(process.env).filter((k) => k.toUpperCase().startsWith('OPERANT_')).sort(),
})

const line = (id, input, output, cacheRead) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: { id, model, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead } },
  }) + '\n'
const transcript = join(dir, `${sessionId}.jsonl`)
let counter = 2
appendFileSync(transcript, line('msg_1', 20_000, 4_000, 60_000) + line('msg_2', 5_000, 12_000, 150_000))
console.log(`fake claude ready (${operator})`)

const quote = (a) => (/^[\w@.:/#=+-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`)

// `operant ...` runs through the shell so the PATH lookup (and the .cmd wrapper on Windows) is the real one.
function operant(rest) {
  const words = rest.match(/"[^"]*"|\S+/g)?.map((w) => w.replace(/^"|"$/g, '')) ?? []
  const r = spawnSync(`operant ${words.map(quote).join(' ')}`, { shell: true, encoding: 'utf8', env: process.env })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  record('fake-claude-commands.jsonl', { operator, cmd: `operant ${rest}`, exit: r.status, output: out })
  console.log(`$ operant ${rest}\n${out.trimEnd()}\n[exit ${r.status}]`)
}

function runLines(text) {
  for (const raw of (text ?? '').split(/\r?\n/)) {
    let l = raw.trim()
    if (!l) continue
    const m = /^\[([^\]]+)\]\s*(.*)$/.exec(l)
    if (m) {
      if (m[1] !== role) continue
      l = m[2]
    }
    const c = /^operant\s+(.*)$/.exec(l) ?? /^operant$/.exec(l)
    if (c) operant(c[1] ?? '')
  }
}

runLines(process.env.FAKE_CLAUDE_SCRIPT)

const rl = createInterface({ input: process.stdin })
rl.on('line', (typed) => {
  const t = typed.trim()
  if (t === '/exit') {
    console.log('bye')
    process.exit(0)
  } else if (t === '/clear') {
    console.log('conversation cleared')
    record('fake-claude-commands.jsonl', { operator, cmd: '/clear', exit: 0, output: '' })
  } else if (/^Operant: you have \d+ unread messages?\. Run: operant inbox$/.test(t)) {
    operant('inbox')
    runLines(process.env.FAKE_CLAUDE_ON_INBOX)
  } else if (t.startsWith('/fake spend ')) {
    const [i, o, c] = t.slice(12).split(/\s+/).map(Number)
    appendFileSync(transcript, line(`msg_${++counter}`, i || 0, o || 0, c || 0))
    console.log(`spent ${i} in, ${o} out, ${c} cache read`)
  } else if (t.startsWith('/fake run operant')) {
    operant(t.slice(17).trim())
  } else if (t) console.log(`> ${t}`)
})
rl.on('close', () => process.exit(0))
setInterval(() => {}, 1000)
