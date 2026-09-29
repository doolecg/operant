#!/usr/bin/env node
// Eval harness: runs `claude -p` over cases/*.json in a throwaway copy of fixtures/node-app, with the
// fake `operant` from stub/ first on PATH, and grades how the agent used it (skill loaded, long
// commands routed through operant test/build/run, plan/ask/notify/agent/task used when they fit and
// left alone when they don't). Node built-ins only. See README.md.
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUB_DIR = path.join(HERE, 'stub');
const FIXTURE = path.join(HERE, 'fixtures', 'node-app');
const CASES_DIR = path.join(HERE, 'cases');
const DEFAULT_REPO = 'F:\\PROGRAMMING\\REPOS\\Operant';
const RUN_TIMEOUT_MS = Number(process.env.OPERANT_EVAL_TIMEOUT_MS) || 6 * 60 * 1000;
const DEFAULT_MAX_TURNS = 12;
const KINDS = ['use', 'negative', 'behaviour'];
const SAFE_API = 'http://127.0.0.1:9'; // the discard port: nothing listens there, so a stray real CLI fails to connect

// Everything else (a raw `npm test`, `Bash(rm ...)`) is denied by dontAsk without running, and the
// attempt still shows up in the stream. (A PowerShell line that starts with `cd <dir>;` is denied
// whole, operant call included, whatever allow rules say; grade() counts those as operantDenied.)
const BASE_TOOLS = ['Read', 'Glob', 'Grep', 'Skill', 'Bash(operant *)', 'PowerShell(operant *)', 'Bash(git *)', 'Bash(ls *)', 'Bash(cat *)',
  'Bash(node -e *)', 'Bash(echo *)', 'PowerShell(git *)', 'PowerShell(Get-ChildItem *)', 'PowerShell(Get-Content *)', 'PowerShell(node -e *)'];

// The baseline arm has no operant at all, so the agent gets the tools it would normally have for this
// work: the same set minus operant, plus npm and node (still inside the throwaway workspace).
const BASELINE_TOOLS = [...BASE_TOOLS.filter(t => !/operant/.test(t)), 'Bash(npm *)', 'Bash(node *)', 'PowerShell(npm *)', 'PowerShell(node *)'];
// OpenCode has no allowlist mode that the free tier accepts; it gets everything except deletes, pushes,
// the web and anything outside its workspace, and the workspace is a throwaway copy.
const OPENCODE_PERMISSION = { bash: { '*': 'allow', 'rm *': 'deny', 'git push*': 'deny', 'Remove-Item*': 'deny', 'del *': 'deny' }, webfetch: 'deny', external_directory: 'deny' };

const USAGE = `usage: node run.mjs --arm <label> [--brief-ref <git ref> | --brief-file <path>] [--plugin-dir <path>]
                   [--cases a,b,c] [--runs 3] [--model sonnet] [-j 3] [--repo <path>] [--keep] [--dry-run]
                   [--no-operant] [--agent claude|opencode]`;

function die(msg) { console.error(`run.mjs: ${msg}`); process.exit(1); }

// ------------------------------------------------------------ options
function parseOptions() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        arm: { type: 'string' }, 'brief-ref': { type: 'string' }, 'brief-file': { type: 'string' }, 'plugin-dir': { type: 'string', multiple: true },
        cases: { type: 'string' }, runs: { type: 'string', default: '3' }, model: { type: 'string' },
        jobs: { type: 'string', short: 'j', default: '3' }, repo: { type: 'string' }, keep: { type: 'boolean', default: false },
        'no-operant': { type: 'boolean', default: false }, agent: { type: 'string', default: 'claude' },
        'dry-run': { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false },
      },
    }));
  } catch (e) { die(`${e.message}\n${USAGE}`); }
  if (values.help) { console.log(USAGE); process.exit(0); }
  if (!values.arm) die(`--arm is required\n${USAGE}`);
  if (values['brief-ref'] && values['brief-file']) die('use either --brief-ref or --brief-file, not both');
  if (!['claude', 'opencode'].includes(values.agent)) die('--agent must be claude or opencode');
  if (values['no-operant'] && (values['brief-ref'] || values['brief-file'] || (values['plugin-dir'] || []).length)) die('--no-operant runs with no brief and no plugin dir; drop --brief-ref/--brief-file/--plugin-dir');
  const int = (name, v) => { const n = Number(v); if (!Number.isInteger(n) || n < 1) die(`--${name} must be a positive integer`); return n; };
  return {
    arm: values.arm, briefRef: values['brief-ref'], briefFile: values['brief-file'], pluginDirs: (values['plugin-dir'] || []).map(p => path.resolve(p)),
    cases: values.cases ? values.cases.split(',').map(s => s.trim()).filter(Boolean) : null,
    runs: int('runs', values.runs), model: values.model || (values.agent === 'opencode' ? 'opencode/big-pickle' : 'sonnet'), jobs: int('jobs', values.jobs),
    noOperant: values['no-operant'], agent: values.agent,
    repo: values.repo || process.env.OPERANT_EVAL_REPO || DEFAULT_REPO, keep: values.keep, dryRun: values['dry-run'],
  };
}

function loadCases(only) {
  const all = fs.readdirSync(CASES_DIR).filter(f => f.endsWith('.json')).sort().map(f => {
    const c = JSON.parse(fs.readFileSync(path.join(CASES_DIR, f), 'utf8'));
    if (!c.name || !c.prompt || !KINDS.includes(c.kind)) die(`cases/${f}: needs name, prompt and kind (${KINDS.join('|')})`);
    return { scenario: {}, env: {}, extraTools: [], expect: {}, ...c };
  });
  const picked = only ? only.map(n => all.find(c => c.name === n) || die(`unknown case "${n}" (have: ${all.map(c => c.name).join(', ')})`)) : all;
  return picked.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.name.localeCompare(b.name));
}

