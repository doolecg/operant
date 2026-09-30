#!/usr/bin/env node
// Fake `operant` CLI for evals. Every call is appended to OPERANT_EVAL_LOG, then canned output is
// printed in the shape of the real CLI's. The arg parser and formatters are copied from
// bin/operant-cli.js (1.18.0) and the handlers return what renderer.js's runControl() returns, so
// text and --json come out the same. Nothing here talks to an app.
// Scenario data: OPERANT_EVAL_SCENARIO (JSON). Per-run state (tile/task ids, closed tiles, memory):
// a JSON file next to the log, so ids stay consistent between calls.
'use strict';
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const logFile = process.env.OPERANT_EVAL_LOG;
// A brief handed over by `send --file <path>` or `send --brief "<text>"` is logged with the call, so a case can grade its text.
function briefOf() {
  if (argv[0] !== 'send') return undefined;
  try {
    const f = argv.indexOf('--file');
    if (f > 0 && argv[f + 1]) return fs.readFileSync(argv[f + 1], 'utf8');
    const words = argv.slice(1).filter(a => !a.startsWith('--'));
    return ['--brief', '--new', '--team'].some(f => argv.includes(f)) && words.length ? words.join(' ') : undefined;
  } catch { return undefined; }
}
if (logFile) {
  try {
    const brief = briefOf();
    fs.appendFileSync(logFile, JSON.stringify({ t: new Date().toISOString(), argv, cwd: process.cwd(), worker: process.env.OPERANT_WORKER || null, ...(brief !== undefined ? { brief } : {}) }) + '\n');
  } catch { /* logging must never change what the agent sees */ }
}

let scenario = {};
try { scenario = JSON.parse(fs.readFileSync(process.env.OPERANT_EVAL_SCENARIO, 'utf8')); } catch { /* no scenario: defaults */ }

const SELF = Number(process.env.OPERANT_TILE) || 7;
const IS_WORKER = process.env.OPERANT_WORKER === '1';

// ------------------------------------------------------------ copied from bin/operant-cli.js
const POSITIONAL = {
  view: ['path'], edit: ['path'], open: ['target'], diff: ['dir'], usage: [], compact: [],
  run: ['command'], agent: ['prompt'], notify: ['text'], title: ['text'],
  test: ['command'], build: ['command'],
  ask: ['question'], ws: ['index'],
  read: ['id'], focus: ['id'], close: ['id'], wait: ['id'], stop: ['id'],
  send: ['id', 'text'],
  browse: ['url'],
  ports: [], watch: ['id'],
  plan: ['path'], board: [], team: [],
  summarize: ['target', 'question'], find: ['question'],
  remember: ['text'], recall: ['query'],
};
const JOIN_REST = { run: 'command', agent: 'prompt', notify: 'text', title: 'text', send: 'text', test: 'command', build: 'command',
  summarize: 'question', find: 'question', remember: 'text', recall: 'query' };

function parseArgs(argv) {
  const cmd = argv[0];
  const rest = argv.slice(1);
  const flags = {};
  const positionals = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[name] = next; i++; }
      else flags[name] = true;
    } else {
      positionals.push(a);
    }
  }
  return { cmd, positionals, flags };
}

function buildArgs(cmd, positionals, flags) {
  const args = {};
  const names = POSITIONAL[cmd] || [];
  const joinField = JOIN_REST[cmd];
  if (joinField) {
    const joinIdx = names.indexOf(joinField);
    for (let i = 0; i < joinIdx; i++) {
      const v = positionals[i];
      args[names[i]] = !isNaN(v) && v.trim() !== '' ? Number(v) : v;
    }
    const restWords = positionals.slice(joinIdx);
    if (restWords.length) args[joinField] = restWords.join(' ');
  } else {
    names.forEach((n, i) => {
      if (positionals[i] === undefined) return;
      const v = positionals[i];
      args[n] = !isNaN(v) && v.trim() !== '' ? Number(v) : v;
    });
  }
  for (const [k, v] of Object.entries(flags)) {
    if (k === 'json') continue;
    let val = v;
    if (val === true || val === false) args[k] = val;
    else if (k === 'options') args[k] = String(val).split('|');
    else if (!isNaN(val) && val.trim() !== '') args[k] = Number(val);
    else args[k] = val;
  }
  // Copied from the CLI: with --file / --brief / --new / --team, send hands over a brief and the tile is optional.
  if (cmd === 'send' && (flags.file || flags.brief || flags.new || flags.team)) {
    const words = [...positionals];
    for (const k of ['brief', 'new', 'team', 'enter']) if (typeof flags[k] === 'string') { words.push(flags[k]); args[k] = true; }
    delete args.id; delete args.text;
    args.brief = true;
    if (typeof flags.file === 'string') { args.file = path.resolve(flags.file); if (words.length) args.id = words[0]; }
    else if (words.length > 1) { args.id = words[0]; args.text = words.slice(1).join(' '); }
    else if (words.length) args.text = words[0];
    if (args.id !== undefined && !isNaN(args.id) && String(args.id).trim() !== '') args.id = Number(args.id);
  }
  if (cmd === 'ask' && positionals.length) args.question = positionals.join(' ');
  if (cmd === 'ws' && positionals.length) args.index = Number(positionals[0]);
  if (cmd === 'task') {
    args.sub = positionals[0];
    if (args.sub === 'add') args.text = positionals.slice(1).join(' ');
    else if (args.sub === 'note') { args.id = Number(positionals[1]); args.text = positionals.slice(2).join(' '); }
    else args.id = Number(positionals[1]);
  }
  for (const k of ['path', 'dir']) if (typeof args[k] === 'string' && args[k]) args[k] = path.resolve(args[k]);
  if (cmd === 'open' && typeof args.target === 'string' && fs.existsSync(args.target)) args.target = path.resolve(args.target);
  return args;
}

