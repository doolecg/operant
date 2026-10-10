// Stands in for Claude Code in e2e runs, without spending tokens:
// - writes a transcript for --session-id in the real format under CLAUDE_CONFIG_DIR (usage tests),
// - logs the launch (selected args, OPERANT_* env names, never values) to CLAUDE_CONFIG_DIR/fake-claude-launches.jsonl,
// - stays alive reading stdin like a tiny REPL: a typed `Run: operant inbox` nudge runs `operant inbox`,
//   `/clear` and `/exit` behave, and `/fake spend <in> <out> <cacheRead>` / `/fake run operant ...` are test hooks,
// - with -p (a dashboard job) emits one stream-json message and stays alive until killed,
// - answers the learn step (haiku, -p) with CLAUDE_CONFIG_DIR/learn-response.json when that file exists,
// - delegation: FAKE_CLAUDE_SUBAGENT=<subagent_type> (at start) or `/fake subagent <subagent_type>` writes a subagent
//   transcript + meta under <session>/subagents, in the real layout, as if the Master called the Agent tool (the
//   delegation guard and the Agents list read it). Without either, no subagent exists (the guard case),
// - runs FAKE_CLAUDE_SCRIPT (one `operant ...` command per line, at start) and FAKE_CLAUDE_ON_INBOX (after each
//   inbox read). A line may start with `[role]` to apply to that role only; output is echoed and logged to
//   CLAUDE_CONFIG_DIR/fake-claude-commands.jsonl.
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)

// `claude --version` answers like Claude Code, so the capability probe finds the CLI.
if (args[0] === '--version') {
  process.stdout.write('2.1.0 (Claude Code)\n')
  process.exit(0)
}

