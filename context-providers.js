// Context provider selection (plan 2.4 part 2): which source answers a question, by its shape, and what
// to use when that provider is missing. Chains degrade CodeGraph -> ripgrep -> manual (reading files by
// hand); memory and git fall back the same way. Usefulness counters (called / used per provider) are kept
// in `<project>/.operant/context-providers.json` so `operant usage` can report them.
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./atomic-write');

const PROVIDERS = ['codegraph', 'memory', 'git', 'ripgrep'];
const CHAINS = {
  codegraph: ['codegraph', 'ripgrep', 'manual'],
  memory: ['memory', 'ripgrep', 'manual'],
  git: ['git', 'manual'],
  ripgrep: ['ripgrep', 'manual'],
};

const GIT_SHAPE = /\b(commits?|diff|blame|branch(es)?|history|changed|changes|who (changed|wrote|touched)|since|regress\w*|merge|reverted?)\b/i;
const MEMORY_SHAPE = /\b(prefer\w*|decid\w*|remember\w*|convention|last time|we agreed|our rule|policy|gotcha|why did we|user wants)\b/i;
const GRAPH_SHAPE = /\b(callers?|callees?|calls?|who uses|used by|references?|definition|defined|implements?|extends|overrides?|depends? on|blast radius|call path|how does .+ work)\b/i;
const IDENTIFIER = /\b[a-z]+[A-Z]\w*\b|\b\w+_\w+\b|\b\w+\(\)|\b[A-Z][a-z]+[A-Z]\w*\b/;
const LITERAL_SHAPE = /"[^"]+"|'[^']+'|`[^`]+`|\b(todo|fixme|error message|string|regex|grep|find all|occurrences?)\b|\*\.\w+/i;

// The provider a question wants, ignoring what is installed: 'git' | 'memory' | 'codegraph' | 'ripgrep'.
function shapeOf(question) {
  const q = String(question || '');
  if (GIT_SHAPE.test(q)) return 'git';
  if (GRAPH_SHAPE.test(q) || IDENTIFIER.test(q)) return 'codegraph';
  if (MEMORY_SHAPE.test(q)) return 'memory';
  if (LITERAL_SHAPE.test(q)) return 'ripgrep';
  return 'ripgrep';
}

// choose(question, { available }) -> { wanted, provider, chain, degraded }
// available: { codegraph, memory, git, ripgrep } booleans; anything not listed as false counts as present.
// `manual` is always available. `degraded` is true when the provider used is not the one the question wanted.
function choose(question, { available = {} } = {}) {
  const wanted = shapeOf(question);
  const chain = CHAINS[wanted];
  const provider = chain.find(p => p === 'manual' || available[p] !== false);
  return { wanted, provider, chain, degraded: provider !== wanted };
}

const statsFile = cwd => path.join(cwd, '.operant', 'context-providers.json');
function readStats(cwd) {
  let o = {};
  try { o = JSON.parse(fs.readFileSync(statsFile(cwd), 'utf8')); } catch { /* none yet */ }
  const out = {};
  for (const p of [...PROVIDERS, 'manual']) {
    const s = o && o[p] || {};
    const called = Math.max(0, Number(s.called) || 0), used = Math.max(0, Number(s.used) || 0);
    if (called || used) out[p] = { called, used, rate: called ? Math.min(1, used / called) : 0 };
  }
  return out;
}
function bump(cwd, provider, field) {
  if (!cwd || ![...PROVIDERS, 'manual'].includes(provider)) return;
  try {
    const raw = {};
    const cur = readStats(cwd);
    for (const [p, s] of Object.entries(cur)) raw[p] = { called: s.called, used: s.used };
    raw[provider] = { called: 0, used: 0, ...raw[provider] };
    raw[provider][field]++;
    fs.mkdirSync(path.join(cwd, '.operant'), { recursive: true });
    writeFileAtomic(statsFile(cwd), JSON.stringify(raw));
  } catch { /* counters are best effort */ }
}
const recordCall = (cwd, provider) => bump(cwd, provider, 'called');
const recordUse = (cwd, provider) => bump(cwd, provider, 'used');
// The same, for any folder inside a project: the counters live in the project root (where `operant usage` reads them).
function recordFor(cwd, provider, field) {
  let root = null;
  try { root = require('./memory').memoryProjectDir(cwd); } catch { /* no project */ }
  if (root) bump(root, provider, field === 'used' ? 'used' : 'called');
}

// Counts a worker's own lookups as they happen (main.js feeds it every tool use): a CodeGraph query or a git
// history command is a call; the next edit after it counts the provider as used (the answer was acted on).
const GIT_LOOKUP = /(?:^|[;&|(])\s*git\s+(?:-C\s+\S+\s+)?(log|diff|show|blame|status|reflog|shortlog|branch)(?![\w-])/i;
function createToolNoter(record) {
  const open = new Set();
  return (name, input) => {
    const k = require('./codegraph-first').classify(name, input).kind;
    const c = input && typeof input === 'object' ? String(input.command ?? input.cmd ?? '') : '';
    const provider = k === 'codegraph' ? 'codegraph' : k === 'other' && /^(bash|shell|powershell)$/i.test(String(name)) && GIT_LOOKUP.test(c) ? 'git' : null;
    if (provider) { record(provider, 'called'); open.add(provider); return; }
    if (k === 'edit' && open.size) { for (const p of open) record(p, 'used'); open.clear(); }
  };
}

// One line for `operant usage`, '' when nothing was recorded.
function formatStats(stats) {
  const parts = Object.entries(stats || {}).map(([p, s]) => `${p} ${s.used}/${s.called} used (${Math.round(s.rate * 100)}%)`);
  return parts.length ? `context providers: ${parts.join('; ')}` : '';
}

module.exports = { choose, shapeOf, recordCall, recordUse, recordFor, createToolNoter, readStats, formatStats, CHAINS, PROVIDERS };
