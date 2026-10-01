(function () {
// Pure. A worker never moves up a tier by itself: a stuck guard, a second failure or rejection, or
// a spent token limit pauses the task and asks the user. And each task has a hard token limit (input + output +
// cache writes) with a separate allowance for saving progress; nothing raises a limit by itself, 0 = no limit.

const ASK_BEFORE_MOVE_UP = true; // Settings › Agents › Team shows it on and locked in this release
const SAVE_SHARE = 0.1, SAVE_CAP = 15000, MIN_INSIDE = 20000;
const WARN_AT = 0.8, SAVE_AT = 0.9;
const SUGGEST_MIN = 5, SUGGEST_MARGIN = 1.25;

const counted = tok => tok ? (tok.input || 0) + (tok.output || 0) + (tok.cacheWrite || 0) : 0;
const fmtTok = n => n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n));
const oneLine = s => String(s || '').replace(/\s+/g, ' ').trim();
const clip = (s, n) => s.length > n ? s.slice(0, n - 1) + '…' : s;

// ------------------------------------------------------------------ limits

// A limit and the Saving progress setting ('over', the default: the save allowance comes on top; 'inside': it is taken
// out of the limit) -> null for no limit, { error } for one that leaves no room, else
// { limit, work, allowance, hard, saving }: the work stops at `work`, saving may go on up to `hard`.
function limitPlan(limit, saving = 'over') {
  limit = Math.max(0, Math.round(+limit || 0));
  if (!limit) return null;
  const allowance = Math.min(Math.round(limit * SAVE_SHARE), SAVE_CAP);
  if (saving === 'inside') {
    if (limit < MIN_INSIDE) return { limit, error: `a limit under ${fmtTok(MIN_INSIDE)} tokens leaves no room to save progress inside it (Settings › Agents › Team › Saving progress)` };
    return { limit, work: limit - allowance, allowance, hard: limit, saving: 'inside' };
  }
  return { limit, work: limit, allowance, hard: limit + allowance, saving: 'over' };
}

// One task's limit, fed its running token count; each event fires once, in order:
//   { type: 'warn' }   80% of the work share: tell the worker and the user
//   { type: 'save' }   90%: tell the worker to save now (files, operant task done --status blocked --note ...)
//   { type: 'limit' }  the work share is spent and nothing was saved: from here the tokens are for saving only
//   { type: 'stop', saved }  it saved after being told to (or at the limit), or the allowance ran out: end the
//                      process and ask the user. saved false = Operant writes the handback from the tile.
function createLimitTracker({ limit, saving } = {}) {
  const plan = limitPlan(limit, saving);
  let phase = 'ok', saved = false, used = 0;
  const live = () => plan && !plan.error && phase !== 'stopped';
  const stop = () => { phase = 'stopped'; return { type: 'stop', saved }; };

  function onTokens(total) {
    used = Math.max(used, +total || 0);
    if (!live()) return null;
    if (used >= plan.hard) return stop();
    if (used >= plan.work) {
      if (saved) return stop();
      if (phase === 'over') return null;
      phase = 'over';
      return { type: 'limit' };
    }
    if (used >= plan.work * SAVE_AT) {
      if (phase === 'saving') return null;
      phase = 'saving';
      return { type: 'save' };
    }
    if (used >= plan.work * WARN_AT && phase === 'ok') { phase = 'warned'; return { type: 'warn' }; }
    return null;
  }

  // The worker handed back (operant task done). After the save call or past the limit, that ends it.
  function onSaved() {
    saved = true;
    if (live() && (phase === 'saving' || phase === 'over')) return stop();
    return null;
  }

  const state = () => ({
    phase, saved, used, plan,
    work: plan && !plan.error ? Math.min(used, plan.work) : used,
    allowanceUsed: plan && !plan.error ? Math.max(0, used - plan.work) : 0,
    pct: plan && !plan.error ? used / plan.work : 0,
  });
  return { onTokens, onSaved, state };
}

