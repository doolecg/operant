const test = require('node:test');
const assert = require('node:assert');
const g = require('../tier-guard.js');

test('asking before moving up is on and cannot be turned off', () => {
  assert.strictEqual(g.ASK_BEFORE_MOVE_UP, true);
});

test('limitPlan: 0 is no limit; the save allowance is 10% capped at 15k, on top by default', () => {
  assert.strictEqual(g.limitPlan(0), null);
  assert.strictEqual(g.limitPlan(undefined), null);
  assert.deepStrictEqual(g.limitPlan(100000), { limit: 100000, work: 100000, allowance: 10000, hard: 110000, saving: 'over' });
  assert.deepStrictEqual(g.limitPlan(600000), { limit: 600000, work: 600000, allowance: 15000, hard: 615000, saving: 'over' });
});

test('limitPlan inside: the reserve comes out of the limit, and under 20k is refused', () => {
  assert.deepStrictEqual(g.limitPlan(100000, 'inside'), { limit: 100000, work: 90000, allowance: 10000, hard: 100000, saving: 'inside' });
  assert.match(g.limitPlan(19999, 'inside').error, /under 20k/);
  assert.ok(!g.limitPlan(20000, 'inside').error);
  assert.ok(!g.limitPlan(10000, 'over').error);
});

test('the tracker warns at 80%, asks to save at 90%, and stops once the worker saved', () => {
  const t = g.createLimitTracker({ limit: 100000 });
  assert.strictEqual(t.onTokens(50000), null);
  assert.deepStrictEqual(t.onTokens(80000), { type: 'warn' });
  assert.strictEqual(t.onTokens(85000), null);
  assert.deepStrictEqual(t.onTokens(90000), { type: 'save' });
  assert.strictEqual(t.onTokens(95000), null);
  assert.deepStrictEqual(t.onSaved(), { type: 'stop', saved: true });
  assert.strictEqual(t.onTokens(200000), null, 'nothing after the stop');
  assert.strictEqual(t.state().phase, 'stopped');
});

test('past the limit without saving: the allowance is for saving only, then a stop without a save', () => {
  const t = g.createLimitTracker({ limit: 100000 });
  assert.deepStrictEqual(t.onTokens(92000), { type: 'save' });
  assert.deepStrictEqual(t.onTokens(100000), { type: 'limit' });
  assert.strictEqual(t.onTokens(105000), null);
  assert.strictEqual(t.state().allowanceUsed, 5000);
  assert.strictEqual(t.state().work, 100000);
  assert.deepStrictEqual(t.onTokens(110000), { type: 'stop', saved: false });
});

test('saving inside the allowance stops at once; a jump past the hard limit stops too', () => {
  const t = g.createLimitTracker({ limit: 100000 });
  t.onTokens(101000);
  assert.deepStrictEqual(t.onSaved(), { type: 'stop', saved: true });
  const u = g.createLimitTracker({ limit: 100000 });
  assert.deepStrictEqual(u.onTokens(500000), { type: 'stop', saved: false });
});

test('a normal handback before 90% is not a stop, and no limit means no events', () => {
  const t = g.createLimitTracker({ limit: 100000 });
  t.onTokens(10000);
  assert.strictEqual(t.onSaved(), null);
  const none = g.createLimitTracker({ limit: 0 });
  assert.strictEqual(none.onTokens(1e9), null);
  const bad = g.createLimitTracker({ limit: 10000, saving: 'inside' });
  assert.strictEqual(bad.onTokens(1e9), null);
});

test('inside the limit: the work stops at limit minus the reserve, the process at the limit', () => {
  const t = g.createLimitTracker({ limit: 100000, saving: 'inside' });
  assert.deepStrictEqual(t.onTokens(81000), { type: 'save' });
  assert.deepStrictEqual(t.onTokens(90000), { type: 'limit' });
  assert.deepStrictEqual(t.onTokens(100000), { type: 'stop', saved: false });
});

