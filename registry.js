// Registries (2.6): what Operant is built on and what it can route to, as information only. Nothing here installs,
// downloads or changes anything. The component registry joins the live health rows (health.js) with an evaluation
// record per component (decision, reason, security note); records are kept in a small file the user can update
// (`operant components set`). The model registry lists each model the tiers, OpenCode and the local model expose.
const pricing = require('./pricing');
const localModel = require('./local-model');
const setup = require('./local-setup');

const DECISIONS = ['adopted', 'optional', 'evaluating', 'rejected'];

// Evaluation records shipped with Operant. `capabilities` is what Operant uses the component for.
const DEFAULT_RECORDS = {
  codegraph: { decision: 'adopted', capabilities: ['code search', 'call paths', 'blast radius'], reason: 'Open source code index; one query replaces a grep and read loop, so workers read less.', security: 'Runs locally on the project folder; no network; the index stays in .codegraph.' },
  agents: { decision: 'adopted', capabilities: ['Claude Code', 'OpenCode', 'other agent CLIs'], reason: 'The agent CLIs are the workers; Operant only launches them.', security: 'Each CLI keeps its own login; Operant never reads or stores the keys.' },
  models: { decision: 'adopted', capabilities: ['team tiers', 'capability routing'], reason: 'Tier models decide cost and quality of each task.', security: 'Model ids only; no credentials.' },
  localmodel: { decision: 'optional', capabilities: ['classify', 'summarise', 'free-tier fallback'], reason: 'Ollama with a small open model, ~3 GB, ask first; a helper for cheap classification and the fallback tier, never a refiner.', security: 'Serves on localhost only; nothing leaves the machine.' },
  mcp: { decision: 'optional', capabilities: ['tool servers'], reason: 'Configured by the user in their agents; Operant reports their state.', security: 'Third-party code the user chose; turn off with the third-party integrations switch.' },
  memory: { decision: 'adopted', capabilities: ['shared project memory', 'recall'], reason: 'Plain Markdown facts shared by every agent of a project.', security: 'Stored on disk as text; secrets are redacted before they are written.' },
  analytics: { decision: 'adopted', capabilities: ['usage', 'cost', 'routing evidence'], reason: 'Local store of task outcomes for routing and stats.', security: 'Local only; nothing is sent anywhere; redacted at write; retention setting applies.' },
  backups: { decision: 'adopted', capabilities: ['state backup', 'skills backup'], reason: 'Restorable copy of settings and skills.', security: 'Keys, tokens and passwords are left out of backups.' },
  updates: { decision: 'adopted', capabilities: ['release check', 'installer download'], reason: 'Operant\'s own GitHub releases.', security: 'Downloads from the repository\'s releases over HTTPS.' },
  app: { decision: 'adopted', capabilities: ['workspace'], reason: 'Operant itself.', security: 'No telemetry.' },
  config: { decision: 'adopted', capabilities: ['settings'], reason: 'config.json holds only what the user changed.', security: 'Keys and tokens are redacted from anything written from it.' },
};

// rows: health.js components; records: user-updated evaluation records ({ [id]: { decision, reason, security, capabilities } }).
// -> [{ id, name, installed, available, healthy, state, capabilities, lastChecked, decision, reason, security }]
function componentRegistry({ rows = [], records = {} } = {}) {
  const ids = [...new Set([...rows.map(r => r.id), ...Object.keys(DEFAULT_RECORDS)])];
  return ids.map(id => {
    const r = rows.find(x => x.id === id) || null;
    const rec = { ...(DEFAULT_RECORDS[id] || {}), ...(records[id] || {}) };
    const state = r ? r.state : 'unknown';
    return {
      id, name: r ? r.name : id, state,
      installed: !r ? null : state === 'unavailable' ? false : state === 'unknown' ? null : state !== 'not-configured',
      available: !r ? null : ['healthy', 'available', 'degraded'].includes(state),
      healthy: !r ? null : state === 'healthy' || state === 'available',
      capabilities: Array.isArray(rec.capabilities) ? rec.capabilities : [],
      lastChecked: (r && r.checkedAt) || null,
      decision: DECISIONS.includes(rec.decision) ? rec.decision : 'evaluating',
      reason: rec.reason || 'not evaluated yet',
      security: rec.security || 'not reviewed yet',
    };
  });
}

