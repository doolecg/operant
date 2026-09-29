// Tests for updater.js: which release asset each system downloads, version comparison, sh quoting, and the
// macOS/Linux install workers. The worker scripts are syntax-checked with sh -n and run against stub tools
// (hdiutil, ditto, open, pkexec...) in a temp folder, so nothing real is mounted, replaced or installed.
// The sh checks skip when no sh is found: Git for Windows' on Windows, /bin/sh elsewhere.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { verifyDigest, historyStore, trimHistory, healthState, HISTORY_MAX, newer, pickAsset, installKind, shQuote, macInstallScript, appImageInstallScript, debInstallScript } = require('../updater.js');

const isWin = process.platform === 'win32';
const findShell = name => (isWin
  ? ['bin', 'usr/bin'].map(d => `C:\\Program Files\\Git\\${d}\\${name}.exe`)
  : [`/bin/${name}`]).find(p => fs.existsSync(p)) || null;
const SH = findShell('sh');
const DASH = findShell('dash'); // Ubuntu's /bin/sh: rejects anything bash-only
const noSh = SH ? false : 'no sh found';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'operant-updatertest-'));
test.after(() => { fs.rmSync(root, { recursive: true, force: true }); });
let n = 0;
const mkdir = () => { const d = path.join(root, `t${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
const posix = p => (isWin ? p.replace(/\\/g, '/') : p); // Git's sh takes C:/... paths
const write = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text, { mode: 0o755 }); };
const read = p => fs.readFileSync(p, 'utf8').trim();
const lines = p => (fs.existsSync(p) ? read(p).split('\n') : []);
const until = async (fn, ms = 8000) => { for (const end = Date.now() + ms; Date.now() < end && !fn();) await new Promise(r => setTimeout(r, 50)); return fn(); };

// ---------------------------------------------------------------- newer

test('newer compares versions numerically', () => {
  assert.ok(newer('1.18.0', '1.17.5'));
  assert.ok(newer('1.10.0', '1.9.9'));
  assert.ok(newer('2', '1.9.9'));
  assert.ok(newer('v1.2.0', '1.1.9'));
  assert.ok(!newer('1.17.5', '1.17.5'));
  assert.ok(!newer('1.17.4', '1.17.5'));
  assert.ok(!newer('1.0', '1.0.0'));
});

// ---------------------------------------------------------------- pickAsset

const asset = name => ({ name, size: 1, browser_download_url: `https://example.invalid/${name}` });
const V = '1.18.0';
const full = [
  'latest.yml', 'latest-mac.yml', 'latest-linux.yml',
  `Operant-${V}-windows-x64.msi`,
  `Operant-${V}-mac-arm64.dmg`, `Operant-${V}-mac-arm64.dmg.blockmap`, `Operant-${V}-mac-x64.dmg`, `Operant-${V}-mac-x64.dmg.blockmap`,
  `Operant-${V}-linux-x86_64.AppImage`, `Operant-${V}-linux-arm64.AppImage`,
  `Operant-${V}-linux-amd64.deb`, `Operant-${V}-linux-arm64.deb`,
].map(asset);
const name = a => (a ? a.name : null);
const pick = (assets, platform, arch, kind) => name(pickAsset(assets, { platform, arch, kind }));

test('pickAsset: Windows takes the first msi, old or new name', () => {
  assert.equal(pick(full, 'win32', 'x64'), `Operant-${V}-windows-x64.msi`);
  assert.equal(pick([asset('Operant-1.17.5.msi'), asset('latest.yml')], 'win32', 'x64'), 'Operant-1.17.5.msi');
  assert.equal(pick([asset('Operant-1.17.5.MSI')], 'win32', 'x64'), 'Operant-1.17.5.MSI');
  assert.equal(pick([asset('a.msi'), asset('b.msi')], 'win32', 'x64'), 'a.msi');
  assert.equal(pick([asset('Operant-1.17.5.msi')], 'win32', 'arm64'), 'Operant-1.17.5.msi');
  assert.equal(pick(full.filter(a => !a.name.endsWith('.msi')), 'win32', 'x64'), null);
});

test('pickAsset: macOS takes the dmg for its arch', () => {
  assert.equal(pick(full, 'darwin', 'arm64'), `Operant-${V}-mac-arm64.dmg`);
  assert.equal(pick(full, 'darwin', 'x64'), `Operant-${V}-mac-x64.dmg`);
  assert.equal(pick(full.filter(a => !a.name.includes('arm64')), 'darwin', 'arm64'), null);
  assert.equal(pick(full.filter(a => !a.name.includes('-x64.dmg')), 'darwin', 'x64'), null);
  assert.equal(pick(full, 'darwin', 'ia32'), null);
});

test('pickAsset: a release with only an msi has nothing for macOS or Linux', () => {
  const msiOnly = [asset('Operant-1.17.5.msi'), asset('Operant-1.17.5.msi.blockmap')];
  assert.equal(pick(msiOnly, 'darwin', 'arm64'), null);
  assert.equal(pick(msiOnly, 'darwin', 'x64'), null);
  assert.equal(pick(msiOnly, 'linux', 'x64', 'appimage'), null);
  assert.equal(pick(msiOnly, 'linux', 'x64', 'deb'), null);
});

test('pickAsset: Linux takes the AppImage or deb for its arch', () => {
  assert.equal(pick(full, 'linux', 'x64', 'appimage'), `Operant-${V}-linux-x86_64.AppImage`);
  assert.equal(pick(full, 'linux', 'arm64', 'appimage'), `Operant-${V}-linux-arm64.AppImage`);
  assert.equal(pick([asset(`Operant-${V}-linux-aarch64.AppImage`)], 'linux', 'arm64', 'appimage'), `Operant-${V}-linux-aarch64.AppImage`);
  assert.equal(pick(full, 'linux', 'x64', 'deb'), `Operant-${V}-linux-amd64.deb`);
  assert.equal(pick(full, 'linux', 'arm64', 'deb'), `Operant-${V}-linux-arm64.deb`);
});

test('pickAsset: Linux never crosses arch, kind or platform', () => {
  const x64Only = full.filter(a => !a.name.includes('arm64'));
  const arm64Only = full.filter(a => !a.name.includes('x86_64') && !a.name.includes('amd64'));
  assert.equal(pick(x64Only, 'linux', 'arm64', 'appimage'), null);
  assert.equal(pick(x64Only, 'linux', 'arm64', 'deb'), null);
  assert.equal(pick(arm64Only, 'linux', 'x64', 'appimage'), null);
  assert.equal(pick(arm64Only, 'linux', 'x64', 'deb'), null);
  assert.equal(pick(full, 'linux', 'ia32', 'appimage'), null);
  assert.equal(pick(full.filter(a => !a.name.endsWith('.deb')), 'linux', 'x64', 'deb'), null);
  assert.equal(pick(full, 'linux', 'x64', undefined), null);
  assert.equal(pick(full, 'linux', 'x64', 'msi'), null);
  assert.equal(pick(full, 'freebsd', 'x64', 'appimage'), null);
});

test('pickAsset returns the asset itself', () => {
  assert.equal(pickAsset(full, { platform: 'darwin', arch: 'x64' }), full.find(a => a.name.endsWith('mac-x64.dmg')));
});

// ---------------------------------------------------------------- installKind

test('installKind: the installer each kind of install can apply', () => {
  assert.equal(installKind({ platform: 'win32', env: {}, execPath: 'C:\\Program Files\\Operant\\Operant.exe' }), 'msi');
  assert.equal(installKind({ platform: 'darwin', env: {}, execPath: '/Applications/Operant.app/Contents/MacOS/Operant' }), 'dmg');
  assert.equal(installKind({ platform: 'linux', env: { APPIMAGE: '/home/u/Operant.AppImage' }, execPath: '/tmp/.mount_Operanx/operant' }), 'appimage');
  assert.equal(installKind({ platform: 'linux', env: {}, execPath: '/opt/Operant/operant' }), 'deb');
  assert.equal(installKind({ platform: 'linux', env: {}, execPath: '/home/u/Operant-linux-x64/operant' }), null);
  assert.equal(installKind({ platform: 'linux', env: {}, execPath: '/opt/Operant-dev/operant' }), null);
  assert.equal(installKind({ platform: 'linux', env: { APPIMAGE: '' }, execPath: '/tmp/x/operant' }), null);
  assert.equal(installKind({ platform: 'freebsd', env: {}, execPath: '/opt/Operant/operant' }), null);
});

// ---------------------------------------------------------------- shQuote

test('shQuote wraps in single quotes and escapes single quotes', () => {
  assert.equal(shQuote('/tmp/a b/c'), "'/tmp/a b/c'");
  assert.equal(shQuote("it's"), `'it'\\''s'`);
  assert.equal(shQuote("''"), `''\\'''\\'''`);
  assert.equal(shQuote(''), "''");
  assert.equal(shQuote('$HOME `x` "y" \\z'), `'$HOME \`x\` "y" \\z'`);
});

test('shQuote round-trips through a real sh', { skip: noSh }, () => {
  const dir = mkdir();
  for (const s of ['/tmp/a b/c', "it's", "'", "''a''", '$HOME `id` "y" ; & | ( ) * ? < > ! # ~', 'back\\slash', 'two\nlines', '  spaces  ', '-n']) {
    fs.writeFileSync(path.join(dir, 'q.sh'), `printf %s ${shQuote(s)}`);
    const r = spawnSync(SH, ['q.sh'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.stdout, s);
  }
});

// ---------------------------------------------------------------- the worker scripts

const nasty = "/Users/o'brien/My $HOME \"Apps\" `x` ; rm -rf & (y)/Operant.app";
const builders = {
  mac: relaunch => [
    macInstallScript({ pid: 4242, dmg: '/tmp/Operant-1.18.0.dmg', bundle: '/Applications/Operant.app', log: '/tmp/Operant-1.18.0-install.log', relaunch }),
    macInstallScript({ pid: 4242, dmg: nasty + '.dmg', bundle: nasty, log: nasty + '.log', relaunch }),
  ],
  appimage: relaunch => [
    appImageInstallScript({ pid: 4242, appImage: '/tmp/Operant-1.18.0.AppImage', target: '/home/u/Operant.AppImage', log: '/tmp/Operant-1.18.0-install.log', relaunch }),
    appImageInstallScript({ pid: 4242, appImage: nasty + '.AppImage', target: nasty, log: nasty + '.log', relaunch }),
  ],
  deb: relaunch => [
    debInstallScript({ pid: 4242, deb: '/tmp/Operant-1.18.0.deb', exe: '/opt/Operant/operant', log: '/tmp/Operant-1.18.0-install.log', relaunch }),
    debInstallScript({ pid: 4242, deb: nasty + '.deb', exe: nasty, log: nasty + '.log', relaunch }),
  ],
};

for (const [kind, build] of Object.entries(builders)) {
  test(`${kind} script parses (sh -n), with and without relaunch, with hostile paths`, { skip: noSh }, () => {
    const dir = mkdir();
    fs.writeFileSync(path.join(dir, 'worker.sh'), [...build(true), ...build(false)].join('\n'));
    for (const shell of [SH, DASH].filter(Boolean)) {
      const r = spawnSync(shell, ['-n', 'worker.sh'], { cwd: dir, encoding: 'utf8' });
      assert.equal(r.status, 0, `${shell}: ${r.stderr}`);
    }
  });
}

test('scripts wait for the pid, log, quote paths, and relaunch only when asked', () => {
  const mac = macInstallScript({ pid: 4242, dmg: '/t/O d.dmg', bundle: "/A/O's.app", log: '/t/log', relaunch: true });
  assert.match(mac, /^exec >>'\/t\/log' 2>&1$/m);
  assert.match(mac, /while kill -0 4242 /);
  assert.match(mac, /^dmg='\/t\/O d\.dmg'$/m);
  assert.match(mac, /^bundle='\/A\/O'\\''s\.app'$/m);
  assert.match(mac, /hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "\$mnt" "\$dmg"/);
  assert.match(mac, /xattr -dr com\.apple\.quarantine "\$bundle"/);
  assert.match(mac, /^open "\$bundle"$/m);
  assert.doesNotMatch(macInstallScript({ pid: 1, dmg: 'd', bundle: 'b', log: 'l', relaunch: false }), /\bopen\b/);

  const img = appImageInstallScript({ pid: 4242, appImage: '/t/a b.AppImage', target: '/h/O.AppImage', log: '/t/log', relaunch: true });
  assert.match(img, /chmod 755 "\$target\.new" && mv -f "\$target\.new" "\$target"/);
  assert.match(img, /^nohup "\$target" >\/dev\/null 2>&1 &$/m);
  assert.doesNotMatch(appImageInstallScript({ pid: 1, appImage: 'a', target: 't', log: 'l', relaunch: false }), /nohup/);

  const deb = debInstallScript({ pid: 4242, deb: '/t/O.deb', exe: '/opt/Operant/operant', log: '/t/log', relaunch: true });
  assert.match(deb, /^pkexec dpkg -i "\$deb"$/m);
  assert.match(deb, /^nohup "\$exe" >\/dev\/null 2>&1 &$/m);
  assert.doesNotMatch(debInstallScript({ pid: 1, deb: 'd', exe: 'e', log: 'l', relaunch: false }), /nohup/);

  assert.doesNotMatch(macInstallScript({ pid: '1; rm -rf ~', dmg: 'd', bundle: 'b', log: 'l' }), /rm -rf ~/);
});

// Stubs stand in for hdiutil, ditto, xattr, open and pkexec: each logs its call to $STUB_LOG. The pid the scripts
// wait for is one that doesn't exist, so they start at once.
const DEAD_PID = 999999999;
const stubs = {
  hdiutil: `[ "$1" = attach ] || exit 0
[ -n "$STUB_MOUNT_FAILS" ] && exit 1
while [ $# -gt 0 ]; do [ "$1" = -mountpoint ] && mnt=$2; shift; done
cp -R "$STUB_DMG_DIR/." "$mnt/"`,
  ditto: `case "$STUB_DITTO" in fail) exit 1;; noop) exit 0;; esac
cp -R "$1" "$2"`,
  xattr: '', open: '', pkexec: '',
};

function sandbox() {
  const dir = mkdir();
  const bin = path.join(dir, 'bin');
  for (const [tool, body] of Object.entries(stubs)) write(path.join(bin, tool), `#!/bin/sh\necho "\${0##*/} $*" >> "$STUB_LOG"\n${body}\n`);
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^path$/i.test(k)) env[k] = v;
  env.PATH = [bin, process.env.PATH].join(path.delimiter);
  env.STUB_LOG = posix(path.join(dir, 'calls.log'));
  env.STUB_DMG_DIR = posix(path.join(dir, 'dmg'));
  const run = (script, extra = {}) => {
    fs.writeFileSync(path.join(dir, 'worker.sh'), script);
    return spawnSync(SH, ['worker.sh'], { cwd: dir, env: { ...env, ...extra }, encoding: 'utf8', timeout: 60000 });
  };
  return { dir, env, run, calls: () => lines(env.STUB_LOG), log: p => (fs.existsSync(p) ? read(p) : '') };
}

// An "installed" app folder in a directory whose name needs quoting, and the dmg content the stub hdiutil mounts.
function macFixture(s) {
  const bundle = path.join(s.dir, "Apps it's (x) & $HOME", 'Operant.app');
  write(path.join(bundle, 'Contents', 'version.txt'), 'old');
  write(path.join(s.dir, 'dmg', 'Operant.app', 'Contents', 'version.txt'), 'new');
  write(path.join(s.dir, 'Operant-1.18.0.dmg'), 'dmg');
  return { bundle, dmg: path.join(s.dir, 'Operant-1.18.0.dmg'), log: path.join(s.dir, 'install.log') };
}
const macScript = (f, relaunch) => macInstallScript({ pid: DEAD_PID, dmg: posix(f.dmg), bundle: posix(f.bundle), log: posix(f.log), relaunch });
const version = f => read(path.join(f.bundle, 'Contents', 'version.txt'));
const clean = f => !fs.existsSync(f.bundle + '.new') && !fs.existsSync(f.bundle + '.old');
const at = (calls, prefix) => calls.findIndex(l => l.startsWith(prefix));

test('mac worker: mounts, swaps the app in, detaches, clears quarantine, relaunches', { skip: noSh }, () => {
  const s = sandbox(), f = macFixture(s);
  const r = s.run(macScript(f, true));
  const why = `${r.stderr}\n${s.log(f.log)}`;
  assert.equal(r.status, 0, why);
  assert.equal(version(f), 'new', why);
  assert.ok(clean(f), why);
  const calls = s.calls();
  const [attach, detach, xattr, open] = ['hdiutil attach', 'hdiutil detach', 'xattr', 'open'].map(p => at(calls, p));
  assert.ok(attach >= 0 && attach < detach && detach < xattr && xattr < open, calls.join('\n'));
  assert.match(calls[attach], /^hdiutil attach -nobrowse -readonly -noautoopen -mountpoint \S+ /);
  assert.equal(calls[attach].split(' -mountpoint ')[1].split(' ')[0], calls[detach].split(' ')[2]);
  assert.equal(calls[xattr], `xattr -dr com.apple.quarantine ${posix(f.bundle)}`);
  assert.equal(calls[open], `open ${posix(f.bundle)}`);
  assert.match(s.log(f.log), /waiting for Operant[\s\S]*replaced/);
});

test('mac worker: without relaunch (an update on quit) it installs but does not open the app', { skip: noSh }, () => {
  const s = sandbox(), f = macFixture(s);
  const r = s.run(macScript(f, false));
  assert.equal(r.status, 0, `${r.stderr}\n${s.log(f.log)}`);
  assert.equal(version(f), 'new');
  assert.ok(clean(f));
  assert.ok(at(s.calls(), 'xattr') >= 0);
  assert.equal(at(s.calls(), 'open'), -1);
});

test('mac worker: a dmg that will not mount leaves the app alone and still relaunches it', { skip: noSh }, () => {
  const s = sandbox(), f = macFixture(s);
  s.run(macScript(f, true), { STUB_MOUNT_FAILS: '1' });
  assert.equal(version(f), 'old');
  assert.ok(clean(f));
  const calls = s.calls();
  assert.equal(at(calls, 'xattr'), -1);
  assert.equal(at(calls, 'ditto'), -1);
  assert.equal(calls[at(calls, 'open')], `open ${posix(f.bundle)}`);
  assert.match(s.log(f.log), /could not mount/);
});

for (const ditto of ['fail', 'noop']) {
  test(`mac worker: a swap that fails (ditto ${ditto}) puts the old app back`, { skip: noSh }, () => {
    const s = sandbox(), f = macFixture(s);
    s.run(macScript(f, true), { STUB_DITTO: ditto });
    assert.equal(version(f), 'old', s.log(f.log));
    assert.ok(clean(f));
    const calls = s.calls();
    assert.ok(at(calls, 'hdiutil detach') > at(calls, 'hdiutil attach'), 'detaches after a failed swap too');
    assert.equal(at(calls, 'xattr'), -1);
    assert.equal(calls[at(calls, 'open')], `open ${posix(f.bundle)}`);
    assert.match(s.log(f.log), /update failed/);
  });
}

test('mac worker: a stale .new or .old from an earlier attempt does not get in the way', { skip: noSh }, () => {
  const s = sandbox(), f = macFixture(s);
  write(path.join(f.bundle + '.new', 'junk'), 'x');
  write(path.join(f.bundle + '.old', 'junk'), 'x');
  const r = s.run(macScript(f, true));
  assert.equal(r.status, 0, `${r.stderr}\n${s.log(f.log)}`);
  assert.equal(version(f), 'new');
  assert.ok(clean(f));
});

test('worker waits for the pid to exit before touching anything', { skip: noSh }, async () => {
  const s = sandbox(), f = macFixture(s);
  // a process for the worker to wait on, started from an sh so that the pid is one that sh's kill knows
  const sleeper = spawn(SH, ['-c', 'sleep 30 & echo $!; wait'], { stdio: ['ignore', 'pipe', 'ignore'] });
  let pid = 0;
  const gotPid = new Promise(resolve => sleeper.stdout.on('data', d => { pid = Number(String(d).trim()); resolve(); }));
  await gotPid;
  const killSleeper = () => spawnSync(SH, ['-c', `kill ${pid}`], { stdio: 'ignore' });
  let worker;
  try {
    fs.writeFileSync(path.join(s.dir, 'worker.sh'), macInstallScript({ pid, dmg: posix(f.dmg), bundle: posix(f.bundle), log: posix(f.log), relaunch: true }));
    worker = spawn(SH, ['worker.sh'], { cwd: s.dir, env: s.env, stdio: 'ignore' });
    const exited = new Promise(resolve => worker.on('exit', resolve));
    await new Promise(r => setTimeout(r, 2500));
    assert.equal(version(f), 'old', 'still waiting while the process runs');
    assert.deepEqual(s.calls(), []);
    killSleeper();
    await exited; // ends on its own: the script gives up after 60 s
    assert.equal(version(f), 'new', s.log(f.log));
  } finally {
    killSleeper();
    sleeper.kill();
    worker?.kill();
  }
});

test('AppImage worker: replaces the file beside itself, makes it executable and starts it', { skip: noSh }, async () => {
  const s = sandbox();
  const target = path.join(s.dir, "Apps it's (x)", 'Operant.AppImage'), src = path.join(s.dir, 'Operant-1.18.0.AppImage'), log = path.join(s.dir, 'install.log');
  write(target, '#!/bin/sh\necho "appimage old started" >> "$STUB_LOG"\n');
  write(src, '#!/bin/sh\necho "appimage new started" >> "$STUB_LOG"\n');
  const r = s.run(appImageInstallScript({ pid: DEAD_PID, appImage: posix(src), target: posix(target), log: posix(log), relaunch: true }));
  assert.equal(r.status, 0, `${r.stderr}\n${s.log(log)}`);
  assert.match(read(target), /appimage new started/);
  assert.ok(!fs.existsSync(target + '.new'));
  if (!isWin) assert.equal(fs.statSync(target).mode & 0o777, 0o755);
  assert.ok(await until(() => s.calls().includes('appimage new started')), `${s.calls()}\n${s.log(log)}`);
});

test('AppImage worker: without relaunch it replaces the file and does not start it', { skip: noSh }, async () => {
  const s = sandbox();
  const target = path.join(s.dir, 'Operant.AppImage'), src = path.join(s.dir, 'new.AppImage'), log = path.join(s.dir, 'install.log');
  write(target, '#!/bin/sh\necho "appimage old started" >> "$STUB_LOG"\n');
  write(src, '#!/bin/sh\necho "appimage new started" >> "$STUB_LOG"\n');
  const r = s.run(appImageInstallScript({ pid: DEAD_PID, appImage: posix(src), target: posix(target), log: posix(log), relaunch: false }));
  assert.equal(r.status, 0, `${r.stderr}\n${s.log(log)}`);
  assert.match(read(target), /appimage new started/);
  await new Promise(r => setTimeout(r, 500));
  assert.deepEqual(s.calls(), []);
});

test('AppImage worker: a failed copy keeps the old file, leaves no .new, and starts the old one', { skip: noSh }, async () => {
  const s = sandbox();
  const target = path.join(s.dir, 'Operant.AppImage'), log = path.join(s.dir, 'install.log');
  write(target, '#!/bin/sh\necho "appimage old started" >> "$STUB_LOG"\n');
  s.run(appImageInstallScript({ pid: DEAD_PID, appImage: posix(path.join(s.dir, 'missing.AppImage')), target: posix(target), log: posix(log), relaunch: true }));
  assert.match(read(target), /appimage old started/);
  assert.ok(!fs.existsSync(target + '.new'));
  assert.match(s.log(log), /could not replace/);
  assert.ok(await until(() => s.calls().includes('appimage old started')));
});

test('deb worker: runs pkexec dpkg -i on the download, then starts the app', { skip: noSh }, async () => {
  const s = sandbox();
  const deb = path.join(s.dir, "Operant 1.18.0 (it's).deb"), exe = path.join(s.dir, 'opt Operant', 'operant'), log = path.join(s.dir, 'install.log');
  write(deb, 'deb');
  write(exe, '#!/bin/sh\necho "operant started" >> "$STUB_LOG"\n');
  const r = s.run(debInstallScript({ pid: DEAD_PID, deb: posix(deb), exe: posix(exe), log: posix(log), relaunch: true }));
  assert.equal(r.status, 0, `${r.stderr}\n${s.log(log)}`);
  assert.equal(s.calls()[0], `pkexec dpkg -i ${posix(deb)}`);
  assert.ok(await until(() => s.calls().includes('operant started')), `${s.calls()}\n${s.log(log)}`);
  assert.match(s.log(log), /installing[\s\S]*dpkg exited with 0/);
});

test('verifyDigest: true on a match, false when there is nothing to check, throws on a mismatch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operant-dg-'));
  try {
    const f = path.join(dir, 'a.msi');
    fs.writeFileSync(f, 'hello');
    const hex = require('node:crypto').createHash('sha256').update('hello').digest('hex');
    assert.equal(await verifyDigest(f, `sha256:${hex}`), true);
    assert.equal(await verifyDigest(f, `sha256:${hex.toUpperCase()}`), true);
    assert.equal(await verifyDigest(f, undefined), false);
    assert.equal(await verifyDigest(f, 'md5:abc'), false);
    await assert.rejects(verifyDigest(f, `sha256:${'0'.repeat(64)}`), /digest mismatch/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('healthState: none, check, then offer-rollback after two unhealthy launches', () => {
  const e = (o = {}) => ({ from: '1.0.0', to: '1.1.0', result: 'installing', attempts: 0, ...o });
  assert.equal(healthState([], '1.1.0'), 'none');
  assert.equal(healthState(undefined, '1.1.0'), 'none');
  assert.equal(healthState([e()], '1.1.0'), 'check');
  assert.equal(healthState([e({ attempts: 1 })], '1.1.0'), 'check');
  assert.equal(healthState([e({ attempts: 2 })], '1.1.0'), 'offer-rollback');
  assert.equal(healthState([e({ attempts: 2 })], '1.0.0'), 'none'); // the install never happened
  assert.equal(healthState([e({ result: 'healthy', attempts: 2 })], '1.1.0'), 'none');
  assert.equal(healthState([e({ result: 'failed-to-start', attempts: 2 })], '1.1.0'), 'none');
  assert.equal(healthState([e({ attempts: 2, to: '1.0.5' }), e({ result: 'healthy' })], '1.1.0'), 'none'); // only the newest counts
});

test('update history: written atomically, completed in place, trimmed to the last 50', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operant-uh-'));
  try {
    const h = historyStore(path.join(dir, 'update-history.json'));
    assert.deepEqual(h.read(), []);
    assert.equal(h.updateLast(() => {}), null);
    for (let i = 0; i < HISTORY_MAX + 5; i++) h.add({ from: `1.0.${i}`, to: `1.0.${i + 1}`, result: 'installing', attempts: 0 });
    const list = h.read();
    assert.equal(list.length, HISTORY_MAX);
    assert.equal(list[0].from, '1.0.5');
    h.updateLast(x => { x.result = 'healthy'; x.attempts++; });
    assert.deepEqual(h.read().at(-1), { from: `1.0.${HISTORY_MAX + 4}`, to: `1.0.${HISTORY_MAX + 5}`, result: 'healthy', attempts: 1 });
    assert.deepEqual(fs.readdirSync(dir), ['update-history.json']);
    fs.writeFileSync(path.join(dir, 'update-history.json'), '{bad');
    assert.deepEqual(h.read(), []);
    assert.deepEqual(trimHistory('nope'), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