test('limit messages tell the worker how to save', () => {
  const plan = g.limitPlan(100000);
  assert.match(g.limitMessage({ type: 'warn' }, { id: 4, plan, used: 80000 }), /80k of its 100k/);
  assert.match(g.limitMessage({ type: 'save' }, { id: 4, plan, used: 90000 }), /operant task done 4 --status blocked --note/);
  assert.match(g.limitMessage({ type: 'limit' }, { id: 4, plan, used: 100000 }), /next 10k tokens are only for saving/);
});

test('autoHandback writes the note from the last steps and edits', () => {
  const n = g.autoHandback({ recent: ['Read("a.js")', 'Bash("npm test")'], edits: ['a.js', 'b.js', 'a.js'], used: 110000, limit: 100000 });
  assert.match(n, /Stopped at the token limit \(110k of 100k\)/);
  assert.match(n, /Edited: a\.js, b\.js\./);
  assert.match(n, /Last steps: Read\("a\.js"\); Bash\("npm test"\)/);
  assert.match(g.autoHandback({}), /No files edited/);
});

test('dailyCap: off at 0, over at or past the cap', () => {
  assert.strictEqual(g.dailyCap(5, 0), null);
  assert.deepStrictEqual(g.dailyCap(100, 100), { over: true, used: 100, cap: 100 });
  assert.strictEqual(g.dailyCap(99, 100).over, false);
});

const done = (tier, total, extra = {}) => ({ tier, type: 'fix', status: 'done', tokens: { input: total, output: 0, cacheWrite: 0, cacheRead: 999999 }, ...extra });

test('suggestLimit: fewer than 5 passed tasks is not enough history, and uses the tier default', () => {
  const s = g.suggestLimit([done('small', 1000), done('small', 2000)], { tier: 'small', current: 300000, fallback: 300000 });
  assert.deepStrictEqual(s, { tokens: 300000, n: 2, enough: false, reason: 'not enough history', direction: null });
});

test('suggestLimit: p90 of passed tasks + 25%, cache reads excluded, rounded up to 10k', () => {
  const entries = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map(k => done('small', k * 1000));
  entries.push({ tier: 'small', status: 'failed', tokens: { input: 900000 } }, done('medium', 5e6));
  const s = g.suggestLimit(entries, { tier: 'small', current: 150000 });
  assert.strictEqual(s.n, 10);
  assert.strictEqual(s.tokens, 120000); // p90 = 90k, * 1.25 = 112.5k -> 120k
  assert.ok(s.enough);
  assert.match(s.reason, /90th percentile of 10 passed tasks \(90k\) \+ 25%/);
  assert.strictEqual(s.direction, null);
});

test('suggestLimit: far under the limit suggests lower; hitting it suggests higher, with the reason', () => {
  const low = Array.from({ length: 6 }, () => done('small', 20000));
  const l = g.suggestLimit(low, { tier: 'small', current: 300000 });
  assert.strictEqual(l.direction, 'lower');
  assert.strictEqual(l.tokens, 30000);
  assert.match(l.reason, /far under the 300k limit/);
  const hit = [...low, done('small', 100000, { status: 'blocked', limitHit: true }), { tier: 'small', status: 'failed', limitHit: true, tokens: { input: 100000 } }, { tier: 'small', status: 'failed', limitHit: true, tokens: { input: 100000 } }];
  const h = g.suggestLimit(hit, { tier: 'small', current: 100000 });
  assert.strictEqual(h.direction, 'higher');
  assert.strictEqual(h.tokens, 150000);
  assert.match(h.reason, /3 of 9 tasks hit the 100k limit/);
});

test('suggestLimit: a task type narrows the history; suggestAll covers every tier', () => {
  const entries = Array.from({ length: 5 }, () => done('small', 40000));
  assert.strictEqual(g.suggestLimit(entries, { tier: 'small', type: 'docs' }).enough, false);
  assert.strictEqual(g.suggestLimit(entries, { tier: 'small', type: 'fix' }).enough, true);
  const all = g.suggestAll(entries, ['small', 'medium'], { small: 300000, medium: 600000 }, { medium: 600000 });
  assert.strictEqual(all.small.tokens, 50000);
  assert.deepStrictEqual(all.medium, { tokens: 600000, n: 0, enough: false, reason: 'not enough history', direction: null });
});

