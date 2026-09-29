#!/usr/bin/env node
// Side-by-side table of result folders (arms): node compare.mjs <resultsDirA> <resultsDirB> [...]
// Per case: pass rate (graded runs only), cost/run and turns for each arm, then totals. Reads runs.jsonl.
import fs from 'node:fs';
import path from 'node:path';

const dirs = process.argv.slice(2).filter(a => !a.startsWith('-'));
if (dirs.length < 2) { console.error('usage: node compare.mjs <resultsDirA> <resultsDirB> [...]'); process.exit(1); }

const arms = dirs.map(d => {
  const file = path.join(path.resolve(d), 'runs.jsonl');
  if (!fs.existsSync(file)) { console.error(`compare.mjs: no runs.jsonl in ${d}`); process.exit(1); }
  const runs = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  return { name: runs[0]?.arm || path.basename(d), runs };
});

const avg = xs => { const v = xs.filter(x => typeof x === 'number'); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const stats = rs => {
  const graded = rs.filter(r => r.graded !== false);
  return { n: rs.length, graded: graded.length, pass: graded.filter(r => r.pass).length, cost: avg(rs.map(r => r.costUsd)), turns: avg(rs.map(r => r.turns)), total: rs.reduce((a, r) => a + (r.costUsd || 0), 0), err: rs.filter(r => r.error).length };
};
const cell = s => !s ? ['-', '-', '-'] : [
  s.graded ? `${s.pass}/${s.graded} ${Math.round(100 * s.pass / s.graded)}%` : 'n/a',
  s.cost === null ? '-' : `$${s.cost.toFixed(3)}`,
  s.turns === null ? '-' : s.turns.toFixed(1),
];

const names = [...new Set(arms.flatMap(a => a.runs.map(r => r.case)))].sort();
const head = ['case', ...arms.flatMap(a => [`${a.name} pass`, 'cost/run', 'turns'])];
const rows = names.map(n => [n, ...arms.flatMap(a => cell(stats(a.runs.filter(r => r.case === n)).n ? stats(a.runs.filter(r => r.case === n)) : null))]);
rows.push(['ALL', ...arms.flatMap(a => cell(stats(a.runs)))]);
const totals = ['total cost / errors', ...arms.flatMap(a => { const s = stats(a.runs); return [`${s.n} runs`, `$${s.total.toFixed(2)}`, `${s.err} err`]; })];
rows.push(totals);

const w = head.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i]).length)));
const line = r => `| ${r.map((c, i) => String(c).padEnd(w[i])).join(' | ')} |`;
console.log([line(head), `|${w.map(n => '-'.repeat(n + 2)).join('|')}|`, ...rows.map(line)].join('\n'));
console.log('\npass = graded runs that passed (baseline runs without an outcome check are n/a); cost = list price per run; turns = model turns per run.');
