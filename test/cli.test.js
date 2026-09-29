// Tests for bin/operant-cli.js: the flag tables, the names agents guess and the suggestions when they guess
// wrong, the help topics, the request to the app, and what an agent sees when it runs outside a tile.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { COMMANDS, POSITIONAL, TOPICS, CMD_ALIAS, FLAG_ALIAS, parseArgs, buildArgs, suggest, resolveAliases, formatResult } = require('../bin/operant-cli.js');

const CLI = path.join(__dirname, '..', 'bin', 'operant-cli.js');
const visible = Object.keys(COMMANDS).filter(n => !COMMANDS[n].hidden);

// The real CLI with every OPERANT* variable removed (this suite may itself run inside a tile, and must
// never reach its app), plus `env`.
function runCli(args, env = {}) {
  return new Promise(resolve => {
    const started = Date.now();
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('OPERANT')));
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...clean, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { err += c; });
    child.on('close', code => resolve({ code, out: out.replace(/\r\n/g, '\n'), err: err.replace(/\r\n/g, '\n'), ms: Date.now() - started }));
    child.stdin.end();
  });
}

// A stand-in for Operant's control API: answer(cmd, args, res) replies, every request is recorded in calls.
async function withApi(answer, fn) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const { cmd, args, tile } = JSON.parse(raw);
      calls.push({ cmd, args, tile, method: req.method, url: req.url, auth: req.headers.authorization, type: req.headers['content-type'] });
      answer(cmd, args, res);
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const env = { OPERANT: '1', OPERANT_API: `http://127.0.0.1:${server.address().port}`, OPERANT_TOKEN: 't0k', OPERANT_TILE: '7' };
  try { return await fn(env, calls); } finally { server.closeAllConnections(); server.close(); }
}
const send = (res, body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
// Answers the commands in `results`, and says no to the rest, as today's app does to _desire.
const app = (results = {}) => (cmd, args, res) => (cmd in results
  ? send(res, { ok: true, result: results[cmd] })
  : send(res, { ok: false, error: `unknown command "${cmd}"` }, 400));

// A port nothing listens on.
async function deadApi() {
  const s = http.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise(r => s.close(r));
  return `http://127.0.0.1:${port}`;
}

const byName = (a, b) => (a.name < b.name ? -1 : 1);

// ---- the tables

test('every command lists the flags it reads, and its help shows them', () => {
  for (const [name, c] of Object.entries(COMMANDS)) {
    assert.ok(Array.isArray(c.flags), `${name} has no flags list`);
    const help = [c.usage, c.desc, ...c.examples].join('\n');
    for (const m of c.usage.matchAll(/--([a-z][\w-]*)/g)) {
      assert.ok(m[1] === 'json' || c.flags.includes(m[1]), `${name}: the usage shows --${m[1]}, which is not in its flags`);
    }
    for (const f of c.flags) assert.ok(help.includes(`--${f}`), `${name}: --${f} is not in its help`);
  }
});

test('the flag table is what the handlers read', () => {
  const expected = {
    run: 'title cwd focus', test: 'cwd idle timeout title focus', build: 'cwd idle timeout title focus',
    read: 'lines new errors grep digest', wait: 'idle timeout new errors grep digest lines',
    agent: 'agent tier budget model cwd title focus', ask: 'options detail', notify: 'title', task: 'for note status', board: 'full',
    remember: 'type global about confidence supersedes', recall: 'about all note', usage: 'breakdown days', watch: 'errors grep off',
    close: 'force', ws: 'name', view: 'focus', edit: 'focus', diff: 'focus', terminal: 'focus', send: 'enter',
  };
  for (const [name, c] of Object.entries(COMMANDS)) {
    assert.deepEqual([...c.flags].sort(), (expected[name] || '').split(' ').filter(Boolean).sort(), name);
  }
});

test('version, hook and _desire are known but hidden', () => {
  for (const name of ['version', 'hook', '_desire']) assert.equal(COMMANDS[name].hidden, true, name);
  assert.ok(!visible.includes('version') && !visible.includes('hook') && !visible.includes('_desire'));
  assert.equal(resolveAliases(['version']).error, undefined);
  assert.equal(resolveAliases(['versio']).error.includes('Closest'), false, 'a hidden command is never suggested');
});

test('the alias tables are the agreed ones and point at real names', () => {
  const invert = table => Object.entries(table).reduce((o, [k, v]) => ({ ...o, [v]: [...(o[v] || []), k] }), {});
  assert.deepEqual(invert(CMD_ALIAS), {
    read: ['logs', 'log', 'tail', 'output', 'cat'], tiles: ['ls', 'list'], run: ['exec', 'sh', 'start', 'spawn-shell'],
    agent: ['spawn', 'worker', 'delegate'], test: ['tests'], build: ['compile'], ask: ['question', 'confirm', 'prompt'],
    plan: ['approve', 'review'], board: ['tasks', 'todo'], recall: ['memory', 'mem', 'facts'], remember: ['save', 'note-fact'],
    stop: ['kill'], usage: ['context', 'ctx'], ports: ['port', 'servers'], notify: ['alert', 'ping'], prime: ['brief', 'context-refresh'],
  });
  assert.deepEqual(invert(FLAG_ALIAS), {
    lines: ['tail', 'last', '-n'], errors: ['error', 'err', 'failures'], grep: ['filter', 'match', 'pattern', '-g'],
    title: ['name'], cwd: ['dir', 'path', 'workdir'], timeout: ['wait-timeout'],
  });
  const flagNames = new Set(visible.flatMap(n => COMMANDS[n].flags));
  for (const [alias, real] of Object.entries(CMD_ALIAS)) {
    assert.ok(visible.includes(real), `${alias} -> ${real}, which is not a command`);
    assert.ok(!Object.hasOwn(COMMANDS, alias), `${alias} is a command, so it cannot be an alias`);
  }
  for (const [alias, real] of Object.entries(FLAG_ALIAS)) assert.ok(flagNames.has(real), `${alias} -> ${real}, which no command has`);
  for (const name of Object.keys(POSITIONAL)) assert.ok(Object.hasOwn(COMMANDS, name), `POSITIONAL has ${name}`);
});

test('every example in the help parses without a guessed or unknown name', () => {
  for (const [name, c] of Object.entries(COMMANDS)) {
    for (const example of c.examples) {
      const words = example.match(/"[^"]*"|\S+/g).map(w => w.replace(/^"|"$/g, ''));
      const r = resolveAliases(words.slice(1));
      assert.equal(words[0], 'operant');
      assert.deepEqual([r.error, r.hits], [undefined, []], `${name}: ${example}`);
    }
  }
});

// ---- parsing

test('parseArgs reads --flag value, a bare --flag and --flag=value', () => {
  assert.deepEqual(parseArgs(['read', '7', '--lines', '50', '--errors']), { cmd: 'read', positionals: ['7'], flags: { lines: '50', errors: true } });
  assert.deepEqual(parseArgs(['read', '7', '--lines=50', '--grep=a=b']).flags, { lines: '50', grep: 'a=b' });
  assert.deepEqual(parseArgs(['wait', '--errors', '--idle', '5', '7']).flags, { errors: true, idle: '5' });
});

test('text and negative numbers stay positional', () => {
  assert.deepEqual(parseArgs(['send', '7', '-5', '-x', 'hello world', '-']).positionals, ['7', '-5', '-x', 'hello world', '-']);
  assert.deepEqual(parseArgs(['read', '7', '-5']).positionals, ['7', '-5']);
});

test('-n and -g are flags only for a command that has --lines or --grep', () => {
  assert.deepEqual(parseArgs(['read', '7', '-n', '20', '-g', 'boom']), { cmd: 'read', positionals: ['7'], flags: { '-n': '20', '-g': 'boom' } });
  assert.deepEqual(parseArgs(['wait', '7', '--errors', '-n', '20']).flags, { errors: true, '-n': '20' }, 'a bare flag does not take -n as its value');
  assert.deepEqual(parseArgs(['watch', '7', '-g', 'x']).flags, { '-g': 'x' });
  for (const cmd of ['run', 'test', 'send', 'agent', 'tiles']) {
    const r = parseArgs([cmd, 'git', 'log', '-n', '5', '-g']);
    assert.deepEqual([r.positionals, r.flags], [['git', 'log', '-n', '5', '-g'], {}], cmd);
  }
});

// ---- guessed names

test('a command alias runs the real command and says so in one note', () => {
  const r = resolveAliases(['logs', '7']);
  assert.deepEqual([r.cmd, r.positionals, r.flags, r.error], ['read', ['7'], {}, undefined]);
  assert.equal(r.note, 'operant: "logs" is "read" - ran operant read 7');
  assert.deepEqual(r.hits, [{ kind: 'command', name: 'logs', cmd: null, suggestion: 'read' }]);
  for (const [alias, real] of Object.entries(CMD_ALIAS)) assert.equal(resolveAliases([alias]).cmd, real, alias);
});

test('flag aliases are mapped, in the same one note', () => {
  const r = resolveAliases(['logs', '7', '--tail', '50', '--error', '-g', 'boom', '--json']);
  assert.deepEqual(r.flags, { lines: '50', errors: true, grep: 'boom', json: true });
  assert.equal(r.note, 'operant: "logs" is "read", "--tail" is "--lines", "--error" is "--errors", "-g" is "--grep" - ran operant read 7 --lines 50 --errors --grep boom --json');
  assert.deepEqual(r.hits.map(h => [h.kind, h.name, h.cmd, h.suggestion]), [
    ['command', 'logs', null, 'read'], ['flag', '--tail', 'read', '--lines'], ['flag', '--error', 'read', '--errors'], ['flag', '-g', 'read', '--grep']]);
  assert.equal(resolveAliases(['exec', 'npm test', '--name', 'dev']).note, 'operant: "exec" is "run", "--name" is "--title" - ran operant run "npm test" --title dev');
  assert.equal(resolveAliases(['run', 'x', '--dir', 'sub']).flags.cwd, 'sub');
  assert.equal(resolveAliases(['wait', '7', '--wait-timeout', '30']).flags.timeout, '30');
});

test('the note is one short line', () => {
  const r = resolveAliases(['spawn', 'x'.repeat(500), '--name', 'w']);
  assert.ok(!r.note.includes('\n') && r.note.length < 200, r.note.length);
});

test('a flag alias applies only where the command has its target', () => {
  assert.deepEqual(resolveAliases(['ws', '2', '--name', 'api']).flags, { name: 'api' }, '--name is ws\'s own flag');
  assert.equal(resolveAliases(['ws', '2', '--name', 'api']).note, null);
  assert.deepEqual(resolveAliases(['view', '--path', 'a.md']).flags, { path: 'a.md' }, '--path is view\'s argument');
  assert.match(resolveAliases(['tiles', '--tail', '5']).error, /^operant: tiles has no --tail flag\./);
  assert.match(resolveAliases(['read', '7', '--path', 'x']).error, /read has no --path flag/);
});

test('a positional\'s name still works as a flag, as it always has', () => {
  assert.deepEqual(resolveAliases(['read', '--id', '7']).flags, { id: '7' });
  assert.equal(resolveAliases(['read', '--id', '7']).note, null);
  assert.deepEqual(buildArgs('run', [], { command: 'npm test' }).command, 'npm test');
  assert.equal(resolveAliases(['notify', '--text', 'hi']).error, undefined);
});

test('-n and -g keep their text where the command has no --lines or --grep', () => {
  const r = resolveAliases(['run', 'git', 'log', '-n', '5']);
  assert.deepEqual([r.positionals, r.flags, r.error, r.note], [['git', 'log', '-n', '5'], {}, undefined, null]);
});

test('--json is fine on every command', () => {
  for (const name of Object.keys(COMMANDS)) assert.equal(resolveAliases([name, '--json']).error, undefined, name);
});

// ---- unknown names

test('an unknown command names the closest one and its usage', () => {
  const r = resolveAliases(['reed', '7']);
  assert.equal(r.error, `operant: unknown command "reed". Closest: read (${COMMANDS.read.usage}). All commands: operant help`);
  assert.deepEqual(r.hits, [{ kind: 'command', name: 'reed', cmd: null, suggestion: 'read' }]);
  assert.match(resolveAliases(['tile']).error, /Closest: tiles \(operant tiles\)/);
  assert.match(resolveAliases(['summary']).error, /Closest: summarize /);
});

test('an unknown command with nothing close just points at help', () => {
  const r = resolveAliases(['frobnicate']);
  assert.equal(r.error, 'operant: unknown command "frobnicate". All commands: operant help');
  assert.equal(r.hits[0].suggestion, null);
  assert.doesNotMatch(resolveAliases(['remove']).error, /Closest/, 'a shared start of three letters is not enough');
});

test('names that are on the Object prototype are not commands or flags', () => {
  for (const name of ['constructor', 'toString', 'hasOwnProperty']) {
    assert.match(resolveAliases([name]).error, /^operant: unknown command/, name);
    assert.match(resolveAliases(['read', '7', `--${name}`]).error, /read has no --/, name);
  }
});

test('an unknown flag names the closest one and the usage', () => {
  const r = resolveAliases(['read', '7', '--line', '5']);
  assert.equal(r.error, `operant: read has no --line flag. Closest: --lines. Usage: ${COMMANDS.read.usage}`);
  assert.deepEqual(r.hits, [{ kind: 'flag', name: '--line', cmd: 'read', suggestion: '--lines' }]);
  assert.equal(resolveAliases(['test', '--pattern', 'x']).error, `operant: test has no --pattern flag. Usage: ${COMMANDS.test.usage}`);
});

test('every unknown flag is named at once, and one in a command is not swallowed silently', () => {
  assert.match(resolveAliases(['read', '7', '--line', '--foo']).error, /^operant: read has no --line or --foo flag\. Closest: --lines\. Usage: /);
  const r = resolveAliases(['run', 'npm', 'run', 'dev', '--port', '3000']);
  assert.match(r.error, /^operant: run has no --port flag\. Usage: operant run <command\.\.\.>/);
  assert.match(resolveAliases(['logs', '7', '--bogus']).error, /^operant: read has no --bogus flag/, 'reported against the real command');
});

test('suggest picks a near name and leaves the rest', () => {
  assert.equal(suggest('reed', visible), 'read');
  assert.equal(suggest('tets', visible), 'test', 'a swap of two letters is one typo');
  assert.equal(suggest('reading', visible), 'read', 'one starts with the other');
  assert.equal(suggest('wa', visible), 'wait', 'a start beats a lookalike (ws)');
  assert.equal(suggest('summary', visible), 'summarize', 'four letters in common');
  assert.equal(suggest('READ', visible), 'read');
  assert.equal(suggest('--Lines', ['lines', 'json']), 'lines');
  for (const word of ['', 'x', 'frobnicate', 'remove', 'notes']) assert.equal(suggest(word, visible), null, word);
});

// ---- what the app is sent

test('run, test, build and agent start in the shell folder, not the tile folder', () => {
  const here = path.resolve(process.cwd());
  for (const cmd of ['run', 'test', 'build', 'agent']) assert.equal(buildArgs(cmd, ['x'], {}).cwd, here, cmd);
  assert.equal(buildArgs('test', [], { cwd: 'sub/dir' }).cwd, path.resolve('sub', 'dir'), 'a relative --cwd is relative to the shell');
  const abs = path.resolve(os.tmpdir(), 'proj');
  assert.equal(buildArgs('run', ['x'], { cwd: abs }).cwd, abs);
  assert.equal(buildArgs('agent', ['x'], { cwd: '123' }).cwd, path.resolve('123'), 'a folder named like a number is still a folder');
  assert.equal(buildArgs('build', [], { cwd: true }).cwd, here, 'a bare --cwd is no folder');
  for (const cmd of ['read', 'view', 'tiles', 'notify', 'ask', 'diff']) assert.ok(!('cwd' in buildArgs(cmd, ['7'], {})), cmd);
});

test('the shell folder is the one the command runs in, after a cd', () => {
  const before = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operant-cli-'));
  try {
    process.chdir(dir);
    assert.equal(buildArgs('run', ['npm test'], {}).cwd, process.cwd());
    assert.equal(buildArgs('test', [], { cwd: 'sub' }).cwd, path.join(process.cwd(), 'sub'));
  } finally { process.chdir(before); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ask options are split on commas, or on | when there is one (PowerShell hands a | to cmd.exe as a pipe)', () => {
  const options = value => buildArgs('ask', ['Q'], { options: value }).options;
  assert.deepEqual(options('Delete,Keep'), ['Delete', 'Keep']);
  assert.deepEqual(options('Delete|Keep'), ['Delete', 'Keep']);
  assert.deepEqual(options('Yes, delete|No'), ['Yes, delete', 'No'], 'a | wins, so a comma can be part of a label');
  assert.deepEqual(options('A, B ,C'), ['A', 'B', 'C']);
  assert.deepEqual(options('Only'), ['Only']);
  assert.deepEqual(options(','), [], 'nothing left: the app falls back to Yes/No');
  assert.match(COMMANDS.ask.usage, /--options "A,B,C"/);
  assert.ok(COMMANDS.ask.examples.every(e => !e.includes('|')));
  assert.ok(!TOPICS.workflows.includes('Delete|Keep'));
});

test('buildArgs still turns positionals and flags into the named args', () => {
  assert.deepEqual(buildArgs('read', ['7'], { lines: '50', errors: true, json: true }), { id: 7, lines: 50, errors: true });
  assert.deepEqual(buildArgs('ask', ['Delete', 'old?'], { options: 'Delete|Keep' }), { question: 'Delete old?', options: ['Delete', 'Keep'] });
  assert.deepEqual(buildArgs('ask', ['Delete', 'old?'], { options: 'Delete,Keep' }), { question: 'Delete old?', options: ['Delete', 'Keep'] });
  assert.deepEqual(buildArgs('task', ['add', 'fix', 'it'], { for: '5' }), { for: 5, sub: 'add', text: 'fix it' });
  assert.deepEqual(buildArgs('send', ['7', 'y', 'es'], { enter: true }), { id: 7, text: 'y es', enter: true });
  assert.deepEqual(buildArgs('view', ['plan.md'], {}), { path: path.resolve('plan.md') });
  assert.deepEqual(buildArgs('ws', ['2'], { name: 'api' }), { index: 2, name: 'api' });
});

// ---- the CLI itself, outside a tile

test('an unknown command exits 1 with the closest one', async () => {
  const r = await runCli(['reed', '7']);
  assert.equal(r.code, 1);
  assert.equal(r.out, '');
  assert.match(r.err, /unknown command "reed"\. Closest: read \(operant read <id>/);
});

test('a guessed command says what it ran, then finds it is not inside a tile', async () => {
  const r = await runCli(['logs', '7']);
  assert.equal(r.code, 2);
  assert.equal(r.err, 'operant: "logs" is "read" - ran operant read 7\noperant: not inside an Operant tile (OPERANT_API is not set)\n');
});

test('an unknown flag exits 1 with the closest one', async () => {
  const r = await runCli(['read', '7', '--line', '5']);
  assert.equal(r.code, 1);
  assert.match(r.err, /^operant: read has no --line flag\. Closest: --lines\. Usage: operant read <id>/);
});

test('a valid command outside a tile still exits 2 with the same message', async () => {
  const r = await runCli(['read', '7', '--lines', '5']);
  assert.deepEqual([r.code, r.out, r.err], [2, '', 'operant: not inside an Operant tile (OPERANT_API is not set)\n']);
});

test('hooks outside a tile exit 0 and print nothing', async () => {
  const r = await runCli(['hook', 'session-start']);
  assert.deepEqual([r.code, r.out, r.err], [0, '', '']);
});

test('help lists the topics; help <topic> prints one; a command still wins', async () => {
  const list = await runCli(['help']);
  assert.equal(list.code, 0);
  assert.ok(list.out.includes('operant help <topic> for a short guide: workflows, fan-out, worker, team, gotchas.'));
  assert.ok(list.out.includes('agents & tasks: agent, ask, notify, plan, task, board, team, summarize, find, msg, inbox'));
  assert.doesNotMatch(list.out, /version|hook|_desire/, 'hidden commands are not listed');

  for (const [name, text] of Object.entries(TOPICS)) {
    const r = await runCli(['help', name]);
    assert.equal(r.code, 0, name);
    assert.ok(r.out.includes(text), name);
  }
  const gotchas = await runCli(['help', 'gotchas']);
  assert.match(gotchas.out, /^Exit code 2: you are not inside Operant/);

  const read = await runCli(['help', 'read']);
  assert.equal(read.out, `${COMMANDS.read.usage}\n\n  ${COMMANDS.read.desc}\n\nExamples:\n${COMMANDS.read.examples.map(e => `  ${e}\n`).join('')}`);

  const team = await runCli(['help', 'team']);
  assert.ok(team.out.startsWith('operant team\n') && team.out.includes(TOPICS.team), 'the command help, then the topic');
  const worker = await runCli(['help', 'worker']);
  assert.equal(worker.out, `${TOPICS.worker}\n`, 'a topic, not the agent command it is also a guess for');
  assert.equal(worker.err, '');
});

test('help for a guessed command shows the real one, and a near miss names the closest topic', async () => {
  const logs = await runCli(['help', 'logs']);
  assert.equal(logs.code, 0);
  assert.ok(logs.out.startsWith(COMMANDS.read.usage));
  assert.equal(logs.err, 'operant: "logs" is "read" - ran operant help read\n');
  const near = await runCli(['help', 'workflow']);
  assert.equal(near.code, 1);
  assert.equal(near.err, 'operant: unknown command "workflow". Closest: workflows (operant help workflows). All commands: operant help\n');
  assert.match((await runCli(['help', 'frobnicate'])).err, /^operant: unknown command "frobnicate"\. All commands: operant help/);
});

test('each topic is 8 to 20 short lines', () => {
  assert.deepEqual(Object.keys(TOPICS), ['workflows', 'fan-out', 'worker', 'team', 'gotchas']);
  for (const [name, text] of Object.entries(TOPICS)) {
    const lines = text.split('\n');
    assert.ok(lines.length >= 8 && lines.length <= 20, `${name} has ${lines.length} lines`);
    assert.ok(lines.every(l => l.length <= 110), `${name} has a line over 110 characters`);
  }
});

// ---- the request to the app

test('run says the tile only started, and how to get the outcome; --json and the other tile commands are unchanged', async () => {
  assert.equal(formatResult('run', { id: 12 }), 'tile 12 · running; read it with: operant wait 12 --errors');
  for (const cmd of ['view', 'edit', 'diff']) assert.equal(formatResult(cmd, { id: 3 }), 'tile 3', cmd);
  assert.equal(formatResult('agent', { id: 3, tier: 'small', taskId: 9 }), 'tile 3  [small]  task 9');
  await withApi(app({ run: { id: 12 } }), async (env, calls) => {
    assert.equal((await runCli(['run', 'npm test'], env)).out, 'tile 12 · running; read it with: operant wait 12 --errors\n');
    assert.equal((await runCli(['run', 'npm test', '--json'], env)).out, '{"id":12}\n');
    assert.equal(calls[0].args.command, 'npm test');
  });
});

test('a request to the app carries the command, its args and the tile, with the token', async () => {
  await withApi(app({ read: { text: 'hello', total: 1, shown: 1 } }), async (env, calls) => {
    const r = await runCli(['read', '7', '--lines', '5'], env);
    assert.deepEqual([r.code, r.out, r.err], [0, 'hello\n', '']);
    assert.deepEqual(calls, [{ cmd: 'read', args: { id: 7, lines: 5 }, tile: '7', method: 'POST', url: '/v1', auth: 'Bearer t0k', type: 'application/json' }]);
  });
  await withApi(app({ read: { text: 'hello', total: 1, shown: 1 } }), async env => {
    assert.equal((await runCli(['read', '7', '--json'], env)).out, '{"text":"hello","total":1,"shown":1}\n');
  });
});

test('a slow answer is waited for (the request has no client-side timeout)', async () => {
  await withApi((cmd, args, res) => setTimeout(() => send(res, { ok: true, result: { answer: 'Keep' } }), 2000), async (env, calls) => {
    const r = await runCli(['ask', 'Delete old migrations?', '--options', 'Delete|Keep'], env);
    assert.deepEqual([r.code, r.out, r.err], [0, 'Keep\n', '']);
    assert.ok(r.ms >= 1900, `answered after ${r.ms}ms`);
    assert.deepEqual(calls[0].args, { question: 'Delete old migrations?', options: ['Delete', 'Keep'] });
  });
});

test('fetch is not used for the request: it gives up after 300s without response headers', () => {
  assert.doesNotMatch(fs.readFileSync(CLI, 'utf8'), /\bfetch\(/);
});

test('an app that is not there gives the same message and exit 1', async () => {
  const r = await runCli(['read', '7'], { OPERANT_API: await deadApi(), OPERANT_TOKEN: 't', OPERANT_TILE: '7' });
  assert.deepEqual([r.code, r.out, r.err], [1, '', 'operant: could not reach Operant (is it still running?)\n']);
});

test('errors, warnings and odd answers are reported as before', async () => {
  await withApi(app({ read: { text: 'x', total: 1, shown: 1 } }), async env => {
    const r = await runCli(['tiles'], env);
    assert.deepEqual([r.code, r.err], [1, 'operant: unknown command "tiles"\n']);
  });
  await withApi((cmd, args, res) => send(res, { ok: true, result: { text: 'x', total: 1, shown: 1 }, warn: 'watch: tile 5 printed an error' }), async env => {
    const r = await runCli(['read', '5'], env);
    assert.deepEqual([r.code, r.out, r.err], [0, 'x\n', 'watch: tile 5 printed an error\n']);
  });
  await withApi((cmd, args, res) => { res.writeHead(500); res.end('oops'); }, async env => {
    const r = await runCli(['read', '5'], env);
    assert.deepEqual([r.code, r.err], [1, 'operant: request failed (500)\n']);
  });
  await withApi((cmd, args, res) => res.destroy(), async env => {
    const r = await runCli(['read', '5'], env);
    assert.equal(r.code, 1);
    assert.match(r.err, /^operant: request failed: .+\n$/);
  });
});

test('a worker still cannot start workers', async () => {
  await withApi(app(), async (env, calls) => {
    const r = await runCli(['agent', 'do it'], { ...env, OPERANT_WORKER: '1' });
    assert.deepEqual([r.code, r.err, calls.length], [1, "operant: workers can't start workers\n", 0]);
  });
});

// ---- the desire-path reports

test('a guess is reported by name only, and the real command still runs', async () => {
  await withApi(app({ read: { text: 'hello', total: 1, shown: 1 } }), async (env, calls) => {
    const r = await runCli(['logs', '7', '--tail', '12345', '--error'], env);
    assert.deepEqual([r.code, r.out], [0, 'hello\n']);
    assert.equal(r.err, 'operant: "logs" is "read", "--tail" is "--lines", "--error" is "--errors" - ran operant read 7 --lines 12345 --errors\n');
    const desires = calls.filter(c => c.cmd === '_desire');
    assert.deepEqual(desires.map(c => c.args).sort(byName), [
      { kind: 'flag', name: '--error', cmd: 'read', suggestion: '--errors' },
      { kind: 'flag', name: '--tail', cmd: 'read', suggestion: '--lines' },
      { kind: 'command', name: 'logs', cmd: null, suggestion: 'read' },
    ]);
    assert.ok(desires.every(c => c.tile === '7' && c.auth === 'Bearer t0k' && c.method === 'POST' && c.url === '/v1'));
    assert.ok(!JSON.stringify(desires).includes('12345'), 'no flag value is sent');
    assert.deepEqual(calls.find(c => c.cmd === 'read').args, { id: 7, lines: 12345, errors: true });
  });
});

test('an unknown command or flag is reported and exits 1', async () => {
  await withApi(app(), async (env, calls) => {
    const r = await runCli(['reed', '7'], env);
    assert.equal(r.code, 1);
    assert.match(r.err, /^operant: unknown command "reed"\. Closest: read /);
    assert.deepEqual(calls.map(c => [c.cmd, c.args]), [['_desire', { kind: 'command', name: 'reed', cmd: null, suggestion: 'read' }]]);
  });
  await withApi(app(), async (env, calls) => {
    const r = await runCli(['read', '7', '--frob', 'secret'], env);
    assert.equal(r.code, 1);
    assert.deepEqual(calls.map(c => c.args), [{ kind: 'flag', name: '--frob', cmd: 'read', suggestion: null }]);
  });
});

test('nothing is reported that is not a name', async () => {
  await withApi(app(), async (env, calls) => {
    assert.equal((await runCli(['npm run build --verbose'], env)).code, 1);
    assert.equal((await runCli(['notify', '--- done ---'], env)).code, 1);
    assert.equal((await runCli(['read', '7', '--lines=5', '--x'.padEnd(40, 'x')], env)).code, 1);
    assert.deepEqual(calls, []);
  });
});

test('a dead, slow or refusing app changes neither the result nor the output', async () => {
  const dead = await runCli(['reed'], { OPERANT_API: await deadApi(), OPERANT_TOKEN: 't', OPERANT_TILE: '7' });
  assert.deepEqual([dead.code, dead.err.split('\n').length], [1, 2], 'one line, no report error');
  await withApi(app(), async env => {
    const refused = await runCli(['reed'], env);
    assert.deepEqual([refused.code, refused.err.split('\n').length], [1, 2]);
  });
  await withApi(() => {}, async env => { // takes every request and never answers
    const hung = await runCli(['reed'], env);
    assert.deepEqual([hung.code, hung.err.split('\n').length], [1, 2]);
    assert.ok(hung.ms < 4000, `took ${hung.ms}ms`);
  });
});

test('a report the app never answers costs at most its 400ms and never the result', async () => {
  await withApi((cmd, args, res) => { if (cmd !== '_desire') send(res, { ok: true, result: { text: 'hello', total: 1, shown: 1 } }); }, async env => {
    const r = await runCli(['logs', '7'], env);
    assert.deepEqual([r.code, r.out, r.err], [0, 'hello\n', 'operant: "logs" is "read" - ran operant read 7\n']);
    assert.ok(r.ms < 3000, `took ${r.ms}ms`);
  });
});

test('outside a tile nothing is sent anywhere', async () => {
  const r = await runCli(['logs', '7', '--tail', '5']);
  assert.equal(r.code, 2);
  assert.equal(r.err.split('\n').length, 3);
});
