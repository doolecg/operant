// Operant: main process.
// Owns the pseudo-terminals (AI agent CLIs / shell sessions) and watches Claude Code's
// transcript folders so every Claude subagent that starts gets its own tile.

const { app, BrowserWindow, Menu, ipcMain, dialog, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const pty = require('@lydell/node-pty');
const { createUpdater } = require('./updater');
const { createMedia } = require('./media');
const { createUsage } = require('./usage');
const shellIntegration = require('./shell-integration');
const { THEMES } = require('./renderer/themes');

// Dev runs can use their own profile (config + single-instance lock) beside an installed copy.
if (process.env.OPERANT_USER_DATA) app.setPath('userData', process.env.OPERANT_USER_DATA);
// A test build (npm run pack) run with its own profile is packaged but must not take over the installed
// app's Explorer entry, operant:// links or jump list.
const installed = app.isPackaged && !process.env.OPERANT_USER_DATA;
// Windows only shows toast notifications for an app with an AppUserModelID (the installer's shortcut carries the same one).
app.setAppUserModelId('com.doolecg.operant');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
// Lives in %APPDATA%/Operant so it survives updates (the install dir is replaced).
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

// Alt is the "Super" key here: Windows reserves most Win+ combos for itself.
const DEFAULT_KEYBINDS = {
  newAgent: ['Alt+Enter'],
  newAgentIn: ['Alt+Shift+Enter'],
  pickAgent: ['Alt+N'],
  newShell: ['Alt+Shift+T'],
  close: ['Alt+Q'],
  fullscreen: ['Alt+F'],
  toggleSplit: ['Alt+E'],
  closeDoneAgents: ['Alt+Shift+A'],
  newWindow: ['Alt+Shift+N'],
  toggleSidebar: ['Alt+B'],
  focusSidebar: ['Alt+Shift+B'], // the keyboard to the sidebar (arrows, or vim keys), Esc gives it back
  toggleLayout: ['Alt+M'],
  promoteMaster: ['Alt+Shift+M'],
  focusLeft: ['Alt+Left', 'Alt+H'], focusRight: ['Alt+Right', 'Alt+L'],
  focusUp: ['Alt+Up'], focusDown: ['Alt+Down', 'Alt+J'],
  swapLeft: ['Alt+Shift+Left', 'Alt+Shift+H'], swapRight: ['Alt+Shift+Right', 'Alt+Shift+L'],
  swapUp: ['Alt+Shift+Up', 'Alt+Shift+K'], swapDown: ['Alt+Shift+Down', 'Alt+Shift+J'],
  resizeLeft: ['Ctrl+Alt+Left'], resizeRight: ['Ctrl+Alt+Right'],
  resizeUp: ['Ctrl+Alt+Up'], resizeDown: ['Ctrl+Alt+Down'],
  prevWorkspace: ['Alt+PageUp'], nextWorkspace: ['Alt+PageDown'],
  help: ['Alt+K', 'F1', 'Alt+Slash'], // keybind popup
  settings: ['Alt+Comma'],
  openConfig: [],
  devtools: ['Ctrl+Shift+I'],
  // Media keys on the keyboard already work everywhere; these are for keyboards without them.
  mediaPlayPause: [], mediaNext: [], mediaPrev: [], mediaShuffle: [],
  tokenUsage: ['Alt+U'], // the token usage graph
  quickOpen: ['Ctrl+P'], commandPalette: ['Ctrl+Shift+P'],
  findInView: ['Ctrl+F'], // only in viewer and diff tiles; terminals keep the key
  showChanges: [],        // the diff tile for the focused tile's project
  // Alt+1..9 switch workspace, Alt+Shift+1..9 move the focused tile there.
};

const DEFAULT_CONFIG = {
  defaultCwd: os.homedir(),
  // Terminal AI CLIs. Any command that runs in a terminal works; tiles run it through the shell.
  agents: [
    { id: 'claude', name: 'Claude Code', command: 'claude', args: [], install: 'npm i -g @anthropic-ai/claude-code', icon: '✻' },
    { id: 'codex', name: 'OpenAI Codex', command: 'codex', args: [], install: 'npm i -g @openai/codex', icon: '◎' },
    { id: 'opencode', name: 'OpenCode', command: 'opencode', args: [], install: 'npm i -g opencode-ai', icon: '▣' },
    { id: 'gemini', name: 'Gemini CLI', command: 'gemini', args: [], install: 'npm i -g @google/gemini-cli', icon: '✦' },
  ],
  defaultAgent: 'claude',          // what Alt+Enter, the master and Explorer's entry open
  agentChosen: false,             // false until the first-run "which agent?" prompt is answered
  shell: 'powershell.exe',
  showExternalAgents: true,       // subagents from Claude sessions not started inside Operant
  agentLookbackSeconds: 20,       // on startup, also open agents that started this recently
  masterOnStartup: true,          // open a "master" agent terminal when Operant starts
  defaultLayout: 'master',        // 'master' (big left pane + stack) or 'dwindle'
  masterRatio: 0.55,
  // Idle reaping (0 disables each). The focused tile and the master terminal are never reaped.
  autoCloseDoneAgentsSeconds: 15, // finished agent tiles, counted from when you first see them
  idleCloseTerminalMinutes: 10,   // Claude/shell tiles with no output and no typing
  maxTilesPerWorkspace: 6,        // new agents spill onto the next workspace past this
  confirmClose: true,             // ask before closing a window that still has terminals running
  restoreSession: 'update',       // reopen the tiles you had open: 'update' (after an update) | 'always' | 'never'
  updateWhenIdle: true,           // clicking Update while an agent is working waits until it finishes
  gapsIn: 5,
  gapsOut: 12,
  rounding: 12,
  borderSize: 2,
  fontSize: 13,
  fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, monospace",
  opacity: 0.86,
  blur: 20,
  lineHeight: 1,
  cursorBlink: true,
  cursorStyle: 'block',           // 'block' | 'bar' | 'underline'
  scrollback: 10000,
  theme: 'obsidian',              // see renderer/themes.js
  accent: '',                     // '' = the theme's own; otherwise a hex color
  wallpaper: 'glow-dots',         // 'glow-dots' | 'glow' | 'plain'
  borderAnimation: 'active',      // 'active' (focused + running agents) | 'focused' | 'off'
  borderAnimationSeconds: 8,
  autoUpdate: true,               // check GitHub releases and install new versions
  explorerContextMenu: true,      // "Open in Operant" when right-clicking a folder
  explorerOpensIn: 'tile',        // 'tile' (in the window you used last) | 'window' (a new Operant window)
  sidebar: true,                  // the projects and folder tree on the left
  sidebarWidth: 250,
  sidebarHiddenFiles: false,      // show dotfiles and the like in the tree
  projects: [],                   // folders pinned at the top of the sidebar
  projectGroups: [],              // named groups of pinned projects: [{ name, projects: [folders] }]
  projectDefaults: {},            // per project folder: { agent, args, startup } for tiles opened in it
  sidebarGit: true,               // each project's branch and changed files in the sidebar
  ide: 'code',                    // "Open in IDE": a command that takes the folder, or 'custom' for ideCommand
  ideCommand: '',
  mediaControls: true,            // what Windows is playing, with its buttons, in the top bar
  tokenUsage: true,               // Claude Code's tokens today in the top bar; click for the graph
  usageSeries: ['input', 'output', 'cacheWrite'], // what the pill and graph count; cache reads would swamp the rest
  planLimits: true,               // Claude plan limits (5-hour session, week) in the token pill's tooltip
  planLimitAlerts: true,          // a notification at 80% and 95% of the 5-hour session, and its ring on the pill
  tokenBudget: 0,                // counted tokens a day; the pill turns orange near it and red past it · 0 = off
  clockFormat: 'auto',            // the bar's clock: 'auto' (from Windows) | '24' | '12'
  clockSeconds: false,
  clockDate: true,
  barTitle: false,                // the focused tile's title beside the clock
  workspaceNames: [],             // names given to workspaces 1-9 (double-click one in the bar)
  editor: 'auto',                 // the editor tile's program: 'auto' | 'vim' | 'nvim' | 'micro' | 'nano' | 'edit' | 'custom'
  editorCommand: '',              // with 'custom': the command, the file is added at the end
  configOpensIn: 'system',        // "Edit config.json": 'system' (Windows' app for .json) | 'editor' (the editor tile)
  vimKeys: false,                 // j/k, h/l, gg/G, Ctrl+D/U and / in viewers, diffs and the sidebar
  fileOpens: 'view',              // double-clicking a file in the sidebar: 'view' (viewer tile) | 'edit' (editor tile) | 'system'
  codegraphButtons: true,        // "Index with CodeGraph" buttons in the sidebar
  codegraphOnStartup: 'changed',  // index pinned projects when Operant starts: 'changed' (lots of changes) | 'all' | 'off'
  codegraphChangedFiles: 20,      // files added, changed or removed since the last index that count as lots
  // Windows notifications
  notifications: true,
  notifyWhenIdleSeconds: 6,       // an agent that was working and has gone quiet this long is waiting for you
  notifySubagents: true,          // a Claude subagent finished
  notifyOnlyUnfocused: true,      // skip it when you're already looking at that tile
  keybinds: DEFAULT_KEYBINDS,
};

// Only what the user changed is stored, so new defaults reach existing installs.
let user = {};
try { user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^﻿/, '')); } catch {} // a BOM from Notepad or PowerShell would fail the parse
const merged = () => ({ ...DEFAULT_CONFIG, ...user, keybinds: { ...DEFAULT_KEYBINDS, ...(user.keybinds || {}) } });
const config = merged();

