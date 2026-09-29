// Tests for agent-brief.js: the always-on brief stays a short pointer; the live part is `operant prime`.
const test = require('node:test');
const assert = require('node:assert/strict');
const { BRIEF, briefFor } = require('../agent-brief.js');

test('the brief is short and identical every launch', () => {
  for (const agent of ['claude', 'opencode']) {
    assert.ok(Buffer.byteLength(briefFor(agent)) <= 640, `${agent}: ${Buffer.byteLength(briefFor(agent))} bytes`);
    assert.equal(briefFor(agent), briefFor(agent));
  }
  assert.equal(BRIEF, briefFor('claude'));
});

test('it points at prime and the skill by the name each agent sees', () => {
  assert.match(briefFor('claude'), /operant prime/);
  assert.match(briefFor('claude'), /`operant:operant` skill/);
  assert.match(briefFor('opencode'), /`operant` skill/);
});

test('team tiers, the progress note and CodeGraph live in prime, not here', () => {
  for (const agent of ['claude', 'opencode']) assert.doesNotMatch(briefFor(agent), /progress\.md|codegraph explore/i);
});
