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