// ------------------------------------------------------------ the brief
// Operant hands Claude tiles agent-brief.js's BRIEF via --append-system-prompt; here the same text
// goes in as a file. A ref/.js file is loaded as a module (briefFor('claude') when it has one), any
// other file is used as-is.
function loadBrief(o, dir) {
  const fromModule = (file, source) => {
    let mod;
    try { mod = createRequire(import.meta.url)(file); } catch (e) { die(`could not load the brief module ${file}: ${e.message} (try --brief-file with the text)`); }
    const fn = typeof mod.briefFor === 'function';
    const text = fn ? mod.briefFor('claude') : mod.BRIEF;
    if (typeof text !== 'string' || !text.trim()) die(`${file} exports no usable briefFor('claude') or BRIEF`);
    const out = path.join(dir, 'brief.txt');
    fs.writeFileSync(out, text);
    return { file: out, text, source, via: fn ? "briefFor('claude')" : 'BRIEF' };
  };
  if (o.briefRef) {
    let src;
    try { src = execFileSync('git', ['-C', o.repo, 'show', `${o.briefRef}:agent-brief.js`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { die(`git show ${o.briefRef}:agent-brief.js failed in ${o.repo}: ${String(e.stderr || e.message).trim()}`); }
    const file = path.join(dir, `agent-brief.${o.briefRef.replace(/[^\w.-]/g, '_')}.cjs`);
    fs.writeFileSync(file, src);
    return fromModule(file, `git ref ${o.briefRef} of ${o.repo}`);
  }
  if (o.briefFile) {
    const file = path.resolve(o.briefFile);
    if (!fs.existsSync(file)) die(`--brief-file ${file} does not exist`);
    if (/\.c?js$/i.test(file)) return fromModule(file, `file ${file}`);
    return { file, text: fs.readFileSync(file, 'utf8'), source: `file ${file}`, via: 'text as-is' };
  }
  return null;
}

// ------------------------------------------------------------ child environment (SAFETY)
// The child must never reach the live Operant this harness may be running inside: drop every
// OPERANT* var, the session vars that would make claude think it is nested in (or talk to) the
// parent session, and any PATH folder that offers a real `operant`. Auth and config vars stay.
const SESSION_VAR = /^(?:CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(?:ENTRYPOINT|EXECPATH|SSE_PORT|PLUGIN_DIRS|SESSION\w*|BRIDGE\w*|CHILD\w*|MESSAGING\w*|PARENT\w*|IDE\w*))$/i;
const OPERANT_FILES = ['operant-cli.js', 'operant', 'operant.cmd', 'operant.bat', 'operant.exe', 'operant.ps1'];

function hasOperant(dir) {
  if (path.resolve(dir).toLowerCase() === path.resolve(STUB_DIR).toLowerCase()) return false;
  return OPERANT_FILES.some(f => { try { return fs.statSync(path.join(dir, f)).isFile(); } catch { return false; } });
}

function childEnv(caseEnv, files, noOperant = false) {
  const env = {};
  const removed = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (k.toUpperCase().startsWith('OPERANT') || SESSION_VAR.test(k)) removed.push(k);
    else env[k] = v;
  }
  const pathKey = Object.keys(env).find(k => k.toUpperCase() === 'PATH') || 'PATH';
  const kept = [];
  const dropped = [];
  for (const raw of (env[pathKey] || '').split(path.delimiter)) {
    const d = raw.replace(/^"|"$/g, '');
    if (d) (hasOperant(d) ? dropped : kept).push(d);
  }
  if (noOperant) { env[pathKey] = kept.join(path.delimiter); return { env, removed, dropped, pathKey }; }
  env[pathKey] = [STUB_DIR, ...kept].join(path.delimiter);
  Object.assign(env, {
    OPERANT: '1', OPERANT_API: SAFE_API, OPERANT_TOKEN: 'eval', OPERANT_TILE: '7',
    OPERANT_EVAL_LOG: files.log, OPERANT_EVAL_SCENARIO: files.scenario,
  }, caseEnv);
  if (env.OPERANT_API !== SAFE_API || env.OPERANT_TOKEN !== 'eval') die('a case tried to override OPERANT_API/OPERANT_TOKEN, refusing');
  return { env, removed, dropped, pathKey };
}

// ------------------------------------------------------------ claude executable
function findOnPath(names) {
  for (const raw of (process.env.PATH || process.env.Path || '').split(path.delimiter)) {
    const d = raw.replace(/^"|"$/g, '');
    if (!d) continue;
    for (const n of names) { const p = path.join(d, n); try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ } }
  }
  return null;
}

function resolveClaude() {
  if (process.env.OPERANT_EVAL_CLAUDE) return process.env.OPERANT_EVAL_CLAUDE;
  const found = findOnPath(process.platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude.bat'] : ['claude']);
  return found || die('claude not found on PATH (set OPERANT_EVAL_CLAUDE to its path)');
}

function resolveOpencode() {
  if (process.env.OPERANT_EVAL_OPENCODE) return process.env.OPERANT_EVAL_OPENCODE;
  return findOnPath(process.platform === 'win32' ? ['opencode.exe', 'opencode.cmd', 'opencode.bat'] : ['opencode']) || die('opencode not found on PATH (set OPERANT_EVAL_OPENCODE to its path)');
}

// A .exe (native install, scoop shim) spawns directly. An npm .cmd shim is unwrapped to the file it
// launches, so no cmd.exe re-parses our arguments; any other .cmd goes through cmd.exe with each
// argument quoted for it.
function spawnSpec(bin, args) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    // The launch line is last; an earlier `IF EXIST "%dp0%\node.exe"` is only the interpreter probe.
    const target = [...fs.readFileSync(bin, 'utf8').matchAll(/"%(?:~dp0|dp0%)\\([^"\r\n]+\.(?:exe|c?js|mjs))"/gi)]
      .map(m => path.join(path.dirname(bin), m[1])).reverse().find(p => !/[\\/]node\.exe$/i.test(p) && fs.existsSync(p));
    if (target) return /\.exe$/i.test(target) ? { cmd: target, args } : { cmd: process.execPath, args: [target, ...args] };
    const q = a => `"${String(a).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
    return { cmd: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${[bin, ...args].map(q).join(' ')}"`], windowsVerbatimArguments: true };
  }
  return { cmd: bin, args };
}

