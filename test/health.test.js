// Tests for health.js: each state from probe results, the worst-state roll-up, unknown before the first check and the cache.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHealth, worst, CHECKS } = require('../health.js');

const NOW = Date.parse('2026-09-29T12:00:00Z');
const H = 3600e3;
const one = (id, raw, now = NOW) => CHECKS[id](raw, now);
const state = (id, raw) => one(id, raw)[0].state;

test('app: healthy with a version, degraded on a bad install, unknown without one', () => {
  assert.equal(state('app', { version: '2.1.0' }), 'healthy');
  assert.equal(state('app', { version: '2.1.0', installState: { ok: false, message: 'files missing' } }), 'degraded');
  assert.equal(state('app', null), 'unknown');
});

test('updates: current, available, degraded, unknown', () => {
  assert.equal(state('updates', { status: { state: 'current', checkedAt: NOW - 1000 }, history: [] }), 'healthy');
  assert.equal(state('updates', { status: { state: 'ready', version: '2.2.0', checkedAt: NOW }, history: [] }), 'available');
  assert.equal(state('updates', { status: { state: 'error', message: 'GitHub API 500', checkedAt: NOW }, history: [] }), 'degraded');
  assert.equal(state('updates', { status: { state: 'current', checkedAt: NOW }, history: [{ to: '2.0.0', result: 'failed-to-start' }] }), 'degraded');
  assert.equal(state('updates', { status: null, history: [] }), 'unknown');
  assert.equal(state('updates', null), 'unknown');
});

test('backups: off, missing, stale, failed test, healthy', () => {
  const at = h => new Date(NOW - h * H).toISOString();
  assert.equal(state('backups', { enabled: false }), 'not-configured');
  assert.equal(state('backups', { enabled: true, everyHours: 24, last: null }), 'degraded');
  assert.equal(state('backups', { enabled: true, everyHours: 24, last: { at: at(60) } }), 'degraded');
  assert.equal(state('backups', { enabled: true, everyHours: 24, last: { at: at(2) }, validated: { ok: false, at: at(1), error: 'bad file' } }), 'degraded');
  assert.equal(state('backups', { enabled: true, everyHours: 24, last: { at: at(2) }, validated: { ok: true, at: at(1) } }), 'healthy');
  assert.equal(state('backups', { enabled: true, everyHours: 24, last: { at: at(2) } }), 'healthy');
});

test('config: parsed, migrated, broken, future, migration error', () => {
  assert.equal(state('config', {}), 'healthy');
  assert.equal(state('config', { migrated: true, from: 1 }), 'healthy');
  assert.equal(state('config', { broken: true }), 'degraded');
  assert.equal(state('config', { future: true, from: 9 }), 'degraded');
  assert.equal(state('config', { error: 'x' }), 'degraded');
  assert.equal(state('config', null), 'unknown');
});

test('agents: one row each, installed / missing / not looked for yet / no command', () => {
  const rows = one('agents', { agents: [{ id: 'claude', name: 'Claude Code', command: 'claude' }, { id: 'opencode', name: 'OpenCode', command: 'opencode' }, { id: 'x', name: 'X', command: 'x' }, { id: 'e', name: 'E', command: '' }], installed: { claude: true, opencode: false } });
  assert.deepEqual(rows.map(r => r.state), ['healthy', 'unavailable', 'unknown', 'not-configured']);
  assert.equal(state('agents', null), 'unknown');
});

test('models: installed (available, not proven), fell back, none, OpenCode list unread', () => {
  const t = (name, o) => ({ name, agent: 'claude', model: 'm', installed: true, oc: false, active: { agent: 'claude', model: 'm' }, ...o });
  const rows = one('models', { modelsRead: false, tiers: [
    t('small'), t('medium', { active: { agent: 'claude', model: 'n', fallback: 'OpenCode not installed' } }), t('high', { active: null }),
    t('max', { oc: true }), t('xsmall', { installed: undefined }),
  ] });
  assert.deepEqual(rows.map(r => r.state), ['available', 'degraded', 'unavailable', 'unknown', 'unknown']);
  assert.equal(one('models', { modelsRead: true, tiers: [t('max', { oc: true })] })[0].state, 'available');
});

test('memory: readable, empty, unreadable, stale', () => {
  const rows = one('memory', { cwd: 'C:/p', project: { dir: 'a', count: 3 }, personal: { dir: 'b', missing: true } });
  assert.deepEqual(rows.map(r => r.state), ['healthy', 'not-configured']);
  assert.equal(one('memory', { cwd: 'C:/p', project: { dir: 'a', error: 'EACCES' }, personal: { dir: 'b', count: 0 } })[0].state, 'degraded');
  assert.equal(one('memory', { cwd: 'C:/p', project: { dir: 'a', count: 3, stale: 1 }, personal: { dir: 'b', count: 0 } })[0].state, 'degraded');
  assert.equal(one('memory', { cwd: '', project: null, personal: { dir: 'b', count: 0 } })[0].state, 'not-configured');
});

