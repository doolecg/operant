(function () {
// Plan validation and strategy: cheap deterministic checks on a task's text before a worker starts (no model).
// Advice only, shown in operant task show and prime; nothing here ever blocks a task.
const TaskType = typeof module !== 'undefined' ? require('./task-type') : globalThis.TaskType;

const CODE = ['fix', 'feature', 'refactor', 'test'];
const ACCEPT = /\b(should|must|when (done|finished)|expect(ed|s)?|acceptance|passes|passing|so that|verify|until|done when|returns?|prints?|shows?|no (errors?|warnings?|failures?))\b|\btests? (pass|green)|\bgreen\b/i;
const CONSTRAIN = /\b(don'?t|do not|never|must not|without|avoid|only|no new|keep|unchanged|leave|constraints?|limit|at most|at least|no more than|backwards?[- ]compatible)\b/i;
const NEG = /\b(?:do not|don'?t|dont|never|must not|mustn'?t|without|avoid)\s+(?:to\s+)?(?:touch(?:ing)?|edit(?:ing)?|chang(?:e|ing)|modif(?:y|ying)|rewrit(?:e|ing)|delet(?:e|ing)|remov(?:e|ing)|alter(?:ing)?|updat(?:e|ing))\s+(?:the\s+|any\s+|in\s+)?([\w./\\-]+)/gi;
const POS = /\b(?:edit|chang(?:e|es)|modif(?:y|ies)|rewrite|delete|remove|alter|update|touch|fix|refactor)\s+(?:the\s+|in\s+)?([\w./\\-]+)/gi;
const FILE = /[\w./\\-]+\.[a-z]{1,5}\b/gi;
const clean = w => String(w || '').toLowerCase().replace(/[.,;:)\]]+$/, '');

function contradictions(text) {
  const out = [], seen = new Set();
  const banned = [...text.matchAll(NEG)].map(m => clean(m[1])).filter(w => w.length > 2);
  const rest = text.replace(NEG, ' ');
  for (const m of rest.matchAll(POS)) {
    const w = clean(m[1]);
    if (banned.includes(w) && !seen.has(w)) { seen.add(w); out.push(w); }
  }
  if (/\bno new (dependenc|librar|package)/i.test(text) && /\b(npm (i|install)|pip install|add (a |the )?(dependency|library|package)|install (a |the )?(package|library))/i.test(text.replace(/\bno new (dependenc\w*|librar\w*|packages?)/gi, ''))) out.push('new dependencies');
  return out;
}

// -> { advice: [{ kind, text }], strategy: { name, why } }
function check(text, profile) {
  const s = String(text || '').trim();
  const p = profile || TaskType.describeTask(s);
  const advice = [];
  const code = CODE.includes(p.type);
  if (code && !ACCEPT.test(s)) advice.push({ kind: 'acceptance', text: 'no acceptance criterion: say how the result will be checked (a test that passes, output that appears)' });
  if (code && !CONSTRAIN.test(s)) advice.push({ kind: 'constraints', text: 'no constraints stated: what must not change, what to avoid?' });
  const conflicts = contradictions(s);
  for (const w of conflicts) advice.push({ kind: 'contradiction', text: `the task both forbids and asks to change "${w}"` });
  const files = [...new Set((s.match(FILE) || []).map(clean))];
  const areas = new Set(files.map(f => f.replace(/\\/g, '/').split('/').filter(Boolean)[0]).filter(x => !/\.[a-z]{1,5}$/.test(x) || files.length > 1));
  const parts = (s.match(/(?:^|[\s(;])\(?\d+[.)]\s/g) || []).length;
  const broad = /\b(everything|all (the )?files|the whole|entire|every (file|module|screen))\b/i.test(s);
  const excess = files.length > 6 || (areas.size > 3 && files.length > 4) || parts > 5 || broad;
  if (excess) advice.push({ kind: 'scope', text: `wide scope (${broad ? 'everything at once' : parts > 5 ? `${parts} numbered parts` : `${files.length} files across ${areas.size} areas`}): split it into smaller tasks` });
  return { advice, strategy: strategy(s, p, { conflicts, files, parts, excess, missing: advice.some(a => a.kind === 'acceptance') }) };
}

function strategy(s, p, f) {
  if (f.conflicts.length || s.split(/\s+/).filter(Boolean).length < 4) return { name: 'clarify', why: f.conflicts.length ? 'the task contradicts itself' : 'too little to act on' };
  if (f.parts >= 3 && f.parts <= 9 && !f.excess) return { name: 'parallel', why: `${f.parts} numbered parts that can run as separate subagents` };
  if (p.type === 'lookup' || (CODE.includes(p.type) && !f.files.length && p.context !== 'low')) return { name: 'retrieval-first', why: 'find the relevant code first (CodeGraph, targeted reads), then act' };
  if (f.excess || p.complexity === 'high' || p.risk === 'high') return { name: 'staged', why: `${f.excess ? 'wide scope' : p.risk === 'high' ? 'high risk' : 'high complexity'}: plan, do one stage, check, continue` };
  return { name: 'direct', why: 'small and clear: just do it' };
}

// Short lines for task show and prime.
function lines(r) {
  return [...r.advice.map(a => `advice (${a.kind}): ${a.text}`), `suggested strategy: ${r.strategy.name} (${r.strategy.why})`];
}

const api = { check, lines, contradictions };
if (typeof module !== 'undefined') module.exports = api; else globalThis.PlanCheck = api;
})();
