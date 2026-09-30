// Tests for worker-context.js: the context section of a worker's launch brief.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const wc = require('../worker-context.js');
const { CONTEXT_MAX_BYTES } = require('../agent-brief.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wctx-'));
const deps = (over = {}) => ({
  getProfile: () => ({ languages: ['JavaScript'], packageManager: 'npm', commands: ['npm test'], failing: [] }),
  getGit: () => ({ branch: 'dev-1', changed: ['M a.js'], changedTotal: 1, commits: ['abc fix cache'], conflicts: 0 }),
  recall: () => ({ shown: 1, text: 'Prefer small commits about the cache' }),
  ...over,
});

test('files the task names are found, inside the project only', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'cache.js'), 'x');
  const got = wc.mentionedFiles('fix cache.js and ../secret.js and /etc/passwd.js and nope.js', d);
  assert.deepEqual(got, ['cache.js']);
});

test('the pieces are the task files, profile, memory and git', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'cache.js'), 'function purge() {}');
  const p = wc.gatherPieces({ cwd: d, task: 'fix the cache purge in cache.js' }, deps());
  assert.deepEqual(p.map(x => x.source), ['cache.js', 'project profile', 'project memory', 'git']);
});

test('the section is one line of text with sources, under the byte cap', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'cache.js'), 'line\n'.repeat(2000));
  const r = wc.workerContext({ cwd: d, task: 'fix the cache purge in cache.js' }, deps());
  assert.match(r.text, /^ — Context for this task/);
  assert.doesNotMatch(r.text, /[\r\n"]/);
  assert.match(r.text, /\[git git\]/);
  assert.ok(Buffer.byteLength(r.text) <= CONTEXT_MAX_BYTES + 400, `${Buffer.byteLength(r.text)} bytes`);
});

test('nothing to say gives an empty string', () => {
  const r = wc.workerContext({ cwd: tmp(), task: 'x' }, { getProfile: () => ({}), getGit: () => null, recall: () => ({ shown: 0, text: '' }) });
  assert.equal(r.text, '');
});

test('git is counted as called, and as used when it made it into the brief', () => {
  const d = tmp();
  const seen = [];
  wc.workerContext({ cwd: d, task: 'what changed in the cache' }, deps({ record: (p, f) => seen.push(`${p}:${f}`) }));
  assert.deepEqual(seen, ['git:called', 'git:used']);
});

test('recordFor writes the counters into the project root', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, '.git'));
  const cp = require('../context-providers.js');
  cp.recordFor(path.join(d), 'git', 'called');
  cp.recordFor(d, 'git', 'used');
  assert.deepEqual(cp.readStats(d).git, { called: 1, used: 1, rate: 1 });
});
