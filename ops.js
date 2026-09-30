// Operations views (2.5): what `operant doctor`, `providers`, `models` and `route explain` print. Pure over facts main.js collects
// (health rows, config, store, credentials), so the tests inject fakes. Secrets are never read into these facts, only whether they exist.
const fs = require('fs');
const os = require('os');
const path = require('path');

// The five states a doctor row shows. health.js's `available` (fine, something to act on) reads as healthy here.
const STATES = ['healthy', 'degraded', 'unavailable', 'not configured', 'unknown'];
const stateOf = s => (s === 'available' ? 'healthy' : s === 'not-configured' ? 'not configured' : STATES.includes(s) ? s : 'unknown');
const RANK = { unavailable: 4, degraded: 3, unknown: 2, 'not configured': 1, healthy: 0 };

const KEY_ENV = ['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];

// Which credentials exist, never their values: Claude Code's login file, OpenCode's auth file (provider ids only), API key variables set.
function collectCredentials({ env = process.env, home = os.homedir(), exists = f => fs.existsSync(f), readJson = f => JSON.parse(fs.readFileSync(f, 'utf8')) } = {}) {
  const claudeFile = path.join(home, '.claude', '.credentials.json');
  const ocFile = path.join(home, '.local', 'share', 'opencode', 'auth.json');
  let ocProviders = [];
  try { if (exists(ocFile)) ocProviders = Object.keys(readJson(ocFile) || {}); } catch { /* unreadable: reads as none */ }
  return { claudeLogin: !!exists(claudeFile), opencodeProviders: ocProviders, keys: KEY_ENV.filter(k => env[k]) };
}

const row = (id, name, state, detail) => ({ id, name, state, detail });

function credentialRows(c) {
  if (!c) return [row('credentials', 'Credentials', 'unknown', 'not checked')];
  const claude = c.claudeLogin || c.keys.includes('ANTHROPIC_API_KEY');
  return [
    claude ? row('cred:claude', 'Claude credentials', 'healthy', `present (${c.claudeLogin ? 'Claude Code login' : 'ANTHROPIC_API_KEY'})`) : row('cred:claude', 'Claude credentials', 'not configured', 'no Claude Code login or ANTHROPIC_API_KEY found'),
    c.opencodeProviders.length ? row('cred:opencode', 'OpenCode credentials', 'healthy', `present for ${c.opencodeProviders.join(', ')}`)
      : row('cred:opencode', 'OpenCode credentials', c.keys.some(k => k !== 'ANTHROPIC_API_KEY') ? 'healthy' : 'not configured', c.keys.some(k => k !== 'ANTHROPIC_API_KEY') ? `key variable set: ${c.keys.filter(k => k !== 'ANTHROPIC_API_KEY').join(', ')}` : 'no OpenCode login or provider key found (free models need none)'),
  ];
}

// facts: { health: [{ id, name, state, detail }] (health.js components), versions: { name: text }, credentials, store, contextProviders, models: routeHealth summary }.
function buildDoctor(f) {
  const rows = (f.health || []).map(c => row(c.id, c.name, stateOf(c.state), c.detail));
  rows.push(...credentialRows(f.credentials));
  const v = Object.entries(f.versions || {}).filter(([, x]) => x);
  rows.push(row('versions', 'Versions', v.length ? 'healthy' : 'unknown', v.length ? v.map(([k, x]) => `${k} ${x}`).join(' · ') : 'not read'));
  const s = f.store;
  rows.push(!s ? row('store', 'Local store', 'unavailable', 'the store did not open; routing and stats have no history')
    : row('store', 'Local store', 'healthy', `schema ${s.version}, ${Object.entries(s.rows || {}).filter(([, n]) => n).map(([t, n]) => `${t} ${n}`).join(', ') || 'no rows yet'}${s.pruned ? `, ${s.pruned} old rows pruned at open` : ''}`));
  const cp = f.contextProviders;
  rows.push(!cp ? row('context', 'Context providers', 'unknown', 'not checked') : row('context', 'Context providers', cp.codegraph ? 'healthy' : 'degraded',
    Object.entries(cp).map(([k, ok]) => `${k} ${ok ? 'ok' : 'missing'}`).join(', ') + (cp.codegraph ? '' : ' (questions fall back to ripgrep, then manual)')));
  return rows;
}

function formatDoctor(rows) {
  const width = Math.max(...rows.map(r => r.name.length), 4);
  const worst = rows.reduce((w, r) => (RANK[r.state] > RANK[w] ? r.state : w), 'healthy');
  const count = Object.fromEntries(STATES.map(s => [s, rows.filter(r => r.state === s).length]));
  return [...rows.map(r => `${r.state.padEnd(14)} ${r.name.padEnd(width)}  ${r.detail}`), '',
    `overall: ${worst} (${STATES.filter(s => count[s]).map(s => `${count[s]} ${s}`).join(', ')})`].join('\n');
}

// providers: one line each for the configured agent CLIs and the model route health. facts: { agents: [{ id, name, command }], installed, credentials, health }.
function providersList(f) {
  const cred = f.credentials || {};
  return (f.agents || []).map(a => {
    const exe = String(a.command || '').trim().split(/\s+/)[0];
    const inst = f.installed ? f.installed[a.id] : undefined;
    const kind = /claude/i.test(a.id + exe) ? 'claude' : /opencode/i.test(a.id + exe) ? 'opencode' : 'other';
    const creds = kind === 'claude' ? (cred.claudeLogin || (cred.keys || []).includes('ANTHROPIC_API_KEY')) : kind === 'opencode' ? (cred.opencodeProviders || []).length > 0 || (cred.keys || []).some(k => k !== 'ANTHROPIC_API_KEY') : null;
    const state = !exe ? 'not configured' : inst === false ? 'unavailable' : inst === true ? (creds === false ? 'degraded' : 'healthy') : 'unknown';
    return { id: a.id, name: a.name || a.id, command: exe || null, installed: inst ?? null, credentials: creds, state };
  });
}
const formatProviders = list => (list.length ? list.map(p => `${p.state.padEnd(14)} ${p.name}  ${p.command || '-'}  ${p.installed === false ? 'not installed' : p.installed ? 'installed' : 'not looked for'}${p.credentials === true ? ', credentials present' : p.credentials === false ? ', no credentials found' : ''}`).join('\n') : 'no agent CLIs configured');

// models: the team tiers with the recorded health of the model each runs on (route-health.js summarize).
function modelsList({ tiers = [], routeHealth = {} }) {
  return tiers.map(t => {
    const h = routeHealth[t.model] || null;
    const state = !t.active ? 'unavailable' : h && h.down ? 'degraded' : t.active.fallback ? 'degraded' : h ? 'healthy' : 'unknown';
    return { tier: t.name, agent: t.agent || null, model: t.model || null, state, calls: h ? h.n : 0, availability: h ? Math.round(h.availability * 100) : null, avgLatencyMs: h ? h.avgLatencyMs : null, down: h && h.down ? h.down.reason : null };
  });
}
const formatModels = list => (list.length ? list.map(m => `${m.state.padEnd(14)} ${m.tier.padEnd(7)} ${[m.agent, m.model].filter(Boolean).join(' · ') || '-'}  ${m.calls ? `${m.availability}% ok over ${m.calls} calls${m.avgLatencyMs != null ? `, ~${Math.round(m.avgLatencyMs / 1000)} s` : ''}` : 'no calls recorded'}${m.down ? `, ${m.down}` : ''}`).join('\n') : 'no tiers set up');

// The stored structured reason of one decision (a routingDecisions row) as text.
function formatExplain(d, taskId) {
  if (!d) return `no routing decision stored for task ${taskId}`;
  const s = d.structured || {}, c = s.chosen || {};
  const L = [`task ${taskId}: ${d.tier || (d.strategy && d.strategy.tier) || '?'}${d.model ? ` (${d.model})` : ''} · ${d.strategy?.basis || s.basis || 'explicit'}`];
  if (d.reason) L.push(`reason: ${d.reason}`);
  if (d.inputs) L.push(`inputs: ${Object.entries(d.inputs).filter(([, v]) => v != null).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (c.tier) L.push(`chosen: ${c.tier}, p(success) ${c.p}${c.evidence === false ? ' (default, under ' + (s.minTasks || 5) + ' tasks of evidence)' : ` from ${c.n} tasks (${c.scope || 'all projects'})`}, utility ${c.utility}`);
  const r = d.rejected || s.rejected;
  if (r) L.push(`rejected: ${r.tier}, utility ${r.utility} (${r.why})`);
  if (s.override) L.push(`override: ${s.override.scope}${s.override.until ? ' until ' + new Date(s.override.until).toISOString() : ', no end'}`);
  if (s.risk) L.push(`risk: ${s.risk}${s.risk === 'high' ? ' (never explored)' : ''}`);
  const alts = (d.alternatives || []).filter(a => a && a.tier);
  if (alts.length) L.push('alternatives: ' + alts.map(a => `${a.tier} n=${a.n} p=${a.p ?? a.rate} $${a.costUsd ?? '?'} u=${a.utility ?? '?'}`).join('; '));
  const sk = (d.strategy?.skipped || []).filter(Boolean);
  if (sk.length) L.push('skipped: ' + sk.map(x => `${x.tier || x.route} ${x.reason || x.kind || ''}`.trim()).join('; '));
  return L.join('\n');
}

module.exports = { collectCredentials, credentialRows, buildDoctor, formatDoctor, providersList, formatProviders, modelsList, formatModels, formatExplain, stateOf, STATES };
