const test = require('node:test');
const assert = require('node:assert/strict');
const { route, signals, signalLine } = require('../routing');

const tiers = ['xsmall', 'small', 'medium', 'high'];
const fallback = { tier: 'small', reason: 'short prompt' };
const cell = (passed, failed = 0, escalated = 0, avgUsd = 0.5) => ({ n: passed + failed + escalated, passed, failed, escalated, avgUsd, avgTokens: 1 });
const go = (stats, extra = {}) => route({ prompt: 'fix the login bug', tiers, stats, counter: 0, fallback, ...extra });

test('cheapest proven tier wins', () => {
  const r = go({ fix: { xsmall: cell(2, 3), small: cell(5, 1, 0, 0.123), medium: cell(9) } });
  assert.deepEqual({ tier: r.tier, basis: r.basis, reason: r.reason }, { tier: 'small', basis: 'outcomes', reason: 'small: 5/6 fix tasks passed, $0.12 avg' });
  assert.deepEqual(r.alternatives.map(a => a.tier), tiers);
  assert.deepEqual(r.skipped, []);
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
  assert.deepEqual({ tier: r.tier, basis: r.basis, reason: r.reason }, { tier: 'medium', basis: 'outcomes', reason: 'medium: small passed only 2/5 fix tasks' });
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
  assert.deepEqual({ tier: r.tier, basis: r.basis, reason: r.reason }, { tier: 'small', basis: 'insufficient data', reason: 'insufficient data for fix tasks (3 recorded); short prompt' });
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

test('a tier whose route is known down is skipped with the reason, never picked', () => {
  const stats = { fix: { small: cell(6), medium: cell(6) } };
  const health = { down: k => (k === 'm-small' ? { reason: 'was rate limited 2 min ago' } : null) };
  const r = go(stats, { health, modelOf: n => 'm-' + n });
  assert.equal(r.tier, 'medium');
  assert.equal(r.basis, 'health');
  assert.match(r.reason, /small was rate limited 2 min ago, skipped/);
  assert.deepEqual(r.skipped, [{ tier: 'small', reason: 'was rate limited 2 min ago' }]);
});

test('every route down: stays on the pick and says so', () => {
  const r = go({ fix: { small: cell(6) } }, { health: { down: () => ({ reason: 'timed out' }) }, modelOf: n => n });
  assert.equal(r.tier, 'small');
  assert.match(r.reason, /every tier's route is down/);
});

// ---- expected utility (2.5)
const { decide } = require('../routing');
const NOW = 1e12, DAYMS = 86400e3;
const runsOf = (tier, n, okN, extra = {}) => Array.from({ length: n }, (_, i) => ({ t: NOW - 1000, type: 'fix', tier, status: i < okN ? 'done' : 'failed', usd: 0.05, durationMs: 60e3, project: 'P', ...extra }));
const pick = (runs, extra = {}) => decide({ prompt: 'fix the login bug', tiers, runs, project: 'P', now: NOW, counter: 0, fallback, ...extra });

test('thin evidence (under 5 tasks per tier) takes the keyword fallback, with the structured reason', () => {
  const r = pick(runsOf('xsmall', 4, 4));
  assert.deepEqual({ tier: r.tier, basis: r.basis }, { tier: 'small', basis: 'insufficient data' });
  assert.equal(r.detail.chosen.evidence, false);
  assert.equal(r.detail.risk, 'low');
  assert.equal(r.alternatives.length, 4);
});

test('a cheap tier with 5+ good tasks beats dearer tiers on utility, and the runner-up is stored', () => {
  const r = pick([...runsOf('xsmall', 6, 6), ...runsOf('medium', 6, 6, { usd: 0.8, durationMs: 300e3 })]);
  assert.equal(r.tier, 'xsmall');
  assert.equal(r.basis, 'utility');
  assert.equal(r.detail.chosen.n, 6);
  assert.ok(r.rejected.tier && r.rejected.utility <= r.detail.chosen.utility && /lower utility/.test(r.rejected.why));
  assert.deepEqual(r.detail.rejected, r.rejected);
});

test('a failing cheap tier loses to a proven dearer one', () => {
  const r = pick([...runsOf('xsmall', 6, 1), ...runsOf('small', 6, 6, { usd: 0.2 })]);
  assert.equal(r.tier, 'small');
});

test('old outcomes decay: last month failures count for less than this week passes', () => {
  const old = runsOf('xsmall', 6, 0, { t: NOW - 120 * DAYMS }), fresh = runsOf('xsmall', 6, 6);
  const e = require('../routing').tierEvidence([...old, ...fresh], { type: 'fix', tiers: ['xsmall'], project: 'P', now: NOW })[0];
  assert.ok(e.rate > 0.99, `rate ${e.rate}`);
  const ev2 = require('../routing').tierEvidence(old, { type: 'fix', tiers: ['xsmall'], project: 'P', now: NOW })[0];
  assert.equal(ev2.rate, 0);
});

test('a project uses its own record once it has 5 tasks, else the pooled one', () => {
  const rows = [...runsOf('small', 5, 0, { project: 'P' }), ...runsOf('small', 6, 6, { project: 'Q' })];
  const t = require('../routing').tierEvidence;
  assert.equal(t(rows, { type: 'fix', tiers: ['small'], project: 'P', now: NOW })[0].scope, 'project');
  assert.equal(t(rows, { type: 'fix', tiers: ['small'], project: 'Z', now: NOW })[0].scope, 'all projects');
});

test('never explores on high-risk work; explores 1 in 10 otherwise', () => {
  const runs = [...runsOf('small', 6, 6), ...runsOf('medium', 6, 6, { usd: 0.9 })];
  const calm = { prompt: 'fix the login bug', counter: 9 };
  assert.equal(pick(runs, calm).basis, 'exploration');
  assert.equal(pick(runs, calm).tier, 'xsmall');
  const risky = pick(runs, { prompt: 'fix the production migration', counter: 9 });
  assert.notEqual(risky.basis, 'exploration');
  assert.equal(risky.detail.risk, 'high');
});

test('an override wins while live, only within the allowed tiers; expired or unallowed ones are ignored', () => {
  const runs = runsOf('small', 6, 6);
  assert.equal(pick(runs, { overrides: [{ tier: 'medium', project: 'P', until: NOW + 1000 }] }).tier, 'medium');
  assert.equal(pick(runs, { overrides: [{ tier: 'medium', project: 'P', until: NOW + 1000 }] }).basis, 'override');
  assert.notEqual(pick(runs, { overrides: [{ tier: 'medium', project: 'P', until: NOW - 1 }] }).basis, 'override');
  assert.notEqual(pick(runs, { overrides: [{ tier: 'max' }] }).basis, 'override');
  assert.equal(pick(runs, { overrides: [{ tier: 'high' }, { tier: 'medium', project: 'P' }] }).tier, 'medium');
  assert.equal(pick(runs, { overrides: [{ tier: 'high', project: 'Other' }] }).basis === 'override', false);
});

test('never moves a task above the tier it already runs on', () => {
  const runs = [...runsOf('xsmall', 6, 0), ...runsOf('small', 6, 0), ...runsOf('medium', 6, 6)];
  assert.equal(pick(runs).tier, 'medium');
  const r = pick(runs, { current: 'small', overrides: [{ tier: 'high' }] });
  assert.ok(['xsmall', 'small'].includes(r.tier));
  assert.equal(route({ prompt: 'fix it', tiers, runs, project: 'P', now: NOW, fallback, current: 'small', health: { down: k => (k === 'm-small' ? { reason: 'timed out' } : null) }, modelOf: n => 'm-' + n }).tier, 'xsmall');
});

test('route() with runs uses utility and still skips a route known down', () => {
  const runs = [...runsOf('small', 6, 6), ...runsOf('medium', 6, 6, { usd: 0.9 })];
  const r = route({ prompt: 'fix the login bug', tiers, runs, project: 'P', now: NOW, fallback, health: { down: k => (k === 'm-small' ? { reason: 'timed out' } : null) }, modelOf: n => 'm-' + n });
  assert.equal(r.basis, 'health');
  assert.equal(r.skipped[0].tier, 'small');
  assert.ok(r.detail && r.alternatives.length === 4);
});

test('withOverride replaces the same scope, keeps others, drops expired, and can clear', () => {
  const { withOverride } = require('../routing');
  let l = withOverride([], { tier: 'small' }, NOW);
  l = withOverride(l, { tier: 'medium', project: 'P', hours: 2 }, NOW);
  l = withOverride(l, { tier: 'high' }, NOW);
  assert.deepEqual(l.map(o => [o.tier, o.project || null, o.until || null]), [['medium', 'P', NOW + 7200e3], ['high', null, null]]);
  assert.deepEqual(withOverride(l, { project: 'P' }, NOW).map(o => o.tier), ['high']);
  assert.deepEqual(withOverride(l, { project: 'P' }, NOW + 9e6).map(o => o.tier), ['high']);
});
