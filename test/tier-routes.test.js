// Tier routes: a tier lists fallback routes; each skipped route keeps its reason. No app, no network:
// failures are faked per reason (busy, out of free use, failed this kind of task before, not set up).
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../tier-routes');
const { mergeUser, migrate, validatePatch, CURRENT } = require('../config-migrate');
const { summarizeRoutes, summarizeRouteUse } = require('../outcomes');
const { opencodeTiers, tiersByMode } = require('../team-tiers');

const BP = 'opencode/big-pickle';
const HAIKU = 'claude-haiku-4-5';
const free = { agent: 'opencode', model: BP, fallbacks: [{ local: true }], use: 'easy' };
const xsmall = { agent: 'opencode', model: BP, fallbacks: [{ agent: 'claude', model: HAIKU }], use: 'small' };
const small = { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' };
const tiers = { free, xsmall, small };
const downBP = text => { const h = R.createHealth(); h.fail(BP, text); return h; };

test('labels: Big Pickle, Haiku 4.5, the local model', () => {
  assert.equal(R.labelOf({ model: BP }), 'Big Pickle');
  assert.equal(R.labelOf({ model: HAIKU }), 'Haiku 4.5');
  assert.equal(R.labelOf({ model: 'claude-opus-5-5' }), 'Opus 5.5');
  assert.equal(R.labelOf({ model: 'ollama/gemma4:e4b' }), 'gemma4 (local)');
});

test('failure text is sorted into busy, out of free use, or not a route problem', () => {
  for (const s of ['429 Too Many Requests', 'Model is overloaded', 'request timed out', '503']) assert.equal(R.classifyFailure(s), 'busy', s);
  for (const s of ['free usage limit reached', 'quota exhausted', 'insufficient credits']) assert.equal(R.classifyFailure(s), 'quota', s);
  for (const s of ['', 'syntax error in file', 'permission denied']) assert.equal(R.classifyFailure(s), null, s);
  // OpenAI (Codex) and Gemini: a used-up plan or day's quota is quota even with a 429; a per-minute limit is busy.
  for (const s of ['You exceeded your current quota, please check your plan and billing details (429)', 'insufficient_quota',
    "You've hit your usage limit. Upgrade or try again in 3 hours", 'RESOURCE_EXHAUSTED: Quota exceeded for quota metric requests per day per user']) assert.equal(R.classifyFailure(s), 'quota', s);
  for (const s of ['429 RESOURCE_EXHAUSTED: requests per minute', 'stream error: 500 server_error', 'The model is overloaded. Please try again later. (503)']) assert.equal(R.classifyFailure(s), 'busy', s);
});

test('all routes healthy: the first one runs, and says so', () => {
  const t = R.resolve(xsmall, { health: R.createHealth() });
  assert.equal(t.model, BP);
  assert.equal(t.route.note, 'Big Pickle, free');
  assert.equal(t.route.primary, true);
  assert.deepEqual(t.skipped, []);
  assert.equal(t.fallback, undefined);
  assert.equal(R.resolve(small, {}).route.note, 'Sonnet 5.5', 'a paid single route is just its name');
});

test('fallback reason: busy -> Haiku, and the tile says why', () => {
  const t = R.resolve(xsmall, { health: downBP('429 rate limit') });
  assert.equal(t.model, HAIKU);
  assert.equal(t.agent, 'claude');
  assert.equal(t.route.note, 'Haiku 4.5, Big Pickle was busy');
  assert.match(t.fallback, /^Big Pickle: 429/);
  assert.equal(t.active, 'Haiku 4.5');
  assert.equal(t.route.free, false);
  assert.deepEqual(t.skipped.map(s => s.kind), ['busy']);
});

test('fallback reason: out of free use', () => {
  const t = R.resolve(xsmall, { health: downBP('free usage limit reached') });
  assert.equal(t.route.note, 'Haiku 4.5, Big Pickle was out of free use');
  assert.equal(t.skipped[0].kind, 'quota');
});

test('fallback reason: this kind of task failed on the route before', () => {
  const stats = { docs: { [BP]: { n: 6, passed: 1 } }, tests: { [BP]: { n: 6, passed: 6 } } };
  const t = R.resolve(xsmall, { health: R.createHealth(), stats, type: 'docs' });
  assert.equal(t.model, HAIKU);
  assert.equal(t.route.note, 'Haiku 4.5, Big Pickle failed this kind of task before');
  assert.equal(R.resolve(xsmall, { stats, type: 'tests' }).model, BP, 'another task type still goes to Big Pickle');
  assert.equal(R.resolve(xsmall, { stats: { docs: { [BP]: { n: 4, passed: 0 } } }, type: 'docs' }).model, BP, 'too few tries to judge');
  assert.equal(R.resolve(xsmall, { stats: { docs: { [HAIKU]: { n: 9, passed: 0 } } }, type: 'docs' }).model, BP, 'a failing later route does not move the first');
});

test('the last route is never skipped by learning, and nothing usable stays on the first', () => {
  const stats = { docs: { [BP]: { n: 9, passed: 0 }, [HAIKU]: { n: 9, passed: 0 } } };
  assert.equal(R.resolve(xsmall, { stats, type: 'docs' }).model, HAIKU);
  const h = R.createHealth();
  h.fail(BP, '429'); h.fail(HAIKU, '529 overloaded');
  assert.equal(R.resolve(xsmall, { health: h }).model, BP, 'all routes down: keep trying the first');
});

test('the free tier goes to the local model only when it is ready, silently Big Pickle otherwise', () => {
  const h = downBP('rate limit exceeded');
  const ctx = ready => ({ health: h, localModel: 'gemma4:e4b', ready: r => (r.local ? ready : true) });
  const on = R.resolve(free, ctx(true));
  assert.equal(on.model, 'ollama/gemma4:e4b');
  assert.equal(on.route.note, 'gemma4 (local), Big Pickle was busy');
  assert.match(on.active, /^local \(gemma4:e4b\)/);
  const off = R.resolve(free, ctx(false));
  assert.equal(off.model, BP);
  assert.equal(off.fallback, undefined);
});

test('routes come back after the cooldown', () => {
  let now = 0;
  const h = R.createHealth({ now: () => now, cooldownMs: 1000 });
  h.fail(BP, '429');
  assert.equal(R.resolve(xsmall, { health: h }).model, HAIKU);
  assert.equal(h.nextRetry(), 1000);
  now = 1500;
  assert.equal(R.resolve(xsmall, { health: h }).model, BP);
  assert.equal(h.nextRetry(), null);
});

test('overlay resolves every tier and every per-mode result; forTask re-picks a resolved tier', () => {
  const h = downBP('503');
  const o = R.overlay(tiers, { health: h, localModel: 'm', ready: r => !r.local });
  assert.equal(o.free.model, BP, 'no ready local route: stays on Big Pickle');
  assert.equal(o.xsmall.model, HAIKU);
  assert.equal(o.small.model, 'claude-sonnet-5-5');
  assert.equal(R.overlayModes({ claude: { tiers, removed: [], empty: false } }, { health: h }).claude.tiers.xsmall.model, HAIKU);
  const fresh = R.overlay(tiers, { health: R.createHealth() });
  assert.equal(R.forTask(fresh.xsmall, { docs: { [BP]: { n: 5, passed: 0 } } }, 'docs').model, HAIKU);
  assert.equal(R.forTask(fresh.xsmall, {}, 'docs').model, BP);
  assert.equal(R.forTask(R.overlay(tiers, { health: h }).xsmall, {}, 'docs').model, HAIKU, 'a health skip survives the per-task pick');
});

test('a Claude team runs xsmall on its Claude route and has no OpenCode free tier', () => {
  const agents = [{ id: 'claude', command: 'claude' }, { id: 'opencode', command: 'opencode' }];
  const r = tiersByMode({ base: tiers, agents }).claude;
  assert.equal(r.tiers.xsmall.model, HAIKU);
  assert.equal(r.tiers.xsmall.agent, 'claude');
  assert.equal(r.tiers.free, undefined);
  assert.equal(r.tiers.small.model, 'claude-sonnet-5-5');
  assert.ok(R.routesOf(r.tiers.xsmall).every(x => x.agent === 'claude'), 'no route on another CLI');
});

test('OpenCode as the default agent still has a free tier and keeps its local fallback', () => {
  const t = opencodeTiers([], { free, xsmall, small }, 'opencode');
  assert.equal(t.free.model, BP);
  assert.deepEqual(t.free.fallbacks, [{ local: true }]);
  assert.equal(t.xsmall.fallbacks, undefined, 'a Claude-only fallback is not carried to OpenCode');
});

test('config migration: a paid xsmall is not offered Big Pickle (another CLI), and a saved offer is dropped', () => {
  assert.ok(CURRENT >= 5);
  const saved = { configVersion: 3, team: { tiers: { xsmall: { agent: 'claude', model: HAIKU, use: 'x' } } } };
  const m = migrate(saved);
  assert.equal(m.user.tierOffers, undefined);
  assert.equal(m.user.team.tiers.xsmall.model, HAIKU, 'nothing switched');
  assert.equal(migrate({ configVersion: 4, tierOffers: ['use-big-pickle'] }).user.tierOffers, undefined);
  assert.equal(R.useBigPickle, undefined);
});

test('saved tiers keep the new free tier from the defaults, ahead of xsmall', () => {
  const defaults = { team: { tiers: { free, xsmall, small }, budgets: { free: 1, xsmall: 2 } }, localModel: {}, backups: {} };
  const merged = mergeUser(defaults, { team: { tiers: { xsmall: { agent: 'claude', model: HAIKU } } } }, {});
  assert.deepEqual(Object.keys(merged.team.tiers), ['free', 'xsmall', 'small']);
  assert.equal(merged.team.budgets.free, 1);
});

test('settings: fallbacks are validated', () => {
  const agents = [{ id: 'claude', name: 'c', command: 'claude' }, { id: 'opencode', name: 'o', command: 'opencode' }];
  const defaults = { team: { tiers: { xsmall }, budgets: {} }, agents };
  const opts = { current: defaults };
  assert.deepEqual(validatePatch({ team: { tiers: { xsmall } } }, defaults, opts), []);
  assert.equal(validatePatch({ team: { tiers: { xsmall: { ...xsmall, fallbacks: 'haiku' } } } }, defaults, opts).length, 1);
  assert.equal(validatePatch({ team: { tiers: { xsmall: { ...xsmall, fallbacks: [{ agent: 'nope', model: 'm' }] } } } }, defaults, opts).length, 1);
});

test('outcomes: per route results for learning, and this week\'s use with cost saved and reasons', () => {
  const e = o => ({ t: 1, type: 'docs', tier: 'xsmall', model: BP, status: 'done', tokens: { input: 1e6, output: 0, cacheWrite: 0, cacheRead: 0 }, usd: 0, ...o });
  const list = [e({}), e({ status: 'failed' }), e({ model: HAIKU, route: 'Haiku 4.5', routeWhy: 'Big Pickle was busy', usd: 1 }), e({ kind: 'orchestration' })];
  assert.deepEqual(summarizeRoutes(list), { docs: { [BP]: { n: 2, passed: 1 }, [HAIKU]: { n: 1, passed: 1 } } });
  const price = (m, t) => ({ usd: m === HAIKU ? t.input / 1e6 : 0 });
  const use = summarizeRouteUse(list, price, { xsmall: HAIKU }).xsmall;
  const bp = use.find(r => r.route === 'Big Pickle'), hk = use.find(r => r.route === 'Haiku 4.5');
  assert.equal(bp.tasks, 2); assert.equal(bp.free, true); assert.equal(bp.savedUsd, 2); assert.equal(bp.tokens, 2e6);
  assert.equal(hk.tasks, 1); assert.equal(hk.savedUsd, 0); assert.equal(hk.usd, 1); assert.deepEqual(hk.why, { 'Big Pickle was busy': 1 });
});

test('a route the recorded health says is down is skipped with the reason', () => {
  const RouteHealth = require('../route-health');
  const tier = { agent: 'claude', model: 'm1', fallbacks: [{ model: 'm2' }] };
  const conf = R.resolve(tier, {});
  const snap = RouteHealth.summarize([{ key: 'm1', t: Date.now() - 60e3, ok: false, kind: 'rate-limit' }]);
  const r = R.forTask(conf, {}, 'fix', RouteHealth.asHealth(snap));
  assert.equal(r.model, 'm2');
  assert.match(r.skipped[0].reason, /rate limited/);
});