test('evidence lists the last failing command, tool calls and tokens', () => {
  assert.deepStrictEqual(g.evidence({ command: 'npm test', error: 'Cannot find module x', calls: 31, tokens: 45000, limit: 300000 }),
    ["last failing command: npm test → Cannot find module x", '31 tool calls', '45k tokens so far of 300k']);
  assert.deepStrictEqual(g.evidence({ error: 'boom', calls: 1 }), ['last error: boom', '1 tool call']);
});

test('a stuck ask offers move up (with its suggested limit), a hint, take over and stop', () => {
  const a = g.makeAsk({ kind: 'stuck', reason: 'the same command keeps failing', next: 'medium', nextLimit: { tokens: 450000, n: 7, enough: true }, at: 1 });
  assert.deepStrictEqual(a.choices.map(c => c.id), ['up', 'hint', 'takeover', 'stop']);
  assert.strictEqual(a.choices[0].label, 'Move up to medium (limit 450k, from 7 tasks)');
  assert.ok(a.choices[1].needsText);
  const top = g.makeAsk({ kind: 'failed', reason: 'x', next: null });
  assert.deepStrictEqual(top.choices.map(c => c.id), ['hint', 'takeover', 'stop']);
  const def = g.makeAsk({ kind: 'rejected', next: 'high', nextLimit: { tokens: 1200000, n: 1, enough: false } });
  assert.strictEqual(def.choices[0].label, 'Move up to high (limit 1.2M, tier default)');
  assert.throws(() => g.makeAsk({ kind: 'bored' }), /unknown ask kind/);
});

test('a limit ask offers raise once, move up, take over, stop; raise only once', () => {
  const a = g.makeAsk({ kind: 'limit', next: 'medium', limit: 300000 });
  assert.deepStrictEqual(a.choices.map(c => c.id), ['raise', 'up', 'takeover', 'stop']);
  assert.strictEqual(a.choices[0].label, 'Raise once to 600k');
  assert.deepStrictEqual(g.makeAsk({ kind: 'limit', limit: 300000, raised: true }).choices.map(c => c.id), ['takeover', 'stop']);
});

