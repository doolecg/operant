// Item 37: a Claude Code PreToolUse hook that reroutes long-running shell commands
// (test/build/install runners) through `operant run --background --inline` instead of the agent's own
// Bash tool, so the raw output never floods the agent's context. The command runs as a Basement task: one
// that finishes within Settings > Agents > "Run in the Basement after" (5 s) returns its result at once,
// a slower one is handed over to the Basement and the same call waits for its errors only. On by default
// (Settings > Agents > "Reroute long commands"). It only rewrites the command and never approves it,
// so the rewritten command still goes through the user's normal permission prompts; ending a command
// with `# raw` opts out. Only rewrites when it's actually running inside an Operant tile (env
// OPERANT=1) — Operant passes this script via --settings, so it also runs for Claude sessions started
// outside Operant, and this env check is what keeps it a no-op there.
//
// Wired up from main.js, which writes a small settings.json fragment (just the `hooks` block, never
// touching the user's own ~/.claude/settings.json) pointing Claude Code's --settings flag at
// long-commands.cmd, which runs this file through the packaged Electron exe with
// ELECTRON_RUN_AS_NODE=1 (see bin/operant.cmd for the same pattern).

'use strict';

// Anything with these has too much going on for a single-command rewrite to stay correct
// (piping into something else, redirecting output, chaining with && / ; , a background job, or a
// command substitution) — left alone, same as any command that already calls `operant` itself.
const UNSAFE = /[|&;<>]|\$\(|`/;
// Quotes too: bash and PowerShell escape them differently, so the rewrite can't re-quote the
// command correctly for both.
const QUOTED = /["']/;
const ALREADY_OPERANT = /\boperant\b/i;
// The agent's way out: a command ending in "# raw" runs exactly as written.
const RAW = /#\s*raw$/i;

// Order matters only where a tool has both a test and build subcommand with the same prefix.
const RULES = [
  { re: /^(npm|pnpm|yarn)\s+ci\b/i, kind: 'install' },
  { re: /^(npm|pnpm|yarn)\s+install\b/i, kind: 'install' },
  { re: /^(npm|pnpm|yarn)\s+(run\s+)?test\b/i, kind: 'test' },
  { re: /^(npm|pnpm|yarn)\s+(run\s+)?build\b/i, kind: 'build' },
  { re: /^npx\s+(vitest|jest)\b/i, kind: 'test' },
  { re: /^pytest\b/i, kind: 'test' },
  { re: /^cargo\s+test\b/i, kind: 'test' },
  { re: /^cargo\s+build\b/i, kind: 'build' },
  { re: /^go\s+test\b/i, kind: 'test' },
  { re: /^go\s+build\b/i, kind: 'build' },
  { re: /^\.?\/?gradlew?(\.bat)?\s+test\b/i, kind: 'test' },
  { re: /^\.?\/?gradlew?(\.bat)?\s+build\b/i, kind: 'build' },
  { re: /^mvn\s+test\b/i, kind: 'test' },
  { re: /^mvn\s+package\b/i, kind: 'build' },
  { re: /^mvn\s+install\b/i, kind: 'install' },
  { re: /^dotnet\s+test\b/i, kind: 'test' },
  { re: /^dotnet\s+build\b/i, kind: 'build' },
];

// Which long-running kind a command is, or null if it's not one of ours to touch.
function classify(command) {
  const cmd = String(command || '').trim();
  if (!cmd || UNSAFE.test(cmd) || QUOTED.test(cmd) || ALREADY_OPERANT.test(cmd) || RAW.test(cmd)) return null;
  for (const rule of RULES) if (rule.re.test(cmd)) return rule.kind;
  return null;
}

// A short, shell-safe title for the tile: the first two words, e.g. "npm-install".
function titleFor(command) {
  const words = String(command).trim().split(/\s+/).slice(0, 2).join('-');
  return (words.replace(/[^a-zA-Z0-9._-]/g, '') || 'run').slice(0, 40);
}

function dq(s) { return `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`; }
// PowerShell's double quotes still expand $variables and escape with ` rather than \, so it gets
// single quotes, where only ' itself is special (doubled).
function sq(s) { return `'${String(s).replace(/'/g, "''")}'`; }

// The rewritten command, or null if `command` isn't a long-running kind we know about (or is
// already unsafe/already-operant, via classify). `shell` is 'bash' (default) or 'powershell' (the
// quoting differs). Tests, builds and installs all go the same way: a Basement task that the app
// waits on inline for a few seconds, then hands over and waits for the errors of (bin/operant-cli.js).
function rewriteCommand(command, shell = 'bash') {
  if (!classify(command)) return null;
  const cmd = String(command).trim();
  const q = shell === 'powershell' ? sq : dq;
  return `operant run ${q(cmd)} --background --inline --title ${q(titleFor(cmd))}`;
}

// The hook's JSON reply for one PreToolUse event (the parsed stdin), or null to leave the call alone.
// No permissionDecision on purpose: an "allow" would approve the rewritten command unseen, while
// leaving it out keeps Claude Code's normal permission flow in place (updatedInput still applies).
// updatedInput replaces the whole tool input, so the other fields (description, run_in_background...)
// are carried over, and the timeout is raised because operant test/build wait up to 600 s themselves.
function hookOutput(input, env = {}) {
  // Off outside an Operant tile — this is the switch that makes the hook a no-op when Claude
  // Code is run any other way, even though --settings wires the hook up unconditionally.
  if (!input || env.OPERANT !== '1') return null;
  // Claude Code's shell tool is "Bash" on macOS/Linux and "PowerShell" on Windows.
  const shell = input.tool_name === 'PowerShell' ? 'powershell' : input.tool_name === 'Bash' ? 'bash' : null;
  if (input.hook_event_name !== 'PreToolUse' || !shell) return null;
  const toolInput = input.tool_input;
  const command = toolInput && toolInput.command;
  const updated = typeof command === 'string' ? rewriteCommand(command, shell) : null;
  if (!updated) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: { ...toolInput, command: updated, timeout: Math.max(Number(toolInput.timeout) || 0, 600000) },
      additionalContext: `Operant rerouted \`${command.trim()}\` to \`${updated}\`: it runs in the Basement and returns only the summary and failing lines (a run over a few seconds is waited on for its errors). `
        + 'To run a command unchanged, end it with `# raw`.',
    },
  };
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => { raw += c; });
  process.stdin.on('end', () => {
    let out = null;
    try { out = hookOutput(JSON.parse(raw || '{}'), process.env); } catch {} // never block the tool call over a hook bug
    if (out) process.stdout.write(JSON.stringify(out), () => process.exit(0));
    else process.exit(0);
  });
}

