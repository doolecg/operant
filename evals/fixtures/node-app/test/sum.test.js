const { test } = require('node:test');
const assert = require('node:assert');
const { sum } = require('../src/sum');

test('sum of an empty list is 0', () => {
  assert.strictEqual(sum([]), 0);
});

test('sum of one number is that number', () => {
  const numbers = [5];
  const total = sum(numbers);
  assert.strictEqual(total, 5);
});

test('sum adds every number in the list', () => {
  assert.strictEqual(sum([1, 2, 3]), 6);
});

test('sum leaves its input alone', () => {
  const numbers = [4, 5, 6];
  sum(numbers);
  assert.deepStrictEqual(numbers, [4, 5, 6]);
});

test('sum of zeros is 0', () => {
  assert.strictEqual(sum([0, 0, 0]), 0);
});