// `claude mcp list|add|remove` against CLAUDE_CONFIG_DIR/.claude.json and ./.mcp.json, in the real output format.
// A server whose name has "bad" fails to connect, one with "auth" needs authentication, the rest connect.
if (args[0] === 'mcp') {
  const file = join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
  const cfg = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  const key = process.cwd().replaceAll('\\', '/')
  const mcpJson = join(process.cwd(), '.mcp.json')
  const proj = () => ((cfg.projects ??= {})[key] ??= {})
  const readJson = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {})
  const scopes = () => ({ user: (cfg.mcpServers ??= {}), local: (proj().mcpServers ??= {}), project: (readJson(mcpJson).mcpServers ?? {}) })
  const save = (project) => {
    writeFileSync(file, JSON.stringify(cfg))
    if (project) writeFileSync(mcpJson, JSON.stringify({ mcpServers: project }))
  }
  const val = (flagName) => args.filter((a, i) => args[i - 1] === flagName)
  const [sub] = args.slice(1)
  if (sub === 'list') {
    process.stdout.write('Checking MCP server health…\n\n')
    for (const group of Object.values(scopes())) {
      for (const [name, v] of Object.entries(group)) {
        const target = v.url ? `${v.url} (HTTP)` : [v.command, ...(v.args ?? [])].join(' ')
        const status = name.includes('bad') ? '✘ Failed to connect — ECONNREFUSED fake server' : name.includes('auth') ? '! Needs authentication' : '✔ Connected'
        process.stdout.write(`${name}: ${target} - ${status}\n`)
      }
    }
  } else if (sub === 'add') {
    const scope = val('-s')[0] ?? 'local'
    const dash = args.indexOf('--')
    const head = dash >= 0 ? args.slice(2, dash) : args.slice(2)
    const positional = head.filter((a, i) => !a.startsWith('-') && !['-s', '-t', '-e', '-H'].includes(head[i - 1]))
    const name = positional[0]
    const entry = dash >= 0 ? { type: 'stdio', command: args[dash + 1], args: args.slice(dash + 2) } : { type: val('-t')[0] ?? 'http', url: positional[1] }
    const envs = val('-e')
    if (envs.length) entry.env = Object.fromEntries(envs.map((e) => [e.split('=')[0], e.slice(e.indexOf('=') + 1)]))
    const hdrs = val('-H')
    if (hdrs.length) entry.headers = Object.fromEntries(hdrs.map((h) => [h.split(': ')[0], h.slice(h.indexOf(': ') + 2)]))
    const group = scopes()[scope]
    group[name] = entry
    save(scope === 'project' ? group : null)
    process.stdout.write(`Added ${entry.type} MCP server ${name}\n`)
  } else if (sub === 'remove') {
    const scope = val('-s')[0]
    const name = args.slice(2).filter((a, i, all) => !a.startsWith('-') && all[i - 1] !== '-s')[0]
    const all = scopes()
    const target = scope ?? Object.keys(all).find((k) => name in all[k])
    if (!target || !(name in all[target])) {
      process.stderr.write(`No MCP server found with name: ${name}\n`)
      process.exit(1)
    }
    delete all[target][name]
    save(target === 'project' ? all.project : null)
    process.stdout.write(`Removed MCP server ${name}\n`)
  }
  process.exit(0)
}
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const sessionId = flag('--session-id') ?? flag('--resume')
const modelArg = flag('--model') ?? ''
const model = modelArg.startsWith('claude-') ? modelArg : modelArg.includes('opus') ? 'claude-opus-5-5' : 'claude-sonnet-5-5'
const operator = process.env.OPERANT_OPERATOR ?? ''
// Hook events (Claude Mods e2e): FAKE_CLAUDE_HOOK_EVENTS names a JSON-lines file of {after, event, payload}. Each one is sent
// through the hook command Operant put in the --settings file, on stdin, as Claude Code would, after `after` ms.
if (process.env.FAKE_CLAUDE_HOOK_EVENTS && existsSync(process.env.FAKE_CLAUDE_HOOK_EVENTS) && flag('--settings')) {
  const settings = JSON.parse(readFileSync(flag('--settings'), 'utf8'))
  const steps = readFileSync(process.env.FAKE_CLAUDE_HOOK_EVENTS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const fire = (step) => {
    // "StatusLine" runs the status line command with its payload (the context card reads it), as Claude Code does.
    const command = step.event === 'StatusLine' ? settings.statusLine?.command : settings.hooks?.[step.event]?.[0]?.hooks?.[0]?.command
    if (!command) return
    // Git's sh by absolute path: the app's PATH may not carry it, and Claude Code runs hook commands with bash too.
    const sh = ['C:/Program Files/Git/usr/bin/sh.exe', '/usr/bin/sh'].find((p) => existsSync(p)) ?? 'sh'
    spawnSync(sh, ['-c', command], { input: JSON.stringify({ hook_event_name: step.event, session_id: sessionId ?? 'fake-session', ...step.payload }), env: process.env })
  }
  for (const step of steps) setTimeout(() => fire(step), step.after ?? 0)
}
const role = operator.split('@')[0]
const configDir = process.env.CLAUDE_CONFIG_DIR
const dir = join(configDir, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'))
mkdirSync(dir, { recursive: true })

// FAKE_CLAUDE_PAINT (clip e2e): paints a full-height screen like Claude Code's: a header with the rows and columns the PTY
// reports, and a footer on the last row. Repaints when the PTY size changes, so the terminal can be checked against it.
if (process.env.FAKE_CLAUDE_PAINT && process.stdout.isTTY) {
  let shown = ''
  const paint = () => {
    // Node only learns a new size from SIGWINCH, which Windows does not send: ask the console again.
    process.stdout._refreshSize?.()
    const rows = process.stdout.rows ?? 0
    const cols = process.stdout.columns ?? 0
    if (!rows || `${rows}x${cols}` === shown) return
    shown = `${rows}x${cols}`
    appendFileSync(join(process.env.CLAUDE_CONFIG_DIR, 'fake-claude-paint.log'), `${rows} ${cols}\n`)
    let out = '\x1b[2J\x1b[3J\x1b[H'
    for (let i = 1; i < rows; i++) out += (i === 1 ? `PTY rows=${rows} cols=${cols}` : `line ${i}`) + '\r\n'
    process.stdout.write(out + 'auto mode on (shift+tab to cycle) · ← for agents')
  }
  paint()
  setInterval(paint, 150).unref()
}

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
if (!process.env.FAKE_CLAUDE_PAINT) console.log(`fake claude ready (${operator})`)

// A subagent the Master "delegated" to: <session>/subagents/agent-<n>.jsonl (+ .meta.json) next to the main transcript.
let agents = 0
function subagent(type) {
  const sub = join(dir, sessionId, 'subagents')
  mkdirSync(sub, { recursive: true })
  const id = `agent-fake${++agents}`
  const at = new Date().toISOString()
  const m = (role, extra) => JSON.stringify({ type: role, timestamp: at, isSidechain: true, agentId: id, agentType: type, message: { role, model, ...extra } }) + '\n'
  writeFileSync(join(sub, `${id}.meta.json`), JSON.stringify({ agentType: type, model }))
  writeFileSync(join(sub, `${id}.jsonl`), m('user', { content: 'Do your part of the task.' }) + m('assistant', { content: [{ type: 'text', text: `${type} is working.` }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 50 } }))
  record('fake-claude-commands.jsonl', { operator, cmd: `subagent ${type}`, exit: 0, output: id })
  console.log(`subagent ${type} started (${id})`)
}
if (process.env.FAKE_CLAUDE_SUBAGENT && sessionId) subagent(process.env.FAKE_CLAUDE_SUBAGENT)

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

// The learn step (`claude -p --model claude-haiku-5-5`, prompt on stdin): answer with the lessons JSON in
// CLAUDE_CONFIG_DIR/learn-response.json, as one result message, and exit.
if ((args.includes('-p') || args.includes('--print')) && modelArg === 'claude-haiku-5-5' && existsSync(join(configDir, 'learn-response.json'))) {
  const text = readFileSync(join(configDir, 'learn-response.json'), 'utf8')
  process.stdin.resume()
  process.stdin.on('data', () => {})
  await new Promise((r) => process.stdin.on('end', r))
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text }))
  process.exit(0)
}

// `claude -p` (a dashboard job's Master): say one thing in stream-json, then keep working until it is killed.
if (args.includes('-p') || args.includes('--print')) {
  console.log(JSON.stringify({ type: 'assistant', session_id: 'fake-run', message: { content: [{ type: 'text', text: 'Working on the task.' }] } }))
  setInterval(() => {}, 1000)
  await new Promise(() => {})
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
  } else if (t.startsWith('/fake subagent ')) {
    subagent(t.slice(15).trim())
  } else if (t.startsWith('/fake run operant')) {
    operant(t.slice(17).trim())
  } else if (t) console.log(`> ${t}`)
})
rl.on('close', () => process.exit(0))
setInterval(() => {}, 1000)
