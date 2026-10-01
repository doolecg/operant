// Task outcomes: one JSON line per finished or escalated board task, kept for 90 days, as data
// for routing from outcomes and benchmarks.
const fs = require('fs');
const { redactValues } = require('./redact');
const { writeFileAtomic } = require('./atomic-write');
const { labelOf, isFreeRoute } = require('./tier-routes');

function appendOutcome(file, entry) {
  fs.appendFileSync(file, JSON.stringify(redactValues(entry)) + '\n');
}

function parse(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (e && typeof e === 'object') out.push(e); } catch {}
  }
  return out;
}

function readOutcomes(file, { sinceMs } = {}) {
  const all = parse(file);
  return sinceMs ? all.filter(e => e.t >= sinceMs) : all;
}

// Drops entries older than keepMs; the file is rewritten only when something went.
function trimOutcomes(file, keepMs, now = Date.now()) {
  const all = parse(file);
  const kept = all.filter(e => e.t > now - keepMs);
  if (kept.length !== all.length) writeFileAtomic(file, kept.map(e => JSON.stringify(e) + '\n').join(''));
  return all.length - kept.length;
}

const total = t => t ? (t.input || 0) + (t.output || 0) + (t.cacheWrite || 0) + (t.cacheRead || 0) : 0;

// -> { "<type>": { "<tier>": { n, passed, failed, escalated, avgUsd (null if any unknown), avgTokens } } }
function summarize(entries) {
  const out = {};
  for (const e of entries) {
    if (e.kind === 'orchestration') continue; // the refiner's own usage isn't a task result
    const cell = ((out[e.type || 'other'] ||= {})[e.tier || 'none'] ||= { n: 0, passed: 0, failed: 0, escalated: 0, usd: 0, unknown: false, tokens: 0 });
    cell.n++;
    if (e.status === 'done') cell.passed++;
    else if (e.status === 'escalated') cell.escalated++;
    else cell.failed++;
    if (typeof e.usd === 'number') cell.usd += e.usd; else cell.unknown = true;
    cell.tokens += total(e.tokens);
  }
  for (const byTier of Object.values(out)) for (const [tier, c] of Object.entries(byTier)) {
    byTier[tier] = { n: c.n, passed: c.passed, failed: c.failed, escalated: c.escalated, avgUsd: c.unknown ? null : c.usd / c.n, avgTokens: c.tokens / c.n };
  }
  return out;
}

// Outcomes carry `codegraph` (first code action, files read before/after the first CodeGraph call, nudge, index state) -> what `operant usage` shows.
// { tasks, firstCodegraph (0..1), avgFilesBefore, avgFilesAfter, nudged, degraded, tokensWith, tokensWithout }
function summarizeCodegraph(entries) {
  const total = t => t ? (t.input || 0) + (t.output || 0) + (t.cacheWrite || 0) : 0;
  const list = (entries || []).filter(e => e && e.codegraph && e.kind !== 'orchestration');
  const out = { tasks: list.length, firstCodegraph: 0, avgFilesBefore: 0, avgFilesAfter: 0, nudged: 0, degraded: 0, tokensWith: null, tokensWithout: null };
  if (!list.length) return out;
  let w = [], wo = [];
  for (const e of list) {
    const g = e.codegraph;
    if (g.firstAction === 'codegraph') out.firstCodegraph++;
    out.avgFilesBefore += g.filesBefore || 0;
    out.avgFilesAfter += g.filesAfter || 0;
    if (g.nudged) out.nudged++;
    if (g.index === 'degraded') out.degraded++;
    (g.codegraphCalls > 0 ? w : wo).push(total(e.tokens));
  }
  out.firstCodegraph /= list.length;
  out.avgFilesBefore /= list.length;
  out.avgFilesAfter /= list.length;
  const avg = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null;
  out.tokensWith = avg(w); out.tokensWithout = avg(wo);
  return out;
}

