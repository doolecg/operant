// Tests for plan-check.js: advice is deterministic, never blocking; a strategy is suggested by task profile.
const test = require('node:test');
const assert = require('node:assert/strict');
const { check, lines } = require('../plan-check.js');
const kinds = r => r.advice.map(a => a.kind);

test('a bare code task lacks acceptance and constraints', () => {
  const r = check('Refactor the settings module and reorganize the config handling for maintainability');
  assert.ok(kinds(r).includes('constraints'));
  assert.ok(kinds(r).includes('acceptance'));
});

test('a clear task with a check and a constraint has no advice', () => {
  const r = check('Fix the crash in board.js when a task has no tier; the board tests must pass; do not change the public API');
  assert.deepEqual(r.advice, []);
  assert.equal(r.strategy.name, 'direct');
});

test('contradictions: forbids and asks to change the same thing', () => {
  const r = check("Don't touch board.js. Then edit board.js to add a state; tests should pass");
  assert.ok(kinds(r).includes('contradiction'));
  assert.match(r.advice.find(a => a.kind === 'contradiction').text, /board\.js/);
  assert.equal(r.strategy.name, 'clarify');
  assert.ok(!kinds(check('Do not edit main.js; edit board.js so the tests pass')).includes('contradiction'));
  assert.ok(kinds(check('No new dependencies, but npm install left-pad so the build passes')).includes('contradiction'));
});

test('excess scope is flagged and staged', () => {
  const r = check('Update a.js, b.js, c.js, d.js, e.js, f.js, g.js in src/, lib/, test/ and docs/ so that all tests pass; do not change the API');
  assert.ok(kinds(r).includes('scope'));
  assert.equal(r.strategy.name, 'staged');
  assert.ok(kinds(check('Rewrite everything across the whole app so it passes')).includes('scope'));
});

test('strategies by profile', () => {
  assert.equal(check('1. add a.js 2. add b.js 3. add c.js; tests must pass').strategy.name, 'parallel');
  assert.equal(check('Where does the router decide which tier a task goes to?').strategy.name, 'retrieval-first');
  assert.equal(check('fix it').strategy.name, 'clarify');
  assert.equal(check('Rename foo to bar in util.js so the tests still pass; keep behaviour unchanged').strategy.name, 'direct');
});

test('lines are short text for task show and prime', () => {
  const l = lines(check("Don't touch board.js. Edit board.js."));
  assert.match(l[0], /^advice \(contradiction\)/);
  assert.match(l[l.length - 1], /^suggested strategy: clarify/);
  assert.deepEqual(check('').advice.length >= 0, true);
});