// The worker's own message at each event (sent between its steps). id: the board task.
function limitMessage(ev, { id, plan, used }) {
  const note = `operant task done ${id} --status blocked --note "<done so far; next step; open issues>"`;
  if (ev.type === 'warn') return `Operant: task ${id} has used ${fmtTok(used)} of its ${fmtTok(plan.work)} token limit (80%). Finish the current step and keep the rest short.`;
  if (ev.type === 'save') return `Operant: task ${id} is at 90% of its ${fmtTok(plan.work)} token limit. Save where you are now: save your files, then ${note}. Then stop.`;
  if (ev.type === 'limit') return `Operant: task ${id} reached its ${fmtTok(plan.work)} token limit. Stop the work. The next ${fmtTok(plan.allowance)} tokens are only for saving: ${note}, then stop.`;
  return '';
}

// A worker stopped before it saved: Operant writes its handback from the tile's last tool calls and edits.
// recent: ['Bash("npm test")', ...] newest last; edits: file paths.
function autoHandback({ recent = [], edits = [], used = 0, limit = 0, what = '' } = {}) {
  const files = [...new Set(edits)].slice(-8);
  const steps = recent.slice(-5).map(s => clip(oneLine(s), 80));
  return [
    `Stopped at the ${what ? `${BUDGET_UNIT[what]} limit (${Math.round(used)} of ${Math.round(limit)})` : `token limit (${fmtTok(used)} of ${fmtTok(limit)})`} before it saved; this note is Operant's, from the tile.`,
    files.length ? `Edited: ${files.join(', ')}.` : 'No files edited.',
    steps.length ? `Last steps: ${steps.join('; ')}.` : '',
    'Next: check those files and continue from there; the tile keeps the rest.',
  ].filter(Boolean).join(' ');
}

// Optional hard daily cap per project: -> null when off, else { over, used, cap }.
function dailyCap(used, cap) {
  cap = Math.max(0, Math.round(+cap || 0));
  if (!cap) return null;
  return { over: (+used || 0) >= cap, used: +used || 0, cap };
}

// ------------------------------------------------------------------ time and tool-call limits

const BUDGET_WARN = 0.9, PACE_MIN_SHARE = 0.2, PACE_MIN_USED = 0.1;
const BUDGET_UNIT = { minutes: 'minutes', calls: 'tool calls' };
const whole = n => Math.max(0, Math.round(+n || 0));

// One task's elapsed-minutes and tool-call limits (0 = no limit), fed onProgress({ minutes, calls, share }) where share
// is the fraction of the token limit used so far (0 with no token limit). Each event fires once per limit:
//   { type: 'pace', what, used, limit, projected }  the pace so far will pass the limit: what the limit would reach when
//                      the tokens run out at the current rate (needs 20% of the tokens and 10% of the limit used)
//   { type: 'warn', what, used, limit }  90% of the limit: tell the worker to save
//   { type: 'stop', what, used, limit }  the limit is spent: end the worker and ask the user (never moves the task up)
function createBudgetTracker({ minutes, calls } = {}) {
  const limits = { minutes: whole(minutes), calls: whole(calls) };
  const phase = { minutes: 'ok', calls: 'ok' }, paced = {};
  function onProgress({ minutes: m = 0, calls: c = 0, share = 0 } = {}) {
    const used = { minutes: +m || 0, calls: +c || 0 }, out = [];
    for (const what of ['minutes', 'calls']) {
      const limit = limits[what], u = used[what];
      if (!limit || phase[what] === 'stopped') continue;
      if (u >= limit) { phase[what] = 'stopped'; out.push({ type: 'stop', what, used: u, limit }); continue; }
      if (u >= limit * BUDGET_WARN) {
        if (phase[what] !== 'warned') { phase[what] = 'warned'; out.push({ type: 'warn', what, used: u, limit }); }
        continue;
      }
      if (!paced[what] && share >= PACE_MIN_SHARE && u >= limit * PACE_MIN_USED) {
        const projected = u / Math.min(share, 1);
        if (projected > limit) { paced[what] = true; out.push({ type: 'pace', what, used: u, limit, projected }); }
      }
    }
    return out;
  }
  return { onProgress, limits, active: () => !!(limits.minutes || limits.calls) };
}

const budgetText = (what, n) => `${Math.round(n)} ${BUDGET_UNIT[what]}`;

