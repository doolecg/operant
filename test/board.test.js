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