// Decomposition: outcomes of tasks one lead handed out (same `lead`, each starting within `gapMs` of the last one
// still running or just done) form a group. Groups of two or more tasks are reported with their workers, total
// tokens (escalated runs included), wall time (first start to last finish) and the time the same tasks would take
// one after another. Extra tokens are estimated against one worker doing the job: the average task's tokens.
// -> { groups, workers, tokens, avgTask, extraTokens, wallMs, serialMs, latest } or null when no group qualifies.
function summarizeGroups(entries, { gapMs = 30 * 60000 } = {}) {
  const list = (entries || []).filter(e => e && e.kind !== 'orchestration' && e.lead != null && e.taskId != null && typeof e.t === 'number');
  const tasks = new Map();
  for (const e of list) { const k = e.project + '|' + e.taskId + '|' + e.lead; if (!tasks.has(k)) tasks.set(k, []); tasks.get(k).push(e); }
  const avgTask = tasks.size ? Math.round([...tasks.values()].reduce((a, es) => a + es.reduce((x, e) => x + total(e.tokens), 0), 0) / tasks.size) : 0;
  const byLead = new Map();
  for (const e of list) { const k = e.project + '|' + e.lead; if (!byLead.has(k)) byLead.set(k, []); byLead.get(k).push(e); }
  const start = e => e.t - (e.durationMs || 0);
  const groups = [];
  for (const es of byLead.values()) {
    es.sort((a, b) => start(a) - start(b));
    let cur = null;
    for (const e of es) {
      if (!cur || start(e) - cur.end > gapMs) groups.push(cur = { es: [], end: 0 });
      cur.es.push(e); cur.end = Math.max(cur.end, e.t);
    }
  }
  const out = groups.map(g => {
    const ids = new Set(g.es.map(e => e.taskId));
    const tokens = g.es.reduce((a, e) => a + total(e.tokens), 0);
    const wallMs = g.end - Math.min(...g.es.map(start));
    const serialMs = g.es.filter(e => e.status !== 'escalated').reduce((a, e) => a + (e.durationMs || 0), 0);
    return { workers: ids.size, tokens, extraTokens: tokens - avgTask, wallMs, serialMs, end: g.end };
  }).filter(g => g.workers >= 2).sort((a, b) => a.end - b.end);
  if (!out.length) return null;
  const sum = k => out.reduce((a, g) => a + g[k], 0);
  return { groups: out.length, workers: sum('workers'), tokens: sum('tokens'), avgTask, extraTokens: sum('extraTokens'), wallMs: sum('wallMs'), serialMs: sum('serialMs'), latest: out[out.length - 1] };
}

// How each kind of task went on each route (model), for the routing that stops sending a task type to a route
// that keeps failing there. -> { "<type>": { "<model>": { n, passed } } }
function summarizeRoutes(entries) {
  const out = {};
  for (const e of entries || []) {
    if (e.kind === 'orchestration' || !e.model) continue;
    const cell = ((out[e.type || 'other'] ||= {})[e.model] ||= { n: 0, passed: 0 });
    cell.n++;
    if (e.status === 'done') cell.passed++;
  }
  return out;
}

// Per tier, which route its tasks ran on, for Settings. priceFn(model, tokens) -> { usd }; paid[tier] is the model
// of the paid route a free one saved money against. -> { "<tier>": [{ route, free, tasks, tokens, usd, savedUsd, why: { "<reason>": n } }] }
function summarizeRouteUse(entries, priceFn, paid = {}) {
  const out = {};
  for (const e of entries || []) {
    if (e.kind === 'orchestration' || !e.tier || !e.model) continue;
    const list = (out[e.tier] ||= []);
    const route = e.route || labelOf({ model: e.model });
    const cell = list.find(c => c.route === route) || (list.push({ route, free: isFreeRoute({ model: e.model }), tasks: 0, tokens: 0, usd: 0, savedUsd: 0, why: {} }), list[list.length - 1]);
    cell.tasks++;
    cell.tokens += total(e.tokens);
    cell.usd += typeof e.usd === 'number' ? e.usd : 0;
    if (cell.free && paid[e.tier]) cell.savedUsd += priceFn(paid[e.tier], e.tokens).usd || 0;
    if (e.routeWhy) cell.why[e.routeWhy] = (cell.why[e.routeWhy] || 0) + 1;
  }
  return out;
}

module.exports = { appendOutcome, readOutcomes, trimOutcomes, summarize, summarizeCodegraph, summarizeGroups, summarizeRoutes, summarizeRouteUse };
