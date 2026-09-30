// Failure tests (2.5): simulated timeout, bad credentials, rate limit, malformed response, corrupt memory, corrupt store,
// MCP failure and network failure. Each asserts a graceful, honest result. All simulated; no network, no model.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { summarize, asHealth } = require('../route-health');
const { classify } = require('../failure-class');
const TierRoutes = require('../tier-routes');
const { openStore, feedOutcome } = require('../store');
const memory = require('../memory');
const { createUpdater } = require('../updater');
const { CHECKS } = require('../health');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'operant-failtest-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;
const mkdir = () => { const d = path.join(root, `t${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
const NOW = 1e12, MIN = 60e3;

test('failure-class: timeout, bad credentials, rate limit and malformed output each get their own kind', () => {
  assert.equal(classify({ note: 'request timed out after 60s' }).kind, 'timeout');
  assert.equal(classify({ note: 'HTTP 401 unauthorized: invalid API key' }).kind, 'auth');
  assert.equal(classify({ note: 'HTTP 429 too many requests' }).kind, 'rate-limit');
  assert.equal(classify({ note: 'could not parse the response: invalid JSON' }).kind, 'bad-output');
  assert.match(classify({ note: 'HTTP 401 unauthorized' }).evidence, /401/);
});

test('failure-class: nothing failed is null and unknown text is "other", never a guess', () => {
  assert.equal(classify({}), null);
  assert.equal(classify(), null);
  assert.equal(classify({ note: 'the moon is full' }).kind, 'other');
});

test('route-health: timeout, rate limit and bad credentials mark a route down with a reason', () => {
  const s = summarize([
    { key: 't', t: NOW - MIN, ok: false, kind: 'timeout' },
    { key: 'r', t: NOW - MIN, ok: false, kind: 'rate-limit' },
    { key: 'a', t: NOW - MIN, ok: false, kind: 'auth' },
  ], NOW);
  assert.match(s.t.down.reason, /timed out/);
  assert.match(s.r.down.reason, /rate limited/);
  assert.match(s.a.down.reason, /failed authentication/);
  const h = asHealth(s, () => NOW);
  assert.equal(h.down('t').kind, 'busy');
  assert.equal(h.down('a').kind, 'unavailable');
  assert.equal(h.down('never-called'), null);
  assert.equal(asHealth(s, () => NOW + 11 * MIN).down('r'), null);
});

test('route-health: malformed records are ignored and nothing is invented for them', () => {
  const s = summarize([null, undefined, 42, {}, { key: 'x' }, { key: 'x', t: 'yesterday', ok: true }, { key: 'k', t: NOW - MIN, ok: true, latencyMs: 'fast' }], NOW);
  assert.deepEqual(Object.keys(s), ['k']);
  assert.equal(s.k.avgLatencyMs, null);
  assert.deepEqual(summarize(undefined, NOW), {});
  assert.equal(asHealth(undefined).down('k'), null);
});

test('tier-routes: failure text is sorted into busy, out of free use, or not a route problem', () => {
  assert.equal(TierRoutes.classifyFailure('429 rate limit exceeded'), 'busy');
  assert.equal(TierRoutes.classifyFailure('request timed out'), 'busy');
  assert.equal(TierRoutes.classifyFailure('free usage limit reached'), 'quota');
  assert.equal(TierRoutes.classifyFailure('SyntaxError: unexpected token in JSON'), null);
  assert.equal(TierRoutes.classifyFailure(undefined), null);
});

test('tier-routes: a rate-limited route is skipped with its reason; with every route down it stays on the first', () => {
  const tier = { agent: 'claude', model: 'claude-haiku-4-5', fallbacks: [{ agent: 'claude', model: 'claude-sonnet-5-5' }] };
  const health = TierRoutes.createHealth({ now: () => NOW });
  health.fail('claude-haiku-4-5', '429 too many requests');
  const one = TierRoutes.resolve(tier, { health });
  assert.equal(one.model, 'claude-sonnet-5-5');
  assert.equal(one.skipped[0].kind, 'busy');
  assert.match(one.route.note, /was busy/);
  health.fail('claude-sonnet-5-5', 'ETIMEDOUT');
  assert.equal(TierRoutes.resolve(tier, { health }).model, 'claude-haiku-4-5');
});

test('tier-routes: a route comes back after its cooldown', () => {
  let t = NOW;
  const h = TierRoutes.createHealth({ now: () => t, cooldownMs: 10 * MIN });
  h.fail('m', 'timeout');
  assert.ok(h.down('m'));
  t += 11 * MIN;
  assert.equal(h.down('m'), null);
});

test('store: corrupt rows are skipped and a corrupt meta file re-migrates without losing rows', () => {
  const dir = mkdir();
  const s = openStore(dir);
  s.append('taskRuns', { project: 'p', taskId: 1 });
  fs.appendFileSync(path.join(dir, 'taskRuns.jsonl'), '{not json\n\u0000\u0000binary\n[1,2]\n"str"\n');
  s.append('taskRuns', { project: 'p', taskId: 2 });
  assert.deepEqual(s.query('taskRuns').map(r => r.taskId), [1, 2]);
  fs.writeFileSync(path.join(dir, 'meta.json'), '{{{ broken');
  const again = openStore(dir);
  assert.equal(again.version(), 1);
  assert.deepEqual(again.query('taskRuns').map(r => r.taskId), [1, 2]);
});

test('store: a missing table, a table of garbage and a newer schema each give an honest result', () => {
  const dir = mkdir();
  const s = openStore(dir);
  fs.rmSync(path.join(dir, 'failures.jsonl'));
  assert.deepEqual(s.query('failures'), []);
  fs.writeFileSync(path.join(dir, 'toolCalls.jsonl'), 'garbage only\n');
  assert.deepEqual(s.query('toolCalls'), []);
  assert.doesNotThrow(() => s.prune());
  assert.throws(() => s.append('nonsense', {}), /unknown table/);
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ schemaVersion: 99 }));
  assert.throws(() => openStore(dir), /newer than this Operant understands/);
});

test('store: an unusable folder fails at open; feedOutcome on junk does not throw', () => {
  const file = path.join(mkdir(), 'a-file');
  fs.writeFileSync(file, 'x');
  assert.throws(() => openStore(path.join(file, 'store')));
  const s = openStore(mkdir());
  assert.doesNotThrow(() => feedOutcome(s, {}));
});

function memEnv() {
  const cwd = mkdir(); fs.mkdirSync(path.join(cwd, '.git'));
  return { cwd, userDataDir: mkdir(), homeDir: mkdir() };
}

test('memory: a corrupt fact file and a corrupt index do not break recall of the good facts', () => {
  const env = memEnv();
  memory.remember({ ...env, text: 'Runs on Node 22 in CI' });
  const dir = memory.projectMemoryDir(env.cwd);
  fs.writeFileSync(path.join(dir, 'broken.md'), '---\nname: [unclosed\n\u0000\u0001 binary junk');
  fs.writeFileSync(path.join(dir, 'empty.md'), '');
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), '\u0000\u0000 not an index');
  let out;
  assert.doesNotThrow(() => { out = memory.recall({ ...env, tokenCap: 500 }); });
  assert.match(JSON.stringify(out), /Node 22/);
  assert.doesNotThrow(() => memory.recall({ ...env, query: 'node' }));
  assert.doesNotThrow(() => memory.listAll(env));
});

test('memory: corrupt usage stats are ignored, and saving nothing is refused clearly', () => {
  const env = memEnv();
  memory.remember({ ...env, text: 'Prefers plain commit messages' });
  fs.writeFileSync(path.join(env.userDataDir, 'memory-stats.json'), '{ truncated');
  assert.doesNotThrow(() => memory.recall({ ...env, query: 'commit' }));
  assert.doesNotThrow(() => memory.remember({ ...env, text: 'Another fact after corruption' }));
  assert.throws(() => memory.remember({ ...env, text: '   ' }), /text required/);
});

test('MCP failure: a failed or malformed probe is unknown or not configured, never a claim that servers work', () => {
  const state = raw => CHECKS.mcp(raw, NOW)[0].state;
  assert.equal(state(null), 'unknown');
  assert.equal(state(undefined), 'unknown');
  assert.equal(state({ servers: 'oops' }), 'not-configured');
  assert.equal(state({}), 'not-configured');
  assert.notEqual(state({ servers: ['a'] }), 'healthy');
  assert.match(CHECKS.mcp({ servers: ['a'] }, NOW)[0].detail, /not connected/);
});

const rel = (tag, extra = {}) => ({ tag_name: tag, html_url: 'https://gh.invalid/' + tag, body: '', assets: [], ...extra });
function updater(fetch) {
  const dir = mkdir(), sent = [];
  const u = createUpdater({ send: (ch, s) => sent.push(s), historyFile: path.join(dir, 'h.json'), currentVersion: '2.0.0', fetch, downloadDir: dir,
    target: { platform: 'win32', arch: 'x64', kind: 'msi' }, getSettings: () => ({}) });
  return { u, dir, sent, last: () => sent[sent.length - 1] };
}

test('updater: network down reports the real error and offers nothing', async () => {
  const h = updater(async () => { throw new Error('getaddrinfo ENOTFOUND api.github.com'); });
  await h.u.check();
  assert.equal(h.last().state, 'error');
  assert.match(h.last().message, /ENOTFOUND/);
  assert.equal(h.u.ready, null);
  assert.deepEqual(fs.readdirSync(h.dir).filter(f => f !== 'h.json'), []);
});

test('updater: a timeout, bad credentials and a rate limit each say what happened', async () => {
  const cases = [[() => { throw new Error('The operation timed out'); }, /timed out/], [() => new Response('{}', { status: 401 }), /401/], [() => new Response('{}', { status: 403 }), /403/], [() => new Response('{}', { status: 429 }), /429/]];
  for (const [res, re] of cases) {
    const h = updater(async () => res());
    await h.u.check();
    assert.equal(h.last().state, 'error');
    assert.match(h.last().message, re);
    assert.equal(h.u.ready, null);
  }
});

test('updater: a malformed response is an error, not a phantom update', async () => {
  for (const body of ['<html>gateway</html>', '{}', 'null', '[]']) {
    const h = updater(async () => new Response(body));
    await h.u.check();
    assert.equal(h.last().state, 'error', body);
    assert.equal(h.u.ready, null);
  }
  const h = updater(async () => new Response(JSON.stringify(rel('2.0.1'))));
  await h.u.check();
  assert.equal(h.last().state, 'error');
  assert.match(h.last().message, /no installer/);
});

test('updater: a failed check can be retried and then succeeds', async () => {
  let up = false;
  const h = updater(async () => { if (!up) throw new Error('offline'); return new Response(JSON.stringify(rel('2.0.0'))); });
  await h.u.check();
  assert.equal(h.last().state, 'error');
  up = true;
  await h.u.check();
  assert.equal(h.last().state, 'current');
});
