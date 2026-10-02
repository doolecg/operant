// Tests for `operant hook <event>` (bin/operant-hook.js through the real CLI): the right JSON for
// Claude Code's hooks, and nothing at all, fast, whenever Operant can't answer.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'bin', 'operant-cli.js');

function runHook(event, { env = {}, input = {}, stdin } = {}) {
  return new Promise(resolve => {
    const started = Date.now();
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('OPERANT')));
    const child = spawn(process.execPath, [CLI, 'hook', event], { env: { ...clean, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', c => { out += c; });
    child.on('close', code => resolve({ code, out, ms: Date.now() - started }));
    child.stdin.end(stdin ?? JSON.stringify(input));
  });
}

// A stand-in for Operant's control API: answers each command from `answers`, records what it got.
async function withApi(answers, fn) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const { cmd, args } = JSON.parse(body);
      calls.push({ cmd, args, auth: req.headers.authorization });
      const result = typeof answers[cmd] === 'function' ? answers[cmd](args) : answers[cmd];
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result === undefined ? { ok: false, error: 'nope' } : { ok: true, result }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const env = { OPERANT: '1', OPERANT_API: `http://127.0.0.1:${server.address().port}`, OPERANT_TOKEN: 't0k', OPERANT_TILE: '7' };
  try { return await fn(env, calls); } finally { server.close(); }
}

const primeData = { v: '1.19.0', role: 'lead', tile: { id: 7, kind: 'ai', agent: 'claude' }, team: { enabled: false }, tiles: [], ports: [] };

test('session-start injects the prime as additionalContext', async () => {
  await withApi({ prime: primeData }, async (env, calls) => {
    const r = await runHook('session-start', { env, input: { hook_event_name: 'SessionStart', source: 'compact', cwd: __dirname } });
    assert.equal(r.code, 0);
    const out = JSON.parse(r.out);
    assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(out.hookSpecificOutput.additionalContext, /^<operant-context>\n.*lead agent in tile 7/);
    assert.deepEqual(calls.map(c => [c.cmd, c.args.hook]), [['prime', 'session-start']]);
    assert.equal(calls[0].auth, 'Bearer t0k');
  });
});

test('session-start prints nothing when the brief is switched off', async () => {
  await withApi({ prime: { off: true } }, async env => {
    const r = await runHook('session-start', { env });
    assert.deepEqual([r.code, r.out], [0, '']);
  });
});

test('outside a tile, or with Operant gone, every hook exits 0 quietly and fast', async () => {
  for (const event of ['session-start', 'subagent-start', 'stop', 'post-tool-use']) {
    const none = await runHook(event, { env: { OPERANT_WORKER: '1' } });
    assert.deepEqual([none.code, none.out], [0, ''], `${event} outside a tile`);
    const dead = await runHook(event, { env: { OPERANT: '1', OPERANT_API: 'http://127.0.0.1:9', OPERANT_TILE: '7', OPERANT_WORKER: '1' } });
    assert.deepEqual([dead.code, dead.out], [0, ''], `${event} with Operant closed`);
    assert.ok(dead.ms < 4000, `${event} took ${dead.ms}ms`);
  }
});

test('garbage on stdin or an unknown event never fails the agent', async () => {
  await withApi({ prime: primeData }, async env => {
    assert.deepEqual(await runHook('session-start', { env, stdin: '{not json' }).then(r => r.code), 0);
    const unknown = await runHook('pre-compact', { env });
    assert.deepEqual([unknown.code, unknown.out], [0, '']);
  });
});

test('subagent-start gives subagents the short brief unless it is switched off', async () => {
  await withApi({ hook: {} }, async env => {
    const out = JSON.parse((await runHook('subagent-start', { env, input: { cwd: __dirname } })).out);
    assert.equal(out.hookSpecificOutput.hookEventName, 'SubagentStart');
    assert.match(out.hookSpecificOutput.additionalContext, /operant test/);
  });
  await withApi({ hook: { off: true } }, async env => {
    assert.equal((await runHook('subagent-start', { env })).out, '');
  });
});

