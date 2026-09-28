// Tests for backup.js against a temp bare repo as the "remote" and a temp clone. Never touches a real remote or ~/.claude.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const backup = require('../backup.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'operant-backuptest-'));
test.after(() => { fs.rmSync(root, { recursive: true, force: true }); });

const write = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

const bare = path.join(root, 'remote.git');
const clone = path.join(root, 'clone');
const hubDir = path.join(root, 'hub');
const claudeDir = path.join(root, 'claude');

test.before(() => {
  execFileSync('git', ['init', '--bare', '-b', 'main', bare], { stdio: 'ignore' });
  execFileSync('git', ['clone', bare, clone], { stdio: 'ignore' });
  git(clone, 'config', 'user.name', 'Test'); git(clone, 'config', 'user.email', 'test@example.invalid');
  write(path.join(hubDir, 'skills', 'alpha', 'SKILL.md'), '# alpha');
  write(path.join(hubDir, 'skills', 'alpha', '__pycache__', 'x.pyc'), 'junk');
  write(path.join(hubDir, 'skills', 'alpha', '.env'), 'SECRET=1');
  write(path.join(hubDir, 'skills', 'alpha', 'deploy.key'), 'k');
  write(path.join(hubDir, 'skills', 'alpha', 'server.pem'), 'k');
  write(path.join(hubDir, 'skills', 'alpha', 'credentials.json'), 'k');
  write(path.join(hubDir, 'skills', 'alpha', 'lib', 'a.js'), 'ok');
  write(path.join(hubDir, 'rules.md'), 'my rules');
  // ~/.claude/skills: a junction into the hub, a local skill, a junction to a folder elsewhere, and things to skip
  fs.mkdirSync(path.join(claudeDir, 'skills'), { recursive: true });
  fs.symlinkSync(path.join(hubDir, 'skills', 'alpha'), path.join(claudeDir, 'skills', 'alpha'), 'junction');
  write(path.join(claudeDir, 'skills', 'local', 'SKILL.md'), '# local');
  write(path.join(root, 'elsewhere', 'linked', 'SKILL.md'), '# linked content');
  fs.symlinkSync(path.join(root, 'elsewhere', 'linked'), path.join(claudeDir, 'skills', 'linked'), 'junction');
  write(path.join(claudeDir, 'skills', 'synced', 'SKILL.md'), 'managed');
  fs.symlinkSync(hubDir, path.join(claudeDir, 'skills', 'operant-hub'), 'junction');
});

const run = () => backup.backupAll({ repos: [{ path: clone }], hubDir, claudeDir });
const tree = () => git(bare, 'ls-tree', '-r', '--name-only', 'main');

test('first run commits and pushes to the remote', async () => {
  const [r] = await run();
  assert.equal(r.status, 'pushed', r.message);
  assert.equal(git(clone, 'log', '-1', '--format=%s'), 'Back up skills');
  assert.equal(git(bare, 'log', '-1', '--format=%s', 'main'), 'Back up skills');
  assert.equal(git(bare, 'show', 'main:rules.md'), 'my rules');
  const files = tree().split('\n');
  assert.ok(files.includes('skills/alpha/SKILL.md'));
  assert.ok(files.includes('skills/alpha/lib/a.js'));
});

test('junctions are resolved to their real content, synced and operant-hub skipped', () => {
  assert.equal(git(bare, 'show', 'main:skills/linked/SKILL.md'), '# linked content');
  assert.equal(git(bare, 'show', 'main:skills/local/SKILL.md'), '# local');
  assert.ok(!/skills\/synced/.test(tree()));
  assert.ok(!/operant-hub/.test(tree()));
  assert.ok(!fs.lstatSync(path.join(clone, 'skills', 'linked')).isSymbolicLink());
});

test('secrets and junk are skipped', () => {
  assert.ok(!/\.env|\.key|\.pem|credentials|__pycache__|\.pyc/.test(tree()), tree());
});

test('a second run with no changes does nothing', async () => {
  const before = git(bare, 'rev-parse', 'main');
  const [r] = await run();
  assert.equal(r.status, 'nothing', r.message);
  assert.equal(git(bare, 'rev-parse', 'main'), before);
});

test('a change is committed and pushed, and removed skills leave the backup', async () => {
  write(path.join(hubDir, 'skills', 'alpha', 'SKILL.md'), '# alpha v2');
  fs.rmSync(path.join(claudeDir, 'skills', 'local'), { recursive: true });
  const [r] = await run();
  assert.equal(r.status, 'pushed', r.message);
  assert.equal(git(bare, 'show', 'main:skills/alpha/SKILL.md'), '# alpha v2');
  assert.ok(!/skills\/local/.test(tree()));
});

test('a non-repo folder reports an error and is left alone', async () => {
  const plain = path.join(root, 'plain');
  fs.mkdirSync(plain);
  const [r] = await backup.backupAll({ repos: [{ path: plain }], hubDir, claudeDir });
  assert.equal(r.status, 'error');
  assert.deepEqual(fs.readdirSync(plain), []);
});

test('a subfolder of a repo is refused (only the repo root is used)', async () => {
  const [r] = await backup.backupAll({ repos: [{ path: path.join(clone, 'skills') }], hubDir, claudeDir });
  assert.equal(r.status, 'error');
});

test('a repo without a remote reports an error', async () => {
  const lone = path.join(root, 'lone');
  execFileSync('git', ['init', lone], { stdio: 'ignore' });
  const [r] = await backup.backupAll({ repos: [{ path: lone }], hubDir, claudeDir });
  assert.equal(r.status, 'error');
  assert.match(r.message, /no remote/);
  assert.deepEqual(fs.readdirSync(lone), ['.git']);
});

test('a rejected push is reported, never forced', async () => {
  const other = path.join(root, 'other');
  execFileSync('git', ['clone', bare, other], { stdio: 'ignore' });
  git(other, 'config', 'user.name', 'T'); git(other, 'config', 'user.email', 't@example.invalid');
  write(path.join(other, 'x.txt'), 'x'); git(other, 'add', '-A'); git(other, 'commit', '-m', 'other'); git(other, 'push');
  const remoteHead = git(bare, 'rev-parse', 'main');
  write(path.join(hubDir, 'skills', 'alpha', 'SKILL.md'), '# alpha v3');
  const [r] = await run();
  assert.equal(r.status, 'error');
  assert.match(r.message, /push failed/);
  assert.equal(git(bare, 'rev-parse', 'main'), remoteHead);
});
