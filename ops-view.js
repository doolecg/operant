(function () {
// The Operations tab of the Usage view (2.5): HTML for the figures analytics.js summarizes, the health states, memory and
// context. Pure: data in, string out, so the tests can read it; every value from outside goes through esc().
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const k = n => (Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.abs(n) >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n || 0)));
const pct = x => Math.round((x || 0) * 100) + '%';
const usd = v => '$' + (v || 0).toFixed(v >= 10 ? 0 : 2);
const secs = ms => (ms == null ? '-' : ms >= 60e3 ? (ms / 60e3).toFixed(1) + ' min' : Math.round(ms / 1e3) + ' s');
const STATE_TEXT = { healthy: 'Healthy', degraded: 'Degraded', unavailable: 'Unavailable', 'not configured': 'Not configured', unknown: 'Unknown' };
const STATE_CLASS = { healthy: 'healthy', degraded: 'degraded', unavailable: 'unavailable', 'not configured': 'not-configured', unknown: 'unknown' };

const table = (head, rows) => rows.length
  ? `<table class="ops-table"><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
  : '<div class="ops-none">Nothing recorded yet</div>';
const section = (id, title, body) => `<section class="ops-sec" data-ops="${id}"><h3>${esc(title)}</h3>${body}</section>`;
const tile = (label, value, sub) => `<div class="ops-tile"><span class="ops-val">${esc(value)}</span><span class="ops-lbl">${esc(label)}</span>${sub ? `<span class="ops-sub">${esc(sub)}</span>` : ''}</div>`;

// d: { days, stats (analytics.summarize), health: [{ name, state, detail }], contextProviders, routes (route-health summary), decisions, store }
function render(d) {
  if (!d || d.error) return `<div class="ops-none">${esc(d && d.error ? d.error : 'Nothing to show yet')}</div>`;
  const s = d.stats, t = s.tasks;
  const out = [];
  out.push(section('overview', `Overview · last ${d.days} days`, `<div class="ops-tiles">${[
    tile('tasks', t.n, `${pct(t.passRate)} passed`), tile('retries', t.retries, `${pct(t.retryRate)} of tasks`), tile('escalated', pct(t.escalationRate)),
    tile('net tokens saved', k(s.savings.netTokens), `gross ${k(s.savings.grossTokens)} − Operant ${k(s.savings.ownTokens)}`), tile('cost', usd(s.cost.usd), `Operant itself ${usd(s.operant.usd)}`),
    tile('routing decisions', d.decisions || 0)].join('')}</div>`));
  out.push(section('models', 'Models', table(['Model', 'Tasks', 'Passed', 'Cost', 'Tokens', 'Wasted', 'Latency'], s.models.map(m => [m.model, m.tasks, pct(m.passRate), usd(m.usd), k(m.tokens), `${k(m.wastedTokens)} (${pct(m.wasteRate)})`, secs(m.avgLatencyMs)]))));
  out.push(section('providers', 'Providers', table(['Provider', 'Calls', 'Errors', 'Latency', 'Kinds'], s.providers.map(p => [p.provider, p.calls, `${p.errors} (${pct(p.errorRate)})`, secs(p.avgLatencyMs), Object.entries(p.kinds).map(([a, b]) => `${a} ${b}`).join(', ') || '-']))));
  out.push(section('tokens', 'Tokens', table(['Input', 'Output', 'Cache read', 'Cache write', 'Total'], [[k(s.tokens.input), k(s.tokens.output), k(s.tokens.cacheRead), k(s.tokens.cacheWrite), k(s.tokens.total)]]) + table(['Tier', 'Tokens'], Object.entries(s.tokens.byTier).map(([a, b]) => [a, k(b)]))));
  out.push(section('cost', 'Cost', table(['Tier', 'Cost'], Object.entries(s.cost.byTier).map(([a, b]) => [a, usd(b)]))));
  out.push(section('latency', 'Latency', table(['Runs', 'Average', 'Median', '95th percentile'], s.latency.n ? [[s.latency.n, secs(s.latency.avgMs), secs(s.latency.p50Ms), secs(s.latency.p95Ms)]] : [])));
  out.push(section('failures', 'Failures', table(['Kind', 'Count'], s.failures.map(f => [f.kind, f.n])) + (s.retryHotSpots.length ? table(['Retry hot spot', 'Tier', 'Retries', 'Tasks'], s.retryHotSpots.map(h => [h.type, h.tier || '-', h.retries, h.tasks])) : '')));
  const st = d.store;
  out.push(section('memory', 'Memory', `<div class="ops-note">${esc((d.health.find(h => h.id === 'memory') || {}).detail || 'Not checked yet')}</div>`
    + (st ? `<div class="ops-note">Local store schema ${esc(st.version)}, ${esc(Object.values(st.rows || {}).reduce((a, b) => a + b, 0))} rows</div>` : '')));
  const cp = Object.entries(d.contextProviders || {});
  out.push(section('context', 'Context', table(['Provider', 'Used', 'Called', 'Rate'], cp.map(([p, v]) => [p, v.used, v.called, pct(v.rate)]))
    + `<div class="ops-note">Unused integrations: ${esc(s.unusedIntegrations.length ? s.unusedIntegrations.join(', ') : 'none')}</div>`));
  out.push(section('health', 'Health', `<div class="ops-health">${(d.health || []).map(h => `<div class="ops-hrow"><i class="hdot ${STATE_CLASS[h.state] || 'unknown'}"></i><span class="ops-hname">${esc(h.name)} · ${esc(STATE_TEXT[h.state] || h.state)}</span><span class="ops-hdetail">${esc(h.detail)}</span></div>`).join('') || '<div class="ops-none">Not checked yet</div>'}</div>`));
  return out.join('');
}

const api = { render, esc };
if (typeof module !== 'undefined') module.exports = api; else globalThis.OpsView = api;
})();
