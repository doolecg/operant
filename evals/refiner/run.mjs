#!/usr/bin/env node
// Refiner eval: sends realistic prompts through refiner.refine() with the fixture repo's brief and grades what comes back
// with the rules in grade.mjs (no model grading). Free model only: OpenCode's big-pickle costs nothing.
//   node run.mjs [--cases vague,trivial] [--runs 1] [--via server|run] [--no-lean] [--json out.json]
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { TIERS, MAX_TIER, gradeCase, passed } from './grade.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const refiner = require('../../refiner.js');
const FIXTURE = path.join(HERE, '..', 'fixtures', 'node-app');
const est = t => Math.ceil(String(t || '').length / 4);

const { values: a } = parseArgs({ options: { cases: { type: 'string' }, runs: { type: 'string', default: '1' }, via: { type: 'string', default: 'server' }, 'no-lean': { type: 'boolean' }, json: { type: 'string' } } });
const cases = JSON.parse(fs.readFileSync(path.join(HERE, 'cases.json'), 'utf8')).filter(c => !a.cases || a.cases.split(',').includes(c.name));
if (!['server', 'run'].includes(a.via)) { console.error('--via must be server or run'); process.exit(2); }
const lean = !a['no-lean'];

// The fixture's own facts, as the app would gather them.
const inputs = async () => ({
  cwd: FIXTURE,
  gitState: { branch: 'main', files: ['src/sum.js'], commits: ['Add avg helper', 'Initial tinycalc'] },
  commands: { test: 'npm test', build: 'npm run build' },
  memoryFacts: ['Tests use node:test', 'Helpers live in src/, one function per file'],
});

const rows = [];
try {
  for (const c of cases) for (let i = 0; i < Number(a.runs); i++) {
    let raw = '';
    const call = a.via === 'server' ? refiner.runOpencodeFast : refiner.runOpencode;
    const provider = async args => { const r = await call({ ...args, lean }); raw = r.text; return r; };
    const t0 = Date.now();
    const out = await refiner.refine({ project: FIXTURE, prompt: c.prompt, settings: { refiner: 'opencode', refinerModel: 'opencode/big-pickle', maxTasks: 4 }, deps: { inputs, tiers: TIERS, maxTier: MAX_TIER, providers: { opencode: provider } } });
    const checks = gradeCase(c.expect, refiner.parseRefinerOutput(raw));
    const u = out.refiner.free;
    rows.push({ name: c.name, run: i + 1, pass: passed(checks), checks, tasks: out.tasks.length, question: !!out.question, promptTokens: est(c.prompt), cleanedTokens: out.refined ? est(out.refined.cleaned) : null, sentTokens: u.input, outTokens: u.output, paid: out.refiner.paid.total, ms: out.refiner.ms || Date.now() - t0, error: out.error || null });
  }
} finally { refiner.stopOpencodeServer(); }

const mark = (r, k) => (r.checks[k] ? (r.checks[k].pass ? 'ok' : 'FAIL') : '-');
const head = ['case', 'parsed', 'keep', 'tasks', 'picks', 'cheap/min', 'question', 'prompt>clean', 'sent/out tok', 'ms'];
const table = rows.map(r => [r.name + (rows.some(x => x !== r && x.name === r.name) ? `#${r.run}` : ''), mark(r, 'parsed'), mark(r, 'keep'), mark(r, 'tasks') + (r.checks.tasks ? ` (${r.tasks})` : ''), mark(r, 'picks'), r.checks.cheap ? mark(r, 'cheap') : r.checks.minTier ? mark(r, 'minTier') : '-', mark(r, 'question'), `${r.promptTokens}>${r.cleanedTokens ?? '-'}`, `${r.sentTokens}/${r.outTokens}`, String(r.ms)]);
const w = head.map((h, i) => Math.max(h.length, ...table.map(t => t[i].length)));
const line = cells => cells.map((c, i) => c.padEnd(w[i])).join('  ');
console.log(line(head)); console.log(line(w.map(n => '-'.repeat(n))));
for (const t of table) console.log(line(t));
const fails = rows.flatMap(r => Object.entries(r.checks).filter(([, c]) => !c.pass).map(([k, c]) => `${r.name}#${r.run} ${k}: ${c.note}`));
if (fails.length) console.log('\nFailed checks:\n' + fails.map(f => '  ' + f).join('\n'));
const errs = rows.filter(r => r.error).map(r => `${r.name}#${r.run}: ${r.error}`);
if (errs.length) console.log('\nRefiner errors:\n' + errs.map(f => '  ' + f).join('\n'));
const sum = k => rows.reduce((s, r) => s + (r[k] || 0), 0);
console.log(`\n${rows.filter(r => r.pass).length}/${rows.length} passed; via ${a.via}, ${lean ? 'lean' : 'default'} OpenCode config; ${sum('sentTokens')} free tokens sent, ${sum('outTokens')} received, ${sum('paid')} paid; ${Math.round(sum('ms') / Math.max(rows.length, 1))} ms per refine`);
if (a.json) fs.writeFileSync(a.json, JSON.stringify(rows, null, 2));
process.exit(rows.every(r => r.pass) ? 0 : 1);
