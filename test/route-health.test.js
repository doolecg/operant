const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize, asHealth, HALF_LIFE_MS } = require('../route-health');

const NOW = 1e12, MIN = 60e3, H = 3600e3;
const ok = (key, ago, latencyMs = 1000) => ({ key, t: NOW - ago, ok: true, latencyMs });
const bad = (key, ago, kind) => ({ key, t: NOW - ago, ok: false, kind });

test('availability, error and rate-limit rates and latency per key', () => {
  const s = summarize([ok('a', 1 * MIN, 1000), ok('a', 2 * MIN, 3000), bad('a', 3 * MIN, 'timeout'), bad('b', 1 * MIN, 'rate-limit')], NOW);
  assert.ok(s.a.availability > 0.6 && s.a.availability < 0.7);
  assert.ok(s.a.timeoutRate > 0.3 && s.a.timeoutRate < 0.4);
  assert.ok(Math.abs(s.a.avgLatencyMs - 2000) < 50);
  assert.equal(s.b.rateLimitRate, 1);
  assert.equal(s.a.down, null);
});

test('a fresh failure marks the key down with a reason until its hold-off ends', () => {
  const s = summarize([bad('m', 2 * MIN, 'rate-limit')], NOW);
  assert.equal(s.m.down.kind, 'rate-limit');
  assert.match(s.m.down.reason, /rate limited 2 min ago/);
  assert.equal(asHealth(s, () => NOW).down('m').kind, 'busy');
  assert.equal(asHealth(s, () => NOW + 11 * MIN).down('m'), null);
  assert.equal(asHealth(summarize([bad('m', MIN, 'auth')], NOW), () => NOW).down('m').kind, 'unavailable');
});

test('a later success clears it; an old outage does not poison the score', () => {
  assert.equal(summarize([bad('m', 5 * MIN, 'timeout'), ok('m', 1 * MIN)], NOW).m.down, null);
  const oldOutage = Array.from({ length: 10 }, (_, i) => bad('m', 48 * H + i * MIN, 'timeout'));
  const old = summarize([...oldOutage, ok('m', 20 * MIN), ok('m', 10 * MIN)], NOW).m;
  assert.equal(old.down, null);
  assert.ok(old.errorRate < 0.05, `error rate ${old.errorRate}`);
  const recentOutage = Array.from({ length: 10 }, (_, i) => bad('m', 40 * MIN + i * MIN, 'timeout'));
  const fresh = summarize([...recentOutage, ok('m', 20 * MIN), ok('m', 10 * MIN)], NOW).m;
  assert.ok(fresh.errorRate > old.errorRate);
  assert.ok(HALF_LIFE_MS > 0);
});

test('bad rows are ignored', () => {
  assert.deepEqual(summarize([null, { t: 1 }, { key: 'x' }], NOW), {});
});