// The worker's own message at each budget event.
function budgetMessage(ev, { id }) {
  const note = `operant task done ${id} --status blocked --note "<done so far; next step; open issues>"`;
  if (ev.type === 'pace') return `Operant: at this pace task ${id} will pass its ${budgetText(ev.what, ev.limit)} limit (about ${budgetText(ev.what, ev.projected)} by the time the tokens run out). Narrow the work and wrap up sooner.`;
  if (ev.type === 'warn') return `Operant: task ${id} has used ${Math.round(ev.used)} of its ${budgetText(ev.what, ev.limit)} limit (90%). Save where you are now: save your files, then ${note}. Then stop.`;
  return '';
}

// ------------------------------------------------------------------ suggestions

const roundUp = n => Math.max(10000, Math.ceil(n / 10000) * 10000);
function percentile(values, p) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
}

// From the outcomes file: the 90th percentile of tokens used by passed tasks on this tier (and task type, when
// given), plus 25%, from at least 5 of them; else "not enough history" and the tier default (`fallback`).
// With the current limit known, it says whether that is too high (passing tasks stay far under it) or too low
// (tasks keep hitting it). -> { tokens, n, enough, reason, direction: 'lower'|'higher'|null }
function suggestLimit(entries, { tier, type, current = 0, fallback = 0 } = {}) {
  const mine = (entries || []).filter(e => e && e.kind !== 'orchestration' && e.tier === tier && (!type || e.type === type));
  const passed = mine.filter(e => e.status === 'done').map(e => counted(e.tokens)).filter(n => n > 0);
  if (passed.length < SUGGEST_MIN) return { tokens: fallback || current || 0, n: passed.length, enough: false, reason: 'not enough history', direction: null };
  const p90 = percentile(passed, 0.9);
  let tokens = roundUp(p90 * SUGGEST_MARGIN), direction = null;
  let reason = `90th percentile of ${passed.length} passed tasks (${fmtTok(p90)}) + 25%`;
  const hits = mine.filter(e => e.limitHit).length;
  if (current) {
    if (hits >= 2 && hits / mine.length >= 0.3) {
      tokens = Math.max(tokens, roundUp(current * 1.5)); direction = 'higher';
      reason = `${hits} of ${mine.length} tasks hit the ${fmtTok(current)} limit`;
    } else if (tokens <= current * 0.6) { direction = 'lower'; reason = `passed tasks stay far under the ${fmtTok(current)} limit: ${reason}`; }
    else if (tokens > current) direction = 'higher';
  }
  return { tokens, n: passed.length, enough: true, reason, direction };
}

// Every tier at once, for Settings: { tier: suggestion } with `current` from the configured limits.
function suggestAll(entries, tierNames, limits, defaults = {}) {
  const out = {};
  for (const tier of tierNames || []) out[tier] = suggestLimit(entries, { tier, current: +(limits || {})[tier] || 0, fallback: +defaults[tier] || 0 });
  return out;
}

// ------------------------------------------------------------------ asking before moving up

const ASK_WHY = { stuck: 'is stuck', failed: 'failed twice on this tier', rejected: 'was rejected twice', limit: 'reached its token limit', budget: 'reached its time or tool-call limit', higher: 'was asked to run on a higher tier' };

// What the card and the notification say: last failing command, tool calls, tokens so far.
function evidence({ command, error, calls, tokens, limit } = {}) {
  const out = [];
  if (command) out.push(`last failing command: ${clip(oneLine(command), 100)}${error ? ` → ${clip(oneLine(error), 100)}` : ''}`);
  else if (error) out.push(`last error: ${clip(oneLine(error), 140)}`);
  if (calls != null) out.push(`${calls} tool call${calls === 1 ? '' : 's'}`);
  if (tokens != null) out.push(`${fmtTok(tokens)} tokens so far${limit ? ` of ${fmtTok(limit)}` : ''}`);
  return out;
}

