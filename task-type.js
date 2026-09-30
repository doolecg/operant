(function () {
// Coarse kind of a board task from its prompt, for outcome records (item 57) and routing (item 59).
// First matching rule wins, so the order is part of the behaviour.
const RULES = [
  ['fix', /\b(fix(es|ed|ing)?|bugs?|broken|errors?|crash(es|ed|ing)?|fail(s|ed|ing|ure|ures)?|regression|not working|doesn'?t work)\b/i],
  ['test', /\b(tests?|specs?|coverage|unit tests?|e2e)\b/i],
  ['refactor', /\b(refactor(ing)?|renam(e|ing)|move|extract|clean ?up|deduplicate|simplif(y|ies)|restructure)\b/i],
  ['docs', /\b(readme|docs?|documentation|changelog|comments?|docstrings?|release notes)\b/i],
  ['lookup', /\b(find|where|what|which|how|why|explain|summari[sz]e|look ?up|list|show|investigate|check)\b/i],
  ['feature', /\b(add|implement|build|create|support|introduce|make|write|new)\b/i],
];

function classifyTask(text) {
  const s = String(text || '');
  for (const [type, re] of RULES) if (re.test(s)) return type;
  return 'other';
}

// Code tasks get the project's checks run before review; docs, lookups and the rest don't.
const needsVerification = task => ['fix', 'feature', 'refactor', 'test'].includes(classifyTask(task && task.text));

// Item 39/78: a deterministic profile of a task (no model): how big, how risky, what language, how much context,
// and how much checking it needs. `env` is what the caller knows about the project: { files, language }.
const HIGH_RISK = /\b(delet(e|es|ing)|drop|remove all|migrat(e|es|ion|ions)|auth(entication|orization)?|security|secrets?|credentials?|passwords?|tokens?|payments?|billing|schema|database|production|prod|deploy|release|force[- ]push|rm -rf|irreversible|encrypt(ion)?)\b/i;
const MED_RISK = /\b(refactor(ing)?|rewrite|restructure|rename|concurren(t|cy)|race|config(uration)?|dependenc(y|ies)|upgrade|public api|breaking)\b/i;
const LANGS = [
  ['typescript', /\.(tsx?|mts|cts)\b|\btypescript\b/i], ['javascript', /\.(jsx?|mjs|cjs)\b|\bjavascript\b|\bnode(\.js)?\b|\belectron\b/i],
  ['python', /\.py\b|\bpython\b|\bpytest\b/i], ['rust', /\.rs\b|\brust\b|\bcargo\b/i], ['go', /\.go\b|\bgolang\b/i],
  ['java', /\.java\b|\bgradle\b|\bmaven\b/i], ['kotlin', /\.kts?\b|\bkotlin\b/i], ['csharp', /\.cs\b|\bc#|\bdotnet\b/i],
];
const LEVELS = ['low', 'medium', 'high'];
const bump = (level, n) => LEVELS[Math.min(2, Math.max(0, LEVELS.indexOf(level) + n))];

function describeTask(text, env = {}) {
  const s = String(text || ''), type = classifyTask(s);
  const fileRefs = new Set(s.match(/[\w./\\-]+\.[a-z]{1,5}\b/gi) || []).size;
  const parts = (s.match(/(?:^|[\s(;])\(?\d+[.)]\s/g) || []).length;
  const score = (s.length > 600 ? 2 : s.length > 200 ? 1 : 0) + (fileRefs > 4 ? 2 : fileRefs > 1 ? 1 : 0) + (parts > 3 ? 2 : parts > 1 ? 1 : 0)
    + (/\b(across|everywhere|all (the )?files|whole|entire|architecture|every)\b/i.test(s) ? 1 : 0);
  let complexity = score >= 4 ? 'high' : score >= 2 ? 'medium' : 'low';
  if (type === 'lookup' || type === 'docs') complexity = bump(complexity, complexity === 'low' ? 0 : -1);
  let risk = HIGH_RISK.test(s) ? 'high' : MED_RISK.test(s) || type === 'refactor' ? 'medium' : 'low';
  if (risk === 'low' && complexity === 'high' && ['fix', 'feature'].includes(type)) risk = 'medium';
  const files = Number(env.files) || 0;
  const repoSize = !files ? 'unknown' : files > 2000 ? 'large' : files > 300 ? 'medium' : 'small';
  const language = (LANGS.find(([, re]) => re.test(s)) || [])[0] || env.language || 'unknown';
  let context = complexity;
  if (repoSize === 'large' && context !== 'high') context = bump(context, 1);
  if (repoSize === 'small' && context === 'medium' && fileRefs < 2) context = 'low';
  const code = ['fix', 'feature', 'refactor', 'test'].includes(type);
  const verification = !code ? 'none' : risk === 'high' || complexity === 'high' ? 'full' : 'checks';
  return { type, complexity, risk, repoSize, language, context, verification };
}

// Item 40/77: the type-check and lint commands a project has, read from its package.json (parsed, or null) and the
// names of the files at its root. Nothing is invented: a project with neither gets none.
function extraChecks(pkg, rootFiles) {
  const files = new Set(rootFiles || []), scripts = (pkg && pkg.scripts) || {}, deps = { ...(pkg && pkg.dependencies), ...(pkg && pkg.devDependencies) };
  const out = [];
  const typeScript = ['typecheck', 'type-check', 'check-types', 'tsc'].find(n => scripts[n]);
  if (typeScript) out.push({ kind: 'typecheck', command: `npm run ${typeScript}` });
  else if (files.has('tsconfig.json') && deps.typescript) out.push({ kind: 'typecheck', command: 'npx tsc --noEmit' });
  if (scripts.lint) out.push({ kind: 'lint', command: 'npm run lint' });
  if (!pkg) {
    if (files.has('mypy.ini')) out.push({ kind: 'typecheck', command: 'mypy .' });
    if (files.has('ruff.toml') || files.has('.ruff.toml')) out.push({ kind: 'lint', command: 'ruff check .' });
    if (files.has('Cargo.toml')) out.push({ kind: 'typecheck', command: 'cargo check' }, { kind: 'lint', command: 'cargo clippy' });
    if (files.has('go.mod')) out.push({ kind: 'lint', command: 'go vet ./...' });
  }
  return out;
}

// What the review card says about a task's risk: an independent review is advised for high risk.
const reviewAdvice = profile => profile && profile.risk === 'high' ? 'high risk: an independent review (a second agent or you reading the diff) is advised' : null;

const api = { classifyTask, needsVerification, describeTask, extraChecks, reviewAdvice, TYPES: [...RULES.map(r => r[0]), 'other'] };
if (typeof module !== 'undefined') module.exports = api; else globalThis.TaskType = api;
})();
