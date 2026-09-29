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
  for (const event of ['session-start', 'subagent-start', 'stop']) {
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
    assert.equal((await runHook('stop', { env: worker, input: { stop_hook_active: true } })).out, '');
    assert.equal((await runHook('stop', { env, input: {} })).out, '', 'a lead is never blocked');
    assert.equal(calls.length, 1);
  });
});
