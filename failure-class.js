(function () {
// Failure classification (2.5): the kind of a failed, blocked or stuck task, read from its note and evidence. Deterministic:
// the same text always gives the same kind, checked in a fixed order (the first match wins). Pure.
// kinds: context-overflow, rate-limit, auth, timeout, stuck-loop, test-failure, bad-output, other.
const RULES = [
  ['context-overflow', /context (window|length|limit|overflow)|maximum context|prompt is too long|too many tokens|token limit exceeded|input is too long|context_length_exceeded/i],
  ['rate-limit', /rate.?limit|too many requests|\b429\b|quota|usage limit|overloaded|\b529\b|out of (free )?(use|credits)/i],
  ['auth', /\b40[13]\b|unauthori[sz]ed|forbidden|invalid (api )?key|authentication|not logged in|login required|credentials?|permission denied/i],
  ['timeout', /time[sd]? ?out|timeout|deadline exceeded|\b(502|503|504)\b|ETIMEDOUT|ECONNRESET/i],
  ['stuck-loop', /stuck|same (command|error|step)|repeat(ed|ing)|loop(ing)?\b|no progress/i],
  ['test-failure', /tests? (failed|failing)|\d+ failing|assertion|checks? failed|typecheck|lint(ing)? (failed|errors?)|build failed|npm test|exit code [1-9]/i],
  ['bad-output', /malformed|invalid json|could not parse|unparseable|unexpected (output|response|format)|empty (response|output)|truncated|bad output|hallucinat/i],
];

// evidence: { note, reason, failure, check: { ok, command }, stuck: bool }. -> { kind, evidence } or null when nothing failed.
function classify(evidence = {}) {
  const text = [evidence.note, evidence.reason, evidence.failure].filter(Boolean).map(String).join(' \n ').replace(/\s+/g, ' ').trim();
  if (evidence.stuck) return { kind: 'stuck-loop', evidence: 'the worker was flagged stuck' };
  for (const [kind, re] of RULES) {
    const m = re.exec(text);
    if (m) return { kind, evidence: text.slice(Math.max(0, m.index - 20), m.index + m[0].length + 40).trim() };
  }
  if (evidence.check && evidence.check.ok === false) return { kind: 'test-failure', evidence: `verification failed: ${evidence.check.command || 'checks'}` };
  return text ? { kind: 'other', evidence: text.slice(0, 80) } : null;
}
// The kinds that say the route itself (provider or model) was unhealthy, as opposed to the task's own result.
const ROUTE_KINDS = ['timeout', 'rate-limit', 'auth'];

const api = { classify, RULES, ROUTE_KINDS };
if (typeof module !== 'undefined') module.exports = api; else globalThis.FailureClass = api;
})();
