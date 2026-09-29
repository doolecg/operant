// The pure helpers of renderer/terminal.js: the review diff, key handling, history stepping, result normalising.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const T = require('../renderer/terminal.js');

test('diff marks what was cut and what was added, and keeps the rest', () => {
  const d = T.diffHtml('please could you fix the login bug', 'fix the login bug');
  assert.match(d.original, /<del>please could you\s*<\/del>|<del>please could you<\/del>/);
  assert.ok(!d.cleaned.includes('<del>'));
  const e = T.diffHtml('fix bug', 'fix the bug now');
  assert.match(e.cleaned, /<ins>the\s*<\/ins>/);
  assert.match(e.cleaned, /<ins>\s*now<\/ins>/);
  assert.ok(!e.original.includes('<'));
});

test('diff rebuilds both texts exactly and escapes markup', () => {
  const a = 'a <b>bold</b> move\nline two', b = 'a bold move, line two';
  const ops = T.diffOps(a, b);
  assert.equal(ops.filter(o => o.op !== '+').map(o => o.text).join(''), a);
  assert.equal(ops.filter(o => o.op !== '-').map(o => o.text).join(''), b);
  assert.ok(!T.diffHtml(a, b).original.includes('<b>'));
  assert.deepEqual(T.diffOps('same', 'same'), [{ op: '=', text: 'same' }]);
});

test('review keys: Enter sends, E edits, O sends the original, Esc discards', () => {
  const k = (key, x = {}) => T.reviewKey({ key, ...x }, true);
  assert.equal(k('Enter'), 'send');
  assert.equal(k('e'), 'edit');
  assert.equal(k('O'), 'original');
  assert.equal(k('Escape'), 'discard');
  assert.equal(k('Enter', { shiftKey: true }), null);
  assert.equal(k('e', { ctrlKey: true }), null);
  assert.equal(T.reviewKey({ key: 'Enter' }, false), null);
  assert.equal(T.reviewKey({ key: 'e' }, false), null);
  assert.equal(T.reviewKey({ key: 'Escape' }, false), 'discard');
});

test('history steps stay inside the list; the last slot is the draft', () => {
  assert.equal(T.historyStep(3, 3, -1), 2);
  assert.equal(T.historyStep(3, 0, -1), 0);
  assert.equal(T.historyStep(3, 3, 1), 3);
  assert.equal(T.historyStep(0, 0, -1), 0);
});

test('a missing or failed refine result becomes one task with the prompt as it was', () => {
  const r = T.normalizeResult(null, 'do the thing');
  assert.equal(r.tasks.length, 1);
  assert.equal(r.tasks[0].prompt, 'do the thing');
  assert.equal(r.cleaned, null);
  assert.ok(r.requestId);
  assert.equal(T.normalizeResult(null, 'x', 'timed out').error, 'timed out');
  const q = T.normalizeResult({ requestId: 'r9', refined: 'clean', question: ' which file? ', tasks: [{ prompt: 'p' }] }, 'orig');
  assert.equal(q.requestId, 'r9');
  assert.equal(q.cleaned, 'clean');
  assert.equal(q.question, 'which file?');
  assert.equal(q.tasks[0].title, 'p');
});

test('text renders escaped, with code blocks and inline code', () => {
  assert.equal(T.renderText('<i>x</i>'), '&lt;i&gt;x&lt;/i&gt;');
  assert.match(T.renderText('run `npm test` now'), /<code>npm test<\/code>/);
  assert.match(T.renderText('a\n```js\nlet x = 1 < 2;\n```\nb'), /<pre class="ot-code">let x = 1 &lt; 2;<\/pre>/);
});

test('board statuses map to labels, unknown ones to "Not on the board"', () => {
  assert.equal(T.statusOf({ status: 'review' })[0], 'Ready for review');
  assert.equal(T.statusOf({ status: 'doing' })[0], 'Working');
  assert.equal(T.statusOf(undefined)[0], 'Not on the board');
  assert.equal(T.estTokens('abcdefgh'), 2);
});
