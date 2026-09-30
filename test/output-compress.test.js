const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { compress } = require('../output-compress.js');
const { formatResult } = require('../bin/operant-cli.js');

const fixture = n => fs.readFileSync(path.join(__dirname, 'fixtures', 'compress', n), 'utf8');

test('stack trace kept', () => {
  const out = compress(fixture('noisy-fail.txt'));
  assert.ok(out.length < fixture('noisy-fail.txt').length * 0.7);
  assert.ok(out.includes('at run (F:/repo/src/app.js:42:7)'));
  assert.ok(out.includes('at Object.<anonymous> (F:/repo/src/index.js:9:1)'));
});

test('error lines and paths kept', () => {
  const out = compress(fixture('noisy-fail.txt'));
  assert.match(out, /src\/app\.ts:42:7 - error TS2322/);
  assert.match(out, /TypeError: x is not a function/);
  assert.match(out, /npm ERR! code ELIFECYCLE/);
});

test('repetitive noise collapsed', () => {
  const out = compress(fixture('noisy-fail.txt'));
  assert.ok(!/compiled module 100 of 200/.test(out));
  assert.match(out, /lines omitted|more like it/);
});

test('exit code kept', () => {
  assert.match(compress(fixture('noisy-fail.txt')), /Process exited with code 2/);
});

test('worth check returns the original when little is saved', () => {
  const t = fixture('mostly-error.txt');
  assert.equal(compress(t), t);
});

test('short output is untouched', () => {
  assert.equal(compress('ok\nerror: x'), 'ok\nerror: x');
});

test('formatResult compresses long read text only when asked', () => {
  const text = fixture('noisy-fail.txt');
  assert.equal(formatResult('read', { text }), text);
  assert.ok(formatResult('read', { text }, { compress: true }).length < text.length);
});
