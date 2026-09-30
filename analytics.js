// Analytics over the local store (2.5): what `operant stats` prints and the Usage view shows. Pure: it takes rows of the
// store's tables (store.js) and returns plain numbers, so the same figures feed the CLI and the dashboard.
//
// Definitions, so the numbers can be checked:
//   gross tokens saved = cache-read tokens of worker runs (input served from cache instead of processed again);
//   Operant's own cost = the tokens and dollars of its orchestration calls (`orchestration` outcome entries: the refiner and helpers);
//   net tokens saved   = gross minus Operant's own tokens;
//   wasted tokens      = tokens of runs that did not pass, per model.
const num = x => (typeof x === 'number' && isFinite(x) ? x : 0);
const sumTokens = t => num(t?.input) + num(t?.output) + num(t?.cacheRead) + num(t?.cacheWrite);
const r2 = x => Math.round(x * 100) / 100;
const rate = (a, b) => (b ? Math.round((a / b) * 1000) / 1000 : 0);
const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);

// A task run joined to its tokens and cost: modelRuns and tokenEvents of one outcome share its corr and time.
function joinRuns({ taskRuns = [], modelRuns = [], tokenEvents = [] }) {
  const key = r => `${r.corr}|${r.t}`;
  const usd = new Map(modelRuns.map(r => [key(r), r.usd])), tok = new Map(tokenEvents.map(r => [key(r), r]));
  return taskRuns.map(r => ({ ...r, usd: typeof usd.get(key(r)) === 'number' ? usd.get(key(r)) : null, tokens: tok.get(key(r)) || null }));
}

// integrations: [{ id, name, configured, used: true|false|null }] (null: not tracked, never reported unused).
// orchestration: outcome entries of kind 'orchestration' ({ tokens, usd }).
function summarize(tables, { orchestration = [], integrations = [], now = Date.now() } = {}) {
  const runs = joinRuns(tables);
  const done = runs.filter(r => r.status === 'done');
  const retries = runs.reduce((s, r) => s + Math.max(0, num(r.attempts) - 1), 0);
  const tasks = {
    n: runs.length, done: done.length, notDone: runs.length - done.length, passRate: rate(done.length, runs.length),
    retries, retryRate: rate(runs.filter(r => num(r.attempts) > 1).length, runs.length), escalationRate: rate(runs.filter(r => num(r.escalations) > 0).length, runs.length),
  };

  const models = {};
  for (const r of runs) {
    const k = r.model || r.tier || 'unknown';
    const m = (models[k] ||= { model: k, tasks: 0, passed: 0, usd: 0, tokens: 0, wastedTokens: 0, durations: [] });
    m.tasks++; if (r.status === 'done') m.passed++;
    m.usd += num(r.usd); const t = sumTokens(r.tokens); m.tokens += t; if (r.status !== 'done') m.wastedTokens += t;
    if (typeof r.durationMs === 'number') m.durations.push(r.durationMs);
  }
  const byModel = Object.values(models).map(({ durations, ...m }) => ({
    ...m, usd: r2(m.usd), passRate: rate(m.passed, m.tasks), wasteRate: rate(m.wastedTokens, m.tokens), avgLatencyMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
  })).sort((a, b) => b.tokens - a.tokens);
  const waster = byModel.filter(m => m.wastedTokens > 0).sort((a, b) => b.wastedTokens - a.wastedTokens)[0] || null;

  const provs = {};
  for (const c of tables.providerCalls || []) {
    const k = c.provider || c.key || 'unknown';
    const p = (provs[k] ||= { provider: k, calls: 0, errors: 0, kinds: {}, lat: [] });
    p.calls++;
    if (!c.ok) { p.errors++; p.kinds[c.kind || 'error'] = (p.kinds[c.kind || 'error'] || 0) + 1; }
    else if (typeof c.latencyMs === 'number') p.lat.push(c.latencyMs);
  }
  const providers = Object.values(provs).map(({ lat, ...p }) => ({ ...p, errorRate: rate(p.errors, p.calls), avgLatencyMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null })).sort((a, b) => b.calls - a.calls);

  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, byTier: {} };
  for (const t of tables.tokenEvents || []) {
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) tokens[k] += num(t[k]);
    if (t.tier) tokens.byTier[t.tier] = (tokens.byTier[t.tier] || 0) + sumTokens(t);
  }
  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;

  const cost = { usd: 0, byTier: {} };
  for (const r of runs) { cost.usd += num(r.usd); if (r.tier) cost.byTier[r.tier] = r2((cost.byTier[r.tier] || 0) + num(r.usd)); }
  cost.usd = r2(cost.usd);

  const lat = runs.map(r => r.durationMs).filter(x => typeof x === 'number').sort((a, b) => a - b);
  const latency = { n: lat.length, avgMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null, p50Ms: percentile(lat, 0.5), p95Ms: percentile(lat, 0.95) };

  const kinds = {};
  for (const f of tables.failures || []) kinds[f.kind || 'other'] = (kinds[f.kind || 'other'] || 0) + 1;
  const failures = Object.entries(kinds).map(([kind, n]) => ({ kind, n })).sort((a, b) => b.n - a.n);

  const spots = {};
  for (const r of runs) {
    const extra = Math.max(0, num(r.attempts) - 1) + num(r.escalations);
    if (!extra) continue;
    const k = `${r.type || 'other'}|${r.tier || '-'}`;
    const s = (spots[k] ||= { type: r.type || 'other', tier: r.tier || null, tasks: 0, retries: 0 });
    s.tasks++; s.retries += extra;
  }
  const retryHotSpots = Object.values(spots).sort((a, b) => b.retries - a.retries).slice(0, 5);

  const own = { tokens: 0, usd: 0, calls: orchestration.length };
  for (const o of orchestration) { own.tokens += sumTokens(o.tokens); own.usd += num(o.usd); }
  own.usd = r2(own.usd);
  const verification = tables.verificationRuns || [];
  const savings = { grossTokens: tokens.cacheRead, ownTokens: own.tokens, netTokens: tokens.cacheRead - own.tokens };

  const codegraphCalls = (tables.toolCalls || []).filter(t => t.tool === 'codegraph').reduce((s, t) => s + num(t.calls), 0);
  const unusedIntegrations = integrations.filter(i => i.configured && i.used === false).map(i => i.name || i.id);

  return {
    at: now, tasks, models: byModel, wasteful: waster, providers, tokens, cost, latency, failures, retryHotSpots, savings, operant: own,
    verification: { n: verification.length, passRate: rate(verification.filter(v => v.ok).length, verification.length) },
    codegraphCalls, integrations, unusedIntegrations,
  };
}

