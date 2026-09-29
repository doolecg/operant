// Tests for platform/unix.js: the sh code macOS and Linux tiles run. Scripts are run through a real sh
// where there is one (Git's on Windows), since quoting mistakes only show up there.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const unix = require('../platform/unix');

const SH = process.platform !== 'win32' ? '/bin/sh'
  : ['C:\\Program Files\\Git\\bin\\sh.exe', 'C:\\Program Files\\Git\\usr\\bin\\sh.exe'].find(p => fs.existsSync(p));
const sh = (script, input = '') => execFileSync(SH, ['-c', script], { input, encoding: 'utf8' });
const needSh = { skip: !SH && 'no sh here' };

test('sq quotes anything so sh reads it back unchanged', needSh, () => {
  for (const s of ['plain', 'two words', "it's", `$HOME \`id\` "x" \\ ; & | < > * ?`, 'line one\nline two', '']) {
    assert.equal(sh(`printf '%s' ${unix.sq(s)}`), s);
  }
});

test('shellKind', () => {
  assert.equal(unix.shellKind('/bin/zsh'), 'posix');
  assert.equal(unix.shellKind('/usr/local/bin/bash'), 'posix');
  assert.equal(unix.shellKind('/bin/sh'), 'posix');
  assert.equal(unix.shellKind('/opt/homebrew/bin/fish'), 'other');
  assert.equal(unix.shellKind('/usr/local/bin/pwsh'), 'powershell');
  assert.equal(unix.shellKind('powershell.exe'), 'powershell');
  if (process.platform === 'win32') assert.equal(unix.shellKind('C:\\Program Files\\Git\\bin\\bash.exe'), 'posix');
});

test('usesSh: PowerShell stays PowerShell; Windows keeps it for anything but a POSIX shell', () => {
  assert.equal(unix.usesSh('pwsh'), false);
  assert.equal(unix.usesSh('powershell.exe'), false);
  assert.equal(unix.usesSh('/bin/zsh'), true);
  assert.equal(unix.usesSh('cmd.exe'), process.platform !== 'win32');
});

test('tileLaunch', () => {
  const login = process.platform === 'darwin' ? ['-l'] : [];
  assert.deepEqual(unix.tileLaunch('/bin/zsh'), { command: '/bin/zsh', args: login });
  assert.deepEqual(unix.tileLaunch('/bin/zsh', { script: 'echo hi' }), { command: '/bin/zsh', args: [...login, '-i', '-c', 'echo hi'] });
  const kept = unix.tileLaunch('/bin/bash', { script: 'npm test', keepOpen: true });
  assert.equal(kept.args.at(-1), `trap : INT\nnpm test\nexec ${['/bin/bash', ...login].map(unix.sq).join(' ')}`);
  // fish can't read sh code: bash (or sh) runs it, then the tile becomes fish.
  const fish = unix.tileLaunch('/usr/bin/fish', { script: 'npm test', keepOpen: true });
  assert.match(fish.command, /^\/bin\/(ba)?sh$/);
  assert.deepEqual(fish.args.slice(0, 1), ['-c']);
  assert.match(fish.args[1], /exec '\/usr\/bin\/fish'/);
});

const agent = line => unix.agentScript({ startup: '', exe: line.split(' ')[0], line, missing: "Smoke: 'nope-cli' isn't installed", failed: 'Smoke exited with an error, press Enter to close' });

test('agentScript runs the agent with its arguments intact', needSh, () => {
  const args = ['--append-system-prompt', 'Run `operant help`. Use "<symbols or question>"\nand $PATH', "it's"];
  assert.equal(sh(agent(`printf '[%s]' ${args.map(unix.sq).join(' ')}`)), args.map(a => `[${a}]`).join(''));
});

test('agentScript explains a missing agent and waits for Enter', needSh, () => {
  const out = sh(agent('nope-cli --flag'), '\n');
  assert.match(out, /Smoke: 'nope-cli' isn't installed/);
  assert.match(out, /Press Enter to close/);
});

test('agentScript waits after a failing agent, and not after a clean exit', needSh, () => {
  assert.match(sh(agent('false'), '\n'), /Smoke exited with an error/);
  assert.equal(sh(agent('true')), '');
});

test('agentScript runs the project startup command first', needSh, () => {
  const s = unix.agentScript({ startup: 'X=from-startup', exe: 'printf', line: `printf '%s' "$X"`, missing: 'm', failed: 'f' });
  assert.equal(sh(s), 'from-startup');
});

test('editScript', needSh, () => {
  assert.equal(unix.editScript("'vim'", " -n -c 'set number'", '/tmp/a b.txt'), "exec 'vim' -n -c 'set number' '/tmp/a b.txt'");
  assert.match(sh(unix.editScript(null, '', 'x'), '\n'), /No editor found/);
});

test('withLocale fills LANG only when nothing is set', () => {
  assert.equal(unix.withLocale({}, 'en-GB').LANG, 'en_GB.UTF-8');
  assert.equal(unix.withLocale({}, 'de').LANG, 'en_US.UTF-8');
  assert.equal(unix.withLocale({ LANG: 'fr_FR.UTF-8' }, 'en-GB').LANG, 'fr_FR.UTF-8');
  assert.equal(unix.withLocale({ LC_ALL: 'C.UTF-8' }, 'en-GB').LANG, undefined);
});
