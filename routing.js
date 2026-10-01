(function () {
// Routing from outcomes: pick the cheapest tier whose recorded results for this kind of task hold up.
// Pure; stats is outcomes.summarize() over the recent window, tiers run cheap to expensive and are already capped.
const MIN_N = 5, MIN_RATE = 0.8, EXPLORE_EVERY = 10;
const classify = p => (typeof TaskType !== 'undefined' ? TaskType : require('./task-type')).classifyTask(p);

// health: { down(key) -> { reason } | null } (route-health.js asHealth) and modelOf(tier) -> the key it runs on: a tier whose
// route is known down is skipped with the reason shown, never picked and retried blindly. Every result carries `alternatives`
// (what each tier's record looked like) and `skipped`, the inputs of the decision trace (no prompt contents).
// With `runs` (stored task runs, see decide) the pick is by expected utility; without, by the outcomes summary in `stats`.
function route({ prompt, tiers, stats, counter, fallback, health, modelOf, runs, ...more }) {
  const type = classify(prompt);
  const r = (runs || activeOverride(more.overrides, { project: more.project })) ? decide({ prompt, type, tiers, runs, counter, fallback, ...more }) : pickTier({ type, tiers, stats, counter, fallback });
  const down = name => (health && modelOf ? health.down(modelOf(name)) : null);
  const skipped = [];
  let out = r;
  if (down(r.tier)) {
    skipped.push({ tier: r.tier, reason: down(r.tier).reason });
    const at = tiers.indexOf(r.tier);
    // A task that already runs on `current` is never moved above it by a skip either.
    const cap = more.current != null ? tiers.indexOf(more.current) : -1;
    const next = [...tiers.slice(at + 1), ...tiers.slice(0, at).reverse()].find(n => !down(n) && (cap < 0 || tiers.indexOf(n) <= cap));
    if (next) out = { ...r, tier: next, basis: 'health', reason: `${next}: ${r.tier} ${down(r.tier).reason}, skipped (${r.reason})` };
    else out = { ...r, reason: `${r.reason}; every tier's route is down, staying on ${r.tier}` };
  }
  return { ...out, type, skipped, alternatives: r.alternatives };
}

// ---- expected utility (2.5). Pure. Units are dollars: utility = p * VALUE - cost - latency - (1 - p) * (cost + RETRY),
// so a failed task pays for a second run. p is the share of passed tasks of this type on this tier, from stored task runs
// weighted by age (each HALF_LIFE_MS halves a run's weight); a tier with fewer than MIN_N such tasks has no evidence and
// takes a conservative default p by rank instead, so an unproven cheap tier never wins on price alone.
const HALF_LIFE_MS = 14 * 86400e3;
const VALUE_USD = 1, RETRY_USD = 0.1, LATENCY_USD_PER_MIN = 0.02;
const DEFAULT_COST_USD = i => 0.02 * Math.pow(3, i);
const DEFAULT_LATENCY_MS = i => 60e3 * (1 + i);
const priorRate = (i, n) => (n > 1 ? 0.5 + 0.4 * (i / (n - 1)) : 0.7);
const r2 = x => Math.round(x * 100) / 100;

// runs: task-run rows { t, type, tier, status, durationMs, usd?, project }. -> per tier { n, p, rate, costUsd, latencyMs, scope, evidence }.
function tierEvidence(runs, { type, tiers, project, now = Date.now(), halfLifeMs = HALF_LIFE_MS }) {
  const w = t => Math.pow(0.5, Math.max(0, now - (t || 0)) / halfLifeMs);
  return tiers.map((name, i) => {
    const mine = (runs || []).filter(x => x && x.type === type && x.tier === name);
    const local = project ? mine.filter(x => x.project === project) : [];
    // A project's own record counts once it has MIN_N tasks; before that the pooled record of all projects does.
    const scope = local.length >= MIN_N ? 'project' : 'all projects';
    const rows = scope === 'project' ? local : mine;
    const n = rows.length;
    const sw = rows.reduce((s, x) => s + w(x.t), 0), pw = rows.reduce((s, x) => s + (x.status === 'done' ? w(x.t) : 0), 0);
    const rate = sw ? pw / sw : 0;
    const usd = rows.filter(x => typeof x.usd === 'number'), lat = rows.filter(x => typeof x.durationMs === 'number');
    const avg = (list, k) => { const t = list.reduce((s, x) => s + w(x.t), 0); return t ? list.reduce((s, x) => s + x[k] * w(x.t), 0) / t : null; };
    const enough = n >= MIN_N;
    return {
      tier: name, n, scope, evidence: enough, rate: r2(rate), p: r2(enough ? rate : priorRate(i, tiers.length)),
      costUsd: avg(usd, 'usd') ?? DEFAULT_COST_USD(i), costKnown: usd.length > 0, latencyMs: avg(lat, 'durationMs') ?? DEFAULT_LATENCY_MS(i),
    };
  });
}
const utilityOf = e => e.p * VALUE_USD - e.costUsd - (e.latencyMs / 60e3) * LATENCY_USD_PER_MIN - (1 - e.p) * (e.costUsd + RETRY_USD);

// An override { tier, project?, until? } applies to one project (its own first) or to every project, until `until` (ms) or for good.
function activeOverride(overrides, { project, now = Date.now() } = {}) {
  const live = (overrides || []).filter(o => o && o.tier && (!o.until || o.until > now));
  return live.find(o => o.project && o.project === project) || live.find(o => !o.project) || null;
}

// The list after setting (replacing the same scope) or clearing an override; hours makes it temporary. Pure.
function withOverride(list, { tier, project, hours }, now = Date.now()) {
  const rest = (list || []).filter(o => o && (o.until == null || o.until > now) && (o.project || null) !== (project || null));
  if (!tier) return rest;
  return [...rest, { tier, ...(project ? { project } : {}), ...(hours > 0 ? { until: now + hours * 3600e3 } : {}), setAt: now }];
}

// tiers: the allowed tier names, cheap to expensive; the only ones ever returned. current: the tier a task already runs on;
// nothing above it is picked (routing never moves a task up on its own; that stays with the user, tier-guard.js).
// -> { tier, basis, reason, alternatives, rejected: { tier, utility, why } | null, detail: the structured reason }
function decide({ prompt, type = classify(prompt), tiers, runs, project, now = Date.now(), counter = 0, fallback, overrides, current }) {
  const ceil = current != null && tiers.includes(current) ? tiers.indexOf(current) : tiers.length - 1;
  const pool = tiers.slice(0, ceil + 1);
  const risky = risk(prompt) === 'high';
  const ev = tierEvidence(runs, { type, tiers: pool, project, now }).map(e => ({ ...e, utility: r2(utilityOf(e)) }));
  const alternatives = ev.map(e => ({ tier: e.tier, n: e.n, rate: e.rate, p: e.p, costUsd: r2(e.costUsd), latencyMs: Math.round(e.latencyMs), utility: e.utility, evidence: e.evidence }));
  const finish = (tier, basis, reason, extra = {}) => {
    const at = ev.find(e => e.tier === tier);
    const other = ev.filter(e => e.tier !== tier).sort((a, b) => b.utility - a.utility)[0];
    const rejected = other ? { tier: other.tier, utility: other.utility, why: at && other.utility <= at.utility ? `lower utility (${other.utility} vs ${at.utility})` : `${basis} chose ${tier}` } : null;
    const chosen = at ? { tier, p: at.p, n: at.n, utility: at.utility, evidence: at.evidence, scope: at.scope } : { tier };
    return { tier, basis, reason, alternatives, rejected, detail: { type, project: project || null, risk: risky ? 'high' : 'low', minTasks: MIN_N, chosen, rejected, ...extra } };
  };

  const ov = activeOverride(overrides, { project, now });
  if (ov && pool.includes(ov.tier)) {
    const until = ov.until ? ` until ${new Date(ov.until).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '';
    return finish(ov.tier, 'override', `${ov.tier}: ${ov.project ? 'project' : 'global'} override${until}`, { override: { tier: ov.tier, scope: ov.project ? 'project' : 'global', until: ov.until || null } });
  }
  if (!ev.some(e => e.evidence)) {
    const pick = pool.includes(fallback?.tier) ? fallback.tier : pool[0];
    const k = ev.reduce((s, e) => s + e.n, 0);
    return finish(pick, 'insufficient data', `insufficient data for ${type} tasks (${k} recorded, ${MIN_N} needed per tier); ${fallback?.reason ?? 'no keyword match'}`);
  }
  const best = ev.reduce((b, e) => (e.utility > b.utility || (e.utility === b.utility && e.p > b.p) ? e : b));
  // Bounded exploration: one decision in EXPLORE_EVERY tries the tier below the pick when it still lacks evidence, never on high-risk work.
  const at = ev.indexOf(best), below = ev[at - 1];
  if (!risky && at > 0 && !below.evidence && (counter | 0) % EXPLORE_EVERY === EXPLORE_EVERY - 1) {
    return finish(below.tier, 'exploration', `trying ${below.tier} (1 in ${EXPLORE_EVERY}, so it can gather evidence; ${best.tier} is the pick)`, { explore: true });
  }
  const how = best.evidence ? `${Math.round(best.rate * 100)}% of ${best.n} ${type} tasks passed` : `no record yet, assumed ${Math.round(best.p * 100)}%`;
  return finish(best.tier, 'utility', `${best.tier}: ${how}, ~$${r2(best.costUsd).toFixed(2)} per task, utility ${best.utility}`);
}

function pickTier({ type, tiers, stats, counter, fallback }) {
  const cells = tiers.map(name => {
    const c = stats?.[type]?.[name];
    const n = c ? c.passed + c.failed + c.escalated : 0;
    return { name, c, n, rate: n ? c.passed / n : 0 };
  });
  const alternatives = cells.map(x => ({ tier: x.name, n: x.n, rate: Math.round(x.rate * 100) / 100 }));
  const usd = c => (c.avgUsd == null ? 'unknown' : '$' + c.avgUsd.toFixed(2));
  const proven = cells.findIndex(x => x.n >= MIN_N && x.rate >= MIN_RATE);
  if (proven >= 0) {
    const p = cells[proven];
    if (proven > 0 && (counter | 0) % EXPLORE_EVERY === EXPLORE_EVERY - 1) {
      return { tier: cells[proven - 1].name, basis: 'exploration', reason: `trying ${cells[proven - 1].name} (1 in 10, so a cheaper tier can earn its way back; ${p.name} is proven)`, alternatives };
    }
    return { tier: p.name, basis: 'outcomes', reason: `${p.name}: ${p.c.passed}/${p.n} ${type} tasks passed, ${usd(p.c)} avg`, alternatives };
  }
  let failing = -1;
  cells.forEach((x, i) => { if (x.n >= MIN_N) failing = i; });
  if (failing >= 0) {
    const f = cells[failing], next = cells[Math.min(failing + 1, cells.length - 1)];
    return { tier: next.name, basis: 'outcomes', reason: `${next.name}: ${f.name} passed only ${f.c.passed}/${f.n} ${type} tasks`, alternatives };
  }
  const k = cells.reduce((s, x) => s + x.n, 0);
  return { tier: fallback?.tier ?? tiers[0], basis: 'insufficient data', reason: `insufficient data for ${type} tasks (${k} recorded); ${fallback?.reason ?? 'no keyword match'}`, alternatives };
}

// Escalation and downgrade signals for one task. They only suggest: nothing here moves a task, and moving up always
// asks the user (tier-guard.js). facts: { confidence 0..1 | null, deps, contextPct, contextTokens, missingContext }.
// -> { up: [{ id, text }], down: [{ id, text }] }, either list empty when no signal fires.
const HIGH_RISK = /\b(delete|drop|migrat\w*|security|auth\w*|password|secret|payment|billing|production|deploy|force[- ]push|schema|encrypt\w*)\b/i;
const AMBIGUOUS = /\b(maybe|somehow|not sure|either|or something|whatever|i guess|figure out|etc)\b|\?/i;
const risk = text => (HIGH_RISK.test(String(text || '')) ? 'high' : 'low');
function signals(task, facts = {}) {
  const text = String(task?.text || ''), up = [], down = [];
  const add = (list, id, why) => list.push({ id, text: why });
  if (facts.confidence != null && facts.confidence < 0.5) add(up, 'low-confidence', `low confidence (${Math.round(facts.confidence * 100)}%)`);
  if (risk(text) === 'high') add(up, 'high-risk', 'high risk: touches something hard to undo or security-sensitive');
  if ((facts.deps || 0) >= 6) add(up, 'big-graph', `big dependency graph (${facts.deps} linked tasks)`);
  if (AMBIGUOUS.test(text)) add(up, 'ambiguity', 'the request is ambiguous');
  if (task?.check && task.check.ok === false) add(up, 'failed-verification', `verification failed: ${task.check.command || 'checks'}`);
  if (facts.missingContext || (facts.contextPct || 0) >= 85) add(up, 'insufficient-context', 'the worker lacks context or is near its context limit');
  if (!up.length && !(task?.changes || []).length) {
    if (text.length && text.length <= 120) add(down, 'simple', 'simple task');
    if (risk(text) === 'low' && !up.length) add(down, 'low-risk', 'low risk');
    if (facts.contextTokens != null && facts.contextTokens <= 8000) add(down, 'small-context', `small context (${facts.contextTokens} tokens)`);
    if (down.length < 2) down.length = 0; // one weak hint is not a downgrade signal
  }
  return { up, down };
}
const signalLine = s => [s.up.length ? `consider a higher tier: ${s.up.map(x => x.text).join('; ')}` : '', s.down.length ? `could run on a lower tier: ${s.down.map(x => x.text).join('; ')}` : ''].filter(Boolean).join(' · ');

const api = { route, decide, tierEvidence, activeOverride, withOverride, signals, signalLine, risk, MIN_N, HALF_LIFE_MS };
if (typeof module !== 'undefined') module.exports = api; else globalThis.Routing = api;
})();
