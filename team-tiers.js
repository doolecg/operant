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

function activeTiers({ team, agents, defaultAgent, isOpenCode, models }) {
  const base = team?.tiers || {};
  const agent = (agents || []).find(a => a.id === defaultAgent) || (agents || [])[0];
  return agent && isOpenCode(agent) ? opencodeTiers(models, base, agent.id) : base;
}

module.exports = { parseModels, reasoningModel, opencodeTiers, activeTiers, FREE_MODEL };
