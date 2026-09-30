const test = require('node:test');
const assert = require('node:assert');
const { normalise, createStuckTracker } = require('../stuck.js');

test('normalise strips timestamps, durations, hex ids and temp paths', () => {
  const a = normalise('Failed at 2026-09-29T10:11:12.345Z after 3.2s id deadbeef12 in C:\\Users\\me\\AppData\\Local\\Temp\\x1\\a.js');
  const b = normalise('Failed at 2026-09-30T01:02:03Z after 41ms id cafebabe99 in C:\\Users\\me\\AppData\\Local\\Temp\\y2\\a.js');
  assert.strictEqual(a, b);
  assert.ok(normalise('x'.repeat(500)).length <= 300);
});

test('the same command failing twice with the same output triggers', () => {
  const t = createStuckTracker();
  assert.strictEqual(t.onToolResult({ command: 'npm  test', text: "Cannot find module 'x' (1.2s)", isError: true }), null);
  const r = t.onToolResult({ command: ' npm test ', text: "Cannot find module 'x' (3.4s)", isError: true });
  assert.strictEqual(r.kind, 'command');
  assert.match(r.reason, /the same command keeps failing: npm test → 'Cannot find module/);
  assert.strictEqual(t.onToolResult({ command: 'npm test', text: "Cannot find module 'x'", isError: true }), null);
});

test('different output does not trigger; successes are ignored', () => {
  const t = createStuckTracker();
  assert.strictEqual(t.onToolResult({ command: 'npm test', text: 'error A', isError: true }), null);
  assert.strictEqual(t.onToolResult({ command: 'npm test', text: 'error B', isError: true }), null);
  assert.strictEqual(t.onToolResult({ command: 'npm test', text: 'error A', isError: false }), null);
  assert.strictEqual(t.onToolResult({ command: 'npm test', text: 'error A', isError: false }), null);
});

test('the same error twice from a non-shell tool triggers', () => {
  const t = createStuckTracker();
  assert.strictEqual(t.onToolResult({ text: 'File not found: a.txt', isError: true }), null);
  const r = t.onToolResult({ text: 'File not found: a.txt', isError: true });
  assert.strictEqual(r.kind, 'error');
  assert.match(r.reason, /same error keeps coming back/);
});

test('turns without edits trigger once; an edit resets the count', () => {
  const t = createStuckTracker({ stuckTurns: 3 });
  assert.strictEqual(t.onTurn(), null);
  assert.strictEqual(t.onTurn(), null);
  t.onFileEdit();
  assert.strictEqual(t.onTurn(), null);
  assert.strictEqual(t.onTurn(), null);
  assert.strictEqual(t.onTurn().kind, 'progress');
  assert.strictEqual(t.onTurn(), null);
});

test('stuckTurns 0 turns the progress check off', () => {
  const t = createStuckTracker({ stuckTurns: 0 });
  for (let i = 0; i < 50; i++) assert.strictEqual(t.onTurn(), null);
});

test('reset() forgets everything', () => {
  const t = createStuckTracker({ stuckTurns: 2 });
  t.onToolResult({ command: 'a', text: 'e', isError: true });
  t.onTurn();
  t.reset();
  assert.strictEqual(t.onToolResult({ command: 'a', text: 'e', isError: true }), null);
  assert.strictEqual(t.onTurn(), null);
  assert.strictEqual(t.onTurn().kind, 'progress');
});

test('a repeat after an edit waits for the third time', () => {
  const t = createStuckTracker();
  assert.strictEqual(t.onToolResult({ command: 'npm test', text: 'fail 2', isError: true }), null);
  t.onFileEdit();
  assert.strictEqual(t.onToolResult({ command: 'npm test', text: 'fail 2', isError: true }), null);
  t.onFileEdit();
  assert.strictEqual(t.onToolResult({ command: 'npm test', text: 'fail 2', isError: true }).kind, 'command');
});

test('the same edit reverted and applied again triggers once, with a plain reason', () => {
  const t = createStuckTracker();
  const a = { file: 'src/a.js', before: 'let x = 1', after: 'let x = 2' };
  assert.strictEqual(t.onFileEdit(a), null);
  assert.strictEqual(t.onFileEdit({ file: 'src/a.js', before: 'let x = 2', after: 'let x = 1' }), null, 'a revert alone is not a loop');
  const r = t.onFileEdit(a);
  assert.strictEqual(r.kind, 'edit-loop');
  assert.match(r.reason, /the same edit to src\/a\.js was reverted and then applied again/);
  assert.strictEqual(t.onFileEdit({ file: 'src/a.js', before: 'let x = 2', after: 'let x = 1' }), null);
  assert.strictEqual(t.onFileEdit(a), null, 'fires once');
});

test('different edits, other files and unchanged edits do not trigger', () => {
  const t = createStuckTracker();
  assert.strictEqual(t.onFileEdit({ file: 'a.js', before: 'a', after: 'b' }), null);
  assert.strictEqual(t.onFileEdit({ file: 'b.js', before: 'b', after: 'a' }), null);
  assert.strictEqual(t.onFileEdit({ file: 'a.js', before: 'a', after: 'c' }), null);
  assert.strictEqual(t.onFileEdit({ file: 'a.js', before: 'same', after: 'same' }), null);
  assert.strictEqual(t.onFileEdit(), null);
});

test('whole-file writes A, B, A, B count as a revert and a reapply', () => {
  const t = createStuckTracker();
  assert.strictEqual(t.onFileEdit({ file: 'f.txt', after: 'A' }), null);
  assert.strictEqual(t.onFileEdit({ file: 'f.txt', after: 'B' }), null);
  assert.strictEqual(t.onFileEdit({ file: 'f.txt', after: 'A' }), null);
  assert.strictEqual(t.onFileEdit({ file: 'f.txt', after: 'B' }).kind, 'edit-loop');
});

test('a patch applied, reversed and applied again triggers', () => {
  const t = createStuckTracker();
  const patch = '--- a/x.js\n+++ b/x.js\n@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n keep';
  const undo = '--- a/x.js\n+++ b/x.js\n@@ -1,2 +1,2 @@\n-const a = 2;\n+const a = 1;\n keep';
  assert.strictEqual(t.onFileEdit({ patch }), null);
  assert.strictEqual(t.onFileEdit({ patch: undo }), null);
  assert.match(t.onFileEdit({ patch }).reason, /the same edit to the patch was reverted and then applied again/);
});

test('an edit still resets the no-progress count', () => {
  const t = createStuckTracker({ stuckTurns: 2 });
  t.onTurn();
  t.onFileEdit({ file: 'a', before: 'x', after: 'y' });
  assert.strictEqual(t.onTurn(), null);
});

test('test, edit, test, edit with the same failing output triggers on the third run, even with different commands', () => {
  const t = createStuckTracker();
  const out = 'not ok 3 - parses dates\n  AssertionError: expected 2 to equal 3 (12ms)';
  assert.strictEqual(t.onToolResult({ command: 'npm test', text: out, isError: true }), null);
  t.onFileEdit({ file: 'a.js', before: '1', after: '2' });
  assert.strictEqual(t.onToolResult({ command: 'node --test test/a.test.js', text: out.replace('12ms', '9ms'), isError: true }), null);
  t.onFileEdit({ file: 'a.js', before: '2', after: '3' });
  const r = t.onToolResult({ command: 'npx jest a', text: out, isError: true });
  assert.strictEqual(r.kind, 'test-cycle');
  assert.match(r.reason, /3 test runs with edits in between, and still failing the same way: 'not ok 3 - parses dates/);
  t.onFileEdit({ file: 'a.js', before: '3', after: '4' });
  assert.strictEqual(t.onToolResult({ command: 'npm test', text: out, isError: true }), null, 'fires once');
});

test('test runs without edits in between, or with changing failures, are not a cycle', () => {
  const t = createStuckTracker();
  for (const n of [1, 2, 3, 4]) {
    t.onFileEdit({ file: 'a.js', before: 'x' + n, after: 'y' + n });
    assert.strictEqual(t.onToolResult({ command: 'npm test', text: `not ok ${n} - case ${n}`, isError: true }), null);
  }
  const u = createStuckTracker();
  assert.strictEqual(u.onToolResult({ command: 'pytest', text: 'FAILED test_a', isError: true }), null);
  assert.strictEqual(u.onToolResult({ command: 'cargo test', text: 'FAILED test_a', isError: true }), null);
  assert.strictEqual(u.onToolResult({ command: 'go test', text: 'FAILED test_a', isError: true }), null);
});
