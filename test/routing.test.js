const test = require('node:test');
const assert = require('node:assert/strict');
const { route, signals, signalLine } = require('../routing');

const tiers = ['xsmall', 'small', 'medium', 'high'];
const fallback = { tier: 'small', reason: 'short prompt' };
const cell = (passed, failed = 0, escalated = 0, avgUsd = 0.5) => ({ n: passed + failed + escalated, passed, failed, escalated, avgUsd, avgTokens: 1 });
const go = (stats, extra = {}) => route({ prompt: 'fix the login bug', tiers, stats, counter: 0, fallback, ...extra });

test('cheapest proven tier wins', () => {
  const r = go({ fix: { xsmall: cell(2, 3), small: cell(5, 1, 0, 0.123), medium: cell(9) } });
  assert.deepEqual(r, { tier: 'small', basis: 'outcomes', reason: 'small: 5/6 fix tasks passed, $0.12 avg' });
});

test('unknown cost reads as unknown', () => {
  assert.match(go({ fix: { xsmall: cell(5, 0, 0, null) } }).reason, /\unknown avg/);
});

test('every tenth decision tries the tier below the proven one', () => {
  const stats = { fix: { small: cell(6), medium: cell(6) } };
  const r = go(stats, { counter: 9 });
  assert.equal(r.tier, 'xsmall');
  assert.equal(r.basis, 'exploration');
  assert.match(r.reason, /^trying xsmall \(1 in 10.*small is proven\)$/);
  assert.equal(go(stats, { counter: 8 }).tier, 'small');
  assert.equal(go({ fix: { xsmall: cell(6) } }, { counter: 9 }).tier, 'xsmall');
});

test('all tiers with data failing: one tier above the most expensive failing one', () => {
  const r = go({ fix: { xsmall: cell(1, 4), small: cell(2, 3) } });
  assert.deepEqual(r, { tier: 'medium', basis: 'outcomes', reason: 'medium: small passed only 2/5 fix tasks' });
});

test('a failing top tier stays at the top tier', () => {
  assert.equal(go({ fix: { high: cell(1, 5) } }).tier, 'high');
});

test('blocked counts as a failure, escalated as a non-pass', () => {
  assert.equal(go({ fix: { xsmall: cell(4, 1), small: cell(5) } }).tier, 'xsmall');
  assert.equal(go({ fix: { xsmall: cell(4, 0, 1), small: cell(5) } }).tier, 'xsmall');
  assert.equal(go({ fix: { xsmall: cell(3, 2), small: cell(5) } }).tier, 'small');
});

test('too little data falls back to the keyword suggestion', () => {
  const r = go({ fix: { xsmall: cell(2, 1) } });
  assert.deepEqual(r, { tier: 'small', basis: 'insufficient data', reason: 'insufficient data for fix tasks (3 recorded); short prompt' });
  assert.equal(go({}).tier, 'small');
});

test('never returns a tier outside the given ones', () => {
  const r = route({ prompt: 'fix it', tiers: ['xsmall', 'small'], stats: { fix: { medium: cell(9), small: cell(0, 5) } }, counter: 0, fallback });
  assert.equal(r.tier, 'small');
});

test('signals suggest a higher tier for risk, ambiguity, failed checks and weak context; they change nothing', () => {
  const task = { id: 1, text: 'maybe drop the old users table', check: { ok: false, command: 'npm test' } };
  const copy = JSON.stringify(task);
  const s = signals(task, { confidence: 0.3, deps: 7, contextPct: 90 });
  assert.deepEqual(s.up.map(x => x.id), ['low-confidence', 'high-risk', 'big-graph', 'ambiguity', 'failed-verification', 'insufficient-context']);
  assert.deepEqual(s.down, []);
  assert.equal(JSON.stringify(task), copy);
  assert.match(signalLine(s), /^consider a higher tier: low confidence/);
});

test('signals suggest a lower tier only for simple, low-risk, small tasks', () => {
  const s = signals({ id: 2, text: 'rename foo to bar' }, { contextTokens: 2000 });
  assert.deepEqual(s.up, []);
  assert.deepEqual(s.down.map(x => x.id), ['simple', 'low-risk', 'small-context']);
  assert.deepEqual(signals({ id: 3, text: 'rename foo', changes: [{}] }, {}).down, []);
  assert.equal(signalLine({ up: [], down: [] }), '');
});