// Background tasks: a long command started detached, its output collected as it arrives, and only a
// status (running / passed / failed with its exit code) surfaced. main.js owns one registry and pushes
// summaries to the renderer's Basement page, which is the only place the retained output is shown.
const KEEP_TASKS = 30;
function createBackgroundTasks({ spawn, maxBytes = 256 * 1024, now = Date.now, onChange = () => {} } = {}) {
  spawn = spawn || require('child_process').spawn;
  const tasks = new Map();
  let seq = 0;
  const add = (t, text) => {
    t.output += text;
    if (t.output.length > maxBytes) { t.output = t.output.slice(-maxBytes); t.truncated = true; }
  };
  const waiters = new Map(); // task id -> callbacks for settled()
  const finish = (t, status, exitCode) => {
    if (t.status !== 'running') return;
    t.status = status; t.exitCode = exitCode; t.endedAt = now();
    onChange(t);
    for (const w of waiters.get(t.id) || []) w();
    waiters.delete(t.id);
  };
  // Resolves with the task once it has finished, or null if it is still running after `ms` (0 = at once). No task -> null.
  function settled(id, ms) {
    const t = tasks.get(Number(String(id).replace(/^bg/i, '')));
    if (!t) return Promise.resolve(null);
    if (t.status !== 'running') return Promise.resolve(t);
    return new Promise(resolve => {
      const cb = () => { clearTimeout(timer); resolve(t); };
      const timer = setTimeout(() => { waiters.set(t.id, (waiters.get(t.id) || []).filter(x => x !== cb)); resolve(t.status !== 'running' ? t : null); }, Math.max(0, ms));
      waiters.set(t.id, [...(waiters.get(t.id) || []), cb]);
    });
  }
  function start(command, { cwd, title, env, shell = true } = {}) {
    const t = { id: ++seq, title: title || titleFor(command), command: String(command), cwd: cwd || null,
      status: 'running', exitCode: null, startedAt: now(), endedAt: null, output: '', truncated: false };
    tasks.set(t.id, t);
    for (const [id, old] of tasks) { if (tasks.size <= KEEP_TASKS) break; if (old.status !== 'running') tasks.delete(id); }
    let child;
    try {
      child = spawn(t.command, { cwd: t.cwd || undefined, env: env || process.env, shell, windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { add(t, String(e.message || e)); finish(t, 'failed', -1); return t; }
    const feed = d => { add(t, d.toString('utf8')); onChange(t); };
    child.stdout && child.stdout.on('data', feed);
    child.stderr && child.stderr.on('data', feed);
    child.on('error', e => { add(t, String(e.message || e)); finish(t, 'failed', -1); });
    child.on('close', (code, signal) => finish(t, code === 0 ? 'passed' : 'failed', code == null ? (signal || -1) : code));
    if (child.unref) child.unref();
    onChange(t);
    return t;
  }
  return { start, settled, get: id => tasks.get(Number(String(id).replace(/^bg/i, ''))) || null, all: () => [...tasks.values()] };
}

// The status line for a task, e.g. "running", "passed", "failed (exit 1)".
function statusText(t) {
  if (t.status === 'running') return 'running';
  return t.status === 'passed' ? 'passed' : `failed (exit ${t.exitCode})`;
}

// What an agent gets back from a Basement task: one status line, then only what matters. A pass is its digest
// summary (or nothing more); a failure is the digest's failures, else the error lines, else the last few lines.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
const ERROR_RE = /\b(error|failed|failure|fatal|exception|traceback|panic|warn(ing)?|FAIL)\b|[✗✖]/i;
function errorLines(text, max = 60) {
  const lines = String(text || '').replace(ANSI, '').replace(/\r/g, '\n').split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l.trim());
  const keep = new Set();
  lines.forEach((l, i) => { if (ERROR_RE.test(l)) for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 2); j++) keep.add(j); });
  const out = [...keep].sort((a, b) => a - b).map(i => lines[i]);
  return out.length > max ? ['... (earlier lines dropped)', ...out.slice(-max)] : out;
}
function taskReport(t, { errors = false, digest } = {}) {
  const secs = Math.max(0, Math.round(((t.endedAt || Date.now()) - t.startedAt) / 1000));
  const head = `${t.title} (bg${t.id}): ${statusText(t)}${t.status === 'running' ? ` after ${secs}s, still in the Basement` : ` in ${secs}s`}`;
  const text = String(t.output || '').replace(ANSI, '');
  let d = null;
  try { d = digest ? digest(text) : null; } catch {}
  if (t.status === 'passed' && !errors) return d ? `${head}\n${d.runner}: ${d.summary}` : head;
  const body = [];
  if (d) {
    body.push(`${d.runner}: ${d.summary}`);
    for (const f of d.failures || []) body.push(`${f.file ? f.file + (f.line ? ':' + f.line : '') : '?'}  ${f.title}${f.message ? ' - ' + String(f.message).split('\n')[0] : ''}`);
    if (d.more) body.push(`... and ${d.more} more`);
  } else {
    const el = errorLines(text);
    body.push(...(el.length ? el : t.status === 'passed' ? ['no errors or warnings'] : text.split(/\r?\n/).filter(l => l.trim()).slice(-15)));
  }
  return `${head}\n${body.join('\n')}`;
}

