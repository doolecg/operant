(function () {
// Team tiers follow the default agent. Claude Code (and any other agent) uses the tiers set in
// Settings › Agents › Team. OpenCode builds its own from the models it can reach: the free Zen
// models have no effort variants, so they give one tier; a paid Zen or OpenAI model with variants
// (low … xhigh) adds a tier per variant.
const FREE_MODEL = 'opencode/big-pickle';
const VARIANT_TIERS = [['small', ['low', 'minimal']], ['medium', ['medium']], ['high', ['high']], ['max', ['xhigh', 'max']]];

// `opencode models --verbose` prints each model id followed by its JSON.
function parseModels(text) {
  const out = [];
  let buf = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (buf == null && line === '{') buf = [];
    if (buf == null) continue;
    buf.push(line);
    if (line === '}') { try { out.push(JSON.parse(buf.join('\n'))); } catch {} buf = null; }
  }
  return out;
}

// The newest paid Zen or OpenAI model that has effort variants, or null.
function reasoningModel(models) {
  const paid = m => m.providerID === 'openai' || (m.providerID === 'opencode' && (m.cost?.input > 0 || m.cost?.output > 0));
  return (models || []).filter(m => paid(m) && m.status !== 'deprecated' && Object.keys(m.variants || {}).length)
    .sort((a, b) => String(b.release_date || '').localeCompare(String(a.release_date || '')) || Object.keys(b.variants).length - Object.keys(a.variants).length)[0] || null;
}

function opencodeTiers(models, base, agentId) {
  const use = n => base[n]?.use || '';
  const own = base.xsmall?.agent === agentId && base.xsmall.model;
  const tiers = { xsmall: { agent: agentId, model: own || FREE_MODEL, use: use('xsmall') } };
  const m = reasoningModel(models);
  if (!m) return tiers;
  const variants = Object.keys(m.variants);
  for (const [tier, names] of VARIANT_TIERS) {
    const effort = names.find(n => variants.includes(n));
    if (effort) tiers[tier] = { agent: agentId, model: `${m.providerID}/${m.id}`, effort, use: use(tier) };
  }
  return tiers;
}

// Which of the configured tiers can run right now. `installed` maps agent id -> CLI found on PATH
// (missing or true = assume it is); `models` is OpenCode's model list once read (null = unknown).
// An OpenCode tier whose CLI or model is missing falls back to the nearest Claude tier of equal or
// higher rank; a Claude tier with Claude missing falls back to OpenCode's derived tier for that slot,
// or is dropped. A fallback tier carries `fallback: 'reason'`.
function availableTiers({ base, agents, isOpenCode, isClaude, installed, models }) {
  const names = Object.keys(base);
  const agentOf = t => (agents || []).find(a => a.id === t.agent);
  const has = t => !installed || installed[t.agent] !== false;
  const kind = t => { const a = agentOf(t); return a && isOpenCode(a) ? 'oc' : a && isClaude && isClaude(a) ? 'cl' : 'other'; };
  const ocModelIds = models ? new Set(models.map(m => `${m.providerID}/${m.id}`)) : null;
  const problem = t => {
    if (!has(t)) return kind(t) === 'oc' ? 'OpenCode not installed' : kind(t) === 'cl' ? 'Claude Code not installed' : `${t.agent} not installed`;
    if (kind(t) === 'oc' && ocModelIds && t.model && !ocModelIds.has(t.model)) return `${t.model} not available in OpenCode`;
    return null;
  };
  const ocAgent = (agents || []).find(a => isOpenCode(a) && installed?.[a.id] !== false);
  const derived = ocAgent && (!models || models.length) ? opencodeTiers(models, base, ocAgent.id) : null;
  const out = {};
  let changed = false;
  names.forEach((name, i) => {
    const t = base[name], why = problem(t);
    if (!why) { out[name] = t; return; }
    changed = true;
    if (kind(t) === 'oc') {
      for (const n of names.slice(i)) {
        const c = base[n];
        if (kind(c) === 'cl' && !problem(c)) { out[name] = { ...c, use: t.use, fallback: why }; return; }
      }
    } else if (kind(t) === 'cl' && derived?.[name]) out[name] = { ...derived[name], fallback: why };
  });
  return changed ? out : base;
}

function activeTiers({ team, agents, defaultAgent, isOpenCode, isClaude, models, installed }) {
  const base = team?.tiers || {};
  const agent = (agents || []).find(a => a.id === defaultAgent) || (agents || [])[0];
  if (agent && isOpenCode(agent)) return opencodeTiers(models, base, agent.id);
  return availableTiers({ base, agents, isOpenCode, isClaude, installed, models });
}

// `agent` entries for OpenCode's config: each OpenCode-run tier becomes a `tier-<name>` subagent
// the lead can hand work to. isOc(agentId) says whether a tier's agent is OpenCode.
function opencodeSubagents(tiers, isOc) {
  const out = {};
  for (const [name, t] of Object.entries(tiers || {})) {
    if (!t?.model || !isOc(t.agent)) continue;
    out[`tier-${name}`] = { mode: 'subagent', model: t.model, ...(t.effort ? { variant: t.effort } : {}), description: t.use || `${name} tier` };
  }
  return out;
}

// Existing `agent` config wins over the tier entries.
function mergeSubagents(agent, subagents) {
  return { ...subagents, ...(agent || {}) };
}

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'where', 'when', 'are', 'not', 'one', 'have', 'use', 'than', 'more', 'matters']);
const words = s => String(s || '').toLowerCase().match(/[a-z]{3,}/g)?.map(w => w.replace(/(ing|ed|es|s)$/, '').replace(/e$/, '')).filter(w => w.length >= 3 && !STOP.has(w)) || [];
const RESEARCH = /\b(research|investigat\w*|web|internet|online|docs? lookup|look ?up (the )?docs?|documentation|compare|survey)\b/i;

// Lowest allowed tier whose `use` text overlaps the prompt most (ties go to the cheaper tier),
// default small; long prompts never go below medium, research never on xsmall.
function suggestTier(prompt, tiers) {
  const names = Object.keys(tiers || {});
  if (!names.length) return null;
  const pw = new Set(words(prompt));
  let idx = names.includes('small') ? names.indexOf('small') : 0, best = 0, hits = [];
  names.forEach((n, i) => {
    const h = [...new Set(words(tiers[n]?.use))].filter(w => pw.has(w));
    if (h.length > best) { best = h.length; idx = i; hits = h; }
  });
  let reason = best ? `matches "${hits.join(', ')}"` : 'default';
  const raise = (min, why) => { const m = Math.min(Math.max(names.indexOf(min), 0) || 0, names.length - 1); if (idx < m) { idx = m; reason = why; } };
  if (RESEARCH.test(prompt) && idx === 0 && names.length > 1) { idx = 1; reason = 'needs research'; }
  if (String(prompt).length > 800) raise(names.includes('medium') ? 'medium' : names[1] || names[0], 'long prompt');
  return { tier: names[idx], reason };
}

const api = { parseModels, reasoningModel, opencodeTiers, availableTiers, activeTiers, opencodeSubagents, mergeSubagents, suggestTier, FREE_MODEL };
  if (typeof module !== 'undefined') module.exports = api; else globalThis.TeamTiers = api;
})();