function saveUser() {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(user, null, 2));
  } catch (e) { console.error('config save failed', e); }
}

// patch: { key: value }; null resets a key to its default.
ipcMain.handle('config:set', (e, patch) => {
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_CONFIG)) continue;
    if (v === null) delete user[k]; else user[k] = v;
  }
  saveUser();
  Object.assign(config, merged());
  if ('explorerContextMenu' in patch && installed) {
    if (config.explorerContextMenu) shellIntegration.register(process.execPath); else shellIntegration.unregister();
  }
  if ('mediaControls' in patch) { if (config.mediaControls) media.start(); else media.stop(); }
  if ('tokenUsage' in patch) { if (config.tokenUsage) usage.start(); else usage.stop(); }
  if ('planLimits' in patch || 'planLimitAlerts' in patch || 'tokenUsage' in patch) pollLimits();
  // Other Operant windows pick the change up live.
  for (const w of windows) if (w.webContents !== e.sender) sendTo(w, 'config:changed', config);
  return config;
});
ipcMain.handle('config:defaults', () => DEFAULT_CONFIG);
// Every Operant window lives in this one process. Each owns its terminals; subagents go to the
// window whose Claude tile started them, and anything else to the window you used last.
const windows = new Set();
let lastFocused = null;
const alive = w => !!w && !w.isDestroyed();
const sendTo = (w, ch, data) => { if (alive(w)) w.webContents.send(ch, data); };
const broadcast = (ch, data) => { for (const w of windows) sendTo(w, ch, data); };
const primary = () => (alive(lastFocused) ? lastFocused : [...windows].find(alive)) || null;
const winOf = e => BrowserWindow.fromWebContents(e.sender);
const sessionOwner = new Map(); // Claude --session-id -> window
// Windows only lets a background app take the foreground in some cases; briefly going
// always-on-top gets the window in front even when it doesn't.
function bringUp(w) {
  if (!alive(w)) return;
  if (w.isMinimized()) w.restore();
  w.show();
  w.setAlwaysOnTop(true); w.focus(); w.setAlwaysOnTop(false);
}

// ---------------------------------------------------------------- terminals

const ptys = new Map(); // id -> pty (each also carries .owner, its window)

ipcMain.handle('config', () => config);

