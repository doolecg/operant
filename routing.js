(function () {
// Routing from outcomes (item 59): pick the cheapest tier whose recorded results for this kind of task hold up.
// Pure; stats is outcomes.summarize() over the recent window, tiers run cheap to expensive and are already capped.
const MIN_N = 5, MIN_RATE = 0.8, EXPLORE_EVERY = 10;
const classify = p => (typeof TaskType !== 'undefined' ? TaskType : require('./task-type')).classifyTask(p);

// health: { down(key) -> { reason } | null } (route-health.js asHealth) and modelOf(tier) -> the key it runs on: a tier whose
// route is known down is skipped with the reason shown, never picked and retried blindly. Every result carries `alternatives`
// (what each tier's record looked like) and `skipped`, the inputs of the decision trace (no prompt contents).
function route({ prompt, tiers, stats, counter, fallback, health, modelOf }) {
  const type = classify(prompt);
  const r = pickTier({ type, tiers, stats, counter, fallback });
  const down = name => (health && modelOf ? health.down(modelOf(name)) : null);
  const skipped = [];
  let out = r;
  if (down(r.tier)) {
    skipped.push({ tier: r.tier, reason: down(r.tier).reason });
    const at = tiers.indexOf(r.tier);
    const next = [...tiers.slice(at + 1), ...tiers.slice(0, at).reverse()].find(n => !down(n));
    if (next) out = { tier: next, basis: 'health', reason: `${next}: ${r.tier} ${down(r.tier).reason}, skipped (${r.reason})` };
    else out = { ...r, reason: `${r.reason}; every tier's route is down, staying on ${r.tier}` };
  }
  return { ...out, type, skipped, alternatives: r.alternatives };
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

const api = { route, signals, signalLine, risk };
if (typeof module !== 'undefined') module.exports = api; else globalThis.Routing = api;
})();
