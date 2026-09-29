// Tests for board.js: a worker's result counts only after review; one retry, then a tier up.
const test = require('node:test');
const assert = require('node:assert/strict');
const b = require('../board.js');

const tiers = ['xsmall', 'small', 'medium', 'high', 'max'];
const mk = (o = {}) => ({ id: 1, text: 'do it', status: 'doing', tier: 'small', ...o });

test('done waits in review; approve finishes it', () => {
  const t = b.handback(mk(), 'done', 'ok');
  assert.equal(t.status, 'review');
  assert.equal(t.note, 'ok');
  assert.equal(b.approve(t).status, 'done');
  assert.throws(() => b.approve(mk()), /not waiting/);
});

test('blocked and failed are kept as reported; other statuses are refused', () => {
  assert.equal(b.handback(mk(), 'blocked', 'x').status, 'blocked');
  assert.equal(b.handback(mk(), 'failed', 'x').status, 'failed');
  assert.throws(() => b.handback(mk(), 'review'), /status must be/);
});

test('first reject retries with the note, second escalates', () => {
  const t = b.handback(mk(), 'done', 'ok');
  assert.equal(b.reject(t, 'tests fail'), 'retry');
  assert.equal(t.status, 'doing');
  assert.equal(t.note, 'tests fail');
  b.handback(t, 'done', 'again');
  assert.equal(b.reject(t, 'still'), 'escalate');
});

test('a failure retries once, then escalates; noRetry escalates at once', () => {
  const t = mk();
  assert.equal(b.failure(t, 'boom'), 'retry');
  assert.equal(b.failure(t, 'boom'), 'escalate');
  assert.equal(b.failure(mk(), 'budget', { noRetry: true }), 'escalate');
});

test('escalation goes one tier up, stops at the allowed top', () => {
  assert.equal(b.escalation(mk(), tiers, 'max'), 'medium');
  assert.equal(b.escalation(mk({ tier: 'medium' }), tiers, 'medium'), null);
  assert.equal(b.escalation(mk({ tier: 'max' }), tiers, 'max'), null);
  assert.equal(b.escalation(mk({ tier: 'nope' }), tiers, 'max'), null);
  assert.equal(b.escalation(mk({ tier: 'small' }), { xsmall: 1, small: 1, medium: 1 }), 'medium');
});

test('moveUp keeps the id, counts the attempt and resets the strikes', () => {
  const t = mk({ retried: true, owner: 5 });
  b.moveUp(t, 'medium');
  assert.deepEqual([t.id, t.tier, t.attempts, t.retried, t.owner, t.status], [1, 'medium', 2, false, null, 'todo']);
});

test('failure note is two lines', () => {
  const n = b.failureNote(mk({ attempts: 2 }), 'budget 300000 tokens reached');
  assert.equal(n.split('\n').length, 2);
  assert.match(n, /Attempt 2 on the small tier did not work: budget 300000/);
});

test('verifying is not open; failed checks go back once, then wait in review', () => {
  assert.ok(b.STATUSES.includes('verifying'));
  assert.equal(b.isOpen(mk({ status: 'verifying' })), false);
  const t = b.handback(mk(), 'done', 'ok');
  assert.equal(b.verifyFailed(t, 'checks failed: npm test'), 'retry');
  assert.equal(t.status, 'doing');
  assert.equal(t.note, 'checks failed: npm test');
  b.handback(t, 'done', 'again');
  assert.equal(b.verifyFailed(t, 'checks failed again'), 'review');
  assert.equal(t.status, 'review');
});

test('unreportedChange: changes since the task started are handed back, none is a failure', () => {
  const before = { head: 'a1', status: '' };
  assert.equal(b.unreportedChange(before, { head: 'a1', status: '' }).changed, false);
  assert.equal(b.unreportedChange(null, { head: 'a1', status: ' M x.js\n' }).changed, false);
  const dirty = b.unreportedChange(before, { head: 'a1', status: ' M x.js\n?? y.js\n', stat: '1 file changed, 2 insertions(+)' });
  assert.equal(dirty.changed, true);
  assert.equal(dirty.note, "The worker made changes but didn't report; Operant found: 1 file changed, 2 insertions(+)");
  assert.match(b.unreportedChange(before, { head: 'a1', status: '?? y.js\n', stat: '' }).note, /1 file with uncommitted changes/);
  assert.equal(b.unreportedChange(before, { head: 'b2', status: '' }).changed, true);
});

test('escalation only reaches tiers the project mode allows', () => {
  const claudeOnly = ['xsmall', 'small', 'high'];
  assert.equal(b.escalation(mk({ tier: 'small' }), claudeOnly, 'max'), 'high');
  assert.equal(b.escalation(mk({ tier: 'high' }), claudeOnly, 'max'), null);
  assert.equal(b.escalation(mk({ tier: 'medium' }), claudeOnly, 'max'), null);
  assert.equal(b.escalation(mk({ tier: 'xsmall' }), ['xsmall'], 'max'), null);
});

test('closing a task ends it with your reason, never retried or open again', () => {
  const t = b.cancel(mk(), 'not needed any more');
  assert.equal(t.status, 'cancelled');
  assert.equal(t.note, 'Closed: not needed any more');
  assert.equal(b.isOpen(t), false);
  assert.equal(b.cancel(mk({ status: 'review' })).note, 'Closed');
  assert.throws(() => b.cancel(mk({ status: 'done' })), /already done/);
  assert.throws(() => b.cancel(t), /already cancelled/);
});

test('readyToClose: only a read, idle worker whose task waits in review', () => {
  const w = { id: 7, tier: 'small' };
  const board = { tasks: [b.handback(mk({ owner: 7 }), 'done', 'ok')] };
  assert.equal(b.readyToClose(board, w, { read: true }).id, 1);
  assert.equal(b.readyToClose(board, w, {}), null, 'not read yet');
  assert.equal(b.readyToClose(board, w, { read: true, busy: true }), null);
  assert.equal(b.readyToClose(board, w, { read: true, waiting: true }), null);
  assert.equal(b.readyToClose(board, { id: 7 }, { read: true }), null, 'not a worker');
  b.reject(board.tasks[0], 'redo');
  assert.equal(b.readyToClose(board, w, { read: true }), null, 'rejected work stays');
  const two = { tasks: [b.handback(mk({ owner: 7 }), 'done'), mk({ id: 2, owner: 7, status: 'doing' })] };
  assert.equal(b.readyToClose(two, w, { read: true }), null, 'other open task');
  assert.equal(b.readyToClose({ tasks: [b.handback(mk({ owner: 7 }), 'blocked')] }, w, { read: true }), null);
});
