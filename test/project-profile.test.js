// Tests for project-profile.js and the Project/Git blocks in `operant prime`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getProfile, getGit } = require('../project-profile.js');
const { formatPrime, BUDGET } = require('../bin/operant-prime.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'op-prof-'));
const put = (d, f, s) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), s); };

test('node project: language, package manager and scripts', () => {
  const d = tmp();
  put(d, 'package.json', JSON.stringify({ scripts: { build: 'x', test: 'y', lint: 'z', other: 'q' } }));
  put(d, 'yarn.lock', '');
  const p = getProfile(d);
  assert.deepEqual(p.languages, ['JavaScript']);
  assert.equal(p.packageManager, 'yarn');
  assert.deepEqual(p.commands, ['yarn build', 'yarn test', 'yarn lint']);
});

test('cargo, gradle, go and python manifests', () => {
  let d = tmp(); put(d, 'Cargo.toml', ''); assert.deepEqual(getProfile(d).commands, ['cargo build', 'cargo test']);
  d = tmp(); put(d, 'build.gradle', ''); put(d, 'gradlew', ''); assert.equal(getProfile(d).commands[0], './gradlew build');
  d = tmp(); put(d, 'go.mod', ''); assert.equal(getProfile(d).languages[0], 'Go');
  d = tmp(); put(d, 'pyproject.toml', '[tool.poetry]\n[tool.pytest]'); const p = getProfile(d);
  assert.equal(p.packageManager, 'poetry'); assert.ok(p.commands.includes('pytest'));
});

test('cache is reused and refreshed when a key file changes', () => {
  const d = tmp();
  put(d, '.operant/x', '');
  put(d, 'package.json', JSON.stringify({ scripts: { test: 'a' } }));
  assert.deepEqual(getProfile(d).commands, ['npm test']);
  assert.ok(fs.existsSync(path.join(d, '.operant', 'profile.json')));
  const c = JSON.parse(fs.readFileSync(path.join(d, '.operant', 'profile.json'), 'utf8'));
  c.commands = ['cached']; fs.writeFileSync(path.join(d, '.operant', 'profile.json'), JSON.stringify(c));
  assert.deepEqual(getProfile(d).commands, ['cached'], 'unchanged files: cache used');
  put(d, 'package.json', JSON.stringify({ scripts: { test: 'a', build: 'b' } }));
  const t = new Date(Date.now() + 5000); fs.utimesSync(path.join(d, 'package.json'), t, t);
  assert.deepEqual(getProfile(d).commands, ['npm run build', 'npm test']);
});

test('failing checks are stored and survive a refresh', () => {
  const d = tmp(); put(d, '.operant/x', ''); put(d, 'Cargo.toml', '');
  assert.deepEqual(getProfile(d, { failing: ['cargo test'] }).failing, ['cargo test']);
  const t = new Date(Date.now() + 5000); fs.utimesSync(path.join(d, 'Cargo.toml'), t, t);
  assert.deepEqual(getProfile(d).failing, ['cargo test']);
});

test('getGit parses and caps porcelain and log output', () => {
  const run = (_d, a) => a[0] === 'rev-parse' ? 'main\n'
    : a[0] === 'status' ? Array.from({ length: 30 }, (_, i) => ` M f${i}.js`).join('\n') + '\nUU c.js\n'
    : Array.from({ length: 9 }, (_, i) => `abc${i} msg ${i}`).join('\n');
  const g = getGit('.', run);
  assert.equal(g.branch, 'main'); assert.equal(g.changed.length, 8); assert.equal(g.changedTotal, 31);
  assert.equal(g.conflicts, 1); assert.equal(g.commits.length, 5);
  assert.equal(getGit('.', () => null), null);
});

test('prime shows Project and Git blocks and stays within BUDGET with huge inputs', () => {
  const big = 'x'.repeat(500) + '<b>';
  const local = {
    progress: 'p'.repeat(5000),
    profile: { languages: Array(20).fill(big), packageManager: big, commands: Array(50).fill(big), failing: Array(50).fill(big) },
    git: { branch: big, changed: Array(500).fill(big), changedTotal: 500, conflicts: 3, commits: Array(50).fill(big) },
  };
  const d = { v: '1', role: 'lead', tile: { id: 1, kind: 'ai', agent: 'claude' }, memory: { text: Array(50).fill('m'.repeat(200)).join('\n'), total: 50 },
    tiles: Array.from({ length: 30 }, (_, i) => ({ id: i + 2, kind: 'shell', title: big })) };
  const text = formatPrime(d, local);
  assert.ok(text.length <= BUDGET, String(text.length));
  assert.doesNotMatch(text, /<b>/);
  const small = formatPrime({ v: '1', role: 'lead', tile: { id: 1, kind: 'ai' } }, { profile: { languages: ['Go'], packageManager: 'go', commands: ['go test ./...'], failing: [] },
    git: { branch: 'dev', changed: [' M a.js'], changedTotal: 1, conflicts: 0, commits: ['abc fix'] } });
  assert.match(small, /Project: Go · go; commands: go test/);
  assert.match(small, /Git: branch dev; changed: M a\.js/);
  assert.match(small, /Recent commits: abc fix/);
});
