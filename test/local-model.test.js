const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const lm = require('../local-model');
const { isFreeModel } = require('../pricing');
const { validatePatch } = require('../config-migrate');

const base = { xsmall: { agent: 'opencode', model: 'opencode/big-pickle', use: 'easy' }, small: { agent: 'claude', model: 'claude-haiku-4-5' } };

test('fallback order: Big Pickle first, the local model only while Big Pickle is down and the model is ready, then back', () => {
  let t = 0;
  const f = lm.createFailover({ now: () => t, cooldownMs: 1000 });
  const at = ready => lm.overlay(base, { ready, model: 'gemma4:e4b', down: f.active() }).xsmall;
  assert.equal(at(true).model, 'opencode/big-pickle');
  assert.equal(at(true).active, 'Big Pickle');
  f.fail('429 rate limit');
  assert.equal(at(true).model, 'ollama/gemma4:e4b');
  assert.match(at(true).active, /^local \(gemma4:e4b\)/);
  assert.match(at(true).fallback, /rate limit/);
  assert.equal(at(false).model, 'opencode/big-pickle', 'not installed or ready: silently Big Pickle');
  assert.equal(at(false).fallback, undefined);
  t = 1500;
  assert.equal(f.active(), null);
  assert.equal(at(true).model, 'opencode/big-pickle', 'back to Big Pickle after the cooldown');
  assert.equal(lm.overlay(base, { ready: true, model: 'x', down: { reason: 'r' } }).small.model, 'claude-haiku-4-5');
  assert.equal(lm.overlayModes({ claude: { tiers: base, removed: [], empty: false } }, { ready: true, model: 'm', down: { reason: 'r' } }).claude.tiers.xsmall.model, 'ollama/m');
});

test('which errors count as Big Pickle being unavailable', () => {
  for (const s of ['429 Too Many Requests', 'Rate limit exceeded', 'Model is overloaded', 'request timed out', 'free usage limit reached', 'quota exhausted', '503']) assert.ok(lm.isFreeFailure(s), s);
  for (const s of ['', 'syntax error in file', 'permission denied']) assert.ok(!lm.isFreeFailure(s), s);
});

test('the OpenCode provider entry: merged, the user\'s own config kept', () => {
  const p = lm.providerConfig('gemma4:e4b').ollama;
  assert.equal(p.options.baseURL, 'http://localhost:11434/v1');
  assert.deepEqual(Object.keys(p.models), ['gemma4:e4b']);
  const merged = JSON.parse(lm.withProvider(JSON.stringify({ instructions: ['a.md'], provider: { ollama: { models: { mine: { name: 'mine' } } }, other: { x: 1 } } }), 'gemma4:e4b'));
  assert.deepEqual(merged.instructions, ['a.md']);
  assert.equal(merged.provider.other.x, 1);
  assert.deepEqual(Object.keys(merged.provider.ollama.models).sort(), ['gemma4:e4b', 'mine']);
  const own = { options: { baseURL: 'http://box:11434/v1' } };
  assert.equal(lm.providerConfig('gemma4:e4b', own).ollama.options, undefined);
  assert.equal(JSON.parse(lm.withProvider('', 'gemma4:e2b')).provider.ollama.models['gemma4:e2b'].name, 'gemma4:e2b');
});

test('local models are free', () => {
  assert.ok(isFreeModel('ollama/gemma4:e4b'));
  assert.ok(isFreeModel('opencode/big-pickle'));
  assert.ok(!isFreeModel('claude-haiku-4-5'));
});

test('settings: localModel and backgroundAfterSeconds are validated', () => {
  const defaults = { localModel: { model: 'gemma4:e4b' }, backgroundAfterSeconds: 5 };
  assert.deepEqual(validatePatch({ localModel: { model: 'gemma4:12b' }, backgroundAfterSeconds: 0 }, defaults), []);
  assert.equal(validatePatch({ localModel: { model: 'not a model!' } }, defaults).length, 1);
  assert.equal(validatePatch({ backgroundAfterSeconds: 601 }, defaults).length, 1);
});

test('parsePercent reads the last percentage of Ollama\'s progress output', () => {
  assert.equal(lm.parsePercent('pulling 3f: 12% ▕██ ▏ 1 GB/8 GB\rpulling 3f: 45% ▕████ ▏'), 45);
  assert.equal(lm.parsePercent('verifying sha256 digest'), null);
});

// A fake process runner: each command is answered by `script(cmd, args)`, which returns { code, out, chunks }.
function harness({ platform = 'win32', ollama = null, script }) {
  const calls = [], states = [];
  let exe = ollama;
  const spawn = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.unref = () => {};
    setImmediate(() => {
      const r = script(cmd, args, () => { exe = 'C:/ollama.exe'; }) || { code: 0 };
      for (const ch of r.chunks || []) c.stdout.emit('data', Buffer.from(ch));
      if (r.out) c.stdout.emit('data', Buffer.from(r.out));
      c.emit('close', r.code);
    });
    return c;
  };
  const m = lm.createLocalModel({ spawn, which: async () => exe, platform, onChange: s => states.push(s), wait: async () => {} });
  return { m, calls, states };
}

test('install: winget when Ollama is missing, then the pull with live progress, then ready', async () => {
  const { m, calls, states } = harness({ script: (cmd, args, found) => {
    if (cmd === 'winget') { found(); return { code: 0 }; }
    if (args[0] === 'list') return { code: 0, out: 'NAME ID SIZE\n' };
    if (args[0] === 'pull') return { code: 0, chunks: ['pulling 3f: 10% \r', 'pulling 3f: 60% \r'] };
  } });
  const r = await m.install('gemma4:e4b');
  assert.equal(r.status, 'ready');
  assert.match(calls[0], /^winget install --id Ollama\.Ollama -e --silent/);
  assert.ok(calls.some(c => c === 'C:/ollama.exe pull gemma4:e4b'));
  assert.ok(states.some(s => s.status === 'installing' && s.pct === 60), 'progress reaches the UI');
  assert.equal(states.at(-1).pct, 100);
});

test('install on macOS or Linux links the official installer instead of running one', async () => {
  const { m, calls } = harness({ platform: 'linux', script: () => ({ code: 0 }) });
  const r = await m.install('gemma4:e4b');
  assert.equal(r.status, 'error');
  assert.equal(r.link, 'https://ollama.com/download');
  assert.deepEqual(calls, []);
});

test('a failed pull is an error, refresh finds the model, remove clears it', async () => {
  let listed = 'NAME ID\ngemma4:e4b abc 3 GB\n';
  const h = harness({ ollama: 'C:/ollama.exe', script: (cmd, args) => {
    if (args[0] === 'list') return { code: 0, out: listed };
    if (args[0] === 'pull') return { code: 1, out: 'Error: pull model manifest: file does not exist' };
    if (args[0] === 'rm') { listed = 'NAME ID\n'; return { code: 0 }; }
  } });
  assert.equal((await h.m.refresh('gemma4:e4b')).status, 'ready');
  const bad = await h.m.install('gemma4:12b');
  assert.equal(bad.status, 'error');
  assert.match(bad.message, /file does not exist/);
  assert.equal((await h.m.remove('gemma4:e4b')).status, 'none');
  assert.equal((await h.m.refresh('gemma4:e4b')).status, 'none');
});