test('pause waits for the answer; nothing moves until then', () => {
  const t = { id: 3, status: 'doing', tier: 'small' };
  g.pause(t, g.makeAsk({ kind: 'stuck', next: 'medium' }));
  assert.strictEqual(t.status, 'paused');
  assert.strictEqual(t.tier, 'small');
  assert.match(g.askText(t), /paused: is stuck; waiting for the user/);
  assert.match(g.askText(t), /Move up to medium \| Retry here with a hint \| I'll take over \| Stop/);
  assert.throws(() => g.answer({ id: 4, status: 'doing' }, 'up'), /not waiting for an answer/);
  assert.throws(() => g.answer(t, 'raise'), /not one of: up, hint, takeover, stop/);
  assert.throws(() => g.answer(t, 'hint', { hint: '  ' }), /a hint is needed/);
  assert.strictEqual(t.status, 'paused');
});

test('each answer: up, hint, raise, take over, stop', () => {
  const mk = (kind, extra) => g.pause({ id: 1, status: 'doing', note: 'n' }, g.makeAsk({ kind, next: 'medium', nextLimit: { tokens: 500000, n: 6, enough: true }, limit: 100000, ...extra }));
  let t = mk('stuck');
  assert.deepStrictEqual(g.answer(t, 'up'), { do: 'up', tier: 'medium', limit: 500000 });
  assert.strictEqual(t.ask, null);
  assert.strictEqual(t.lastAsk.choice, 'up');
  t = mk('stuck');
  assert.deepStrictEqual(g.answer(t, 'hint', { hint: ' the fixture\n is in test/data ' }), { do: 'retry', hint: 'the fixture is in test/data' });
  assert.strictEqual(t.status, 'doing');
  t = mk('limit');
  assert.deepStrictEqual(g.answer(t, 'raise'), { do: 'raise', limit: 200000 });
  assert.strictEqual(t.budget, 200000);
  assert.strictEqual(t.raised, true);
  t = mk('failed');
  assert.deepStrictEqual(g.answer(t, 'takeover'), { do: 'takeover' });
  assert.strictEqual(t.status, 'blocked');
  assert.match(t.note, /You took this over/);
  t = mk('rejected');
  assert.deepStrictEqual(g.answer(t, 'stop'), { do: 'stop' });
  assert.strictEqual(t.status, 'cancelled');
  assert.match(t.note, /Stopped by you: was rejected twice/);
});

test('budget tracker: 0 is no limit; warns at 90% once, stops at the limit once, per limit', () => {
  const none = g.createBudgetTracker({ minutes: 0, calls: 0 });
  assert.strictEqual(none.active(), false);
  assert.deepStrictEqual(none.onProgress({ minutes: 999, calls: 999 }), []);
  const t = g.createBudgetTracker({ minutes: 30, calls: 100 });
  assert.deepStrictEqual(t.onProgress({ minutes: 10, calls: 50 }), []);
  assert.deepStrictEqual(t.onProgress({ minutes: 27, calls: 50 }), [{ type: 'warn', what: 'minutes', used: 27, limit: 30 }]);
  assert.deepStrictEqual(t.onProgress({ minutes: 28, calls: 90 }), [{ type: 'warn', what: 'calls', used: 90, limit: 100 }]);
  assert.deepStrictEqual(t.onProgress({ minutes: 30, calls: 90 }), [{ type: 'stop', what: 'minutes', used: 30, limit: 30 }]);
  assert.deepStrictEqual(t.onProgress({ minutes: 40, calls: 100 }), [{ type: 'stop', what: 'calls', used: 100, limit: 100 }]);
  assert.deepStrictEqual(t.onProgress({ minutes: 50, calls: 200 }), []);
});

test('budget tracker: the pace warning fires once when the token pace projects past the limit', () => {
  const t = g.createBudgetTracker({ minutes: 30 });
  assert.deepStrictEqual(t.onProgress({ minutes: 5, share: 0.1 }), [], 'too early in the tokens to project');
  assert.deepStrictEqual(t.onProgress({ minutes: 10, share: 0.5 }), [], '20 minutes projected, under 30');
  const ev = t.onProgress({ minutes: 15, share: 0.4 });
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].type, 'pace');
  assert.strictEqual(ev[0].projected, 37.5);
  assert.deepStrictEqual(t.onProgress({ minutes: 16, share: 0.4 }), []);
  assert.match(g.budgetMessage(ev[0], { id: 7 }), /at this pace task 7 will pass its 30 minutes limit/);
  assert.match(g.budgetMessage({ type: 'warn', what: 'calls', used: 90, limit: 100 }, { id: 7 }), /90 of its 100 tool calls limit \(90%\)/);
});

test('a budget stop asks the user, never moves up on its own, and raising doubles the limits once', () => {
  const ask = g.makeAsk({ kind: 'budget', reason: 'time limit 30 minutes reached', next: 'medium', budgetLimits: { minutes: 30, calls: 200 } });
  assert.strictEqual(ask.why, 'reached its time or tool-call limit');
  assert.deepStrictEqual(ask.choices.map(c => c.id), ['raise', 'up', 'takeover', 'stop']);
  assert.ok(!g.makeAsk({ kind: 'budget', budgetLimits: { minutes: 30, calls: 200 }, raised: true }).choices.some(c => c.id === 'raise'));
  const task = { id: 3 };
  g.pause(task, ask);
  assert.strictEqual(task.status, 'paused');
  assert.deepStrictEqual(g.answer(task, 'raise'), { do: 'raise', limit: null });
  assert.deepStrictEqual(task.budgetX, { minutes: 60, calls: 400 });
  assert.strictEqual(task.budget, undefined, 'the token limit is untouched');
  assert.match(g.autoHandback({ used: 30, limit: 30, what: 'minutes' }), /minutes limit \(30 of 30\)/);
});