// A folder passed on the command line (e.g. from the Explorer right-click entry).
// Dev runs also pass the app's own folder (`electron .`), and Chromium can put its flags first.
function folderArg(argv) {
  const appDir = path.resolve(app.getAppPath()).toLowerCase();
  const args = argv.slice(1).filter(a => !a.startsWith('-'));
  for (const a of args) {
    const dir = path.resolve(a.replace(/"/g, ''));
    if (!app.isPackaged && dir.toLowerCase() === appDir) continue;
    try { if (fs.statSync(dir).isDirectory()) return dir; } catch {}
  }
  return null;
}
const startDirs = new Map(); // webContents id -> folder that window was opened for
ipcMain.handle('startup-folder', e => startDirs.get(e.sender.id) || null);

// The PATH Windows would give a freshly started program: machine + user entries from the
// registry. Our own process.env.PATH can be stale (Operant was started before an agent CLI was
// installed, or by a parent with an old environment), so tiles couldn't find the command.
// Read without blocking the main process (every terminal's output passes through it), and kept for a minute.
let regPath = null; // { at, value: Promise<string> }
function registryPath() {
  if (regPath && Date.now() - regPath.at < 60000) return regPath.value;
  const read = key => run('reg.exe', ['query', key, '/v', 'Path']).then(r => {
    const m = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/mi.exec(r.stdout);
    return m ? m[1].trim().replace(/%([^%]+)%/g, (s, v) => process.env[v] ?? s) : '';
  });
  const value = Promise.all([read('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'), read('HKCU\\Environment')])
    .then(parts => parts.filter(Boolean).join(';'));
  regPath = { at: Date.now(), value };
  return value;
}

// A child process's output and exit code, never rejecting (a missing program gives code -1).
function run(cmd, args, opts = {}) {
  return new Promise(resolve => {
    execFile(cmd, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20, ...opts }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

async function withFreshPath(env) {
  if (process.platform !== 'win32') return env;
  const key = Object.keys(env).find(k => k.toUpperCase() === 'PATH') || 'Path';
  const seen = new Set();
  env[key] = [...(env[key] || '').split(';'), ...(await registryPath()).split(';')]
    .filter(p => p && !seen.has(p.toLowerCase()) && seen.add(p.toLowerCase()))
    .join(';');
  return env;
}
const freshEnv = () => withFreshPath({ ...process.env });

const findAgent = id => config.agents.find(a => a.id === id) || config.agents.find(a => a.id === config.defaultAgent) || config.agents[0];
// Claude Code gets its own --session-id, which is how its subagents find their parent tile.
const isClaude = agent => /(^|[\\/])claude(\.(exe|cmd|ps1))?$/i.test(String(agent.command).trim());

// A restored Claude tile continues its conversation, if it had one (a tile you never typed in
// leaves no transcript, and --resume would fail on it).
const hasTranscript = id => {
  try { return fs.readdirSync(PROJECTS_DIR).some(p => fs.existsSync(path.join(PROJECTS_DIR, p, id + '.jsonl'))); } catch { return false; }
};

// The editor tile's program: Settings › Files › Editor, or the first one found. Git for Windows brings
// vim and nano without putting them on PATH, so its usr\bin is looked in too.
const GIT_BIN = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin');
let editorFound = null; // { at, key, value: Promise<string|null> }
function editorCommand() {
  if (config.editor === 'custom') return Promise.resolve((config.editorCommand || '').trim() || null);
  const key = config.editor || 'auto';
  if (editorFound && editorFound.key === key && Date.now() - editorFound.at < 60000) return editorFound.value;
  const value = (async () => {
    const env = await freshEnv();
    const order = key !== 'auto' ? [key] : ['nvim', 'vim', 'micro', 'edit', 'nano'];
    const found = await Promise.all(order.map(async c => (await run('where', [c], { env })).code === 0 ? c
      : fs.existsSync(path.join(GIT_BIN, c + '.exe')) ? path.join(GIT_BIN, c + '.exe') : null));
    return found.find(Boolean) || null;
  })();
  editorFound = { at: Date.now(), key, value };
  return value;
}
ipcMain.handle('editor:name', async () => { const c = await editorCommand(); return c ? path.basename(c).replace(/\.exe$/i, '') : null; });

// Settings › Projects: the defaults of the project a folder is in (the innermost, if they nest).
const projectOf = dir => Object.keys(config.projectDefaults || {})
  .filter(p => { const a = path.resolve(dir).toLowerCase(), b = path.resolve(p).toLowerCase(); return a === b || a.startsWith(b.replace(/[\\/]$/, '') + path.sep); })
  .sort((a, b) => b.length - a.length)[0];

ipcMain.handle('pty:create', async (e, { kind, agentId, cwd, cols, rows, run, resume, edit }) => {
  const id = crypto.randomUUID();
  const agent = kind === 'ai' ? findAgent(agentId) : null;
  const resuming = !!(agent && isClaude(agent) && /^[0-9a-f-]{36}$/i.test(resume || '') && hasTranscript(resume));
  const sessionId = agent && isClaude(agent) ? (resuming ? resume : crypto.randomUUID()) : null;
  const dir = cwd && fs.existsSync(cwd) ? cwd : config.defaultCwd;
  const proj = config.projectDefaults?.[projectOf(dir)] || {};
  const startup = String(proj.startup || '').trim();

  // Run the agent through the shell (PATH lookup, .cmd shims). The tile closes when it
  // exits cleanly; on failure it waits so the error stays readable.
  let command = config.shell;
  let args = run && !agent ? ['-NoLogo', '-NoExit', '-Command', run] : startup && !edit ? ['-NoLogo', '-NoExit', '-Command', startup] : ['-NoLogo'];
  // An editor tile: the editor on that file, and the tile closes when you quit it.
  if (edit && !agent) {
    const q = a => `'${String(a).replace(/'/g, "''")}'`;
    const ed = await editorCommand();
    // Vim gets line numbers, and no swap file (it would be left beside the file whenever the tile is closed with vim still open).
    // Its title carries vim's modified flag ([+]), which is how the tile knows to ask before closing.
    const noSwap = ed && /(^|[\\/])n?vim(\.exe)?$/i.test(ed) ? " -n -c 'set number title titlestring=%t%m'" : '';
    args = ['-NoLogo', '-Command', ed ? `& ${config.editor === 'custom' ? ed : q(ed)}${noSwap} ${q(edit)}`
      : `Write-Host 'No editor found. Install vim, neovim, micro or nano, or set one in Settings > Files.' -ForegroundColor Yellow; Read-Host 'Press Enter to close'`];
  }
  if (agent) {
    const q = a => `'${String(a).replace(/'/g, "''")}'`;
    const extra = String(proj.args || '').trim().split(/\s+/).filter(Boolean);
    const quoted = [...[].concat(agent.args || []), ...extra, ...(sessionId ? [resuming ? '--resume' : '--session-id', sessionId] : [])].map(q).join(' ');
    // A command that isn't installed gets a plain explanation instead of PowerShell's error.
    const missing = `${agent.name}: '${agent.command}' isn't installed or isn't on your PATH.`
      + (agent.install ? ` Install it with: ${agent.install}` : ' Set its command in Settings > Agents.');
    const exe = String(agent.command).trim().split(/\s+/)[0];
    args = ['-NoLogo', '-Command', [
      ...(startup ? [startup] : []),
      `if (-not (Get-Command ${q(exe)} -ErrorAction SilentlyContinue)) { Write-Host ${q(missing)} -ForegroundColor Yellow; Read-Host 'Press Enter to close'; exit }`,
      `& ${agent.command} ${quoted}; if (-not $?) { Read-Host ${q(`${agent.name} exited with an error, press Enter to close`)} }`,
    ].join('; ')];
  }

  // If Operant was itself started from inside a Claude session, don't let the
  // child claude think it's nested: that turns off transcript saving, which the
  // subagent tiles depend on.
  const env = await withFreshPath({ ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' });
  for (const k of Object.keys(env)) {
    if (k === 'CLAUDECODE' || k === 'CLAUDE_PID' || /^CLAUDE_CODE_(CHILD_SESSION|ENTRYPOINT|SESSION_|BRIDGE_|MESSAGING_)/.test(k)) delete env[k];
  }

  const p = pty.spawn(command, args, {
    name: 'xterm-256color',
    cols: cols || 100,
    rows: rows || 30,
    cwd: dir,
    env,
    useConpty: true,
  });
  const owner = winOf(e);
  p.owner = owner;
  p.label = agent ? agent.name : 'Shell';
  ptys.set(id, p);
  if (sessionId) sessionOwner.set(sessionId, owner);
  p.onData(data => sendTo(owner, 'pty:data', { id, data }));
  p.onExit(({ exitCode }) => { ptys.delete(id); sendTo(owner, 'pty:exit', { id, exitCode }); });
  return { id, sessionId, cwd: dir, agent };
});

ipcMain.on('pty:write', (_e, { id, data }) => ptys.get(id)?.write(data));
ipcMain.on('pty:resize', (_e, { id, cols, rows }) => {
  try { if (cols > 1 && rows > 1) ptys.get(id)?.resize(cols, rows); } catch {}
});
ipcMain.on('pty:kill', (_e, { id }) => { try { ptys.get(id)?.kill(); } catch {} ptys.delete(id); });

ipcMain.handle('pick-folder', async e => {
  const r = await dialog.showOpenDialog(winOf(e), { properties: ['openDirectory'], defaultPath: config.defaultCwd });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('config:path', () => { if (!fs.existsSync(CONFIG_PATH)) saveUser(); return CONFIG_PATH; });
ipcMain.on('open-config', () => {
  if (!fs.existsSync(CONFIG_PATH)) saveUser();
  shell.openPath(CONFIG_PATH);
});
// The sidebar's folder tree: one level at a time, folders first.
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
ipcMain.handle('fs:list', async (_e, { dir, hidden }) => {
  try {
    const ents = await fs.promises.readdir(dir, { withFileTypes: true });
    return ents
      .filter(d => hidden || !(d.name.startsWith('.') || d.name.startsWith('$') || /^(desktop\.ini|thumbs\.db|ntuser\.)/i.test(d.name)))
      .map(d => ({ name: d.name, path: path.join(dir, d.name), dir: d.isDirectory() || (d.isSymbolicLink() && isDir(path.join(dir, d.name))) }))
      .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
      .slice(0, 3000);
  } catch { return null; }
});
ipcMain.handle('fs:is-dir', (_e, p) => isDir(p));
// The viewer tile: a file's text (up to 5 MB), or why it can't be shown.
const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml', avif: 'image/avif' };
ipcMain.handle('fs:read', async (_e, p) => {
  try {
    const st = await fs.promises.stat(p);
    const type = IMAGE_TYPES[path.extname(p).slice(1).toLowerCase()];
    if (type) {
      if (st.size > 30 * 1024 * 1024) return { mtime: st.mtimeMs, error: 'This image is over 30 MB' };
      return { mtime: st.mtimeMs, image: `data:${type};base64,${(await fs.promises.readFile(p)).toString('base64')}`, size: st.size };
    }
    if (st.size > 5 * 1024 * 1024) return { mtime: st.mtimeMs, error: 'This file is over 5 MB' };
    const buf = await fs.promises.readFile(p);
    if (buf.subarray(0, 8000).includes(0)) return { mtime: st.mtimeMs, error: 'This isn’t a text file' };
    return { mtime: st.mtimeMs, text: buf.toString('utf8').replace(/^﻿/, '') };
  } catch (e) { return { error: e.code === 'ENOENT' ? 'The file is gone' : e.message }; }
});
// Viewer tiles follow their file: its folder is watched (editors save by replacing the file, which a
// watch on the file itself would lose), one watcher per folder for every tile looking into it.
const dirWatches = new Map(); // folder (lower case) -> { watcher, files: Map<file lower case, Set<{ w, key }>> }
function watchFile(w, key, file) {
  const dir = path.dirname(file), dk = dir.toLowerCase(), fk = file.toLowerCase();
  let d = dirWatches.get(dk);
  if (!d) {
    d = { files: new Map(), timers: new Map() };
    try {
      d.watcher = fs.watch(dir, (_ev, name) => {
        const targets = name ? [path.join(dir, String(name)).toLowerCase()] : [...d.files.keys()];
        for (const t of targets) {
          if (!d.files.has(t)) continue;
          clearTimeout(d.timers.get(t));
          d.timers.set(t, setTimeout(() => { for (const s of d.files.get(t) || []) sendTo(s.w, 'fs:changed', s.key); }, 120));
        }
      });
      d.watcher.on('error', () => {});
    } catch { return; }
    dirWatches.set(dk, d);
  }
  if (!d.files.has(fk)) d.files.set(fk, new Set());
  d.files.get(fk).add({ w, key });
}
function unwatchFile(w, key) {
  for (const [dk, d] of dirWatches) {
    for (const [fk, subs] of d.files) {
      for (const s of subs) if (s.w === w && (key == null || s.key === key)) subs.delete(s);
      if (!subs.size) { d.files.delete(fk); clearTimeout(d.timers.get(fk)); }
    }
    if (!d.files.size) { try { d.watcher.close(); } catch {} dirWatches.delete(dk); }
  }
}
ipcMain.on('fs:watch', (e, { key, file }) => { const w = winOf(e); unwatchFile(w, key); if (file) watchFile(w, key, file); });

// Every file in a folder, for Quick open: git's list (tracked + untracked, minus ignored) in a repository,
// otherwise a walk that skips the usual build and dependency folders. Kept for 20 seconds.
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target', '.gradle', '.idea', '.vs', '.next', '.nuxt',
  '__pycache__', '.venv', 'venv', '.cache', 'bin', 'obj', '.codegraph', 'coverage']);
const fileLists = new Map(); // folder -> { at, value: Promise<string[]> }
async function listFiles(root) {
  const git = await run('git', ['-C', root, 'ls-files', '-co', '--exclude-standard', '-z']);
  if (git.code === 0) return git.stdout.split('\0').filter(Boolean).slice(0, 50000);
  const out = [];
  async function walk(dir, rel, depth) {
    if (out.length >= 50000 || depth > 12) return;
    let ents;
    try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const d of ents) {
      if (d.isDirectory()) { if (!SKIP_DIRS.has(d.name) && !d.name.startsWith('.')) await walk(path.join(dir, d.name), rel + d.name + '/', depth + 1); }
      else if (d.isFile()) out.push(rel + d.name);
    }
  }
  await walk(root, '', 0);
  return out;
}
ipcMain.handle('fs:files', (_e, root) => {
  const c = fileLists.get(root);
  if (c && Date.now() - c.at < 20000) return c.value;
  const value = listFiles(root);
  fileLists.set(root, { at: Date.now(), value });
  return value;
});

// Git in the sidebar and the diff tile. Status: the branch, and each changed path (relative to the
// repository's top folder, with / separators) with its two-letter porcelain code.
ipcMain.handle('git:status', async (_e, dir) => {
  const top = await run('git', ['-C', dir, 'rev-parse', '--show-toplevel']);
  if (top.code !== 0) return null;
  const r = await run('git', ['-C', dir, 'status', '--porcelain=v1', '-b', '-z', '-uall']);
  if (r.code !== 0) return null;
  const parts = r.stdout.split('\0');
  let branch = '', ahead = 0, behind = 0;
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    if (p.startsWith('## ')) {
      const h = p.slice(3).replace(/^No commits yet on /, '');
      branch = h.startsWith('HEAD (no branch)') ? 'detached' : h.split('...')[0].split(' ')[0];
      ahead = +(/ahead (\d+)/.exec(p)?.[1] || 0); behind = +(/behind (\d+)/.exec(p)?.[1] || 0);
      continue;
    }
    const code = p.slice(0, 2), file = p.slice(3);
    // The old name follows a rename.
    files.push({ code, path: file, ...(code[0] === 'R' || code[0] === 'C' ? { orig: parts[++i] } : {}) });
  }
  return { root: top.stdout.trim().replace(/\//g, path.sep), branch, ahead, behind, files };
});
// One file's changes against HEAD (staged and not), as a unified diff. An untracked file is all added lines.
ipcMain.handle('git:diff', async (_e, { root, file, code }) => {
  if (code === '??') {
    try {
      const buf = await fs.promises.readFile(path.join(root, file));
      if (buf.subarray(0, 8000).includes(0)) return { binary: true };
      if (buf.length > 2 * 1024 * 1024) return { error: 'This file is over 2 MB' };
      const lines = buf.toString('utf8').replace(/\r/g, '').split('\n');
      if (lines.at(-1) === '') lines.pop();
      return { text: `@@ -0,0 +1,${lines.length} @@ new file\n` + lines.map(l => '+' + l).join('\n') };
    } catch (e) { return { error: e.message }; }
  }
  const head = await run('git', ['-C', root, 'rev-parse', '--verify', '-q', 'HEAD']);
  const r = await run('git', ['-C', root, 'diff', '--no-color', '--no-ext-diff', '-M', head.code === 0 ? 'HEAD' : '--cached', '--', file]);
  if (r.code !== 0) return { error: r.stderr.trim() || 'git diff failed' };
  if (/^Binary files /m.test(r.stdout)) return { binary: true };
  return { text: r.stdout.replace(/^[\s\S]*?(?=^@@)/m, '') };
});

// Committing from the diff tile. Git never waits on a prompt (it would hang with no terminal); a login it
// needs comes from Git Credential Manager's own window. Each resolves to { ok, out } with git's messages.
const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' };
const git = async (root, args) => {
  const r = await run('git', ['-C', root, ...args], { env: gitEnv, timeout: 120000 });
  return { ok: r.code === 0, out: (r.stdout + r.stderr).trim() };
};
// files: [{ path, orig }] relative to root. Only those are committed; anything else staged stays staged.
ipcMain.handle('git:commit', async (_e, { root, files, message, amend, push }) => {
  const paths = [...new Set(files.flatMap(f => [f.path, f.orig].filter(Boolean)))];
  let r = await git(root, ['add', '-A', '--', ...paths]);
  if (!r.ok) return r;
  r = await git(root, ['commit', ...(amend ? ['--amend'] : []), '-m', message, '--', ...paths]);
  if (!r.ok || !push) return r;
  const p = await pushBranch(root);
  return { ok: p.ok, out: `${r.out}\n\n${p.out}`, pushed: p.ok };
});
async function pushBranch(root) {
  const up = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  return git(root, up.ok ? ['push'] : ['push', '-u', 'origin', 'HEAD']);
}
ipcMain.handle('git:push', (_e, root) => pushBranch(root));
ipcMain.handle('git:pull', (_e, root) => git(root, ['pull']));
// Roll back: a tracked file goes back to its last commit; a new one is deleted.
ipcMain.handle('git:rollback', async (_e, { root, file }) => {
  const full = path.join(root, file.path);
  if (file.code === '??' || file.code[0] === 'A') {
    if (file.code[0] === 'A') await git(root, ['rm', '--cached', '-q', '--', file.path]);
    try { await fs.promises.rm(full, { force: true }); return { ok: true, out: '' }; } catch (e) { return { ok: false, out: e.message }; }
  }
  return git(root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', file.path, ...(file.orig ? [file.orig] : [])]);
});
ipcMain.handle('git:branches', async (_e, root) => {
  const r = await git(root, ['branch', '--format=%(refname:short)']);
  return r.ok ? r.out.split(/\r?\n/).filter(Boolean) : [];
});
ipcMain.handle('git:checkout', (_e, { root, branch, create }) => git(root, create ? ['switch', '-c', branch] : ['switch', branch]));
ipcMain.handle('git:last-message', async (_e, root) => (await git(root, ['log', '-1', '--format=%B'])).out);

// A question with buttons, as a Windows dialog over the window that asks. Resolves to the button's index.
ipcMain.handle('ask', (e, { message, detail, buttons, cancelId }) =>
  dialog.showMessageBox(winOf(e), { type: 'question', title: 'Operant', message, detail, buttons, defaultId: 0, cancelId, noLink: true }).then(r => r.response));
ipcMain.on('fs:open', (_e, p) => shell.openPath(p));
ipcMain.on('fs:reveal', (_e, p) => shell.showItemInFolder(p));
// Where the IDE presets install when their launcher isn't on PATH (JetBrains never adds itself). Newest version first.
const inDirs = (parent, prefix, rel) => { try {
  return fs.readdirSync(parent).filter(n => n.startsWith(prefix)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map(n => path.join(parent, n, rel));
} catch { return []; } };
const LOCAL = process.env.LOCALAPPDATA || '', PF = process.env.ProgramFiles || 'C:\\Program Files';
const IDE_PATHS = {
  code: () => [path.join(LOCAL, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'), path.join(PF, 'Microsoft VS Code', 'bin', 'code.cmd')],
  cursor: () => [path.join(LOCAL, 'Programs', 'cursor', 'resources', 'app', 'bin', 'cursor.cmd')],
  windsurf: () => [path.join(LOCAL, 'Programs', 'Windsurf', 'bin', 'windsurf.cmd')],
  zed: () => [path.join(LOCAL, 'Programs', 'Zed', 'bin', 'zed.exe'), path.join(LOCAL, 'Programs', 'Zed', 'zed.exe')],
  idea: () => [path.join(LOCAL, 'JetBrains', 'Toolbox', 'scripts', 'idea.cmd'), ...inDirs(path.join(PF, 'JetBrains'), 'IntelliJ IDEA', 'bin\\idea64.exe')],
  rider: () => [path.join(LOCAL, 'JetBrains', 'Toolbox', 'scripts', 'rider.cmd'), ...inDirs(path.join(PF, 'JetBrains'), 'Rider', 'bin\\rider64.exe'), ...inDirs(path.join(PF, 'JetBrains'), 'JetBrains Rider', 'bin\\rider64.exe')],
  subl: () => [path.join(PF, 'Sublime Text', 'subl.exe'), path.join(PF, 'Sublime Text 3', 'subl.exe')],
};
async function ideCommand() {
  if (config.ide === 'custom') return (config.ideCommand || '').trim();
  const cmd = config.ide || 'code';
  if (!IDE_PATHS[cmd] || (await run('where', [cmd])).code === 0) return cmd;
  const found = IDE_PATHS[cmd]().find(p => fs.existsSync(p));
  return found ? `"${found}"` : cmd;
}
const codegraphVersion = async () => {
  const r = await run('codegraph', ['--version'], { shell: true, env: await freshEnv() });
  return r.code === 0 && r.stdout.trim() || null;
};
ipcMain.handle('codegraph:version', codegraphVersion);
// Which pinned projects to index as Operant starts, asked once per run (the first window gets the answer):
// with 'changed', indexed projects with at least codegraphChangedFiles files changed since their last index;
// with 'all', every pinned project, including ones CodeGraph hasn't set up yet.
let codegraphStartupDone = false;
const codegraphPending = async dir => { const env = await freshEnv(); return new Promise(resolve => {
  let out = '';
  const p = spawn('codegraph', ['status', '--json', `"${dir}"`], { shell: true, env, windowsHide: true });
  const timer = setTimeout(() => { try { p.kill(); } catch {} resolve(0); }, 30000);
  p.stdout.on('data', d => { out += d; });
  p.on('error', () => { clearTimeout(timer); resolve(0); });
  p.on('close', () => {
    clearTimeout(timer);
    try { const c = JSON.parse(out).pendingChanges || {}; resolve((c.added || 0) + (c.modified || 0) + (c.removed || 0)); } catch { resolve(0); }
  });
}); };
ipcMain.handle('codegraph:startup', async () => {
  if (codegraphStartupDone || config.codegraphOnStartup === 'off') return [];
  codegraphStartupDone = true;
  const seen = new Set();
  const projects = [...config.projects, ...(config.projectGroups || []).flatMap(g => g.projects || [])]
    .filter(p => p && isDir(p) && !seen.has(p.toLowerCase()) && seen.add(p.toLowerCase()));
  if (!projects.length || !await codegraphVersion()) return [];
  if (config.codegraphOnStartup === 'all') return projects;
  const indexed = projects.filter(p => fs.existsSync(path.join(p, '.codegraph')));
  const counts = await Promise.all(indexed.map(codegraphPending));
  return indexed.filter((_, i) => counts[i] >= Math.max(1, config.codegraphChangedFiles || 1));
});
// Runs the IDE through cmd so .cmd launchers like code and cursor work. Resolves to an error message, or null.
ipcMain.handle('ide:open', async (_e, dir) => { const cmd = await ideCommand(); return new Promise(resolve => {
  if (!cmd) return resolve('Set a custom IDE command in Settings › Sidebar');
  let child;
  try { child = spawn(`${cmd} "${dir}"`, { shell: true, cwd: dir, detached: true, stdio: 'ignore', windowsHide: true }); }
  catch (err) { return resolve(err.message); }
  // Launchers hand off and exit 0 at once; "not recognized" exits non-zero. A GUI exe that keeps running is fine.
  const timer = setTimeout(() => { child.unref(); resolve(null); }, 4000);
  child.on('error', err => { clearTimeout(timer); resolve(err.message); });
  child.on('exit', code => { clearTimeout(timer); resolve(code ? `"${cmd}" didn't start (exit ${code}). Is it installed and on PATH?` : null); });
}); });

ipcMain.on('win:minimize', e => winOf(e)?.minimize());
ipcMain.on('win:maximize', e => { const w = winOf(e); if (w?.isMaximized()) w.unmaximize(); else w?.maximize(); });
ipcMain.on('win:close', e => winOf(e)?.close());
ipcMain.on('win:new', () => createWindow());
ipcMain.on('devtools', e => winOf(e)?.webContents.toggleDevTools());

// The renderer decides when to notify (it knows which tile is focused); clicking brings that tile up.
// Clicking a notification brings up its window and focuses the tile it's about, also when the
// toast is clicked later from the Action Center. Installed, each toast carries an operant:// link
// that Windows hands to Operant (see second-instance); in dev the click event does it.
const ICON = path.join(__dirname, 'build', 'icon.png').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const protocolReady = process.platform === 'win32' && installed && app.setAsDefaultProtocolClient('operant');
const liveNotes = new Set(); // a Notification that gets garbage-collected never reports its click

function focusTile(wcId, tileId) {
  const w = [...windows].find(x => alive(x) && x.webContents.id === wcId);
  if (!w) return;
  bringUp(w);
  sendTo(w, 'focus-tile', tileId);
}

function toastXml(title, body, launch) {
  const x = s => String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
  return `<toast launch="${x(launch)}" activationType="protocol"><visual><binding template="ToastGeneric">`
    + `<text>${x(title)}</text><text>${x(body)}</text><image placement="appLogoOverride" src="${x(ICON)}"/>`
    + '</binding></visual></toast>';
}

ipcMain.on('notify', (e, { title, body, tileId }) => {
  const w = winOf(e);
  if (!w || !config.notifications || !Notification.isSupported()) return;
  const wcId = w.webContents.id;
  const n = new Notification(protocolReady
    ? { toastXml: toastXml(title, body, `operant://focus/${wcId}/${tileId}`) }
    : { title, body, icon: ICON });
  liveNotes.add(n);
  if (liveNotes.size > 50) liveNotes.delete(liveNotes.values().next().value);
  n.on('click', () => focusTile(wcId, tileId));
  n.show();
});

// operant://focus/<window>/<tile> from a clicked toast.
function focusLink(argv) {
  const m = argv.map(a => /^operant:\/\/focus\/(\d+)\/(\d+)/i.exec(a)).find(Boolean);
  return m ? { wcId: +m[1], tileId: +m[2] } : null;
}
ipcMain.handle('win:focused', e => { const w = winOf(e); return !!w && w.isFocused() && !w.isMinimized(); });

// ------------------------------------------------------------------ updates

const updater = createUpdater({ send: broadcast, onInstall: () => { session.restoreNext = true; writeSession(); } });
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.on('update:check', () => updater.check());
ipcMain.handle('update:state', () => updater.status);
ipcMain.on('open-releases', () => shell.openExternal('https://github.com/doolecg/operant/releases'));
ipcMain.on('open-link', (_e, url) => { if (/^https?:\/\//i.test(String(url))) shell.openExternal(url); }); // links in release notes
ipcMain.on('update:install', async () => {
  // Installing quits every window, so ask once for all of them before starting the installer.
  if (!await confirmClose([...windows].filter(alive), { update: true })) return;
  if (updater.install()) app.quit();
});

// -------------------------------------------------------------------- media

const media = createMedia({ send: broadcast });
ipcMain.handle('media:state', () => media.state());
ipcMain.on('media:command', (_e, cmd) => media.command(String(cmd)));

// -------------------------------------------------------------------- usage

const usage = createUsage({ projectsDir: PROJECTS_DIR, send: broadcast });
ipcMain.handle('usage:summary', () => usage.summary());
ipcMain.handle('usage:series', (_e, range) => usage.series(String(range)));

// Claude plan limits (the 5-hour session and the week), as Claude Code's /usage shows them: asked of
// Anthropic with the login Claude Code keeps in ~/.claude/.credentials.json, at most once a minute.
// Operant never refreshes that login; Claude Code does whenever it runs.
let limitsCache = null;
async function fetchLimits() {
  if (!config.planLimits) return null;
  if (limitsCache && Date.now() - limitsCache.at < 60000) return limitsCache;
  const got = await askLimits();
  broadcast('usage:limits', got);
  limitAlerts(got);
  return got;
}
ipcMain.handle('usage:limits', () => fetchLimits());
async function askLimits() {
  let token;
  try { token = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8')).claudeAiOauth?.accessToken; } catch {}
  if (!token) return (limitsCache = { at: Date.now(), error: 'Sign in to Claude Code to see your plan limits' });
  try {
    const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': `Operant/${app.getVersion()}` },
      signal: AbortSignal.timeout(10000),
    });
    if (r.status === 401) return (limitsCache = { at: Date.now(), error: 'Claude login expired · open Claude Code to refresh it' });
    if (!r.ok) return (limitsCache = { at: Date.now(), error: `Couldn't read plan limits (${r.status})` });
    const d = await r.json();
    const one = x => x && typeof x.utilization === 'number' ? { used: x.utilization, resets: x.resets_at || null } : null;
    return (limitsCache = { at: Date.now(), session: one(d.five_hour), week: one(d.seven_day), weekOpus: one(d.seven_day_opus), weekSonnet: one(d.seven_day_sonnet) });
  } catch (e) {
    return (limitsCache = { at: Date.now(), error: `Couldn't read plan limits (${e.name === 'TimeoutError' ? 'timed out' : e.message})` });
  }
}

// Plan-limit alerts: a notification when the 5-hour session passes 80% and 95%, once each per session window.
// The limits are asked for every 2 minutes while the pill or the alerts want them.
const alerted = new Set(); // "<resets>|<threshold>"
function limitAlerts(l) {
  const s = l?.session;
  if (!config.planLimitAlerts || !config.notifications || !s || !Notification.isSupported()) return;
  const hit = [95, 80].find(t => s.used >= t);
  if (!hit || alerted.has(`${s.resets}|${hit}`)) return;
  [80, 95].filter(t => t <= hit).forEach(t => alerted.add(`${s.resets}|${t}`));
  const at = s.resets ? new Date(s.resets).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const n = new Notification({ title: `Claude session limit ${Math.round(s.used)}% used`, body: at ? `It resets at ${at}` : 'Your 5-hour session is nearly used up', icon: ICON });
  liveNotes.add(n);
  n.on('click', () => bringUp(primary()));
  n.show();
}
let limitsT = null;
function pollLimits() {
  clearInterval(limitsT); limitsT = null;
  if (!config.planLimits || !(config.tokenUsage || config.planLimitAlerts)) return;
  fetchLimits();
  limitsT = setInterval(fetchLimits, 120000);
}

// ---------------------------------------------------------- subagent watcher
// Layout on disk: projects/<project>/<sessionId>/subagents/agent-<id>.jsonl (+ .meta.json)

const agents = new Map(); // agentId -> { file, offset, partial, done, lastActivity }
const startTime = Date.now();

function readMeta(file) {
  try { return JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')); } catch { return null; }
}

function considerAgentFile(file) {
  const base = path.basename(file);
  if (!/^agent-.+\.jsonl$/.test(base)) return;
  const agentId = base.slice(6, -6);
  if (agents.has(agentId)) return;
  let st;
  try { st = fs.statSync(file); } catch { return; }
  const fresh = st.birthtimeMs > startTime - config.agentLookbackSeconds * 1000
    || st.mtimeMs > startTime - config.agentLookbackSeconds * 1000;
  const a = { agentId, file, offset: 0, partial: '', announced: false, lastSize: -1 };
  agents.set(agentId, a);
  if (!fresh) { a.ignored = true; return; }

  const sessionDir = path.dirname(path.dirname(file));
  a.sessionId = path.basename(sessionDir);
  a.project = path.basename(path.dirname(sessionDir));
  tailAgent(a);
}

function tailAgent(a) {
  if (a.ignored) return;
  let st;
  try { st = fs.statSync(a.file); } catch { return; }
  if (!a.announced) {
    const meta = readMeta(a.file);
    // meta.json can land a moment after the transcript; wait briefly for it.
    if (!meta && Date.now() - st.birthtimeMs < 1500) return;
    a.announced = true;
    a.owner = sessionOwner.get(a.sessionId) || primary();
    sendTo(a.owner, 'agent:new', {
      agentId: a.agentId, sessionId: a.sessionId, project: a.project,
      agentType: meta?.agentType || 'agent', description: meta?.description || a.agentId,
      spawnDepth: meta?.spawnDepth || 1,
    });
  }
  if (st.size === a.lastSize) return;
  a.lastSize = st.size;
  if (st.size < a.offset) a.offset = 0;
  const fd = fs.openSync(a.file, 'r');
  try {
    const len = st.size - a.offset;
    if (len <= 0) return;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, a.offset);
    a.offset = st.size;
    const text = a.partial + buf.toString('utf8');
    const lines = text.split('\n');
    a.partial = lines.pop();
    const entries = [];
    for (const l of lines) {
      if (!l.trim()) continue;
      try { entries.push(JSON.parse(l)); } catch {}
    }
    if (entries.length) sendTo(a.owner, 'agent:entries', { agentId: a.agentId, entries: entries.map(slimEntry).filter(Boolean) });
  } finally { fs.closeSync(fd); }
}

// Strip transcript lines down to what the renderer draws.
function slimEntry(o) {
  if (o.type !== 'user' && o.type !== 'assistant') return null;
  const c = o.message?.content;
  const blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
  return {
    role: o.type,
    stop: o.message?.stop_reason || null,
    blocks: blocks.map(b => {
      if (b.type === 'text') return { type: 'text', text: b.text };
      if (b.type === 'thinking') return b.thinking ? { type: 'thinking', text: b.thinking } : null;
      if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
      if (b.type === 'tool_result') {
        const t = typeof b.content === 'string' ? b.content
          : Array.isArray(b.content) ? b.content.map(x => x.text || (x.type === 'image' ? '[image]' : '')).join('\n') : '';
        return { type: 'tool_result', id: b.tool_use_id, text: t.slice(0, 4000), isError: !!b.is_error };
      }
      return null;
    }).filter(Boolean),
  };
}

function scanAll() {
  let projects;
  try { projects = fs.readdirSync(PROJECTS_DIR); } catch { return; }
  for (const p of projects) {
    const pdir = path.join(PROJECTS_DIR, p);
    let sessions;
    try { sessions = fs.readdirSync(pdir, { withFileTypes: true }); } catch { continue; }
    for (const s of sessions) {
      if (!s.isDirectory()) continue;
      const sub = path.join(pdir, s.name, 'subagents');
      let files;
      try { files = fs.readdirSync(sub); } catch { continue; }
      for (const f of files) considerAgentFile(path.join(sub, f));
    }
  }
}

function startWatcher() {
  scanAll();
  try {
    fs.watch(PROJECTS_DIR, { recursive: true }, (_ev, rel) => {
      if (!rel || !rel.includes('subagents')) return;
      const full = path.join(PROJECTS_DIR, rel);
      if (full.endsWith('.jsonl')) {
        const id = path.basename(full).slice(6, -6);
        const a = agents.get(id);
        if (a) tailAgent(a); else considerAgentFile(full);
      }
    });
  } catch (e) { console.error('watch failed, polling only', e); }
  // fs.watch can coalesce or miss appends on Windows; poll as a backstop.
  setInterval(() => { for (const a of agents.values()) tailAgent(a); }, 400);
  setInterval(scanAll, 3000);
}

// --------------------------------------------------------------------- app

// ---------------------------------------------------------------- session
// What each window has open, so its tiles come back after an update (or on every start, in
// Settings). Each renderer sends its own snapshot whenever its tiles or layout change.

const SESSION_PATH = path.join(app.getPath('userData'), 'session.json');
let session = { restoreNext: false };
try { session = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8')); } catch {}
const snapshots = new Map(); // webContents id -> snapshot, in window order
const restoreFor = new Map(); // webContents id -> snapshot that window starts with
const toRestore = config.restoreSession !== 'never' && (session.restoreNext || config.restoreSession === 'always')
  ? (session.windows || []).filter(s => s?.tiles?.length) : [];
let quitting = false;
let sessionT = null;
function writeSession() {
  clearTimeout(sessionT); sessionT = null;
  // Nothing saved yet this run: keep what's on disk for the next start.
  if (snapshots.size) session.windows = [...snapshots.values()];
  try { fs.writeFileSync(SESSION_PATH, JSON.stringify(session)); } catch (e) { console.error('session save failed', e); }
}
ipcMain.on('session:save', (e, snap) => {
  snapshots.set(e.sender.id, snap);
  sessionT ??= setTimeout(writeSession, 500);
});
ipcMain.handle('session:take', e => { const s = restoreFor.get(e.sender.id) || null; restoreFor.delete(e.sender.id); return s; });
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => { if (sessionT) writeSession(); });

let started = false;
function createWindow(startDir = null, restore = null) {
  // A new window opens a little down and right of the one you're in.
  const from = primary();
  const b = from && !from.isMaximized() ? from.getBounds() : null;
  const w = new BrowserWindow({
    width: b?.width || 1600, height: b?.height || 950, minWidth: 700, minHeight: 450,
    ...(b ? { x: b.x + 32, y: b.y + 32 } : {}),
    frame: false,
    backgroundColor: (THEMES[config.theme] || THEMES.obsidian).bg,
    title: 'Operant',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  const wcId = w.webContents.id;
  // Run from source the process is electron.exe, whose icon the taskbar would show; point it at Operant's.
  if (process.platform === 'win32' && !app.isPackaged) {
    w.setAppDetails({ appId: 'com.doolecg.operant', appIconPath: path.join(__dirname, 'build', 'icon.ico'), appIconIndex: 0, relaunchDisplayName: 'Operant' });
  }
  windows.add(w);
  lastFocused = w;
  if (startDir) startDirs.set(wcId, startDir);
  if (restore) restoreFor.set(wcId, restore);
  w.on('focus', () => { lastFocused = w; });
  w.on('close', e => {
    if (w.closeConfirmed || !running(w).length || !config.confirmClose) return;
    e.preventDefault();
    quitting = false; // a quit waits for the answer, and Cancel ends it
    confirmClose([w]).then(ok => { if (ok) w.close(); });
  });
  w.on('closed', () => {
    windows.delete(w);
    startDirs.delete(wcId);
    restoreFor.delete(wcId);
    // Closing one of several windows forgets its tiles; quitting, or closing the last, keeps them.
    if (!quitting && windows.size) { snapshots.delete(wcId); sessionT ??= setTimeout(writeSession, 500); }
    if (lastFocused === w) lastFocused = null;
    // Its terminals go with it.
    for (const [id, p] of ptys) if (p.owner === w) { try { p.kill(); } catch {} ptys.delete(id); }
    unwatchFile(w);
  });
  w.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  w.webContents.once('did-finish-load', () => {
    if (started) return;
    started = true;
    startWatcher();
    if (config.autoUpdate) updater.start();
    if (config.mediaControls) media.start();
    if (config.tokenUsage) usage.start();
    pollLimits();
  });
  return w;
}

// Closing a window ends its terminals, so it asks first while any are still running.
// "Don't ask again" turns off confirmClose, which Settings › Tiles & subagents turns back on.
const running = w => [...ptys.values()].filter(p => p.owner === w);
let asking = null;
function confirmClose(wins, { update = false } = {}) {
  const list = wins.flatMap(running);
  if (!list.length || !config.confirmClose) { wins.forEach(w => { w.closeConfirmed = true; }); return Promise.resolve(true); }
  if (asking) return asking.then(() => false);
  const counts = new Map();
  for (const p of list) counts.set(p.label, (counts.get(p.label) || 0) + 1);
  const what = [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ');
  const owner = wins.find(alive);
  if (owner) bringUp(owner);
  const opts = {
    type: 'warning', title: 'Operant',
    message: list.length === 1 ? '1 terminal is still running' : `${list.length} terminals are still running`,
    detail: `${what}\n\n` + (update && config.restoreSession !== 'never'
      ? `Updating closes ${list.length === 1 ? 'it. It reopens' : 'them. They reopen'} after the update, and Claude Code conversations pick up where they left off.`
      : `Closing ends ${list.length === 1 ? 'it' : 'them'}.`),
    buttons: [update ? 'Update' : 'Close', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
    checkboxLabel: "Don't ask again",
  };
  asking = (owner ? dialog.showMessageBox(owner, opts) : dialog.showMessageBox(opts)).then(({ response, checkboxChecked }) => {
    asking = null;
    if (response !== 0) return false;
    if (checkboxChecked) {
      user.confirmClose = false; saveUser(); config.confirmClose = false;
      broadcast('config:changed', config);
    }
    wins.forEach(w => { w.closeConfirmed = true; });
    return true;
  });
  return asking;
}

// Right-click the taskbar icon for another window.
function setJumpList() {
  if (process.platform !== 'win32' || !installed) return;
  app.setUserTasks([{ program: process.execPath, arguments: '--new-window', iconPath: process.execPath, iconIndex: 0,
    title: 'New window', description: 'Open another Operant window' }]);
}

// Launching Operant again opens another window in this one process. A folder from Explorer's
// "Open in Operant" becomes a tile in the window you used last, or a new window (Settings).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const link = focusLink(argv);
    if (link) return focusTile(link.wcId, link.tileId);
    const dir = folderArg(argv);
    const target = primary();
    if (dir && target && config.explorerOpensIn === 'tile') { bringUp(target); sendTo(target, 'open-folder', dir); }
    else createWindow(dir);
  });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    editorCommand(); // warms the PATH and editor lookups before the first tile needs them
    createWindow(folderArg(process.argv), toRestore[0]);
    for (const s of toRestore.slice(1)) createWindow(null, s);
    // Restore once after an update; the next start is a normal one.
    if (session.restoreNext) { session.restoreNext = false; writeSession(); }
    setJumpList();
    if (installed) {
      if (config.explorerContextMenu) shellIntegration.register(process.execPath);
      else shellIntegration.unregister();
    }
  });
}
app.on('window-all-closed', () => {
  for (const p of ptys.values()) { try { p.kill(); } catch {} }
  app.quit();
});
