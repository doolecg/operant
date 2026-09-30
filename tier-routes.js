(function () {
// Tier routes (item 96): a tier is a model, and can list fallback routes (`fallbacks`: more { agent, model, effort }
// entries, or { local: true } for the local Ollama model). A route is skipped, with the reason kept, when it was
// busy or out of free use lately (health, remembered for a cooldown) or when this kind of task kept failing on it
// (learned from outcomes). Pure; main.js owns the health instance, the renderer picks per task.
const FREE_MODEL = 'opencode/big-pickle';
const COOLDOWN_MS = 10 * 60 * 1000;
const LEARN_MIN_N = 5, LEARN_MIN_RATE = 0.5;

// Why a route was skipped: what the tile says ("Haiku 4.5, Big Pickle was busy") and what Settings lists.
const REASON_TEXT = { busy: 'was busy', quota: 'was out of free use', failed: 'failed this kind of task before', unavailable: 'is not set up' };

const QUOTA = /quota|usage limit|limit (reached|exceeded)|free (usage|tier|use)|insufficient|exhausted|out of (free )?(use|credits)/i;
const BUSY = /\b(429|502|503|504|529)\b|rate.?limit|too many requests|overload|capacity|timed? ?out|timeout|exceeded|unavailable|busy/i;
// Error text -> 'quota' (free use used up), 'busy' (rate limited, overloaded, timed out) or null (not a route problem).
function classifyFailure(text) {
  const s = String(text || '');
  if (/rate.?limit|too many requests|429/i.test(s) && !/free (usage|use|tier)/i.test(s)) return 'busy';
  if (QUOTA.test(s)) return 'quota';
  return BUSY.test(s) ? 'busy' : null;
}

const isFreeRoute = r => !!r && (r.model === FREE_MODEL || /-free$/i.test(r.model || '') || !!r.local || /^ollama\//i.test(r.model || ''));
const keyOf = r => String(r?.model || (r?.local ? 'ollama' : ''));

const NAMES = [
  [/^opencode\/big-pickle$/i, () => 'Big Pickle'],
  [/^ollama\/(.+)$/i, m => `${m[1].split(':')[0]} (local)`],
  [/claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?/i, m => `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}${m[3] != null ? '.' + m[3] : ''}`],
];
// "opencode/big-pickle" -> "Big Pickle", "claude-haiku-4-5" -> "Haiku 4.5", "ollama/gemma4:e4b" -> "gemma4 (local)"
function labelOf(route) {
  const id = String(route?.model || '');
  if (!id) return route?.local ? 'local model' : String(route?.agent || 'agent');
  for (const [re, f] of NAMES) { const m = re.exec(id); if (m) return f(m); }
  return id.split('/').pop();
}

// Remembers routes that turned work away, so a tier goes to its next route for a while, then tries again.
function createHealth({ now = Date.now, cooldownMs = COOLDOWN_MS } = {}) {
  const down = new Map();
  return {
    fail(key, text, kind) {
      const k = kind || classifyFailure(text) || 'busy';
      const d = { kind: k, reason: String(text || REASON_TEXT[k]).replace(/\s+/g, ' ').slice(0, 120), until: now() + cooldownMs };
      down.set(key, d);
      return d;
    },
    clear(key) { down.delete(key); },
    down(key) { const d = down.get(key); if (d && now() >= d.until) { down.delete(key); return null; } return d || null; },
    // The earliest time any route comes back, or null.
    nextRetry() { let t = null; for (const k of [...down.keys()]) { const d = this.down(k); if (d && (t == null || d.until < t)) t = d.until; } return t; },
  };
}

// A tier's routes in order: its own model first, then the fallbacks. The local route takes the local model's name.
function routesOf(tier, localModel) {
  if (!tier) return [];
  const own = { agent: tier.agent, model: tier.model, ...(tier.effort ? { effort: tier.effort } : {}) };
  const rest = (tier.fallbacks || []).filter(r => r && (r.model || r.local)).map(r => r.local
    ? { agent: tier.agent, model: `ollama/${localModel}`, local: true }
    : { agent: r.agent || tier.agent, model: r.model, ...(r.effort ? { effort: r.effort } : {}) });
  return [own, ...rest].map(r => ({ ...r, label: labelOf(r) }));
}

// Learned skips: outcomes.summarizeRoutes() output is { type: { model: { n, passed } } }. A route that passed under
// half of its last few tasks of this type (at least LEARN_MIN_N of them) is not used for that type.
function failedBefore(stats, type, route) {
  const c = stats?.[type]?.[keyOf(route)];
  return !!c && c.n >= LEARN_MIN_N && c.passed / c.n < LEARN_MIN_RATE;
}

// Walks the routes in order and marks each skipped one with why. A route already marked (by an earlier pick, so
// health and readiness are not asked again) keeps its mark, except a learned one, which is decided per task type.
function choose(routes, ctx) {
  const list = routes.map(r => { const { skipped, ...rest } = r; return skipped && skipped.kind !== 'failed' ? { ...rest, skipped } : rest; });
  let pick = -1;
  list.forEach((r, i) => {
    let why = r.skipped || null;
    const d = !why && ((ctx.health && ctx.health.down(keyOf(r))) || (ctx.provider && ctx.provider.down(keyOf(r))));
    if (d) why = { kind: d.kind, reason: d.reason };
    else if (!why && ctx.ready && !ctx.ready(r)) why = { kind: 'unavailable', reason: REASON_TEXT.unavailable, quiet: true };
    else if (!why && ctx.type && failedBefore(ctx.stats, ctx.type, r) && i < list.length - 1) why = { kind: 'failed', reason: `${ctx.type} tasks failed here before` };
    if (why) r.skipped = why; else if (pick < 0) pick = i;
  });
  // Nothing usable: stay on the first route and let it try again.
  if (pick < 0) pick = 0;
  const skipped = list.slice(0, pick).filter(r => r.skipped && !r.skipped.quiet).map(r => ({ label: r.label, kind: r.skipped.kind, reason: r.skipped.reason }));
  return { list, pick, skipped };
}

// The tier with the chosen route's agent/model/effort, plus
//   route: { label, free, primary, note }, routes: [{ ...route, skipped? }], skipped: [{ label, kind, reason }],
//   and, once it is not on its first route, `fallback` (why) and `active` (which one runs).
function shape(tier, { list, pick, skipped }) {
  const chosen = list[pick];
  const shown = skipped.map(s => `${s.label} ${REASON_TEXT[s.kind]}`).join('; ');
  const note = !skipped.length ? (isFreeRoute(chosen) ? `${chosen.label}, free` : chosen.label) : `${chosen.label}, ${shown}`;
  const { fallback, active, route, routes, skipped: oldSkipped, ...rest } = tier;
  const out = { ...rest, agent: chosen.agent, model: chosen.model, route: { label: chosen.label, free: isFreeRoute(chosen), primary: pick === 0, note }, routes: list, skipped };
  if (chosen.effort) out.effort = chosen.effort; else delete out.effort;
  if (skipped.length) { out.fallback = `${skipped[0].label}: ${skipped[0].reason}`; out.active = chosen.local ? `local (${chosen.model.replace(/^ollama\//, '')})` : chosen.label; }
  else if (list.length > 1) out.active = chosen.label;
  return out;
}

// Picks the route a tier runs on now. ctx: { localModel, ready(route) -> bool, health, provider, stats, type }.
function resolve(tier, ctx = {}) {
  const routes = routesOf(tier, ctx.localModel);
  return routes.length ? shape(tier, choose(routes, ctx)) : tier;
}

// A tier that is already resolved, picked again for one kind of task: a route this type failed on before is skipped.
// `provider` is the recorded health of each model (route-health.js asHealth): a route known down is skipped with the reason.
function forTask(tier, stats, type, provider) {
  if (!tier || !tier.routes || tier.routes.length < 2) return tier;
  return shape(tier, choose(tier.routes, { stats, type, provider }));
}

// Every tier with routes resolved (a tier with one route just gets its `route` note).
function overlay(tiers, ctx) {
  if (!tiers) return tiers;
  const out = {};
  for (const [name, t] of Object.entries(tiers)) out[name] = t && t.model ? resolve(t, ctx) : t;
  return out;
}
// The same for a { claude, opencode } map of per-mode results ({ tiers, removed, empty }).
function overlayModes(modes, ctx) {
  const out = {};
  for (const [k, m] of Object.entries(modes || {})) out[k] = m && m.tiers ? { ...m, tiers: overlay(m.tiers, ctx) } : m;
  return out;
}

// The one-click change offered by config-migrate.js: the tier runs Big Pickle first and keeps what it ran before as its fallback.
function useBigPickle(tier, agentId = 'opencode') {
  if (!tier || tier.model === FREE_MODEL) return tier;
  const before = { agent: tier.agent, model: tier.model, ...(tier.effort ? { effort: tier.effort } : {}) };
  const { effort, ...rest } = tier;
  return { ...rest, agent: agentId, model: FREE_MODEL, fallbacks: [before, ...(tier.fallbacks || []).filter(r => r.model !== tier.model)] };
}

const api = { useBigPickle, FREE_MODEL, COOLDOWN_MS, REASON_TEXT, classifyFailure, isFreeRoute, keyOf, labelOf, createHealth, routesOf, failedBefore, resolve, forTask, overlay, overlayModes };
if (typeof module !== 'undefined') module.exports = api; else globalThis.TierRoutes = api;
})();
