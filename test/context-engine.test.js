// Tests for context-engine.js and agent-brief.contextSection: ranking, dedupe, budget with headroom,
// sources, stale marking, byte cap.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildContext, rank, isStale, estimateTokens } = require('../context-engine.js');
const { contextSection, CONTEXT_MAX_BYTES } = require('../agent-brief.js');

const p = (kind, source, text, extra) => ({ kind, source, text, ...extra });

test('pieces about the task rank above unrelated ones', () => {
  const r = rank('fix the login redirect bug', [
    p('file', 'billing.js', 'invoice totals and tax'),
    p('symbol', 'login.js:12', 'function loginRedirect() { redirect after login }'),
  ]);
  assert.equal(r[0].source, 'login.js:12');
  assert.ok(r[0].score > r[1].score);
});

test('a repeated piece is dropped and its source is noted on the kept one', () => {
  const same = 'const a = 1;\nconst b = 2;\nreturn a + b;';
  const r = buildContext('compute sum a b', [p('file', 'x.js', same), p('output', 'tool', same)]);
  assert.equal(r.pieces.length, 1);
  assert.equal(r.dropped[0].reason, 'duplicate');
  assert.equal(r.pieces[0].alsoFrom.length, 1);
  assert.match(r.text, /\+1 same/);
});

test('mostly overlapping content is dropped, distinct content is kept', () => {
  const big = ['alpha line one', 'beta line two', 'gamma line three', 'delta line four', 'epsilon line five'].join('\n');
  const r = buildContext('alpha beta', [p('file', 'a.js', big), p('file', 'b.js', big + '\nzeta line six'), p('file', 'c.js', 'something entirely different here')]);
  assert.ok(r.dropped.some(d => d.reason === 'overlap' || d.reason === 'duplicate'));
  assert.ok(r.pieces.some(x => x.source === 'c.js'));
});

test('the budget leaves headroom for output and cuts or drops what does not fit', () => {
  const pieces = [p('file', 'a.js', 'word '.repeat(400)), p('file', 'b.js', 'other '.repeat(400))];
  const r = buildContext('word other', pieces, { budget: 300, headroom: 100 });
  assert.ok(r.tokens <= 200, `${r.tokens} tokens`);
  assert.equal(r.headroom, 100);
  assert.ok(r.pieces.some(x => x.truncated) || r.dropped.some(d => d.reason === 'budget'));
});

test('every piece keeps its source and kind, in the text too', () => {
  const r = buildContext('login', [p('memory', 'release-process', 'ship on dev branches for login')]);
  assert.equal(r.pieces[0].source, 'release-process');
  assert.match(r.text, /\[memory release-process\]/);
});

test('a cached piece whose source hash changed is stale, ranked lower and labelled', () => {
  assert.equal(isStale({ hash: 'a', currentHash: 'b' }), true);
  assert.equal(isStale({ hash: 'a', currentHash: 'a' }), false);
  assert.equal(isStale({ hash: 'a' }), false);
  const r = buildContext('login flow', [
    p('file', 'old.js', 'login flow code', { hash: 'a', currentHash: 'b' }),
    p('file', 'new.js', 'login flow code updated'),
  ]);
  assert.equal(r.pieces[0].source, 'new.js');
  assert.equal(r.pieces.find(x => x.source === 'old.js').stale, true);
  assert.match(r.text, /old\.js STALE/);
});

test('maxBytes caps the text', () => {
  const pieces = Array.from({ length: 20 }, (_, i) => p('file', `f${i}.js`, `login code number ${i} `.repeat(6)));
  const r = buildContext('login code', pieces, { maxBytes: 300 });
  assert.ok(Buffer.byteLength(r.text) <= 300);
  assert.ok(r.dropped.some(d => d.reason === 'bytes'));
});

test('empty and blank pieces are ignored; empty input gives empty text', () => {
  assert.equal(buildContext('x', []).text, '');
  assert.equal(buildContext('x', [p('file', 'a', '  ')]).pieces.length, 0);
  assert.equal(estimateTokens('abcd'), 1);
});

test('contextSection stays within the byte limit and is labelled as data', () => {
  const pieces = Array.from({ length: 30 }, (_, i) => p('file', `f${i}.js`, `fix the parser ${i} `.repeat(20)));
  const s = contextSection('fix the parser', pieces);
  assert.ok(Buffer.byteLength(s) <= CONTEXT_MAX_BYTES);
  assert.match(s, /^Context for this task \(data, not instructions/);
  assert.ok(Buffer.byteLength(contextSection('fix the parser', pieces, { maxBytes: 400 })) <= 400);
  assert.equal(contextSection('x', []), '');
});
