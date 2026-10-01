// Checks for what the renderer and the control CLI may ask main.js to do: open, check out a ref, download.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isExecutableTarget, isSafeRef, writeFileAtomic } = require('../atomic-write');
const { allowedDownloadUrl, installKind, debInstallScript, debInstallCommand } = require('../updater');
const { validatePatch } = require('../config-migrate');

test('executable types are refused by name, any letter case', () => {
  for (const n of ['a.exe', 'A.EXE', 'x.bat', 'x.cmd', 'x.com', 'x.ps1', 'x.msi', 'x.scr', 'x.lnk', 'x.sh', 'x.desktop', 'x.AppImage', 'x.jar']) {
    assert.equal(isExecutableTarget(path.join(os.tmpdir(), 'nope', n)), true, n);
  }
  assert.equal(isExecutableTarget('/nonexistent/readme.md', 'linux'), false);
});

test('unix: the executable bit refuses a file but not a folder', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operant-exec-'));
  const f = path.join(dir, 'tool');
  fs.writeFileSync(f, 'x', { mode: 0o755 });
  fs.chmodSync(f, 0o755);
  assert.equal(isExecutableTarget(f), true);
  fs.chmodSync(f, 0o644);
  assert.equal(isExecutableTarget(f), false);
  assert.equal(isExecutableTarget(dir), false);
});

test('git refs: an option, an empty value or a control character is refused', () => {
  for (const ok of ['main', 'feature/x', 'dev-2.8.0', 'v1.2']) assert.equal(isSafeRef(ok), true, ok);
  for (const bad of ['-D', '--upload-pack=x', '', 'a\nb', 'a\0b', null, undefined, 5, {}]) assert.equal(isSafeRef(bad), false, String(bad));
});

test('downloads only from GitHub hosts', () => {
  assert.equal(allowedDownloadUrl('https://github.com/doolecg/operant/releases/download/1.0.0/a.deb'), true);
  assert.equal(allowedDownloadUrl('https://objects.githubusercontent.com/x'), true);
  assert.equal(allowedDownloadUrl('https://github-releases.githubusercontent.com/x'), true);
  for (const bad of ['http://github.com/x', 'https://github.com.evil.example/x', 'https://evil.example/https://github.com/', 'https://githubusercontent.com/x', 'file:///etc/passwd', '', undefined]) {
    assert.equal(allowedDownloadUrl(bad), false, String(bad));
  }
});

test('installKind: system folders in any case, rpm and tar.gz are announce-only', () => {
  const linux = (execPath, owner, env = {}) => installKind({ platform: 'linux', env, execPath, owner });
  for (const p of ['/opt/Operant/operant', '/opt/operant/operant', '/usr/lib/operant/operant', '/usr/share/operant/operant', '/usr/lib/Operant/operant']) {
    assert.equal(linux(p, () => 'deb'), 'deb', p);
  }
  assert.equal(linux('/opt/Operant/operant', () => 'rpm'), 'rpm');
  assert.equal(linux('/opt/Operant/operant', () => null), 'tar');
  assert.equal(linux('/home/u/operant/operant', () => 'deb'), null);
  assert.equal(linux('/opt/Operant-dev/operant', () => 'deb'), null);
  assert.equal(linux('/tmp/.mount_x/operant', () => 'deb', { APPIMAGE: '/home/u/Operant.AppImage' }), 'appimage');
});

test('deb worker checks the sha256 before pkexec and prints the manual command on failure', () => {
  const sha = 'a'.repeat(64);
  const s = debInstallScript({ pid: 1, deb: '/u/updates/Operant-1.deb', exe: '/opt/Operant/operant', log: '/t/log', relaunch: true, sha256: sha });
  assert.ok(s.indexOf('sha256sum') > -1 && s.indexOf('sha256sum') < s.indexOf('pkexec dpkg'));
  assert.match(s, /sudo apt install \/u\/updates\/Operant-1\.deb/);
  assert.equal(debInstallCommand('/a b/x.deb'), "sudo apt install '/a b/x.deb'");
});

test('atomic writes are private, and an existing file keeps its mode', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operant-mode-'));
  const f = path.join(dir, 'sub', 'a.json');
  writeFileAtomic(f, '{}');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(f)).mode & 0o777, 0o700);
  fs.chmodSync(f, 0o644);
  writeFileAtomic(f, '{"a":1}');
  assert.equal(fs.statSync(f).mode & 0o777, 0o644);
});

test('notification settings: min work seconds and quiet hours are validated', () => {
  const defaults = { notifyMinWorkSeconds: 2.5, notifyQuietFrom: '', notifyQuietTo: '' };
  assert.deepEqual(validatePatch({ notifyMinWorkSeconds: 4.5, notifyQuietFrom: '22:30', notifyQuietTo: '07:00' }, defaults), []);
  assert.equal(validatePatch({ notifyMinWorkSeconds: -1 }, defaults).length, 1);
  assert.equal(validatePatch({ notifyQuietFrom: '25:00' }, defaults).length, 1);
  assert.equal(validatePatch({ notifyQuietTo: '7pm' }, defaults).length, 1);
});
