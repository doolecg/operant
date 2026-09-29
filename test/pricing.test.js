const test = require('node:test');
const assert = require('node:assert/strict');
const { priceOf, info } = require('../pricing');

test('a known Claude model prices from the table', () => {
  const r = priceOf('claude-sonnet-5-5', { input: 1e6, output: 1e6, cacheWrite: 1e6, cacheRead: 1e6 });
  assert.equal(r.usd, 2 + 10 + 2.5 + 0.2);
  assert.equal(r.source, info.source);
  assert.equal(info.date, '2026-09-29');
});

test('id decorations still match: provider prefix, dots, date suffix, [1m]', () => {
  assert.equal(priceOf('anthropic/claude-opus-4.8[1m]', { input: 1e6 }).usd, 5);
  assert.equal(priceOf('claude-haiku-4-5-20251001', { output: 1e6 }).usd, 5);
  assert.equal(priceOf('claude-opus-5-5', { input: 1e6 }).usd, 4);
});

test('an unknown model is null, never a guess', () => {
  assert.equal(priceOf('mystery-model-9', { input: 1e6 }).usd, null);
  assert.equal(priceOf(undefined, { input: 5 }).usd, null);
  assert.equal(priceOf('claude-sonnet-5-6', { input: 1e6 }).usd, null);
});

test('free Zen models are $0', () => {
  assert.deepEqual(priceOf('big-pickle', { input: 1e6 }), { usd: 0, source: 'OpenCode Zen free' });
  assert.equal(priceOf('nemotron-3-ultra-free', { output: 1e6 }).usd, 0);
});

test("OpenCode's recorded cost wins when above 0", () => {
  const r = priceOf('some-model', { input: 1e6 }, 0.37);
  assert.equal(r.usd, 0.37);
  assert.equal(r.source, 'OpenCode recorded cost');
  assert.equal(priceOf('claude-haiku-4-5', { input: 1e6 }, 0.5).usd, 0.5);
  assert.equal(priceOf('claude-haiku-4-5', { input: 1e6 }, 0).usd, 1);
});