const k = n => (Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.abs(n) >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n)));
const pct = x => Math.round(x * 100) + '%';
const secs = ms => (ms == null ? 'n/a' : ms >= 60e3 ? (ms / 60e3).toFixed(1) + ' min' : Math.round(ms / 1e3) + ' s');

// The text of `operant stats`.
function formatStats(s, { days = 30 } = {}) {
  if (!s || !s.tasks.n) return `no task runs recorded in the last ${days} days`;
  const L = [];
  L.push(`last ${days} days: ${s.tasks.n} tasks, ${pct(s.tasks.passRate)} passed, ${s.tasks.retries} retries (${pct(s.tasks.retryRate)} of tasks), ${pct(s.tasks.escalationRate)} escalated`);
  L.push(`tokens saved: gross ${k(s.savings.grossTokens)} (cache reads), Operant's own ${k(s.savings.ownTokens)}, net ${k(s.savings.netTokens)}`);
  L.push(`Operant itself: ${s.operant.calls} orchestration calls, ${k(s.operant.tokens)} tokens, $${s.operant.usd.toFixed(2)}`);
  L.push(`cost: $${s.cost.usd.toFixed(2)}${Object.keys(s.cost.byTier).length ? ' (' + Object.entries(s.cost.byTier).map(([t, v]) => `${t} $${v.toFixed(2)}`).join(', ') + ')' : ''} · latency avg ${secs(s.latency.avgMs)}, p95 ${secs(s.latency.p95Ms)}`);
  L.push('retry hot spots: ' + (s.retryHotSpots.length ? s.retryHotSpots.map(h => `${h.type} on ${h.tier || '-'} (${h.retries} retries in ${h.tasks} tasks)`).join('; ') : 'none'));
  L.push('wastes most tokens: ' + (s.wasteful ? `${s.wasteful.model} (${k(s.wasteful.wastedTokens)} in runs that did not pass, ${pct(s.wasteful.wasteRate)} of its tokens)` : 'none'));
  if (s.failures.length) L.push('failures: ' + s.failures.map(f => `${f.kind} ${f.n}`).join(', '));
  L.push('unused integrations: ' + (s.unusedIntegrations.length ? s.unusedIntegrations.join(', ') : 'none'));
  return L.join('\n');
}

module.exports = { summarize, formatStats, joinRuns, sumTokens };
