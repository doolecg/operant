// macOS and Linux: how a tile's shell is started, and the PATH and locale a terminal window there would have.
// Windows tiles run PowerShell (pty:create in main.js); a POSIX shell set on Windows (Git Bash) comes here too.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

// Single quotes for sh: nothing inside is expanded; a quote closes, is escaped, and reopens.
const sq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

// The user's login shell: what their terminal app opens.
function defaultShell() {
  let own = '';
  try { own = os.userInfo().shell || ''; } catch {}
  return process.env.SHELL || own || (isMac ? '/bin/zsh' : '/bin/bash');
}

// 'powershell' (Windows PowerShell or pwsh), 'posix' (sh, bash, zsh, ksh, dash...) or 'other' (fish, nu...).
function shellKind(shell) {
  const name = path.basename(String(shell || '').trim()).toLowerCase().replace(/\.exe$/, '');
  if (name === 'powershell' || name === 'pwsh') return 'powershell';
  return /^(sh|bash|zsh|ksh|mksh|pdksh|dash|ash|yash)$/.test(name) ? 'posix' : 'other';
}
// Whether tiles run sh code (this file) rather than PowerShell's. On Windows only a POSIX shell set in
// Settings does; anything else there keeps PowerShell, as before.
const usesSh = shell => (isWin ? shellKind(shell) === 'posix' : shellKind(shell) !== 'powershell');

// A tile's program and arguments. `script` is sh code to run (none: just the interactive shell), and
// `keepOpen` hands the tile to the interactive shell once it's done, like PowerShell's -NoExit.
// sh-family shells run it interactively (-i) so the rc files load first (aliases, nvm, the functions a
// project's startup command uses), the way PowerShell loads its profile. Other shells (fish, nu) can't
// read sh code, so bash runs it and the tile then becomes their shell.
function tileLaunch(shell, { script = null, keepOpen = false } = {}) {
  const login = isMac ? ['-l'] : []; // macOS terminals open login shells (Homebrew's PATH is in .zprofile); Linux ones don't
  if (!script) return { command: shell, args: login };
  // A trapped INT lets Ctrl+C stop the command without also ending the script before the shell starts.
  const body = keepOpen ? `trap : INT\n${script}\nexec ${[shell, ...login].map(sq).join(' ')}` : script;
  if (shellKind(shell) === 'posix') return { command: shell, args: [...login, '-i', '-c', body] };
  return { command: fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh', args: ['-c', body] };
}

const yellow = s => `printf '\\033[33m%s\\033[0m\\n' ${sq(s)}`;
const pause = s => `printf '%s' ${sq(s)}; read -r _`;

// An agent CLI. The tile closes when it exits cleanly; a missing command gets a plain explanation, and
// a failure waits so the error stays readable. `line` is the command line, its arguments already quoted.
function agentScript({ startup, exe, line, missing, failed }) {
  return [
    startup,
    `if ! command -v ${sq(exe)} >/dev/null 2>&1; then ${yellow(missing)}; ${pause('Press Enter to close')}; exit; fi`,
    `${line} || { printf '\\n'; ${pause(failed)}; }`,
  ].filter(Boolean).join('\n');
}

// An editor tile: `ed` is the editor's command (already quoted), or null when none was found.
function editScript(ed, flags, file) {
  return ed ? `exec ${ed}${flags} ${sq(file)}`
    : `${yellow('No editor found. Install vim, neovim, micro or nano, or set one in Settings > Files.')}; ${pause('Press Enter to close')}`;
}

// The PATH a new terminal window would have. macOS starts apps from Finder with only
// /usr/bin:/bin:/usr/sbin:/sbin, and Homebrew, nvm and ~/.local/bin (where agent CLIs live) come from
// the login shell's startup files, so the shell is asked. The first answer is waited for; after that a
// refresh (at most once a minute, like the Windows registry read) never makes anyone wait.
let pathCache = null, pathAsk = null; // { at, value }
function loginPath() {
  if (pathCache && Date.now() - pathCache.at < 60000) return Promise.resolve(pathCache.value);
  pathAsk ??= askLoginPath().then(value => {
    pathAsk = null;
    pathCache = value || !pathCache ? { at: Date.now(), value } : { ...pathCache, at: Date.now() };
    return pathCache.value;
  });
  return pathCache ? Promise.resolve(pathCache.value) : pathAsk;
}
function askLoginPath() {
  const shell = defaultShell(), kind = shellKind(shell), mark = '__OPERANT_PATH__';
  // env is a program, so its output reads the same from bash, zsh and fish; the marks skip whatever
  // the startup files print. DISABLE_AUTO_UPDATE stops oh-my-zsh asking about updates.
  const cmd = `echo ${mark}; /usr/bin/env; echo ${mark}`;
  const [file, args] = kind === 'posix' ? [shell, ['-ilc', cmd]] : /fish$/.test(shell) ? [shell, ['-l', '-c', cmd]] : ['/bin/sh', ['-lc', cmd]];
  return new Promise(resolve => {
    const child = execFile(file, args, { encoding: 'utf8', timeout: 10000, maxBuffer: 4 << 20,
      env: { ...process.env, DISABLE_AUTO_UPDATE: 'true', ZSH_TMUX_AUTOSTART: 'false' } }, (_err, stdout) => {
      const m = /^PATH=(.*)$/m.exec(String(stdout || '').split(mark)[1] || '');
      resolve(m ? m[1].trim() : '');
    });
    try { child.stdin?.end(); } catch {}
  });
}
// The login shell's PATH first (a terminal's order, so Homebrew's git wins over the system one), then
// anything only Operant's own PATH has.
async function freshPath(current) {
  const seen = new Set();
  return [...(await loginPath()).split(':'), ...String(current || '').split(':')]
    .filter(p => p && !seen.has(p) && seen.add(p)).join(':');
}

// GUI apps on macOS start without LANG, and a shell then treats UTF-8 as bytes (vim, less, git's pager).
function withLocale(env, locale) {
  if (env.LANG || env.LC_ALL || env.LC_CTYPE) return env;
  const m = /^([a-z]{2,3})[-_]([a-z]{2})\b/i.exec(String(locale || ''));
  env.LANG = m ? `${m[1].toLowerCase()}_${m[2].toUpperCase()}.UTF-8` : 'en_US.UTF-8';
  return env;
}

// Where a command is on PATH, or null.
function which(cmd, env) {
  return new Promise(resolve => {
    execFile('/bin/sh', ['-c', 'command -v "$1"', 'sh', cmd], { encoding: 'utf8', env }, (err, stdout) => {
      const p = String(stdout || '').trim().split('\n')[0];
      resolve(!err && p.startsWith('/') ? p : null);
    });
  });
}

module.exports = { sq, defaultShell, shellKind, usesSh, tileLaunch, agentScript, editScript, loginPath, freshPath, withLocale, which };