// kind: stuck | failed | rejected | limit. next: the tier above (null at the top allowed), with nextLimit
// { tokens, n, enough } its suggested limit. limit: the task's current limit (for Raise once, which doubles it once).
// -> the ask kept on the task: { kind, reason, evidence, next, choices: [{ id, label, needsText? }], at }
function makeAsk({ kind, reason, evidence: ev = [], next = null, nextLimit = null, limit = 0, budgetLimits = null, raised = false, at = Date.now() }) {
  if (!ASK_WHY[kind]) throw new Error(`unknown ask kind "${kind}"`);
  const choices = [];
  if (kind === 'limit' && limit && !raised) choices.push({ id: 'raise', label: `Raise once to ${fmtTok(limit * 2)}` });
  if (kind === 'budget' && budgetLimits && !raised) choices.push({ id: 'raise', label: 'Raise once (double the time and tool-call limits)' });
  if (next) {
    const lim = nextLimit && nextLimit.tokens ? ` (limit ${fmtTok(nextLimit.tokens)}${nextLimit.enough ? `, from ${nextLimit.n} tasks` : ', tier default'})` : '';
    choices.push({ id: 'up', label: `Move up to ${next}${lim}` });
  }
  if (kind !== 'limit' && kind !== 'budget') choices.push({ id: 'hint', label: 'Retry here with a hint', needsText: true });
  choices.push({ id: 'takeover', label: "I'll take over" }, { id: 'stop', label: 'Stop' });
  return { kind, why: ASK_WHY[kind], reason: oneLine(reason), evidence: ev, next, nextLimit: next ? nextLimit : null, limit, budgetLimits, choices, at };
}

// Pauses the task on the ask. Nothing runs until the user answers; unanswered, it stays paused (never escalated).
function pause(task, ask) {
  task.status = 'paused';
  task.ask = ask;
  return task;
}

// The user's answer. -> what the app does next: { do: 'up', tier, limit } | { do: 'retry', hint } |
// { do: 'raise', limit } | { do: 'takeover' } | { do: 'stop' }. The task's status and limit change here.
function answer(task, choice, { hint } = {}) {
  const ask = task.ask;
  if (!ask || task.status !== 'paused') throw new Error(`task ${task.id} is not waiting for an answer`);
  if (!ask.choices.some(c => c.id === choice)) throw new Error(`"${choice}" is not one of: ${ask.choices.map(c => c.id).join(', ')}`);
  if (choice === 'hint' && !oneLine(hint)) throw new Error('a hint is needed to retry here');
  task.ask = null;
  task.lastAsk = { kind: ask.kind, choice, at: ask.at };
  if (choice === 'up') return { do: 'up', tier: ask.next, limit: ask.nextLimit && ask.nextLimit.tokens || null };
  if (choice === 'hint') { task.status = 'doing'; return { do: 'retry', hint: oneLine(hint) }; }
  if (choice === 'raise' && ask.kind === 'budget') {
    task.status = 'doing'; task.raised = true;
    task.budgetX = { minutes: whole(ask.budgetLimits?.minutes) * 2, calls: whole(ask.budgetLimits?.calls) * 2 };
    return { do: 'raise', limit: null };
  }
  if (choice === 'raise') { task.status = 'doing'; task.budget = ask.limit * 2; task.raised = true; return { do: 'raise', limit: task.budget }; }
  if (choice === 'takeover') { task.status = 'blocked'; task.takenOver = true; task.note = [task.note, 'You took this over'].filter(Boolean).join(' · '); return { do: 'takeover' }; }
  task.status = 'cancelled';
  task.note = `Stopped by you: ${ask.why}`;
  return { do: 'stop' };
}

// What `operant task show` and the lead's context say about a paused task.
function askText(task) {
  const a = task.ask;
  if (!a) return '';
  return [`paused: ${a.why}${a.reason ? ` (${a.reason})` : ''}; waiting for the user`,
    ...a.evidence.map(e => `  ${e}`),
    `  choices (the user picks on the card Operant shows): ${a.choices.map(c => c.label).join(' | ')}`].join('\n');
}

const api = {
  ASK_BEFORE_MOVE_UP, SAVE_SHARE, SAVE_CAP, MIN_INSIDE, SUGGEST_MIN,
  limitPlan, createLimitTracker, limitMessage, createBudgetTracker, budgetMessage, autoHandback, dailyCap, counted, fmtTok,
  percentile, suggestLimit, suggestAll,
  evidence, makeAsk, pause, answer, askText,
};
if (typeof module !== 'undefined') module.exports = api; else globalThis.TierGuard = api;
})();