// What the Basement page draws: newest first, the running ones first of all, each row with its status
// and duration, and the selected task (default: the first row) with its full retained output.
function basementModel(tasks, selectedId, now = Date.now()) {
  const list = (Array.isArray(tasks) ? tasks : []).slice().sort((a, b) =>
    (b.status === 'running') - (a.status === 'running') || b.startedAt - a.startedAt);
  const rows = list.map(t => ({ id: t.id, title: t.title, command: t.command, status: t.status, label: statusText(t),
    seconds: Math.max(0, Math.round(((t.endedAt || now) - t.startedAt) / 1000)) }));
  const sel = list.find(t => t.id === selectedId) || list[0] || null;
  return { rows, selected: sel && { ...rows.find(r => r.id === sel.id), output: sel.output || '', truncated: !!sel.truncated },
    running: rows.filter(r => r.status === 'running').length };
}

const api = { classify, rewriteCommand, titleFor, hookOutput, createBackgroundTasks, statusText, basementModel, taskReport, errorLines };
if (typeof module !== 'undefined') {
  if (require.main === module) main();
  module.exports = { classify, rewriteCommand, titleFor, hookOutput, createBackgroundTasks, statusText, basementModel, taskReport, errorLines };
} else if (typeof window !== 'undefined') window.OperantLongCommands = api; // loaded by the renderer for the Basement page
