const test = require('node:test');
const assert = require('node:assert/strict');
const { inQuietHours } = require('../renderer/quiet-hours');

const at = (h, m = 0) => new Date(2026, 0, 1, h, m);

test('same-day window: start inclusive, end exclusive', () => {
  assert.equal(inQuietHours('09:00', '17:00', at(9, 0)), true);
  assert.equal(inQuietHours('09:00', '17:00', at(12)), true);
  assert.equal(inQuietHours('09:00', '17:00', at(17, 0)), false);
  assert.equal(inQuietHours('09:00', '17:00', at(8, 59)), false);
});

test('window crossing midnight', () => {
  assert.equal(inQuietHours('22:00', '07:00', at(23)), true);
  assert.equal(inQuietHours('22:00', '07:00', at(0, 30)), true);
  assert.equal(inQuietHours('22:00', '07:00', at(6, 59)), true);
  assert.equal(inQuietHours('22:00', '07:00', at(7, 0)), false);
  assert.equal(inQuietHours('22:00', '07:00', at(12)), false);
});

test('empty, equal or malformed bounds mean never quiet', () => {
  assert.equal(inQuietHours('', '', at(3)), false);
  assert.equal(inQuietHours('22:00', '', at(23)), false);
  assert.equal(inQuietHours('10:00', '10:00', at(10)), false);
  assert.equal(inQuietHours('25:00', '07:00', at(3)), false);
  assert.equal(inQuietHours('abc', '07:00', at(3)), false);
});
