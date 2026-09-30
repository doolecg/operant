const test = require('node:test');
const assert = require('node:assert/strict');
const { classify } = require('../failure-class');

const kind = e => classify(e)?.kind;

test('each failure kind is read from the note', () => {
  assert.equal(kind({ note: 'prompt is too long for the context window' }), 'context-overflow');
  assert.equal(kind({ note: 'HTTP 429 too many requests' }), 'rate-limit');
  assert.equal(kind({ note: '401 Unauthorized: invalid api key' }), 'auth');
  assert.equal(kind({ note: 'request timed out after 120s' }), 'timeout');
  assert.equal(kind({ note: 'the worker kept repeating the same command' }), 'stuck-loop');
  assert.equal(kind({ note: '3 tests failed in board.test.js' }), 'test-failure');
  assert.equal(kind({ note: 'model returned malformed JSON' }), 'bad-output');
  assert.equal(kind({ note: 'something odd happened' }), 'other');
});

test('the stuck flag and a failed check are evidence too', () => {
  assert.equal(kind({ note: 'x', stuck: true }), 'stuck-loop');
  assert.equal(kind({ check: { ok: false, command: 'npm test' } }), 'test-failure');
  assert.equal(classify({ check: { ok: true } }), null);
  assert.equal(classify({}), null);
});

test('deterministic: earlier rules win, same input same answer', () => {
  const e = { note: 'rate limit hit, then timeout' };
  assert.equal(kind(e), 'rate-limit');
  assert.deepEqual(classify(e), classify(e));
  assert.match(classify(e).evidence, /rate limit/);
});
