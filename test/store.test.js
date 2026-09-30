const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openStore, feedOutcome, corrOf, MIGRATIONS, TABLES } = require('../store');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'op-store-'));
const DAY = 86400e3;

test('opening creates the tables and records the schema version; reopening migrates nothing', () => {
  const dir = tmp();
  const a = openStore(dir);
  assert.equal(a.version(), MIGRATIONS.length);
  assert.deepEqual(a.migrated, [1]);
  for (const t of TABLES) assert.ok(fs.existsSync(path.join(dir, t + '.jsonl')));
  const b = openStore(dir);
  assert.deepEqual(b.migrated, []);
});

test('migrations run in order at open and rewrite existing rows', () => {
  const dir = tmp();
  openStore(dir).append('taskRuns', { project: 'p', taskId: 1, status: 'done' });
  const v2 = ctx => ctx.write('taskRuns', ctx.read('taskRuns').map(r => ({ ...r, outcome: r.status })));
  const s = openStore(dir, { migrations: [...MIGRATIONS, v2] });
  assert.deepEqual(s.migrated, [2]);
  assert.equal(s.query('taskRuns')[0].outcome, 'done');
  assert.throws(() => openStore(dir, { migrations: MIGRATIONS }), /newer than this Operant/);
});

test('rows are scoped by project and correlation id', () => {
  const s = openStore(tmp());
  s.append('taskRuns', { project: 'a', corr: 'a:1' });
  s.append('taskRuns', { project: 'b', corr: 'b:1' });
  assert.equal(s.query('taskRuns', { project: 'a' }).length, 1);
  assert.equal(s.query('taskRuns', { corr: 'b:1' })[0].project, 'b');
  assert.throws(() => s.append('nope', {}), /unknown table/);
});

test('retention drops rows older than the window at open (default 90 days)', () => {
  const dir = tmp();
  const now = 200 * DAY;
  const s = openStore(dir, { now: () => now });
  s.append('failures', { t: now - 100 * DAY, kind: 'old' });
  s.append('failures', { t: now - 10 * DAY, kind: 'new' });
  const again = openStore(dir, { now: () => now });
  assert.equal(again.pruned, 1);
  assert.deepEqual(again.query('failures').map(r => r.kind), ['new']);
  assert.equal(openStore(dir, { now: () => now, keepMs: 5 * DAY }).count('failures'), 0);
});

test('an outcome feeds task, model, token, tool, verification, failure and provider rows under one correlation id', () => {
  const s = openStore(tmp());
  const f = feedOutcome(s, { t: Date.now(), project: 'Operant', taskId: 7, workerId: 23, type: 'fix', tier: 'small', agent: 'claude', model: 'claude-haiku-4-5', status: 'failed', reason: 'tests failed: 2 failing', attempts: 1, durationMs: 5000, tokens: { input: 10, output: 5 }, codegraph: { codegraphCalls: 3, firstAction: 'codegraph' }, check: { ok: false, command: 'npm test' } });
  assert.equal(f.kind, 'test-failure');
  const corr = corrOf('Operant', 7);
  for (const t of ['taskRuns', 'modelRuns', 'tokenEvents', 'toolCalls', 'verificationRuns', 'failures', 'providerCalls']) assert.equal(s.query(t, { corr }).length, 1, t);
  assert.equal(s.query('providerCalls')[0].ok, true, 'a failing test is not a provider outage');
  feedOutcome(s, { t: Date.now(), project: 'Operant', taskId: 8, model: 'm', agent: 'claude', status: 'failed', reason: '429 too many requests', durationMs: 10 });
  const p = s.query('providerCalls', { corr: corrOf('Operant', 8) })[0];
  assert.deepEqual([p.ok, p.kind], [false, 'rate-limit']);
  assert.equal(feedOutcome(s, { kind: 'orchestration', taskId: 9 }), null);
  assert.equal(feedOutcome(s, { t: 1, project: 'x', taskId: 1, status: 'done', model: 'm' }), null);
});

test('decision rows keep inputs, alternatives and strategy linked task -> worker -> result', () => {
  const s = openStore(tmp());
  const corr = corrOf('Operant', 7);
  s.append('routingDecisions', { corr, project: 'Operant', taskId: 7, workerId: 23, inputs: { type: 'fix' }, alternatives: [{ tier: 'small', n: 6 }], strategy: { basis: 'outcomes', tier: 'small' } });
  feedOutcome(s, { t: Date.now(), project: 'Operant', taskId: 7, workerId: 23, status: 'done', model: 'm' });
  const d = s.query('routingDecisions', { corr })[0], r = s.query('taskRuns', { corr })[0];
  assert.equal(d.workerId, r.workerId);
  assert.equal(d.strategy.basis, 'outcomes');
});