function fmtTile(t) {
  const flags = [t.busy && 'busy', t.focused && 'focused', t.self && 'self'].filter(Boolean).map(f => `[${f}]`);
  if (t.runaway) flags.push(`[⚠ ${t.runaway}]`);
  if (t.waiting) flags.push('[waiting]');
  return [t.id, t.kind, t.title, t.cwd, t.tokens, flags.join(' ')].filter(x => x !== undefined && x !== '').join('  ');
}

function footer(result) {
  const { total, shown } = result || {};
  if (typeof total !== 'number' || typeof shown !== 'number' || shown >= total) return '';
  return `\n(showing ${shown} of ${total} lines)`;
}

function fmtDigest(d) {
  if (!d) return '(no digest recognised for this output; try --errors)';
  const lines = [`${d.runner}: ${d.summary}`];
  for (const f of d.failures || []) {
    const loc = f.file ? `${f.file}${f.line ? ':' + f.line : ''}` : '?';
    lines.push(`${loc}  ${f.title}${f.message ? ' — ' + f.message.split('\n')[0] : ''}`);
    if (f.frame && f.frame !== loc) lines.push(`  ${f.frame}`);
  }
  if (d.more) lines.push(`… and ${d.more} more`);
  return lines.join('\n');
}

function fmtTok(n) { return n >= 1e6 ? +(n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? +(n / 1e3).toFixed(1) + 'k' : String(n); }
function fmtBreakdown(b) {
  const lines = [`where tokens go (${b.days === 7 ? 'last 7 days' : 'today'}):`];
  lines.push(...b.tiles.slice(0, 8).map(t => `  ${t.label}  in ${fmtTok(t.input)} out ${fmtTok(t.output)} cache-r ${fmtTok(t.cacheRead)} cache-w ${fmtTok(t.cacheWrite)}`));
  if (b.biggestTurns.length) {
    lines.push('  biggest turns:');
    lines.push(...b.biggestTurns.slice(0, 5).map(t => `    ${fmtTok(t.tokens)}  ${t.tile}${t.cause ? `  (${t.cause})` : ''}`));
  }
  if (b.repeatedReads.length) {
    lines.push('  read more than 3×:');
    lines.push(...b.repeatedReads.slice(0, 5).map(r => `    ${r.count}×  ${r.file}  (${r.label})`));
  }
  const big = b.overhead.filter(o => o.big);
  if (big.length) {
    lines.push('  session overhead over 20k (system prompt/CLAUDE.md/memory/skills/MCP tools):');
    lines.push(...big.slice(0, 5).map(o => `    ${fmtTok(o.tokens)}  ${o.label}`));
  }
  return lines.join('\n');
}

function formatResult(cmd, result) {
  switch (cmd) {
    case 'tiles': return (result || []).map(fmtTile).join('\n');
    case 'status': return `${result.id}  ${result.kind}  ${result.title}  ${result.cwd}  ws=${result.ws}${result.branch ? '  ' + result.branch : ''}${result.tokens ? '  ' + result.tokens + ' tokens' : ''}`;
    case 'view': case 'edit': case 'diff': case 'run': return `tile ${result.id}`;
    case 'agent': return `tile ${result.id}` + (result.tier ? `  [${result.tier}]  task ${result.taskId}` : '');
    case 'send': return result && result.brief ? result.text : '';
    case 'summarize': case 'find': return result.text || '(no answer)';
    case 'team': {
      if (!result.enabled) return 'team mode: disabled (Settings › Agents › Team)';
      const lines = [`team mode: enabled  ·  ${result.workers}/${result.maxWorkers} workers running`];
      for (const [name, t] of Object.entries(result.tiers || {})) lines.push(`  ${name}: ${t.agent} ${t.model}${t.effort ? ` (${t.effort} effort)` : ''}  —  ${t.use}`);
      return lines.join('\n');
    }
    case 'test': case 'build': return result.digest ? fmtDigest(result.digest) : (result.text || '(no output)');
    case 'read': return ('digest' in result) ? fmtDigest(result.digest) : (result.text || '') + footer(result);
    case 'wait': return ('digest' in result) ? (result.exited ? '[exited]\n' : '') + fmtDigest(result.digest) : (result.exited ? '[exited]\n' : '') + (result.text || '') + footer(result);
    case 'stop': return `stopped tile ${result.id} (${result.how})`;
    case 'ask': return result.answer === null ? '(closed)' : String(result.answer);
    case 'ws': return `workspace ${result.current}`;
    case 'browse': return `opened ${result.url}`;
    case 'ports': return (result.ports || []).length ? result.ports.map(p => `${p.id}  ${p.title}  ${p.url}`).join('\n') : '(no dev servers found)';
    case 'watch':
      if (result.watches) return result.watches.length
        ? result.watches.map(w => `${w.id}${w.errors ? '  errors' : ''}${w.grep ? `  grep:"${w.grep}"` : ''}`).join('\n')
        : '(no watches)';
      return result.off ? `stopped watching tile ${result.id}` : `watching tile ${result.id}`;
    case 'plan': return result.approved ? 'approved' : `change: ${result.note || ''}`;
    case 'task': if (result.sub === 'show') return [`${result.id}  ${result.status}${result.tier ? '  ' + result.tier : ''}`, result.text, ...(result.note ? [`note: ${result.note}`] : []),
      ...(result.askText ? [result.askText, 'Only the user answers this, on the board. Do not move the task up or restart it yourself.'] : [])].join('\n');
      return result.sub === 'add' ? String(result.id) : `${result.id}  ${result.status}${result.note ? `  ${result.note}` : ''}`;
    case 'board': {
      const owner = o => o ? `${o.id} ${o.title}` : '-';
      return (result.tasks || []).length ? result.tasks.map(t => `${t.id}  ${t.status}  ${owner(t.owner)}  ${t.text}${t.note ? `  · ${t.note}` : ''}`).join('\n') : '(no tasks)';
    }
    case 'remember': return `${result.name} (${result.type}${result.updated ? ', updated' : ''})`;
    case 'recall': return (result.text || '') + (result.more ? `\n(${result.more} more matched, ${result.shown} of ${result.total} shown)` : '');
    case 'usage': {
      const lines = [result.max
        ? `context: ${result.tokens.toLocaleString()} / ${result.max.toLocaleString()} tokens (${result.pct}%)`
        : 'context: not available for this tile yet'];
      const l = result.limits;
      const pct = x => x && typeof x.used === 'number' ? `${Math.round(x.used)}%${x.resets ? ` (resets ${new Date(x.resets).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })})` : ''}` : null;
      if (!l) lines.push('plan limits: off (Settings › Usage)');
      else if (l.error) lines.push(l.error);
      else {
        if (pct(l.session)) lines.push(`session (5h): ${pct(l.session)}`);
        if (pct(l.week)) lines.push(`week: ${pct(l.week)}`);
      }
      if (result.breakdown) lines.push('', fmtBreakdown(result.breakdown));
      return lines.join('\n');
    }
    default: return result === undefined || result === null || result === '' || Object.keys(result || {}).length === 0
      ? 'ok' : JSON.stringify(result);
  }
}