test('codegraph: indexed, not indexed, CLI missing, not looked for', () => {
  assert.equal(state('codegraph', { cwd: 'p', cli: '1.2.3', indexed: true }), 'healthy');
  assert.equal(state('codegraph', { cwd: 'p', cli: '1.2.3', indexed: false }), 'not-configured');
  assert.equal(state('codegraph', { cwd: 'p', cli: null, indexed: false }), 'unavailable');
  assert.equal(state('codegraph', { cwd: 'p', cli: null, indexed: true }), 'degraded');
  assert.equal(state('codegraph', { cwd: 'p', indexed: true }), 'unknown');
  assert.equal(state('codegraph', { cwd: '', cli: '1' }), 'not-configured');
});

test('mcp: servers present or absent, never connected to', () => {
  assert.equal(state('mcp', { servers: ['a', 'b'] }), 'available');
  assert.equal(state('mcp', { servers: [] }), 'not-configured');
  assert.equal(state('mcp', null), 'unknown');
});

test('analytics: sizes, none yet, unreadable', () => {
  assert.equal(state('analytics', { usage: { bytes: 5000 }, outcomes: { bytes: 100 } }), 'healthy');
  assert.equal(state('analytics', { usage: { missing: true }, outcomes: { missing: true } }), 'not-configured');
  assert.equal(state('analytics', { usage: { error: 'EACCES' }, outcomes: { bytes: 1 } }), 'degraded');
});

test('worst: roll-up order', () => {
  const r = states => states.map(s => ({ state: s }));
  assert.equal(worst(r(['healthy', 'available'])), 'available');
  assert.equal(worst(r(['healthy', 'not-configured'])), 'not-configured');
  assert.equal(worst(r(['healthy', 'unknown', 'not-configured'])), 'unknown');
  assert.equal(worst(r(['healthy', 'degraded', 'unknown'])), 'degraded');
  assert.equal(worst(r(['degraded', 'unavailable', 'unknown'])), 'unavailable');
});

test('unknown before the first check, and a missing probe stays unknown', async () => {
  const h = createHealth({ probes: { app: () => ({ version: '1' }) }, now: () => NOW });
  const before = h.peek();
  assert.equal(before.at, null);
  assert.equal(before.overall, 'unknown');
  assert.ok(before.components.every(c => c.state === 'unknown' && c.checkedAt === null));
  const after = await h.get();
  assert.equal(after.components.find(c => c.id === 'app').state, 'healthy');
  assert.equal(after.components.find(c => c.id === 'app').checkedAt, NOW);
  assert.equal(after.components.find(c => c.id === 'mcp').state, 'unknown');
  assert.equal(after.components.find(c => c.id === 'mcp').checkedAt, null);
});

test('a throwing probe becomes degraded, not healthy', async () => {
  const h = createHealth({ probes: { app: () => { throw new Error('boom'); } }, now: () => NOW });
  const r = (await h.get()).components.find(c => c.id === 'app');
  assert.equal(r.state, 'degraded');
  assert.match(r.detail, /boom/);
});

test('cache: reused within the ttl and per project, refreshed by force or after it; event on a state change', async () => {
  let t = NOW, calls = 0, ok = true, cgCalls = 0;
  const events = [];
  const h = createHealth({
    now: () => t, ttlMs: 1000, slowTtlMs: 5000, onChange: e => events.push(e.overall),
    probes: { app: () => { calls++; return ok ? { version: '1' } : null; }, codegraph: () => { cgCalls++; return { cwd: 'p', cli: '1', indexed: true }; } },
  });
  await h.get(); await h.get();
  assert.equal(calls, 1);
  await h.get({ cwd: 'other' });
  assert.equal(calls, 2);
  await h.get({ cwd: 'other' });
  assert.equal(calls, 2);
  await h.get({ force: true, cwd: 'other' });
  assert.equal(calls, 3);
  assert.equal(cgCalls, 2, 'slow probe is remembered per project even when forced');
  t += 2000;
  await h.get({ cwd: 'other' });
  assert.equal(calls, 4);
  assert.equal(events.length, 0, 'no state changed yet');
  ok = false;
  await h.get({ force: true, cwd: 'other' });
  assert.equal(events.length, 1);
  t += 6000;
  await h.get({ force: true, cwd: 'other' });
  assert.equal(cgCalls, 3, 'slow probe re-run after its ttl');
});