test('stop blocks a worker once with the reason, and never while a stop hook is already active', async () => {
  const block = 'Before you stop, report your result: `operant task done 12 --note "..."`';
  await withApi({ hook: args => (args.event === 'stop' ? { block } : {}) }, async (env, calls) => {
    const worker = { ...env, OPERANT_WORKER: '1' };
    const out = JSON.parse((await runHook('stop', { env: worker, input: { stop_hook_active: false } })).out);
    assert.deepEqual(out, { decision: 'block', reason: block });
    assert.deepEqual(calls[0].args, { event: 'stop', active: false });
    // the app decides whether an active stop hook still blocks (waiting messages do, a report does not)
    await runHook('stop', { env: worker, input: { stop_hook_active: true } });
    assert.deepEqual(calls[1].args, { event: 'stop', active: true });
  });
  await withApi({ hook: {} }, async env => {
    assert.equal((await runHook('stop', { env, input: {} })).out, '', 'nothing to say, nothing printed');
  });
});

test('post-tool-use hands waiting agent messages over as additionalContext', async () => {
  await withApi({ hook: args => (args.event === 'post-tool-use' ? { context: 'Message from tile 3 (Claude Code, lead): hi' } : {}) }, async (env, calls) => {
    const out = JSON.parse((await runHook('post-tool-use', { env })).out);
    assert.deepEqual(out, { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'Message from tile 3 (Claude Code, lead): hi' } });
    assert.deepEqual(calls.map(c => c.args), [{ event: 'post-tool-use' }]);
  });
  await withApi({ hook: {} }, async env => assert.equal((await runHook('post-tool-use', { env })).out, ''));
});

// The CodeGraph-first gate (pre-tool-use): needs no Operant API, only a .codegraph folder and a state file per agent.
test('pre-tool-use denies a code grep until the agent has made a CodeGraph call, per session and subagent', async () => {
  const fs = require('node:fs'), os = require('node:os');
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'operant-gate-'));
  fs.mkdirSync(path.join(proj, '.codegraph'));
  fs.mkdirSync(path.join(proj, 'src'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'operant-gate-tmp-'));
  const env = { TMPDIR: tmp, TEMP: tmp, TMP: tmp };
  const sid = 'sess-' + process.pid;
  const ask = (tool_name, tool_input, extra = {}, e = env) => runHook('pre-tool-use', { env: e, input: { session_id: sid, cwd: path.join(proj, 'src'), tool_name, tool_input, ...extra } });
  try {
    const denied = await ask('Grep', { pattern: 'notify' });
    assert.equal(denied.code, 0);
    const out = JSON.parse(denied.out);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /codegraph explore "notify"/);
    assert.equal((await ask('Grep', { pattern: 'x', glob: '*.css' })).out, '');
    assert.notEqual((await ask('Bash', { command: 'rg notify' })).out, '');
    // a subagent's CodeGraph call unlocks only the subagent
    assert.equal((await ask('Bash', { command: 'codegraph explore "notify"' }, { agent_id: 'sub1' })).out, '');
    assert.equal((await ask('Grep', { pattern: 'notify' }, { agent_id: 'sub1' })).out, '');
    assert.notEqual((await ask('Grep', { pattern: 'notify' })).out, '');
    assert.notEqual((await ask('Grep', { pattern: 'notify' }, { agent_id: 'sub2' })).out, '');
    assert.equal((await ask('mcp__codegraph__codegraph_explore', { query: 'notify' })).out, '');
    assert.equal((await ask('Grep', { pattern: 'notify' })).out, '');
    // off switch, and no index
    assert.equal((await ask('Grep', { pattern: 'notify' }, { session_id: 'other' }, { ...env, OPERANT_CODEGRAPH_GATE: '0' })).out, '');
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'operant-gate-bare-'));
    fs.mkdirSync(path.join(bare, '.git'));
    try { assert.equal((await ask('Grep', { pattern: 'notify' }, { cwd: bare, session_id: 'other' })).out, ''); } finally { fs.rmSync(bare, { recursive: true, force: true }); }
    assert.equal((await runHook('pre-tool-use', { env, stdin: '{nope' })).out, '');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