// ------------------------------------------------------------ canned world (a tiny Node project)
const TIERS = {
  xsmall: { agent: 'opencode', model: 'opencode/big-pickle', use: 'very easy tasks: look things up, read and summarise files, renames, run tests, docs tweaks' },
  small: { agent: 'claude', model: 'claude-sonnet-5-5', use: 'smaller tasks: a feature across a few files, a normal bug fix, simple edits' },
};
const ABOVE_TOP = ['medium', 'high', 'max'];
const MAX_WORKERS = 5;
const AGENTS = ['claude', 'opencode'];

// The project the agent is in: nearest folder up with a package.json, else where it stands.
function projectRoot() {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return process.cwd();
}
const ROOT = projectRoot();

// Once the agent has removed the off-by-one in src/sum.js the canned suite passes.
function sumFixed() {
  try { return !/numbers\.length\s*-\s*1/.test(fs.readFileSync(path.join(ROOT, 'src', 'sum.js'), 'utf8')); } catch { return false; }
}

function kindOf(cmd) {
  const c = String(cmd);
  if (/\bnode\s+--test\b|\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b|\bnpx\s+(?:vitest|jest)\b|\bpytest\b|\bcargo\s+test\b|\bgo\s+test\b/.test(c)) return 'test';
  if (/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?build\b|\bnode\s+build\.js\b|\btsc\b/.test(c)) return 'build';
  if (/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:dev|start|serve)\b|\bnode\s+server\.js\b|\bvite\b/.test(c)) return 'dev';
  if (/\b(?:npm|pnpm|yarn)\s+(?:install|i|ci|add)\b/.test(c)) return 'install';
  return 'other';
}

const SCRIPT_CMD = { test: 'node --test', build: 'node build.js', dev: 'node server.js' };

function testBody(fixed) {
  const s = path.sep;
  const fail = (decl, title, ms, msg, actual, expected, line, tail) => [
    `test at test${s}sum.test.js:${decl}:1`,
    `✖ ${title} (${ms}ms)`,
    '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
    '  ',
    `  ${msg}`,
    '  ',
    `      at TestContext.<anonymous> (${ROOT}${s}test${s}sum.test.js:${line}:10)`,
    '      at Test.runInAsyncScope (node:async_hooks:227:14)',
    '      at Test.run (node:internal/test_runner/test:1382:25)',
    '      at Test.processPendingSubtests (node:internal/test_runner/test:960:18)',
    '      at Test.postRun (node:internal/test_runner/test:1522:19)',
    '      at Test.run (node:internal/test_runner/test:1447:12)',
    tail,
    '    generatedMessage: true,',
    "    code: 'ERR_ASSERTION',",
    `    actual: ${actual},`,
    `    expected: ${expected},`,
    "    operator: 'strictEqual',",
    "    diff: 'simple'",
    '  }',
    '',
  ];
  const stats = (pass, failN) => [
    'ℹ tests 5', 'ℹ suites 0', `ℹ pass ${pass}`, `ℹ fail ${failN}`, 'ℹ cancelled 0', 'ℹ skipped 0', 'ℹ todo 0', 'ℹ duration_ms 75.4228',
  ];
  if (fixed) {
    return ['✔ sum of an empty list is 0 (0.6846ms)', '✔ sum of one number is that number (0.3102ms)', '✔ sum adds every number in the list (0.1522ms)',
      '✔ sum leaves its input alone (0.5765ms)', '✔ sum of zeros is 0 (0.1013ms)', ...stats(5, 0)];
  }
  return ['✔ sum of an empty list is 0 (0.6846ms)', '✖ sum of one number is that number (0.6809ms)', '✖ sum adds every number in the list (0.1522ms)',
    '✔ sum leaves its input alone (0.5765ms)', '✔ sum of zeros is 0 (0.1013ms)', ...stats(3, 2), '', '✖ failing tests:', '',
    ...fail(9, 'sum of one number is that number', '0.6809', '0 !== 5', 0, 5, 12, '      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3) {'),
    ...fail(15, 'sum adds every number in the list', '0.1522', '3 !== 6', 3, 6, 16, '      at async Test.processPendingSubtests (node:internal/test_runner/test:960:7) {'),
  ].slice(0, -1);
}