function claudeArgs(c, o, brief) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--model', o.model, '--permission-mode', 'dontAsk'];
  if (brief) args.push('--append-system-prompt-file', brief.file);
  args.push('--max-turns', String(c.maxTurns || DEFAULT_MAX_TURNS));
  // The user's MCP servers (mail, calendar, IDE...) add tokens and start-up time but nothing this
  // measures; both arms get the same bare tool set.
  args.push('--strict-mcp-config');
  for (const p of o.pluginDirs) args.push('--plugin-dir', p);
  // Last: --allowedTools is variadic, which is also why the prompt goes in on stdin.
  args.push('--allowedTools', ...(o.noOperant ? BASELINE_TOOLS : BASE_TOOLS), ...c.extraTools);
  return args;
}

// --dir pins opencode to the throwaway workspace; without it a trial run edited the repo's own fixture.
const opencodeArgs = (c, o, ws) => ['run', '--format', 'json', '--dir', ws, '--model', o.model, promptFor(c, o)];
const promptFor = (c, o) => o.noOperant && c.baselinePrompt ? c.baselinePrompt : c.prompt;
const buildArgs = (c, o, brief, ws) => o.agent === 'opencode' ? opencodeArgs(c, o, ws) : claudeArgs(c, o, brief);

const display = a => /^[\w@%+=:,./\\-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`;

function killTree(pid) {
  if (process.platform === 'win32') { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ } }
  else { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } } }
}

// ------------------------------------------------------------ workspace
function prepareWorkspace(name, n) {
  const ws = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), `operant-eval-${name}-${n}-`));
  fs.cpSync(FIXTURE, ws, { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: ws, stdio: 'ignore' });
  git('init', '-q');
  git('symbolic-ref', 'HEAD', 'refs/heads/main');
  for (const [k, v] of [['user.name', 'eval'], ['user.email', 'eval@example.com'], ['core.autocrlf', 'false'], ['commit.gpgsign', 'false']]) git('config', k, v);
  git('add', '-A');
  git('commit', '-qm', 'initial', '--no-verify');
  return ws;
}

// Where claude keeps per-project data for a working directory: its path with every non-alphanumeric
// character turned into "-". Refuses anything that isn't one of our own workspaces.
function claudeProjectDir(ws) {
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects', ws.replace(/[^A-Za-z0-9]/g, '-'));
  if (!path.basename(dir).includes('operant-eval-')) throw new Error(`refusing to remove ${dir}`);
  return dir;
}

// ------------------------------------------------------------ stream parsing
const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => b && b.text || '').join('') : '';

// Background subagents make the session wake up again as each one finishes, so a stream can hold
// several init and result events: turns and durations add up across them, cost and modelUsage are
// already session totals in each. Subagent tool calls are in the stream too (parent_tool_use_id set).
function parseStream(raw) {
  const s = { init: null, toolUses: [], results: new Map(), resultEvents: [], result: null, denied: new Map(), rateLimit: null, bad: 0, messageIds: new Set() };
  for (const line of raw.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    let ev;
    try { ev = JSON.parse(l); } catch { s.bad++; continue; }
    if (ev.type === 'system' && ev.subtype === 'init') s.init = s.init || ev;
    else if (ev.type === 'system' && ev.subtype === 'permission_denied') s.denied.set(ev.tool_use_id, ev.tool_name);
    else if (ev.type === 'assistant' && ev.message) {
      if (ev.message.id) s.messageIds.add(ev.message.id);
      for (const b of ev.message.content || []) {
        if (b.type === 'tool_use' && !s.toolUses.some(t => t.id === b.id)) s.toolUses.push({ id: b.id, name: b.name, input: b.input || {}, sub: !!ev.parent_tool_use_id });
      }
    } else if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
      for (const b of ev.message.content) if (b.type === 'tool_result') s.results.set(b.tool_use_id, { isError: !!b.is_error, text: textOf(b.content).slice(0, 200) });
    } else if (ev.type === 'result') s.resultEvents.push(ev);
    else if (ev.type === 'rate_limit_event' && ev.rate_limit_info) {
      const i = ev.rate_limit_info, w = i.unifiedWindows || {};
      s.rateLimit = { status: i.status, fiveHour: w.five_hour?.utilization ?? null, sevenDay: w.seven_day?.utilization ?? null };
    }
  }
  s.result = s.resultEvents.at(-1) || null;
  return s;
}

// `opencode run --format json`: one JSON event per line (step_start, tool_use, text, step_finish, error).
// Mapped onto parseStream's shape (Claude tool names, one synthetic result event) so grading and totals
// work unchanged; an opencode turn is one model step.
const OPENCODE_TOOLS = { bash: 'Bash', read: 'Read', edit: 'Edit', write: 'Write', glob: 'Glob', grep: 'Grep', task: 'Agent', skill: 'Skill', patch: 'Edit' };
function parseOpencode(raw) {
  const s = { init: null, toolUses: [], results: new Map(), resultEvents: [], result: null, denied: new Map(), rateLimit: null, bad: 0, messageIds: new Set(), apiError: null };
  let steps = 0, cost = 0, lastText = null, reason = null;
  const tok = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  for (const line of raw.split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;
    let ev;
    try { ev = JSON.parse(l); } catch { s.bad++; continue; }
    const p = ev.part || {};
    if (ev.type === 'tool_use' && p.tool) {
      const id = p.callID || p.id;
      s.toolUses.push({ id, name: OPENCODE_TOOLS[p.tool] || p.tool, input: p.state?.input || {}, sub: false });
      if (p.state?.status === 'error') s.results.set(id, { isError: true, text: String(p.state.error || '').slice(0, 200) });
      else if (p.state?.status === 'completed') s.results.set(id, { isError: false, text: String(p.state.output || '').slice(0, 200) });
    } else if (ev.type === 'text' && typeof p.text === 'string') lastText = p.text;
    else if (ev.type === 'step_finish') {
      steps++; cost += p.cost || 0; reason = p.reason || reason;
      tok.input += p.tokens?.input || 0; tok.output += p.tokens?.output || 0;
      tok.cacheRead += p.tokens?.cache?.read || 0; tok.cacheCreate += p.tokens?.cache?.write || 0;
    } else if (ev.type === 'error') s.apiError = ev.error?.data?.message || ev.error?.name || 'error';
  }
  if (steps) {
    s.resultEvents.push({ type: 'result', subtype: 'success', is_error: false, num_turns: steps, total_cost_usd: cost, result: lastText, terminal_reason: reason,
      usage: { input_tokens: tok.input, output_tokens: tok.output, cache_read_input_tokens: tok.cacheRead, cache_creation_input_tokens: tok.cacheCreate } });
    s.messageIds = new Set(Array.from({ length: steps }, (_, i) => i));
  }
  s.result = s.resultEvents.at(-1) || null;
  return s;
}

const sum = xs => xs.reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);

// Totals across a stream's result events (see parseStream).
function totals(s) {
  const rs = s.resultEvents, last = rs.at(-1);
  if (!last) return { turns: s.messageIds.size, durationMs: null, costUsd: null, usage: null, isError: null, subtype: null, terminalReason: null, finalText: null };
  const mu = Object.values(last.modelUsage || {});
  const usage = mu.length
    ? { input: sum(mu.map(m => m.inputTokens)), output: sum(mu.map(m => m.outputTokens)), cacheRead: sum(mu.map(m => m.cacheReadInputTokens)), cacheCreate: sum(mu.map(m => m.cacheCreationInputTokens)) }
    : { input: sum(rs.map(r => r.usage?.input_tokens)), output: sum(rs.map(r => r.usage?.output_tokens)), cacheRead: sum(rs.map(r => r.usage?.cache_read_input_tokens)), cacheCreate: sum(rs.map(r => r.usage?.cache_creation_input_tokens)) };
  const bad = rs.find(r => r.is_error) || last;
  const text = [...rs].reverse().map(r => r.result).find(t => typeof t === 'string' && t);
  return {
    turns: sum(rs.map(r => r.num_turns)), durationMs: sum(rs.map(r => r.duration_ms)), costUsd: last.total_cost_usd ?? null, usage,
    isError: !!rs.find(r => r.is_error), subtype: bad.subtype ?? null, terminalReason: last.terminal_reason ?? null, finalText: text ? text.slice(0, 500) : null,
  };
}

// ------------------------------------------------------------ shell command classification
// Commands are split at unquoted separators so `operant run "npm run dev"` counts as operant and
// only the parts outside operant's own arguments can be a raw long command.
function segments(cmd) {
  const out = [];
  let cur = '', q = null;
  for (const c of cmd) {
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (';&|\n\r()`{}'.includes(c)) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim()).filter(Boolean);
}

