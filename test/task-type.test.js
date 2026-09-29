// Tests for task-type.js: deterministic keyword classes for board tasks.
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyTask } = require('../task-type.js');

const cases = [
  ['Fix the crash when the tile closes during a resize', 'fix'],
  ['The settings page is broken on macOS', 'fix'],
  ['Find where the failing test is set up', 'fix'],
  ['Add unit tests for board.js escalation', 'test'],
  ['Raise coverage of memory.js', 'test'],
  ['Refactor the updater to share one download helper', 'refactor'],
  ['Rename tierDot to tierBadge everywhere', 'refactor'],
  ['Extract the pricing table into its own file', 'refactor'],
  ['Update the README with the new CLI flags', 'docs'],
  ['Add a changelog entry for 2.0', 'docs'],
  ['Where is the session file written?', 'lookup'],
  ['Explain how escalation picks the next tier', 'lookup'],
  ['Summarise the open tasks in the repo', 'lookup'],
  ['Add a dark theme option to Settings', 'feature'],
  ['Implement outcome recording', 'feature'],
  ['Create a new tile kind for logs', 'feature'],
  ['Ponder the meaning of life', 'other'],
  ['', 'other'],
];
for (const [text, want] of cases) test(`${want}: ${text || '(empty)'}`, () => assert.equal(classifyTask(text), want));

test('needsVerification: code tasks only', () => {
  const { needsVerification } = require('../task-type.js');
  for (const text of ['fix the login bug', 'add a settings page', 'refactor the parser', 'write tests for board']) assert.equal(needsVerification({ text }), true, text);
  for (const text of ['update the README', 'where is the config read?', 'hello']) assert.equal(needsVerification({ text }), false, text);
});