// What the tile's terminal shows for the command it was given.
function tileLines(t) {
  if (t.id === SELF) return ['(this is your own tile)'];
  if (Array.isArray(t.lines)) return t.lines;
  if (t.kind === 'ai') return ['Claude Code v2.1.284', '', `> ${String(t.prompt || '').split('\n')[0].slice(0, 200)}`, '', '● Done.'];
  if (t.kind !== 'shell') return [];
  const prompt = process.platform === 'win32' ? `PS ${t.cwd}>` : `${t.cwd} $`;
  const viaNpm = /^\s*(?:npm|pnpm|yarn)\b/.test(t.cmd);
  const head = viaNpm && SCRIPT_CMD[t.run] ? ['', `> tinycalc@0.3.0 ${t.run === 'dev' && /\bstart\b/.test(t.cmd) ? 'start' : t.run}`, `> ${SCRIPT_CMD[t.run]}`, ''] : [];
  let body = [];
  if (t.run === 'test') body = testBody(sumFixed());
  else if (t.run === 'build') body = ['warning: src/avg.js has no test file', 'built 2 modules -> dist/bundle.js (484 bytes)'];
  else if (t.run === 'dev') body = ['  Local: http://localhost:5173/'];
  else if (t.run === 'install') body = ['up to date, audited 1 package in 312ms', '', 'found 0 vulnerabilities'];
  else {
    const m = /^\s*npm\s+run\s+(\S+)/.exec(t.cmd);
    if (m) body = [`npm error Missing script: "${m[1]}"`, 'npm error', 'npm error To see a list of scripts, run:', 'npm error   npm run'];
  }
  return [`${prompt} ${t.cmd}`, ...head, ...body, ...(t.run === 'dev' ? [] : [prompt])];
}

// Same cleanup and filters as the renderer's read/wait.
function cleanLines(lines) {
  const out = [];
  let blanks = 0;
  for (const raw of lines) {
    const l = raw.replace(/[ \t]+$/, '');
    if (l === '') { blanks++; continue; }
    if (blanks) out.push(...(blanks >= 3 ? [''] : Array(blanks).fill('')));
    blanks = 0;
    out.push(l);
  }
  if (blanks) out.push(...(blanks >= 3 ? [''] : Array(blanks).fill('')));
  return out;
}
function withContext(lines, isMatch, before, after) {
  const idxs = [];
  lines.forEach((l, i) => { if (isMatch(l)) idxs.push(i); });
  if (!idxs.length) return null;
  const ranges = [];
  for (const i of idxs) {
    const s = Math.max(0, i - before), e = Math.min(lines.length - 1, i + after);
    const r = ranges.at(-1);
    if (r && s <= r[1] + 1) r[1] = Math.max(r[1], e);
    else ranges.push([s, e]);
  }
  return ranges.map(([s, e]) => lines.slice(s, e + 1).join('\n')).join('\n…\n');
}
const ERROR_RE = /\b(error|failed|failure|fatal|exception|traceback|panic|warn(ing)?|FAIL)\b|[✗✖]/i;

function readOutput(t, { lines, isNew, errors, grep } = {}) {
  const all = cleanLines(tileLines(t));
  const cap = lines || (errors || grep ? 400 : 60);
  let cleaned;
  if (isNew) cleaned = all.slice(t.cursor == null ? Math.max(0, all.length - 60) : Math.min(t.cursor, all.length));
  else cleaned = all;
  t.cursor = all.length;
  if (cap && cleaned.length > cap) cleaned = cleaned.slice(-cap);
  const total = cleaned.length;
  let text;
  if (errors) {
    const grouped = withContext(cleaned, l => ERROR_RE.test(l), 1, 2);
    text = grouped == null ? `no errors or warnings in the last ${total} lines` : grouped;
  } else if (grep) {
    let re;
    try { re = new RegExp(grep, 'i'); } catch { re = null; }
    const isMatch = re ? l => re.test(l) : l => l.toLowerCase().includes(String(grep).toLowerCase());
    const grouped = withContext(cleaned, isMatch, 1, 1);
    text = grouped == null ? `no matches in the last ${total} lines` : grouped;
  } else {
    text = cleaned.join('\n');
    if (isNew && !text) text = '(no new output)';
  }
  return { text, total, shown: text ? text.split('\n').length : 0 };
}

