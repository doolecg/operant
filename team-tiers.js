(function () {
const Reg = typeof module !== 'undefined' ? require('./cli-registry') : globalThis.CliRegistry;
const Roles = typeof module !== 'undefined' ? require('./roles') : null;
// Team tiers follow the team's CLI. Claude Code (and any other agent) uses the tiers set in
// Settings › Agents › Team that run on it. OpenCode builds its own from the models it can reach: the free Zen
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
  // xsmall keeps a model of OpenCode's own that it can reach (models null = unknown, so assume it can).
  const own = base.xsmall?.agent === agentId && (!models || models.some(m => `${m.providerID}/${m.id}` === base.xsmall.model)) && base.xsmall.model;
  // Fallback routes that OpenCode itself can run (the local model, or another of its models) carry over.
  const keep = n => { const f = (base[n]?.fallbacks || []).filter(r => r.local || (r.agent || base[n].agent) === agentId); return f.length ? { fallbacks: f } : {}; };
  const tiers = {};
  if (base.free) tiers.free = { agent: agentId, model: FREE_MODEL, use: use('free'), ...keep('free') };
  tiers.xsmall = { agent: agentId, model: own || FREE_MODEL, use: use('xsmall'), ...keep('xsmall') };
  const m = reasoningModel(models);
  if (!m) return tiers;
  const variants = Object.keys(m.variants);
  for (const [tier, names] of VARIANT_TIERS) {
    const effort = names.find(n => variants.includes(n));
    if (effort) tiers[tier] = { agent: agentId, model: `${m.providerID}/${m.id}`, effort, use: use(tier) };
  }
  return tiers;
}

// Codex and Gemini start from the tier table in cli-registry.js (a model, and for Codex an effort, per tier), with
// the `use` text of the configured tiers.
function registryTiers(cli, base, agentId) {
  const tiers = {};
  for (const [name, t] of Object.entries(Reg.get(cli)?.tiers || {})) tiers[name] = { agent: agentId, ...t, use: base[name]?.use || '' };
  return tiers;
}

// Single-CLI teams: a team runs on one CLI, the project's lead CLI (cli-registry.js leadCli), and only on that CLI's
// tiers. `installed` maps agent id -> CLI found on PATH (missing or true = assume it is); `models` is OpenCode's model
// list once read (null = unknown). A configured tier on this CLI is kept, with its fallback routes on other CLIs left
// out (the local model only for OpenCode). A slot on another CLI, or one that can't run, takes the first of its own
// fallback routes that is on this CLI (marked with `fallback`), or its derived tier (OpenCode: opencodeTiers; Codex and Gemini: registryTiers);
// otherwise it is dropped and listed in `removed`. Nothing is borrowed from another CLI. `empty` = nothing left.
const AGENT_MODES = Reg.IDS;
function cliTiers(cli, { base, agents, installed, models } = {}) {
  const names = Object.keys(base || {}), label = Reg.labelOf(cli);
  const on = id => Reg.kindOf((agents || []).find(a => a.id === id)) === cli;
  const has = id => !installed || installed[id] !== false;
  const ocIds = cli === 'opencode' && models ? new Set(models.map(m => `${m.providerID}/${m.id}`)) : null;
  const ok = r => on(r.agent) && has(r.agent) && !(ocIds && r.model && !ocIds.has(r.model));
  const own = (agents || []).find(a => Reg.is(a, cli) && has(a.id));
  const derived = !own ? null : cli === 'opencode' ? ((!models || models.length) ? opencodeTiers(models, base, own.id) : null)
    : Reg.get(cli)?.tiers ? registryTiers(cli, base, own.id) : null;
  const out = {}, removed = [];
  for (const name of names) {
    const t = base[name];
    const routes = (t.fallbacks || []).filter(r => (r.local ? cli === 'opencode' : ok({ ...r, agent: r.agent || t.agent })));
    if (ok(t)) {
      if (routes.length === (t.fallbacks || []).length) out[name] = t;
      else { const { fallbacks, ...rest } = t; out[name] = routes.length ? { ...rest, fallbacks: routes } : rest; }
      continue;
    }
    const why = !on(t.agent) ? `${label} team` : !has(t.agent) ? `${label} not installed` : `${t.model} not available in ${label}`;
    const r = routes.find(f => !f.local);
    if (r) {
      const { effort, fallbacks, ...rest } = t, after = routes.slice(routes.indexOf(r) + 1);
      out[name] = { ...rest, agent: r.agent || t.agent, model: r.model, ...(r.effort ? { effort: r.effort } : {}), ...(after.length ? { fallbacks: after } : {}), fallback: why };
    } else if (derived?.[name]) out[name] = { ...derived[name], use: t.use || derived[name].use, ...(on(t.agent) ? { fallback: why } : {}) };
    else removed.push(name);
  }
  return { tiers: out, removed, empty: !Object.keys(out).length };
}

// The default agent's team tiers (Settings and the gear slider). OpenCode builds its set from its models.
function activeTiers({ team, agents, defaultAgent, models, installed }) {
  const base = team?.tiers || {};
  const agent = (agents || []).find(a => a.id === defaultAgent) || (agents || [])[0];
  if (agent && Reg.is(agent, 'opencode')) return opencodeTiers(models, base, agent.id);
  return cliTiers(Reg.kindOf(agent), { base, agents, installed, models }).tiers;
}

// `operant agent --agent/--model/--tier` that names another CLI than the project's team runs on -> the error text, else null.
// kind: the CLI id of what was named, or 'other' (a custom agent or an unknown model, which is let through).
function modeConflict(cli, what, kind) {
  if (!kind || kind === 'other' || kind === cli || !Reg.get(kind)) return null;
  return `this project's team runs on ${Reg.labelOf(cli)}, and ${what} runs on ${Reg.labelOf(kind)}: a team uses one CLI - change the project's CLI in its sidebar menu (Agents) or Settings › Agents`;
}

// The team tiers for each CLI that has an agent set up ({ claude: { tiers, removed, empty }, opencode: ... }), for main to keep in config.
function tiersByMode({ base, agents, installed, models }) {
  const out = {};
  for (const cli of Reg.IDS) if ((agents || []).some(a => Reg.is(a, cli))) out[cli] = cliTiers(cli, { base, agents, installed, models });
  return out;
}

// `agent` entries for OpenCode's config: each OpenCode-run tier becomes a `tier-<name>` subagent
// the lead can hand work to, and each role whose tier runs on OpenCode a `role-<name>` one. isOc(agentId) says whether a tier's agent is OpenCode.
function opencodeSubagents(tiers, isOc) {
  const out = {};
  for (const [name, t] of Object.entries(tiers || {})) {
    if (!t?.model || !isOc(t.agent)) continue;
    out[`tier-${name}`] = { mode: 'subagent', model: t.model, ...(t.effort ? { variant: t.effort } : {}), description: t.use || `${name} tier` };
  }
  // The role presets (roles.js) as `role-<name>` subagents, on the model of the role's tier.
  for (const [name, r] of Object.entries(Roles?.ROLES || {})) {
    const t = tiers?.[r.tier];
    if (!t?.model || !isOc(t.agent) || !Roles.roleText(name)) continue;
    out[`role-${name}`] = { mode: 'subagent', model: t.model, ...(t.effort ? { variant: t.effort } : {}), prompt: Roles.roleText(name), description: Roles.roleDescription(name) || `${name} role` };
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
  const research = Math.max(names.indexOf('small'), 1);
  if (RESEARCH.test(prompt) && idx < research && names.length > 1) { idx = Math.min(research, names.length - 1); reason = 'needs research'; }
  if (String(prompt).length > 800) raise(names.includes('medium') ? 'medium' : names[1] || names[0], 'long prompt');
  return { tier: names[idx], reason };
}

const api = { parseModels, reasoningModel, opencodeTiers, registryTiers, cliTiers, activeTiers, opencodeSubagents, mergeSubagents, suggestTier, modeConflict, tiersByMode, AGENT_MODES, FREE_MODEL };
  if (typeof module !== 'undefined') module.exports = api; else globalThis.TeamTiers = api;
})();
