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

const api = { classifyTask, needsVerification, TYPES: [...RULES.map(r => r[0]), 'other'] };
if (typeof module !== 'undefined') module.exports = api; else globalThis.TaskType = api;
})();
