const test = require('node:test');
const assert = require('node:assert');
const { warnLevel, WARN_MSG, checkpointText, createRecovery } = require('../context-recovery.js');

test('warn level sits below auto compact, 70 when it is off', () => {
  assert.strictEqual(warnLevel(85), 75);
  assert.strictEqual(warnLevel(0), 70);
  assert.strictEqual(warnLevel(undefined), 70);
  assert.strictEqual(warnLevel(5), 1);
});

test('warns once per crossing and again after dropping under', () => {
  const r = createRecovery();
  assert.strictEqual(r.shouldWarn('a', 0.5, 0.7, 0.85), false);
  assert.strictEqual(r.shouldWarn('a', 0.72, 0.7, 0.85), true);
  assert.strictEqual(r.shouldWarn('a', 0.75, 0.7, 0.85), false);
  assert.strictEqual(r.shouldWarn('a', 0.4, 0.7, 0.85), false);
  assert.strictEqual(r.shouldWarn('a', 0.71, 0.7, 0.85), true);
  assert.strictEqual(r.shouldWarn('b', 0.71, 0.7, 0.85), true);
});

test('no warning once at or over the compact level', () => {
  const r = createRecovery();
  assert.strictEqual(r.shouldWarn('a', 0.9, 0.7, 0.85), false);
});

test('checkpoint text names task, files and next step', () => {
  const t = checkpointText({ task: 'Fix the\nlogin bug', files: ['a.js', 'b.js'], next: '' });
  assert.match(t, /Task: Fix the login bug/);
  assert.match(t, /a\.js, b\.js/);
  assert.match(t, /progress\.md/);
  assert.match(checkpointText({ files: Array.from({ length: 20 }, (_, i) => 'f' + i) }), /and 5 more/);
  assert.match(WARN_MSG(72.4), /72%/);
});

test('the second compact suggests a split, once', () => {
  const r = createRecovery();
  assert.strictEqual(r.beginCompact('a', { task: 't', files: ['x', 'x'] }).split, false);
  const second = r.beginCompact('a', { files: ['y'] });
  assert.strictEqual(second.split, true);
  assert.strictEqual(second.checkpoint.count, 2);
  assert.strictEqual(r.beginCompact('a').split, false);
  assert.strictEqual(r.beginCompact('b').split, false);
  assert.deepStrictEqual(r.checkpointFor('b').files, []);
  r.forget('a');
  assert.strictEqual(r.count('a'), 0);
  assert.strictEqual(r.checkpointFor('a'), null);
});
