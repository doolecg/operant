const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize, formatStats } = require('../analytics');

const T = 1e12;
const tables = () => ({
  taskRuns: [
    { corr: 'p:1', t: T, type: 'fix', tier: 'small', model: 'm-small', status: 'done', attempts: 1, escalations: 0, durationMs: 60e3 },
    { corr: 'p:2', t: T + 1, type: 'fix', tier: 'small', model: 'm-small', status: 'failed', attempts: 3, escalations: 1, durationMs: 120e3 },
    { corr: 'p:3', t: T + 2, type: 'docs', tier: 'xsmall', model: 'm-x', status: 'done', attempts: 1, escalations: 0, durationMs: 30e3 },
  ],
  modelRuns: [{ corr: 'p:1', t: T, usd: 0.1 }, { corr: 'p:2', t: T + 1, usd: 0.3 }, { corr: 'p:3', t: T + 2, usd: 0 }],
  tokenEvents: [
    { corr: 'p:1', t: T, tier: 'small', input: 100, output: 50, cacheRead: 1000, cacheWrite: 0 },
    { corr: 'p:2', t: T + 1, tier: 'small', input: 400, output: 100, cacheRead: 500, cacheWrite: 0 },
    { corr: 'p:3', t: T + 2, tier: 'xsmall', input: 10, output: 10, cacheRead: 0, cacheWrite: 0 },
  ],
  providerCalls: [{ provider: 'claude', ok: true, latencyMs: 1000 }, { provider: 'claude', ok: false, kind: 'rate-limit' }],
  failures: [{ kind: 'test-failure' }, { kind: 'test-failure' }, { kind: 'timeout' }],
  toolCalls: [{ tool: 'codegraph', calls: 4 }],
  verificationRuns: [{ ok: true }, { ok: false }],
});

test('tasks, retries, models, waste and latency', () => {
  const s = summarize(tables());
  assert.deepEqual([s.tasks.n, s.tasks.done, s.tasks.passRate, s.tasks.retries], [3, 2, 0.667, 2]);
  assert.equal(s.tasks.escalationRate, 0.333);
  const small = s.models.find(m => m.model === 'm-small');
  assert.deepEqual([small.tasks, small.usd, small.tokens, small.wastedTokens], [2, 0.4, 2150, 1000]);
  assert.equal(s.wasteful.model, 'm-small');
  assert.deepEqual(s.retryHotSpots[0], { type: 'fix', tier: 'small', tasks: 1, retries: 3 });
  assert.equal(s.latency.avgMs, 70000);
  assert.equal(s.cost.usd, 0.4);
  assert.deepEqual(s.failures[0], { kind: 'test-failure', n: 2 });
  assert.deepEqual([s.providers[0].calls, s.providers[0].errorRate], [2, 0.5]);
});

test('gross vs net tokens saved subtracts the tokens and cost of Operant itself', () => {
  const s = summarize(tables(), { orchestration: [{ tokens: { input: 200, output: 100 }, usd: 0.05 }] });
  assert.deepEqual(s.savings, { grossTokens: 1500, ownTokens: 300, netTokens: 1200 });
  assert.deepEqual([s.operant.calls, s.operant.usd], [1, 0.05]);
});

test('unused integrations: configured, tracked and not used; untracked ones are never listed', () => {
  const s = summarize(tables(), { integrations: [{ id: 'a', name: 'A', configured: true, used: false }, { id: 'b', name: 'B', configured: true, used: null }, { id: 'c', name: 'C', configured: false, used: false }, { id: 'd', name: 'D', configured: true, used: true }] });
  assert.deepEqual(s.unusedIntegrations, ['A']);
  assert.equal(s.codegraphCalls, 4);
});

test('formatStats says what it counts; an empty store says so', () => {
  const out = formatStats(summarize(tables()), { days: 30 });
  assert.match(out, /tokens saved: gross 1\.5k \(cache reads\), Operant's own 0, net 1\.5k/);
  assert.match(out, /retry hot spots: fix on small \(3 retries in 1 tasks\)/);
  assert.match(out, /wastes most tokens: m-small/);
  assert.match(formatStats(summarize({})), /no task runs recorded/);
});
