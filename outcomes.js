// Task outcomes (item 57): one JSON line per finished or escalated board task, kept for 90 days, as data
// for routing from outcomes (item 59) and benchmarks.
const fs = require('fs');
const { writeFileAtomic } = require('./atomic-write');

function appendOutcome(file, entry) {
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
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

module.exports = { appendOutcome, readOutcomes, trimOutcomes, summarize };