// One line each; the security note is on the next line so it is read, not skipped.
function formatComponents(list) {
  if (!list.length) return 'no components';
  const yn = v => (v == null ? '?' : v ? 'yes' : 'no');
  return list.map(c => [
    `${c.state.padEnd(14)} ${c.name}  [${c.decision}]  installed ${yn(c.installed)}, available ${yn(c.available)}, healthy ${yn(c.healthy)}${c.lastChecked ? `, checked ${new Date(c.lastChecked).toISOString().slice(0, 16).replace('T', ' ')}` : ', never checked'}`,
    `${' '.repeat(15)}capabilities: ${c.capabilities.join(', ') || '-'}`,
    `${' '.repeat(15)}why: ${c.reason}`,
    `${' '.repeat(15)}security: ${c.security}`,
  ].join('\n')).join('\n');
}

// Keeps the record file's shape: only known decisions, short strings. -> the new records object.
function withRecord(records, id, patch) {
  const cur = { ...(records || {}) };
  const p = {};
  if (patch.decision != null) { if (!DECISIONS.includes(patch.decision)) throw new Error(`decision must be one of: ${DECISIONS.join(', ')}`); p.decision = patch.decision; }
  for (const k of ['reason', 'security']) if (patch[k] != null) p[k] = String(patch[k]).slice(0, 400);
  if (patch.capabilities != null) p.capabilities = String(patch.capabilities).split(',').map(s => s.trim()).filter(Boolean).slice(0, 12);
  cur[id] = { ...(cur[id] || {}), ...p };
  return cur;
}

const costTier = (p, free) => (free ? 'free' : !p ? null : p.input <= 1 ? 'low' : p.input <= 3 ? 'medium' : 'high');

// One entry: { id, provider, contextWindow, tools, reasoning, costTier, source, tiers }. Fields Operant has no data for are null.
function entry(id, provider, extra = {}) {
  const free = pricing.isFreeModel(id);
  const row = pricing.TABLE.find(([re]) => re.test(pricing.normalize(id)));
  return { id, provider, contextWindow: null, tools: null, reasoning: null, costTier: costTier(row && row[1], free), source: 'team tiers', tiers: [], ...extra };
}

// tiers: [{ name, agent, model, effort }] (team tiers); opencodeModels: parsed `opencode models --verbose` or null;
// local: { model, status } (local-model.js state) or null.
function modelRegistry({ tiers = [], opencodeModels = null, local = null } = {}) {
  const map = new Map();
  const put = (id, provider, extra) => { const cur = map.get(id); map.set(id, cur ? { ...cur, ...Object.fromEntries(Object.entries(extra || {}).filter(([, v]) => v != null)) } : entry(id, provider, extra)); return map.get(id); };
  for (const m of opencodeModels || []) {
    const cost = m.cost || {}, free = !(cost.input > 0 || cost.output > 0);
    put(`${m.providerID}/${m.id}`, m.providerID, { contextWindow: m.limit?.context ?? null, tools: m.capabilities?.toolcall ?? m.tool_call ?? null,
      reasoning: m.capabilities?.reasoning ?? m.reasoning ?? (Object.keys(m.variants || {}).length > 0 || null), costTier: free ? 'free' : cost.input <= 1 ? 'low' : cost.input <= 3 ? 'medium' : 'high', source: 'opencode' });
  }
  if (local) {
    const info = setup.MODEL_INFO[local.model] || {};
    put(`ollama/${local.model}`, 'ollama', { costTier: 'free', tools: false, source: 'local model', installed: local.status === 'ready', diskBytes: info.bytes ?? null });
  } else for (const m of localModel.MODELS) put(`ollama/${m}`, 'ollama', { costTier: 'free', tools: false, source: 'local model', installed: false, diskBytes: (setup.MODEL_INFO[m] || {}).bytes ?? null });
  for (const t of tiers) {
    if (!t.model) continue;
    const e = put(t.model, String(t.model).includes('/') ? String(t.model).split('/')[0] : (t.agent || null));
    e.tiers = [...new Set([...e.tiers, t.name])];
    if (t.effort && e.reasoning == null) e.reasoning = true;
  }
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function formatModelRegistry(list) {
  if (!list.length) return 'no models known';
  const v = x => (x == null ? '?' : x === true ? 'yes' : x === false ? 'no' : x);
  return list.map(m => `${m.id}  provider ${m.provider || '?'}  cost ${m.costTier || '?'}  context ${m.contextWindow ? Math.round(m.contextWindow / 1000) + 'k' : '?'}  tools ${v(m.tools)}  reasoning ${v(m.reasoning)}${m.tiers.length ? `  tiers ${m.tiers.join(', ')}` : ''}${m.installed === false ? '  (not installed)' : ''}`).join('\n');
}

module.exports = { componentRegistry, formatComponents, withRecord, modelRegistry, formatModelRegistry, DEFAULT_RECORDS, DECISIONS };
