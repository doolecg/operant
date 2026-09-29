// Grading for the refiner eval: plain string and number rules, no model in the loop. Pure, so the unit tests can use it.
export const TIERS = {
  xsmall: { agent: 'opencode', model: 'opencode/big-pickle', effort: 'low', use: 'very easy tasks: lookups, one-line answers' },
  small: { agent: 'claude', model: 'claude-haiku-4-5', effort: 'low', use: 'simple edits and small fixes' },
  medium: { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'low', use: 'a feature across several files' },
  high: { agent: 'claude', model: 'claude-opus-5-5', effort: 'high', use: 'hard or risky work: architecture, migrations, security' },
};
export const MAX_TIER = 'medium';

const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ');
const tierIndex = name => Object.keys(TIERS).indexOf(name);

// The text a requirement can be found in: the cleaned request plus every task's title and prompt.
export function haystack(value) {
  return norm([value?.cleaned, ...(value?.tasks || []).flatMap(t => [t.title, t.prompt])].join(' \n '));
}

// keep: list of requirements, each a list of alternative substrings (any one counts). -> { ok, missing: [first alternative of each miss] }
export function gradeKeep(value, keep = []) {
  const hay = haystack(value);
  const missing = keep.filter(alts => !alts.some(a => hay.includes(norm(a)))).map(alts => alts[0]);
  return { ok: !missing.length, missing };
}

// One case against one raw answer. parsed: the parseRefinerOutput result of what the model said, before the picks were checked.
// Every check that applies comes back as { pass, note }; a check that does not apply is left out.
export function gradeCase(expect, parsed) {
  const checks = { parsed: { pass: !!parsed?.ok, note: parsed?.ok ? '' : parsed?.error || 'no answer' } };
  if (!parsed?.ok) return checks;
  const v = parsed.value, asked = !!v.question;
  if (expect.question === true) checks.question = { pass: asked, note: asked ? v.question : 'no question asked' };
  else if (!expect.questionOk) checks.question = { pass: !asked, note: asked ? `asked: ${v.question}` : '' };
  if (asked) return checks; // a question is the answer; nothing to keep or split yet
  if (expect.keep) { const k = gradeKeep(v, expect.keep); checks.keep = { pass: k.ok, note: k.missing.length ? `missing: ${k.missing.join(', ')}` : '' }; }
  if (expect.tasks) { const n = v.tasks.length; checks.tasks = { pass: n >= expect.tasks[0] && n <= expect.tasks[1], note: `${n} tasks, expected ${expect.tasks[0]}-${expect.tasks[1]}` }; }
  const allowed = Object.keys(TIERS).slice(0, tierIndex(MAX_TIER) + 1);
  const tierOk = t => allowed.includes(t.tier) && TIERS[t.tier].agent === t.agent && TIERS[t.tier].model === t.model;
  checks.picks = { pass: v.tasks.every(tierOk), note: v.tasks.filter(t => !tierOk(t)).map(t => `${t.tier || '?'}/${t.agent || '?'}/${t.model || '?'}`).join(', ') };
  if (expect.cheap) checks.cheap = { pass: v.tasks.every(t => tierIndex(t.tier) <= tierIndex(expect.cheap)), note: v.tasks.map(t => t.tier).join(',') };
  if (expect.minTier) checks.minTier = { pass: v.tasks.every(t => tierIndex(t.tier) >= tierIndex(expect.minTier)), note: v.tasks.map(t => t.tier).join(',') };
  if (expect.highRisk) checks.highRisk = { pass: v.tasks.some(t => t.risk === 'high'), note: v.tasks.map(t => t.risk).join(',') };
  return checks;
}

export const passed = checks => Object.values(checks).every(c => c.pass);
