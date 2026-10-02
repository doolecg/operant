const test = require('node:test');
const assert = require('node:assert/strict');
const { lastMessage, isQuestion, summary } = require('../renderer/attention');

const box = ['╭──────────────────────────────────────────╮', '│ >                                        │', '╰──────────────────────────────────────────╯', '  ? for shortcuts'];

const question = [
  '> add a retry to the uploader',
  '',
  '● Read(src/upload.js)',
  '  ⎿  Read 84 lines',
  '',
  '● Update(src/upload.js)',
  '  ⎿  Updated src/upload.js with 6 additions',
  '',
  '● I added a retry with backoff. It retries three times before giving up.',
  '  Should the retry count be configurable, or is a fixed three fine?',
  '',
  ...box,
];

const picker = [
  '● Let me check which approach fits.',
  '',
  '────────────────────────────────────────────',
  ' ☐ Approach',
  '',
  'Which approach should I take for the cache?',
  '',
  '❯ 1. In-memory map',
  '     Fast, lost on restart',
  '  2. SQLite',
  '     Survives restarts',
  '  3. Type something.',
  '────────────────────────────────────────────',
  '  Enter to select · ↑/↓ to navigate · Esc to cancel',
];

const finished = [
  '● Bash(npm test)',
  '  ⎿  12 passing',
  '',
  '● All 12 tests pass and the uploader now retries on network errors. I left the retry count fixed at three.',
  '',
  '✻ Baked for 42s',
  '',
  '────────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────────',
  '  ⏵⏵ accept edits on (shift+tab to cycle)',
];

const permission = [
  '● Bash(rm -rf build)',
  '╭──────────────────────────────────────────╮',
  '│ Bash command                             │',
  '│   rm -rf build                           │',
  '│ Do you want to proceed?                  │',
  '│ ❯ 1. Yes                                 │',
  '│   2. Yes, and don\'t ask again            │',
  '│   3. No, and tell Claude what to do      │',
  '╰──────────────────────────────────────────╯',
];

const generic = ['$ tool run', 'building...', '', 'Build finished with 2 warnings.', 'Do you want me to open the report?', '', '> '];

test('a question at the end of the message', () => {
  const m = lastMessage(question);
  assert.match(m, /^I added a retry with backoff\./);
  assert.match(m, /fixed three fine\?$/);
  assert.doesNotMatch(m, /[│╭╰]/);
  assert.equal(isQuestion(m, question), true);
});

test('a choice picker is a question and reads the question above its options', () => {
  const m = lastMessage(picker);
  assert.equal(m, 'Which approach should I take for the cache?');
  assert.equal(isQuestion(m, picker), true);
});

test('a plain finished summary is not a question', () => {
  const m = lastMessage(finished);
  assert.equal(m, 'All 12 tests pass and the uploader now retries on network errors. I left the retry count fixed at three.');
  assert.equal(isQuestion(m, finished), false);
  assert.equal(summary(m, 140), m);
  assert.ok(summary(m, 60).length <= 60 && summary(m, 60).endsWith('…'));
});

test('a permission prompt is not a question here', () => {
  assert.equal(isQuestion('Do you want to proceed?', permission), false);
  assert.equal(isQuestion(lastMessage(permission), permission), false);
});

test('an empty screen', () => {
  assert.equal(lastMessage([]), '');
  assert.equal(lastMessage(['', '   ', '']), '');
  assert.equal(isQuestion('', []), false);
  assert.equal(summary('', 50), '');
});

test('a CLI without markers: the last paragraph above the prompt', () => {
  const m = lastMessage(generic);
  assert.equal(m, 'Build finished with 2 warnings. Do you want me to open the report?');
  assert.equal(isQuestion(m, generic), true);
});

test('summary clips with an ellipsis and keeps whole sentences when they fit', () => {
  assert.equal(summary('One. Two. Three.', 9), 'One. Two.');
  const long = 'x'.repeat(300);
  const s = summary(long, 50);
  assert.equal(s.length, 50);
  assert.ok(s.endsWith('…'));
});