// The renderer's digest (renderer/digest.js) for a node:test run, as it returns it on Windows.
function digestOf(t) {
  if (t.run !== 'test') return null;
  const s = path.sep;
  if (sumFixed()) return { runner: 'node:test', summary: 'Tests: 0 failed, 5 passed', failures: [], more: 0, ok: true };
  const f = (title, line, actual, expected) => ({
    title, file: `test${s}sum.test.js`, line,
    message: `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n  ${actual} !== ${expected}\n    generatedMessage: true,`,
    frame: `test${s}sum.test.js:${line}:1`,
  });
  return {
    runner: 'node:test', summary: 'Tests: 2 failed, 3 passed', more: 0, ok: false,
    failures: [f('sum of one number is that number', 9, 0, 5), f('sum adds every number in the list', 15, 3, 6)],
  };
}

const PORT_URL_RE = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?(?:\/[^\s"'<>]*)?/gi;

const SUMMARIES = {
  'sum.js': 'sum(numbers) adds up a list, but its loop stops at numbers.length - 1, so the last element is never added.',
  'avg.js': 'avg(numbers) returns the mean of a list, or 0 for an empty list.',
  'sum.test.js': 'Five node:test cases for sum(); "one number" and "every number in the list" fail because sum() skips the last element.',
  'package.json': 'tinycalc 0.3.0; scripts: test = node --test, build = node build.js, dev = node server.js.',
  'README.md': 'Tiny number helpers (sum, avg) with npm test, npm run build and npm run dev (http://localhost:5173).',
  'build.js': 'Bundles src/*.js into dist/bundle.js after requiring each module; warns about modules without a test file.',
  'server.js': 'HTTP dev server on port 5173 with GET /sum?n=1,2,3 and GET /avg?n=1,2,3.',
};

// ------------------------------------------------------------ per-run state
const stateFile = logFile ? logFile + '.state.json' : null;
function initialState() {
  const tasks = (scenario.tasks || []).map(t => ({ status: 'todo', owner: null, note: null, title: null, ...t }));
  return { nextTile: scenario.nextTile || 12, nextTask: Math.max(0, ...tasks.map(t => t.id)) + 1, tiles: (scenario.tiles || []).map(t => ({ kind: 'ai', cwd: ROOT, ...t })), tasks, watches: {}, memory: [] };
}
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
// A directory as lock: calls in one run are normally sequential, but parallel tool calls happen.
function withState(fn) {
  const lock = stateFile && stateFile + '.lock';
  let locked = false;
  if (lock) {
    for (let i = 0; i < 150 && !locked; i++) {
      try { fs.mkdirSync(lock); locked = true; } catch { if (i === 100) { try { fs.rmdirSync(lock); } catch { /* stale lock */ } } sleep(20); }
    }
  }
  try {
    let st = null;
    if (stateFile) { try { st = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* first call */ } }
    if (!st) st = initialState();
    const out = fn(st);
    if (stateFile) fs.writeFileSync(stateFile, JSON.stringify(st));
    return out;
  } finally {
    if (locked) { try { fs.rmdirSync(lock); } catch { /* already gone */ } }
  }
}

const selfTile = () => ({ id: SELF, kind: 'ai', title: IS_WORKER ? 'worker' : 'claude', cwd: ROOT, self: true });
function needTile(st, id) {
  if (Number(id) === SELF) return selfTile();
  const t = st.tiles.find(x => x.id === Number(id) && !x.closed);
  if (!t) throw new Error(`no tile ${id}`);
  return t;
}
// Workers are done by the time anyone looks: a `wait`/`read` on an agent tile closes its board task,
// so a fan-out ends instead of polling until the turn cap.
function finishWorker(st, t) {
  const task = t.kind === 'ai' && t.id !== SELF && st.tasks.find(x => x.owner === t.id && x.status !== 'done');
  if (task) { task.status = 'done'; task.note = 'done (canned worker result)'; }
}
function newTile(st, props) {
  const t = { id: st.nextTile++, cwd: process.cwd(), ...props };
  st.tiles.push(t);
  return t;
}
const tldr = t => t.title || String(t.text).split('\n')[0].replace(/^[#>*\-\s]+/, '').replace(/^task:\s*/i, '').split(/(?<=[.!?])\s/)[0].slice(0, 80);
const fmtOwner = (st, id) => id == null ? null : { id, title: id === SELF ? selfTile().title : (st.tiles.find(x => x.id === id && !x.closed) || {}).title || `tile ${id} (closed)` };
const shortName = text => String(text).trim().split(/\s+/).slice(0, 8).join(' ').slice(0, 60);
const iso = ms => new Date(Date.now() + ms).toISOString();

const BASE_MEMORY = [
  { name: 'Node 20 or newer', type: 'project', body: 'The package uses node:test, which needs Node 20 or newer.' },
  { name: 'Small commits, plain messages', type: 'user', body: 'No prefixes or trailers in commit messages.' },
];
const memoryLine = f => `- **${f.name}** [${f.type}]${f.about ? ` (about: ${f.about})` : ''} — ${f.body}`;
const allMemory = st => [...BASE_MEMORY, ...st.memory];

// ------------------------------------------------------------ commands (results as renderer.js returns them)
const HANDLERS = {
  tiles: (a, st) => [selfTile(), ...st.tiles.filter(t => !t.closed)].map(t => ({
    id: t.id, kind: t.kind, title: t.title, cwd: t.cwd, busy: t.kind === 'ai' || t.run === 'dev', ws: 1, focused: t.id === SELF, self: t.id === SELF,
    ...(t.id === SELF ? { tokens: '9.1k' } : {}),
  })),
  status: () => ({ id: SELF, kind: 'ai', title: selfTile().title, cwd: ROOT, ws: 1, project: ROOT, branch: currentBranch(), tokens: '9.1k' }),
  view: (a, st) => ({ id: newTile(st, { kind: 'view', title: path.basename(String(a.path || '')) }).id }),
  edit: (a, st) => ({ id: newTile(st, { kind: 'edit', title: path.basename(String(a.path || '')) }).id }),
  diff: (a, st) => ({ id: newTile(st, { kind: 'diff', title: 'changes' }).id }),
  open: () => ({}),
  browse: a => {
    if (!a.url) throw new Error('url required');
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(a.url) ? a.url : 'http://' + a.url;
    if (!/^https?:\/\//i.test(url)) throw new Error('browse only opens http(s) URLs');
    return { url };
  },
  run: (a, st) => {
    if (!a.command) throw new Error('command required');
    const t = newTile(st, { kind: 'shell', title: a.title || a.command.slice(0, 40), cwd: a.cwd || process.cwd(), cmd: a.command, run: kindOf(a.command) });
    return { id: t.id };
  },
  // test/build run their command in a new tile and wait; the id isn't part of the answer, so they
  // don't take one from the counter here.
  test: (a, st) => testOrBuild('test', a, st),
  build: (a, st) => testOrBuild('build', a, st),
  read: (a, st) => {
    const t = needTile(st, a.id);
    finishWorker(st, t);
    if (a.digest) return { id: t.id, title: t.title, busy: false, digest: digestOf(t) };
    const lines = Math.min(Math.max(1, +a.lines || (a.errors || a.grep ? 400 : 60)), 2000);
    const r = readOutput(t, { lines, isNew: !!a.new, errors: !!a.errors, grep: a.grep });
    return { id: t.id, title: t.title, busy: t.run === 'dev', ...r };
  },
  send: (a, st) => {
    if (!a.brief) return { id: needTile(st, a.id).id };
    let text = a.text;
    if (a.file !== undefined) {
      try { text = fs.readFileSync(a.file, 'utf8'); } catch (e) { throw new Error(`can't read the brief file: ${e.message}`); }
    }
    if (!String(text || '').trim()) throw new Error('the brief is empty: give --file <path> or --brief "<text>"');
    if (a.team && scenario.team !== 'on') throw new Error('team mode is off, so nothing was sent: turn on team mode (Settings › Agents › Team), then send again');
    const lead = scenario.claudeTile || 'idle';
    if (a.new || (a.id === undefined && lead === 'none')) {
      const t = newTile(st, { kind: 'ai', title: 'Claude Code', prompt: text });
      return { to: t.id, brief: true, opened: true, delivered: true, text: `started Claude Code tile ${t.id} with the brief${a.team ? ' as team work' : ''}; it is running now` };
    }
    const to = a.id !== undefined ? needTile(st, a.id).id : 12;
    return lead === 'busy'
      ? { to, brief: true, opened: false, delivered: false, waiting: true, text: `tile ${to} is busy: the brief is queued and goes in when it is idle (not interrupted)` }
      : { to, brief: true, opened: false, delivered: true, text: `sent to Claude Code tile ${to}${a.team ? ' as team work' : ''}` };
  },
  wait: (a, st) => {
    const t = needTile(st, a.id);
    finishWorker(st, t);
    if (a.digest) return { id: t.id, exited: false, digest: digestOf(t) };
    const lines = Math.min(Math.max(1, +a.lines || (a.errors ? 400 : 30)), 2000);
    const r = readOutput(t, { lines, isNew: !!a.new, errors: !!a.errors, grep: a.grep });
    return { id: t.id, exited: false, ...r };
  },
  stop: (a, st) => {
    const t = needTile(st, a.id);
    return { id: t.id, stopped: true, how: t.kind === 'ai' ? 'esc' : 'ctrl-c' };
  },
  agent: (a, st) => {
    if (!a.prompt) throw new Error('prompt required');
    let tier = null, agentName = a.agent || 'claude';
    if (a.agent && !AGENTS.includes(a.agent)) throw new Error(`unknown agent "${a.agent}" - configured: ${AGENTS.join(', ')}`);
    if (a.tier) {
      tier = String(a.tier);
      if (ABOVE_TOP.includes(tier)) throw new Error(`tier "${tier}" is above the top tier allowed (small) - use --tier xsmall or small`);
      if (!TIERS[tier]) throw new Error(`unknown tier "${tier}" - set it up in Settings › Agents › Team`);
      if (st.tiles.filter(t => t.tier && !t.closed).length >= MAX_WORKERS) throw new Error(`max workers already running (${MAX_WORKERS}) - wait for one to finish`);
      agentName = TIERS[tier].agent;
    }
    let taskId = null, prompt = a.prompt;
    if (tier) {
      taskId = st.nextTask++;
      st.tasks.push({ id: taskId, text: String(a.prompt), title: a.title ? String(a.title) : null, status: 'todo', owner: null, note: null, tier });
      prompt = `${a.prompt} — when done, run: operant task done ${taskId} --note '<what changed, files>'`;
    }
    const t = newTile(st, { kind: 'ai', title: a.title || agentName, cwd: a.cwd || process.cwd(), prompt, tier });
    if (tier) st.tasks.find(x => x.id === taskId).owner = t.id;
    return { id: t.id, ...(tier ? { tier, taskId } : {}) };
  },
  team: (a, st) => {
    if (scenario.team !== 'on') return { enabled: false };
    return { enabled: true, tiers: TIERS, maxWorkers: MAX_WORKERS, workers: st.tiles.filter(t => t.tier && !t.closed).length };
  },
  usage: a => {
    const r = { id: SELF, tokens: 41200, max: 200000, pct: 21, project: path.basename(ROOT),
      limits: scenario.limits !== undefined ? scenario.limits : { session: { used: 19, resets: iso(2 * 3600e3) }, week: { used: 48, resets: iso(3 * 86400e3) } } };
    if (a.breakdown) {
      r.breakdown = {
        days: a.days === 7 ? 7 : 1,
        tiles: [{ label: 'claude · ' + path.basename(ROOT), input: 1200, output: 8400, cacheRead: 512000, cacheWrite: 41000 }],
        biggestTurns: [{ tokens: 38000, tile: 'claude', cause: 'first turn: system prompt and skills' }],
        repeatedReads: [], overhead: [{ tokens: 21000, label: 'system prompt, CLAUDE.md, skills', big: true }],
      };
    }
    return r;
  },
  compact: () => ({}),
  ports: (a, st) => {
    const ports = [];
    for (const t of st.tiles.filter(x => !x.closed && x.kind === 'shell')) {
      const found = new Map();
      for (const line of tileLines(t)) for (const m of line.matchAll(PORT_URL_RE)) found.set(new URL(m[0]).port || '80', m[0]);
      for (const [port, url] of found) ports.push({ id: t.id, title: t.title, port: Number(port), url });
    }
    return { ports };
  },
  watch: (a, st) => {
    if (a.id == null) return { watches: Object.entries(st.watches).map(([id, w]) => ({ id: Number(id), errors: !!w.errors, grep: w.grep || null })) };
    const t = needTile(st, a.id);
    if (a.off) { delete st.watches[t.id]; return { id: t.id, off: true }; }
    if (!a.errors && !a.grep) throw new Error('--errors or --grep required');
    st.watches[t.id] = { errors: !!a.errors, grep: a.grep || null };
    return { id: t.id, watching: true };
  },
  notify: a => {
    if (!a.text) throw new Error('text required');
    return {};
  },
  title: () => ({}),
  focus: (a, st) => { needTile(st, a.id); return {}; },
  close: (a, st) => {
    const t = needTile(st, a.id);
    if (t.id === SELF && !a.force) throw new Error("pass force to close the tile you're running in");
    t.closed = true;
    return {};
  },
  ws: a => ({ current: a.index != null ? Number(a.index) : 1 }),
  ask: a => {
    if (!a.question) throw new Error('question required');
    if (scenario.askAnswer !== undefined) return { answer: scenario.askAnswer };
    return { answer: Array.isArray(a.options) && a.options.length ? a.options[0] : 'yes' };
  },
  plan: a => {
    if (!a.path) throw new Error('path required');
    const ans = scenario.planAnswer;
    if (ans === undefined || ans === null || ans === 'approved') return { approved: true };
    return { approved: false, note: String(ans).replace(/^change:\s*/i, '') };
  },
  task: (a, st) => {
    if (a.sub === 'add') {
      if (!a.text) throw new Error('text required');
      const id = st.nextTask++;
      st.tasks.push({ id, text: String(a.text), title: null, status: 'todo', owner: a.for != null ? Number(a.for) : null, note: null });
      return { id, sub: 'add' };
    }
    const t = st.tasks.find(x => x.id === Number(a.id));
    if (!t) throw new Error(`no task ${Number(a.id)}`);
    if (a.sub === 'show') return { sub: 'show', id: t.id, status: t.status, tier: t.tier || null, text: t.text, note: t.note, askText: t.askText || null };
    if (a.sub === 'claim') { t.owner = SELF; t.status = 'doing'; }
    else if (a.sub === 'done') { t.status = a.status === 'blocked' || a.status === 'failed' ? String(a.status) : 'done'; if (a.note != null) t.note = String(a.note); }
    else if (a.sub === 'approve') { if (t.status !== 'review') throw new Error(`task ${t.id} is not in review`); t.status = 'done'; }
    else if (a.sub === 'reject') {
      if (t.status !== 'review') throw new Error(`task ${t.id} is not in review`);
      if (a.note == null || a.note === true) throw new Error('--note required: say why');
      t.status = 'doing'; t.note = String(a.note);
    }
    else if (a.sub === 'note') { if (!a.text) throw new Error('text required'); t.note = String(a.text); }
    else throw new Error(`unknown task command "${a.sub}"`);
    return { id: t.id, status: t.status, note: t.note, sub: a.sub };
  },
  board: (a, st) => ({ tasks: st.tasks.map(t => ({ id: t.id, status: t.status, text: a.full ? t.text : tldr(t), note: t.note, owner: fmtOwner(st, t.owner) })) }),
  remember: (a, st) => {
    if (!a.text) throw new Error('text required');
    const name = shortName(a.text);
    const type = ['user', 'feedback', 'project', 'reference'].includes(a.type) ? a.type : 'project';
    const old = st.memory.find(f => f.name === name);
    if (old) Object.assign(old, { type, body: a.text, about: a.about });
    else st.memory.push({ name, type, body: String(a.text), about: a.about });
    return { name, type, updated: !!old };
  },
  recall: (a, st) => {
    const facts = allMemory(st);
    if (a.about) {
      const hit = facts.filter(f => f.about && String(f.about).toLowerCase().includes(String(a.about).toLowerCase()));
      return { text: hit.length ? hit.map(f => `## ${f.name} [${f.type}]\nabout: ${f.about}\n${f.body}`).join('\n\n') : '(no facts linked to that)', shown: hit.length, total: hit.length, more: 0 };
    }
    if (a.query) {
      const q = String(a.query).toLowerCase();
      const hit = facts.filter(f => `${f.name} ${f.body} ${f.about || ''}`.toLowerCase().includes(q));
      return { text: hit.length ? hit.map(f => `## ${f.name} [${f.type}]\n${f.body}`).join('\n\n') : '(no facts match)', shown: hit.length, total: hit.length, more: 0 };
    }
    const section = (title, list) => list.length ? `### ${title} memory\n${list.map(memoryLine).join('\n')}` : null;
    const text = [section('Project', facts.filter(f => f.type !== 'user')), section('Global', facts.filter(f => f.type === 'user'))].filter(Boolean).join('\n\n');
    return { text, shown: 2, total: 2, more: 0 };
  },
  summarize: (a, st) => {
    const target = a.target;
    if (target === undefined) throw new Error('target required');
    if (typeof target === 'number') {
      const t = needTile(st, target);
      return { text: t.run === 'test' ? (sumFixed() ? 'All 5 tests pass.' : 'Two of five tests fail: "sum of one number is that number" (0 !== 5) and "sum adds every number in the list" (3 !== 6). sum() skips the last element.') : `Tile ${t.id} ran "${t.cmd || t.title}"; nothing notable in its output.` };
    }
    return { text: SUMMARIES[path.basename(String(target))] || `${target}: (no summary available in this eval)` };
  },
  find: a => {
    if (!a.question) throw new Error('question required');
    return { text: ['src/sum.js:2  sum(numbers): the loop stops at numbers.length - 1', 'src/avg.js:2  avg(numbers): mean of the list, 0 when empty', 'test/sum.test.js:9  sum tests (2 of 5 fail)', 'server.js:14  listens on port 5173'].join('\n') };
  },
};

function testOrBuild(kind, a, st) {
  const cwd = a.cwd || process.cwd();
  const command = a.command || (fs.existsSync(path.join(ROOT, 'package.json')) ? `npm run ${kind}` : null);
  if (!command) throw new Error(`couldn't spot a ${kind} command in ${cwd} — pass one, e.g. operant ${kind} "npm run ${kind}"`);
  const t = { id: -1, kind: 'shell', title: a.title || command.slice(0, 40), cwd, cmd: command, run: kindOf(command) };
  const digest = digestOf(t);
  if (digest) return { id: st.nextTile, command, digest };
  return { id: st.nextTile, command, digest: null, text: readOutput(t, { lines: 400, errors: true }).text };
}

function currentBranch() {
  try { return /refs\/heads\/(.+)/.exec(fs.readFileSync(path.join(ROOT, '.git', 'HEAD'), 'utf8'))[1].trim(); } catch { return undefined; }
}

// ------------------------------------------------------------ main
function loadHelp() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'help.json'), 'utf8')); }
  catch { return { list: 'operant <cmd> [args] [--flag value] [--json]', commands: {} }; }
}

