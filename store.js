// Versioned local database (2.5): JSON-lines tables under <userData>/store, one file per table, plus meta.json with the
// schema version. Migrations run when the store opens, records are scoped by project and carry correlation ids
// (`corr` ties task -> worker -> result), and records older than the retention window are pruned at open.
// node:sqlite is not relied on: Electron ships its own Node, and plain files need no dependency.
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./atomic-write');
const { classify, ROUTE_KINDS } = require('./failure-class');

const DAY = 86400e3;
const DEFAULT_KEEP_MS = 90 * DAY;
const TABLES = ['taskRuns', 'modelRuns', 'tokenEvents', 'routingDecisions', 'toolCalls', 'verificationRuns', 'failures', 'providerCalls'];

// MIGRATIONS[i] takes the store from schema version i to i+1. ctx: { dir, table(name) -> file, read(name), write(name, rows) }.
const MIGRATIONS = [
  ctx => { for (const t of TABLES) { const f = ctx.table(t); if (!fs.existsSync(f)) fs.writeFileSync(f, ''); } },
];

function parseLines(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (e && typeof e === 'object' && !Array.isArray(e)) out.push(e); } catch {}
  }
  return out;
}

let seq = 0;
// A short unique id: time in base 36 plus a counter, so ids made in one millisecond still differ.
const newId = (prefix = 'id', now = Date.now()) => `${prefix}-${now.toString(36)}${(seq = (seq + 1) % 1296).toString(36).padStart(2, '0')}`;
// The correlation id of one task: every decision, run and result of it shares it.
const corrOf = (project, taskId) => `${project || '-'}:${taskId}`;

// options: { migrations, keepMs, now }
function openStore(dir, { migrations = MIGRATIONS, keepMs = DEFAULT_KEEP_MS, now = Date.now } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const fileOf = t => path.join(dir, t + '.jsonl');
  const metaFile = path.join(dir, 'meta.json');
  let meta = { schemaVersion: 0 };
  try { meta = { ...meta, ...JSON.parse(fs.readFileSync(metaFile, 'utf8')) }; } catch {}
  const target = migrations.length;
  if (meta.schemaVersion > target) throw new Error(`the store is schema ${meta.schemaVersion}, newer than this Operant understands (${target})`);
  const ctx = { dir, table: fileOf, read: t => parseLines(fileOf(t)), write: (t, rows) => writeFileAtomic(fileOf(t), rows.map(r => JSON.stringify(r) + '\n').join('')) };
  const migrated = [];
  for (let v = meta.schemaVersion; v < target; v++) {
    migrations[v](ctx);
    meta.schemaVersion = v + 1;
    migrated.push(v + 1);
    writeFileAtomic(metaFile, JSON.stringify(meta));
  }

  const store = {
    dir, version: () => meta.schemaVersion, migrated, tables: TABLES,
    // Rows of one table, newest last. filter: { project, corr, sinceMs, where(row) }, limit keeps the newest N.
    query(table, { project, corr, sinceMs, where, limit } = {}) {
      let rows = parseLines(fileOf(table));
      if (project) rows = rows.filter(r => r.project === project);
      if (corr) rows = rows.filter(r => r.corr === corr);
      if (sinceMs) rows = rows.filter(r => r.t >= sinceMs);
      if (where) rows = rows.filter(where);
      return limit ? rows.slice(-limit) : rows;
    },
    append(table, row) {
      if (!TABLES.includes(table)) throw new Error(`unknown table "${table}"`);
      const rec = { id: newId(table.slice(0, 3), now()), t: now(), v: meta.schemaVersion, ...row };
      fs.appendFileSync(fileOf(table), JSON.stringify(rec) + '\n');
      return rec;
    },
    // Drops rows older than keepMs from every table; a file is rewritten only when something goes. -> rows removed.
    prune(keep = keepMs) {
      let removed = 0;
      for (const t of TABLES) {
        const all = parseLines(fileOf(t)), kept = all.filter(r => typeof r.t === 'number' && r.t > now() - keep);
        if (kept.length !== all.length) { ctx.write(t, kept); removed += all.length - kept.length; }
      }
      return removed;
    },
    count: table => parseLines(fileOf(table)).length,
  };
  store.pruned = store.prune();
  return store;
}

// Feeds one outcomes.jsonl entry (outcomes.js) into the tables: the task run, its model run, token event, tool calls, verification
// run, failure (classified) and the provider call routing health reads. -> the failure classification or null.
function feedOutcome(store, e) {
  if (!e || e.kind === 'orchestration') return null;
  const base = { t: e.t, project: e.project || null, corr: e.corr || corrOf(e.project, e.taskId), taskId: e.taskId ?? null, workerId: e.workerId ?? null };
  store.append('taskRuns', { ...base, type: e.type, tier: e.tier, agent: e.agent, model: e.model, status: e.status, attempts: e.attempts, escalations: e.escalations, durationMs: e.durationMs ?? null, route: e.route || null, lead: e.lead ?? null });
  if (e.model) store.append('modelRuns', { ...base, model: e.model, agent: e.agent, tier: e.tier, durationMs: e.durationMs ?? null, usd: typeof e.usd === 'number' ? e.usd : null });
  if (e.tokens) store.append('tokenEvents', { ...base, model: e.model || null, tier: e.tier, ...e.tokens });
  if (e.codegraph) store.append('toolCalls', { ...base, tool: 'codegraph', calls: e.codegraph.codegraphCalls || 0, firstAction: e.codegraph.firstAction || null, index: e.codegraph.index || null });
  if (e.check) store.append('verificationRuns', { ...base, ok: !!e.check.ok, command: e.check.command || null });
  const bad = e.status && e.status !== 'done';
  const failure = e.failureClass || (bad ? classify({ note: e.reason, check: e.check, stuck: e.stuck }) : null);
  if (bad && failure) store.append('failures', { ...base, status: e.status, kind: failure.kind, evidence: failure.evidence });
  if (e.model) {
    const routeKind = failure && ROUTE_KINDS.includes(failure.kind) ? failure.kind : null;
    store.append('providerCalls', { ...base, key: e.model, provider: e.agent || null, ok: !routeKind, kind: routeKind, latencyMs: !routeKind ? e.durationMs ?? null : null });
  }
  return bad ? failure : null;
}

module.exports = { feedOutcome, openStore, newId, corrOf, MIGRATIONS, TABLES, DEFAULT_KEEP_MS };
