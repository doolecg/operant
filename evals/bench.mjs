// Benchmarks and baselines: a replayable task set per category (evals/bench/<category>.json). Each task names a
// synthetic fixture and holds recorded results for two arms, the agent's normal tools (baseline) and Operant.
// `node run.mjs --bench` replays them (no model call, no spend) and prints, per category: gross tokens, net tokens
// saved (gross saved minus Operant's own overhead), cost, success and retries. Nothing here starts a session.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BENCH_DIR = path.join(HERE, 'bench');
export const CATEGORIES = ['simple-coding', 'medium-coding', 'complex-coding', 'debugging', 'refactor', 'exploration', 'docs', 'tests'];
const ARMS = ['baseline', 'operant'];

export function loadBench(dir = BENCH_DIR) {
  const sets = [];
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json')).sort()) {
    const set = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const t of set.tasks || []) for (const arm of ARMS) {
      const r = t.runs && t.runs[arm];
      if (!r || !['gross', 'cost', 'success', 'retries'].every(k => k in r)) throw new Error(`${f}: task "${t.id}" lacks a complete "${arm}" run`);
    }
    sets.push(set);
  }
  return sets.sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category));
}

const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);
// One row per category: totals per arm, and the net saving = baseline gross - Operant gross - Operant overhead.
export function summarizeBench(sets) {
  return sets.map(set => {
    const ts = set.tasks || [], arm = a => ({
      gross: sum(ts, t => t.runs[a].gross), cost: sum(ts, t => t.runs[a].cost), retries: sum(ts, t => t.runs[a].retries),
      success: ts.length ? sum(ts, t => (t.runs[a].success ? 1 : 0)) / ts.length : 0,
    });
    const baseline = arm('baseline'), operant = arm('operant'), overhead = sum(ts, t => t.runs.operant.overhead || 0);
    return { category: set.category, tasks: ts.length, baseline, operant: { ...operant, overhead }, netTokens: baseline.gross - operant.gross - overhead, grossTokens: baseline.gross - operant.gross };
  });
}

const k = n => (Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const pct = x => `${Math.round(x * 100)}%`;
export function formatBench(rows) {
  const head = ['category', 'tasks', 'gross saved', 'net saved', 'cost base', 'cost operant', 'success base', 'success operant', 'retries base', 'retries operant'];
  const body = rows.map(r => [r.category, r.tasks, k(r.grossTokens), k(r.netTokens), `$${r.baseline.cost.toFixed(2)}`, `$${r.operant.cost.toFixed(2)}`, pct(r.baseline.success), pct(r.operant.success), r.baseline.retries, r.operant.retries].map(String));
  const w = head.map((h, i) => Math.max(h.length, ...body.map(b => b[i].length)));
  const line = cells => cells.map((c, i) => c.padEnd(w[i])).join('  ').trimEnd();
  return [line(head), ...body.map(line), '', 'Replayed from synthetic recorded runs (evals/bench); no model was called.'].join('\n');
}

export function benchMain() {
  const rows = summarizeBench(loadBench());
  console.log(formatBench(rows));
  return rows;
}
