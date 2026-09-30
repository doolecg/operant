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

test('describeTask: profile of a small docs task and a risky multi-part one', () => {
  const { describeTask } = require('../task-type.js');
  const low = describeTask('update the README', { files: 50, language: 'javascript' });
  assert.deepEqual(low, { type: 'docs', complexity: 'low', risk: 'low', repoSize: 'small', language: 'javascript', context: 'low', verification: 'none' });
  const big = describeTask('fix the auth migration across src/a.js src/b.js src/c.js src/d.js src/e.js: 1. drop old table 2. backfill 3. update login 4. add tests', { files: 5000 });
  assert.equal(big.risk, 'high');
  assert.equal(big.complexity, 'high');
  assert.equal(big.repoSize, 'large');
  assert.equal(big.language, 'javascript');
  assert.equal(big.verification, 'full');
});

test('describeTask: deterministic, language from the prompt beats the project, unknown without info', () => {
  const { describeTask } = require('../task-type.js');
  assert.deepEqual(describeTask('fix foo.py'), describeTask('fix foo.py'));
  assert.equal(describeTask('fix foo.py', { language: 'rust' }).language, 'python');
  assert.equal(describeTask('fix the bug').language, 'unknown');
  assert.equal(describeTask('fix the bug').repoSize, 'unknown');
  assert.equal(describeTask('refactor the parser').risk, 'medium');
  assert.equal(describeTask('add a button').verification, 'checks');
});

test('extraChecks: type check and lint only when the project has them', () => {
  const { extraChecks } = require('../task-type.js');
  assert.deepEqual(extraChecks({ scripts: { test: 'x', lint: 'eslint .', typecheck: 'tsc' } }, []), [
    { kind: 'typecheck', command: 'npm run typecheck' }, { kind: 'lint', command: 'npm run lint' }]);
  assert.deepEqual(extraChecks({ scripts: { test: 'x' }, devDependencies: { typescript: '5' } }, ['tsconfig.json']), [{ kind: 'typecheck', command: 'npx tsc --noEmit' }]);
  assert.deepEqual(extraChecks({ scripts: { test: 'x' } }, ['tsconfig.json']), []);
  assert.deepEqual(extraChecks(null, ['Cargo.toml']).map(c => c.command), ['cargo check', 'cargo clippy']);
  assert.deepEqual(extraChecks(null, ['go.mod']).map(c => c.command), ['go vet ./...']);
  assert.deepEqual(extraChecks(null, []), []);
});

test('reviewAdvice: only high-risk tasks get the independent-review line', () => {
  const { reviewAdvice, describeTask } = require('../task-type.js');
  assert.match(reviewAdvice(describeTask('fix the auth token check')), /independent review/);
  assert.equal(reviewAdvice(describeTask('add a button')), null);
  assert.equal(reviewAdvice(null), null);
});