const OPERANT_HEAD = /^(?:"[^"]*[\\/]|'[^']*[\\/]|[^\s"']*[\\/])?operant(?:\.cmd)?["']?(?=\s|$)/i;
const WRAPPER = /^(?:bash|sh|zsh|cmd|cmd\.exe|powershell|powershell\.exe|pwsh|env|time|timeout|nohup|start|call|sudo|Start-Process|Invoke-Expression|iex|Invoke-Command)\b/i;
const LONG = [
  /\b(?:npm|pnpm|yarn|npx|bun)\b[^\n]*?\b(?:test|build|install|ci|i|dev|start|run|serve|vitest|jest)\b/i,
  /\bnode\s+(?:--test\b|\.?[\\/]?(?:build|server)\.js\b)/i,
  /\bpytest\b|\b(?:python3?|py)\s+-m\s+(?:pytest|unittest)\b/i,
  /\bcargo\s+(?:test|build|run|install)\b/i,
  /\bgo\s+(?:test|build|run|install)\b/i,
  /\b(?:gradlew?(?:\.bat)?|\.[\\/]gradlew)\b[^\n]*?\b(?:test|build|check|assemble|run)\b/i,
  /\bmvn\b[^\n]*?\b(?:test|package|install|verify|compile)\b/i,
  /\bdotnet\s+(?:test|build|run|publish)\b/i,
];
const ROUTE = new Set(['test', 'build', 'run']);

function isRawLong(seg) {
  // A quoted string that only mentions a command (git commit -m "npm test") isn't running it,
  // except behind a wrapper (bash -c "npm test").
  const scan = WRAPPER.test(seg) ? seg : seg.replace(/"[^"]*"|'[^']*'/g, '""');
  return LONG.some(re => re.test(scan));
}

// operant invocations (as word lists after `operant`) and raw long commands in one shell command,
// plus which of the two the command reached first.
function classifyCommand(cmd) {
  const operant = [];
  let raw = 0, first = null;
  for (const seg of segments(cmd)) {
    const m = OPERANT_HEAD.exec(seg);
    if (m) {
      const words = seg.slice(m[0].length).trim().split(/\s+/).filter(Boolean).map(w => w.replace(/^["']|["']$/g, ''));
      operant.push(words);
      if (!first && ROUTE.has(words[0])) first = 'operant';
    } else if (isRawLong(seg)) { raw++; if (!first) first = 'raw'; }
  }
  return { operant, raw, first };
}

// ------------------------------------------------------------ grading
const SKILL_RE = /"skill"\s*:\s*"(?:[\w-]+:)?operant"/;
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const startsWith = (argv, want) => want.every((w, i) => argv[i] === w);

function grade(c, s, logCalls, opts = {}) {
  const skillCalls = s.toolUses.filter(t => t.name === 'Skill');
  const skillInvoked = skillCalls.some(t => SKILL_RE.test(JSON.stringify(t.input)));

  const shell = s.toolUses.filter(t => SHELL_TOOLS.has(t.name)).map(t => ({ t, ...classifyCommand(String(t.input.command || '')) }));
  const attempts = shell.flatMap(x => x.operant);
  const rawLong = shell.filter(x => x.raw).map(x => String(x.t.input.command).slice(0, 300));
  const firstLong = shell.map(x => x.first).find(Boolean) || null;

  const calls = logCalls.map(l => l.argv);
  const routeCalls = calls.filter(a => ROUTE.has(a[0])).length;
  const routed = routeCalls > 0 && firstLong === 'operant';
  const usedAgentTool = s.toolUses.some(t => t.name === 'Agent' || t.name === 'Task');
  const delegated = usedAgentTool || calls.some(a => a[0] === 'agent' || (a[0] === 'task' && a[1] === 'add'));

  const e = c.expect || {};
  const checks = {};
  if (!opts.baseline) { // the baseline arm has no operant, so only its outcome is graded (see outcomeCheck)
    if ('routed' in e) checks.routed = routed === e.routed;
    if ('delegated' in e) checks.delegated = delegated === e.delegated;
    for (const want of e.operant || []) checks[`operant ${want}`] = calls.some(a => startsWith(a, want.split(/\s+/)));
    for (const group of e.operantAny || []) checks[`operant any of ${group.join(' | ')}`] = group.some(want => calls.some(a => startsWith(a, want.split(/\s+/))));
    if (e.noOperant) {
      const banned = new Set(e.noOperant);
      checks[`no operant ${e.noOperant.join('|')}`] = ![...calls.map(a => a[0]), ...attempts.map(w => w[0])].some(w => banned.has(w));
    }
    if (e.agentTier) checks[`agent --tier ${e.agentTier.join('|')}`] = calls.some(a => a[0] === 'agent' && e.agentTier.includes(a[a.indexOf('--tier') + 1]));
    for (const [cmd, max] of Object.entries(e.maxCalls || {})) checks[`at most ${max} operant ${cmd}`] = calls.filter(a => a[0] === cmd).length <= max;
    for (const re of e.noShell || []) checks[`no shell /${re}/`] = !shell.some(x => new RegExp(re, 'i').test(String(x.t.input.command || '')));
  }

  const toolCounts = {};
  for (const t of s.toolUses) toolCounts[t.name] = (toolCounts[t.name] || 0) + 1;
  // operant commands the permission rules refused: a harness artifact to read results against
  const refused = t => s.denied.has(t.id) || (s.results.get(t.id)?.isError && /^Permission to use/i.test(s.results.get(t.id).text));
  const operantDenied = shell.filter(x => x.operant.length && refused(x.t)).length;
  return {
    skillInvoked, skillCalls: skillCalls.map(t => t.input.skill || null),
    operantCalls: calls, operantAttempts: attempts, operantDenied,
    routed, firstLong, firstLongRouted: firstLong === null ? null : firstLong === 'operant', routeCalls,
    rawLongAttempts: rawLong.length, rawLong, delegated, usedAgentTool,
    shellCommands: shell.map(x => String(x.t.input.command).slice(0, 300)), toolCounts,
    checks, checksPassed: Object.values(checks).every(Boolean),
  };
}

// expect.outcome: a command run in the workspace after the session (e.g. `node --test`); exit 0 passes.
// Used in every arm, so the baseline and operant arms are judged on the same thing.
function outcomeCheck(c, ws) {
  const cmd = c.expect && c.expect.outcome;
  if (!cmd) return null;
  const r = spawnSync(cmd, { cwd: ws, shell: true, encoding: 'utf8', timeout: 60000, windowsHide: true });
  return { cmd, ok: r.status === 0, code: r.status, tail: `${r.stdout || ''}${r.stderr || ''}`.trim().slice(-300) };
}

// Safety net for agents with no sandbox: the repo's own fixture must not change during a run.
function fixtureStatus(repo) {
  try { return execFileSync('git', ['-C', repo, 'status', '--porcelain', '--', 'evals/fixtures'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
}
function guardFixture(repo, before) {
  const after = fixtureStatus(repo);
  if (after === null || after === before) return false;
  try { execFileSync('git', ['-C', repo, 'checkout', '--', 'evals/fixtures'], { stdio: 'ignore' }); } catch { /* reported below anyway */ }
  return true;
}

// ------------------------------------------------------------ one run
const active = new Set();
let aborting = false;

async function runOne(job, o, brief, agentBin, runDir) {
  const { c, n } = job;
  const files = {
    log: path.join(runDir, 'stub', `${c.name}-${n}.log.jsonl`),
    scenario: path.join(runDir, 'stub', `${c.name}-${n}.scenario.json`),
    raw: path.join(runDir, 'raw', `${c.name}-${n}.jsonl`),
  };
  const rec = { arm: o.arm, agent: o.agent, noOperant: o.noOperant, case: c.name, kind: c.kind, run: n, model: o.model, pass: false, error: null };
  const started = Date.now();
  let ws = null, fixtureBefore = null;
  try {
    ws = prepareWorkspace(c.name, n);
    fs.writeFileSync(files.scenario, JSON.stringify(c.scenario || {}, null, 2));
    fs.writeFileSync(files.log, '');
    const { env } = childEnv(o.noOperant ? {} : c.env || {}, files, o.noOperant);
    if (o.agent === 'opencode') {
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ permission: OPENCODE_PERMISSION });
      env.PWD = ws; // an inherited PWD from the parent shell can override the child's cwd
      fixtureBefore = fixtureStatus(o.repo);
      // opencode reads AGENTS.md from the working directory: that is where the brief goes.
      if (brief) fs.writeFileSync(path.join(ws, 'AGENTS.md'), brief.text);
    }
    const spec = spawnSpec(agentBin, buildArgs(c, o, brief, ws));
    const out = await new Promise(resolve => {
      const chunks = [], errChunks = [];
      let done = false, timedOut = false, seenResult = false, timer = null, grace = null;
      const finish = (code, spawnError) => {
        if (done) return;
        done = true;
        clearTimeout(timer); clearTimeout(grace);
        active.delete(child.pid);
        resolve({ stdout: Buffer.concat(chunks).toString('utf8'), stderr: Buffer.concat(errChunks).toString('utf8'), code, timedOut, spawnError });
      };
      const child = spawn(spec.cmd, spec.args, { cwd: ws, env, windowsHide: true, detached: process.platform !== 'win32', windowsVerbatimArguments: spec.windowsVerbatimArguments, stdio: ['pipe', 'pipe', 'pipe'] });
      if (child.pid) active.add(child.pid);
      timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, RUN_TIMEOUT_MS);
      child.stdout.on('data', d => {
        chunks.push(d);
        // A finished session can linger on child processes; give it a moment, then end it.
        if (!seenResult && (d.includes('"type":"result"') || d.includes('"reason":"stop"'))) { seenResult = true; grace = setTimeout(() => killTree(child.pid), 20000); }
      });
      child.stderr.on('data', d => errChunks.push(d));
      child.on('error', e => finish(null, e.message));
      child.on('close', code => finish(code));
      child.stdin.on('error', () => {});
      child.stdin.end(o.agent === 'opencode' ? '' : promptFor(c, o));
    });

    fs.writeFileSync(files.raw, out.stdout);
    const escaped = fixtureBefore !== null && guardFixture(o.repo, fixtureBefore);
    const s = o.agent === 'opencode' ? parseOpencode(out.stdout) : parseStream(out.stdout);
    const logCalls = fs.readFileSync(files.log, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    Object.assign(rec, grade(c, s, logCalls, { baseline: o.noOperant }));
    const outcome = outcomeCheck(c, ws);
    if (outcome) { rec.outcome = outcome; rec.checks.outcome = outcome.ok; rec.checksPassed = Object.values(rec.checks).every(Boolean); }
    // Without operant only the outcome can be graded; a case with none isn't counted in the pass rate.
    rec.graded = !o.noOperant || !!outcome;

    const r = s.result || {};
    Object.assign(rec, totals(s), {
      resultEvents: s.resultEvents.length, subagents: r.subagent_stats?.spawned ?? 0, subagentToolUses: s.toolUses.filter(t => t.sub).length,
      // The denial events cover subagents too; result.permission_denials only the main thread.
      permissionDenials: s.toolUses.filter(t => s.denied.has(t.id)).map(t => ({ tool: t.name, input: JSON.stringify(t.input).slice(0, 200) })),
      toolResults: s.toolUses.map(t => ({ tool: t.name, isError: s.results.get(t.id)?.isError ?? null, out: s.results.get(t.id)?.text ?? null })),
      init: s.init && { tools: s.init.tools, skills: s.init.skills, slashCommands: s.init.slash_commands, plugins: (s.init.plugins || []).map(p => p.name), mcpServers: s.init.mcp_servers, version: s.init.claude_code_version },
      rateLimit: s.rateLimit, badLines: s.bad, exitCode: out.code, stderr: out.stderr.slice(0, 2000) || null,
    });
    // Running out of turns is an outcome to grade; an API failure or a crash is not (it would let a
    // negative case pass just by never getting to act).
    if (s.apiError && !s.result) rec.error = `${o.agent}: ${s.apiError}`;
    else if (out.spawnError) rec.error = `spawn: ${out.spawnError}`;
    else if (aborting && !s.result) rec.error = 'aborted';
    else if (out.timedOut) rec.error = 'timeout';
    else if (!s.result) rec.error = `no result event (exit ${out.code})`;
    else if (rec.isError && rec.subtype !== 'error_max_turns') rec.error = `result: ${rec.subtype}`;
    if (escaped) rec.error = 'wrote outside its workspace (evals/fixtures in the repo changed; restored)';
    rec.pass = rec.graded ? !rec.error && rec.checksPassed : null;
  } catch (e) {
    rec.error = `harness: ${e.message}`;
  } finally {
    rec.endedAt = new Date().toISOString();
    rec.wallMs = Date.now() - started;
    if (ws) {
      if (o.keep) rec.workspace = ws;
      else {
        const rm = p => fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
        try { rm(ws); } catch { rec.workspace = ws; }
        // claude makes an (empty) projects/<mangled cwd>/memory folder per working directory; one
        // per run would pile up in the user's ~/.claude.
        try { rm(claudeProjectDir(ws)); } catch { /* harmless leftover */ }
      }
    }
  }
  return rec;
}

async function pool(jobs, limit, fn) {
  let i = 0;
  const worker = async () => { for (;;) { if (aborting) return; const j = jobs[i++]; if (!j) return; await fn(j); } };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
}

// ------------------------------------------------------------ summary
const avg = xs => { const v = xs.filter(x => typeof x === 'number'); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const pct = (n, d) => d ? `${Math.round(100 * n / d)}%` : '-';
const num = (x, dp = 1) => x === null ? '-' : x.toFixed(dp);
const usd = x => x === null ? '-' : `$${x.toFixed(3)}`;

function aggregate(rs) {
  return {
    runs: rs.length, graded: rs.filter(r => r.graded !== false).length, errors: rs.filter(r => r.error).length, pass: rs.filter(r => r.pass).length,
    skill: rs.filter(r => r.skillInvoked).length, routed: rs.filter(r => r.routed).length,
    rawLongAvg: avg(rs.map(r => r.rawLongAttempts)), turnsAvg: avg(rs.map(r => r.turns)),
    costAvg: avg(rs.map(r => r.costUsd)), costTotal: rs.reduce((a, r) => a + (r.costUsd || 0), 0),
  };
}

function sha1(file) { try { return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex'); } catch { return null; } }

function claudeVersion(bin) {
  try { const spec = spawnSpec(bin, ['--version']); return spawnSync(spec.cmd, spec.args, { encoding: 'utf8', timeout: 15000, windowsHide: true, windowsVerbatimArguments: spec.windowsVerbatimArguments }).stdout.trim() || null; } catch { return null; }
}

function setupInfo(o, brief, claudeBin) {
  const skillFile = path.join(os.homedir(), '.claude', 'skills', 'operant', 'SKILL.md');
  return {
    agent: o.agent, noOperant: o.noOperant, model: o.model, claude: claudeBin, claudeVersion: claudeVersion(claudeBin),
    brief: brief ? { source: brief.source, via: brief.via, bytes: Buffer.byteLength(brief.text), sha1: crypto.createHash('sha1').update(brief.text).digest('hex') } : null,
    pluginDirs: o.pluginDirs,
    globalSkill: fs.existsSync(skillFile) ? { path: skillFile, bytes: fs.statSync(skillFile).size, sha1: sha1(skillFile) } : null,
    runsPerCase: o.runs, jobs: o.jobs,
  };
}

function summaryMarkdown(o, setup, records, meta) {
  const row = (label, kind, a) => `| ${label} | ${kind} | ${a.runs} | ${pct(a.pass, a.graded)} | ${pct(a.skill, a.runs)} | ${pct(a.routed, a.runs)} | ${num(a.rawLongAvg)} | ${num(a.turnsAvg)} | ${usd(a.costAvg)} | ${a.errors} |`;
  const head = '| case | kind | runs | pass | skill | routed | raw long/run | turns | cost/run | err |\n|---|---|---|---|---|---|---|---|---|---|';
  const byCase = new Map();
  for (const r of records) byCase.set(r.case, [...(byCase.get(r.case) || []), r]);
  const first = records.find(r => r.init);
  const listed = (list, re) => Array.isArray(list) ? list.some(x => re.test(x)) : null;
  const yn = v => v === null ? 'unknown' : v ? 'yes' : 'no';
  const lines = [
    `# Operant eval: ${o.arm}`, '',
    `- when: ${meta.startedAt} (${Math.round(meta.wallMs / 1000)}s wall)`,
    `- agent: ${setup.agent}${setup.noOperant ? ' (baseline: no operant, no brief, no plugin, no stub; graded on outcome only)' : ''}; model: ${setup.model}; ${setup.agent} ${setup.claudeVersion || '?'} at ${setup.claude}`,
    `- brief: ${setup.brief ? `${setup.brief.source}, ${setup.brief.via}, ${setup.brief.bytes} bytes, sha1 ${setup.brief.sha1.slice(0, 12)}` : 'none (no --append-system-prompt-file)'}`,
    `- plugin dir: ${setup.pluginDirs.length ? setup.pluginDirs.join(', ') : 'none'}`,
    `- ~/.claude/skills/operant/SKILL.md: ${setup.globalSkill ? `exists, ${setup.globalSkill.bytes} bytes, sha1 ${setup.globalSkill.sha1}` : 'not present'}`,
    `- seen by the child: operant in init skills: ${yn(first ? listed(first.init.skills, /(^|:)operant$/) : null)}; as a slash command: ${yn(first ? listed(first.init.slashCommands, /(^|:)operant$/) : null)}`,
    `- runs: ${records.length} (${setup.runsPerCase} per case, -j ${setup.jobs}); errors: ${records.filter(r => r.error).length}; total cost $${records.reduce((a, r) => a + (r.costUsd || 0), 0).toFixed(2)} (list price; billed to the subscription)`,
  ];
  const rl = records.filter(r => r.rateLimit).sort((a, b) => a.endedAt.localeCompare(b.endedAt));
  if (rl.length) {
    const f = rl[0].rateLimit, l = rl.at(-1).rateLimit, p = v => v === null ? '?' : `${Math.round(v * 100)}%`;
    lines.push(`- plan usage seen while running: 5h ${p(f.fiveHour)} -> ${p(l.fiveHour)}, 7d ${p(f.sevenDay)} -> ${p(l.sevenDay)}`);
  }
  lines.push('', '## Per case', '', head);
  for (const [name, rs] of byCase) lines.push(row(name, rs[0].kind, aggregate(rs)));
  lines.push('', '## Per kind', '', head);
  for (const kind of KINDS) { const rs = records.filter(r => r.kind === kind); if (rs.length) lines.push(row(`all ${kind}`, kind, aggregate(rs))); }
  lines.push(row('all', '', aggregate(records)));
  lines.push('', 'skill = loaded the operant skill; routed = an operant test/build/run call came before any raw long command; raw long/run = shell attempts at tests/builds/installs/dev servers without operant (denied by the harness, still counted).');
  const denied = records.filter(r => r.operantDenied);
  if (denied.length) lines.push('', `${denied.reduce((a, r) => a + r.operantDenied, 0)} operant command(s) in ${denied.length} run(s) were refused by the harness's permission rules (typically a PowerShell line starting with \`cd <dir>;\`), so those runs may understate operant use: ${denied.map(r => `${r.case}#${r.run}`).join(', ')}.`);
  const bad = records.filter(r => r.graded !== false && !r.pass);
  if (bad.length) {
    lines.push('', '## Not passing', '');
    for (const r of bad) {
      const unmet = Object.entries(r.checks || {}).filter(([, v]) => !v).map(([k]) => k);
      lines.push(`- ${r.case} #${r.run}: ${[r.error && `error ${r.error}`, unmet.length && `unmet: ${unmet.join(', ')}`].filter(Boolean).join('; ') || 'no result'}${r.finalText ? ` | "${r.finalText.replace(/\s+/g, ' ').slice(0, 120)}"` : ''}`);
    }
  }
  return lines.join('\n') + '\n';
}

// ------------------------------------------------------------ dry run
function printDryRun(cases, o, brief, claudeBin, runDir) {
  console.log(`arm ${o.arm}, agent ${o.agent}${o.noOperant ? ' (baseline, --no-operant)' : ''}, model ${o.model}, ${o.runs} run(s) per case, -j ${o.jobs}`);
  console.log(`${o.agent}: ${claudeBin}`);
  console.log(`brief: ${brief ? `${brief.source} via ${brief.via}, ${Buffer.byteLength(brief.text)} bytes -> ${brief.file}` : 'none'}`);
  console.log(`plugin dirs: ${o.pluginDirs.join(', ') || 'none'}`);
  let shown = false;
  for (const c of cases) {
    const files = { log: path.join(runDir, 'stub', `${c.name}-1.log.jsonl`), scenario: path.join(runDir, 'stub', `${c.name}-1.scenario.json`) };
    const { env, removed, dropped, pathKey } = childEnv(o.noOperant ? {} : c.env || {}, files, o.noOperant);
    const spec = spawnSpec(claudeBin, buildArgs(c, o, brief, '<workspace>'));
    console.log(`\n=== ${c.name} (${c.kind}) ===`);
    console.log(`cwd:   ${path.join(fs.realpathSync.native(os.tmpdir()), `operant-eval-${c.name}-<n>-XXXXXX`)}  (fresh fixture copy + git repo per run)`);
    console.log(`cmd:   ${[spec.cmd, ...spec.args].map(display).join(' ')}`);
    console.log(`${o.agent === 'opencode' ? 'prompt' : 'stdin'}: ${promptFor(c, o)}${o.agent === 'opencode' ? '' : ''}`);
    if (o.agent === 'opencode') console.log(`env:   OPENCODE_CONFIG_CONTENT=${JSON.stringify({ permission: OPENCODE_PERMISSION })}${brief ? '  (brief written to AGENTS.md in the workspace)' : ''}`);
    console.log(`env:   ${Object.keys(env).filter(k => k.toUpperCase().startsWith('OPERANT')).sort().map(k => `${k}=${env[k]}`).join(' ')}`);
    const dirs = env[pathKey].split(path.delimiter);
    console.log(o.noOperant ? `${pathKey}:  ${dirs.length} inherited dirs, no stub, no operant` : `${pathKey}:  ${dirs[0]}  (stub, first)  then ${dirs.length - 1} inherited dirs`);
    if (c.expect && c.expect.outcome) console.log(`outcome: ${c.expect.outcome}  (run in the workspace after the session)`);
    if (!shown) {
      shown = true;
      console.log(`removed from env (${removed.length}, same for every case): ${removed.join(', ') || 'none'}`);
      console.log(`dropped from ${pathKey} (offer a real operant): ${dropped.join(' ; ') || 'none'}`);
    }
  }
}

// ------------------------------------------------------------ main
async function main() {
  const o = parseOptions();
  for (const pd of o.pluginDirs) if (!fs.existsSync(pd)) die(`--plugin-dir ${pd} does not exist`);
  const cases = loadCases(o.cases);
  if (process.platform !== 'win32') { try { fs.chmodSync(path.join(STUB_DIR, 'operant'), 0o755); } catch { /* read-only checkout */ } }

  const d = new Date(), p2 = x => String(x).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const runDir = path.join(HERE, 'results', `${stamp}-${o.arm.replace(/[^\w.-]/g, '_')}`);
  // A dry run writes nothing under results/: the brief goes to a temp folder that is removed after.
  const workDir = o.dryRun ? fs.mkdtempSync(path.join(os.tmpdir(), 'operant-eval-dry-')) : runDir;
  // Nothing worth keeping if we stop before any session starts (dry run, bad --brief-ref, ...).
  let launched = false;
  process.on('exit', () => { if (!launched) fs.rmSync(workDir, { recursive: true, force: true }); });
  for (const sub of o.dryRun ? [''] : ['raw', 'stub']) fs.mkdirSync(path.join(workDir, sub), { recursive: true });

  const claudeBin = o.agent === 'opencode' ? resolveOpencode() : resolveClaude();
  if (o.agent === 'opencode' && o.pluginDirs.length) console.error('note: --plugin-dir has no effect with --agent opencode');
  const brief = loadBrief(o, workDir);
  if (o.dryRun) { printDryRun(cases, o, brief, claudeBin, runDir); return; }

  const setup = setupInfo(o, brief, claudeBin);
  const jobs = [];
  for (let n = 1; n <= o.runs; n++) for (const c of cases) jobs.push({ c, n }); // run 1 of every case first, so a stop still covers all cases
  console.log(`arm ${o.arm}: ${cases.length} cases x ${o.runs} runs = ${jobs.length} ${o.agent} sessions on ${o.model} (-j ${o.jobs}); results in ${runDir}`);

  process.on('SIGINT', () => { aborting = true; console.error('\ninterrupted: stopping the runs I started'); for (const pid of active) killTree(pid); });

  const started = Date.now();
  const records = [];
  launched = true;
  await pool(jobs, o.jobs, async job => {
    const r = await runOne(job, o, brief, claudeBin, runDir);
    records.push(r);
    fs.appendFileSync(path.join(runDir, 'runs.jsonl'), JSON.stringify(r) + '\n');
    // Once the plan says no, the remaining sessions would only fail.
    if (r.rateLimit && !/^allowed/.test(r.rateLimit.status || 'allowed') && !aborting) { aborting = true; console.error(`plan limit hit (${r.rateLimit.status}): not starting more runs`); }
    console.log(`[${records.length}/${jobs.length}] ${r.case}#${r.run} ${r.pass === null ? 'n/a ' : r.pass ? 'PASS' : 'FAIL'} ${r.error ? `(${r.error}) ` : r.subtype && r.subtype !== 'success' ? `(${r.subtype}) ` : ''}turns=${r.turns ?? '-'} ${usd(r.costUsd ?? null)} ${Math.round((r.wallMs || 0) / 1000)}s skill=${r.skillInvoked ? 'y' : 'n'} routed=${r.routed ? 'y' : 'n'} raw=${r.rawLongAttempts ?? '-'}`);
  });

  const meta = { startedAt: new Date(started).toISOString(), wallMs: Date.now() - started };
  const byCase = {};
  for (const c of cases) byCase[c.name] = aggregate(records.filter(r => r.case === c.name));
  const byKind = {};
  for (const k of KINDS) byKind[k] = aggregate(records.filter(r => r.kind === k));
  const first = records.find(r => r.init);
  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify({ arm: o.arm, agent: o.agent, noOperant: o.noOperant, ...meta, setup, initSample: first && first.init, cases: byCase, kinds: byKind, totals: aggregate(records) }, null, 2));
  const md = summaryMarkdown(o, setup, records.sort((a, b) => a.case.localeCompare(b.case) || a.run - b.run), meta);
  fs.writeFileSync(path.join(runDir, 'summary.md'), md);
  console.log(`\n${md}`);
  if (o.keep) console.log(`kept workspaces: ${records.map(r => r.workspace).filter(Boolean).join('\n  ') || 'none'}`);
}

// Importable (for checking the grader) without starting a run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
export { opencodeArgs, classifyCommand, grade, outcomeCheck, parseOpencode, parseStream, totals, childEnv, spawnSpec };