function main() {
  const help = loadHelp();
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') { console.log(help.list); return; }
  if (argv[0] === 'help') {
    if (!argv[1]) { console.log(help.list); return; }
    if (!help.commands[argv[1]]) {
      console.error(`operant: unknown command "${argv[1]}"`);
      console.error(`Commands: ${Object.keys(help.commands).join(', ')}`);
      process.exitCode = 1;
      return;
    }
    console.log(help.commands[argv[1]]);
    return;
  }

  if (!process.env.OPERANT_API) {
    console.error('operant: not inside an Operant tile (OPERANT_API is not set)');
    process.exitCode = 2;
    return;
  }

  const { cmd, positionals, flags } = parseArgs(argv);
  // Same guardrail as the real CLI: a worker can't start workers, checked before any request.
  if (cmd === 'agent' && IS_WORKER) {
    console.error("operant: workers can't start workers");
    process.exitCode = 1;
    return;
  }

  // A redesigned CLI may hand the agent its brief through these; empty unless the scenario has text.
  if (cmd === 'prime' || cmd === 'hook') {
    const prime = scenario.prime;
    if (!prime) return;
    if (cmd === 'prime') console.log(prime);
    else if (positionals[0] === 'session-start') console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: prime } }));
    return;
  }

  const handler = HANDLERS[cmd];
  if (!handler) { console.error(`operant: unknown command "${cmd}"`); process.exitCode = 1; return; }
  let result;
  try { result = withState(st => handler(buildArgs(cmd, positionals, flags), st)); }
  catch (e) { console.error(`operant: ${e.message}`); process.exitCode = 1; return; }

  if (flags.json) console.log(JSON.stringify(result));
  else {
    const text = formatResult(cmd, result);
    if (text) console.log(text);
  }
}

try { main(); } catch (e) { console.error(`operant: ${e.message}`); process.exitCode = 1; }
