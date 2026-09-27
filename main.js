// Operant: main process.
// Owns the pseudo-terminals (AI agent CLIs / shell sessions) and watches Claude Code's
// transcript folders so every Claude subagent that starts gets its own tile.

const { app, BrowserWindow, Menu, ipcMain, dialog, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const pty = require('@lydell/node-pty');
const { createUpdater } = require('./updater');
const { createMedia } = require('./media');
const shellIntegration = require('./shell-integration');
const { THEMES } = require('./renderer/themes');

// Dev runs can use their own profile (config + single-instance lock) beside an installed copy.
if (process.env.OPERANT_USER_DATA) app.setPath('userData', process.env.OPERANT_USER_DATA);
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
  mediaControls: true,            // what Windows is playing, with its buttons, in the top bar
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
ipcMain.handle('config:set', (_e, patch) => {
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_CONFIG)) continue;
    if (v === null) delete user[k]; else user[k] = v;
  }
  saveUser();
  Object.assign(config, merged());
  if ('explorerContextMenu' in patch && app.isPackaged) {
    if (config.explorerContextMenu) shellIntegration.register(process.execPath); else shellIntegration.unregister();
  }
  if ('mediaControls' in patch) { if (config.mediaControls) media.start(); else media.stop(); }
  return config;
});
ipcMain.handle('config:defaults', () => DEFAULT_CONFIG);
let win = null;
const send = (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data); };

// ---------------------------------------------------------------- terminals

const ptys = new Map(); // id -> pty

ipcMain.handle('config', () => config);

// A folder passed on the command line (e.g. from the Explorer right-click entry).
function folderArg(argv) {
  const args = argv.slice(app.isPackaged ? 1 : 2).filter(a => !a.startsWith('-'));
  for (const a of args) {
    const dir = a.replace(/"/g, '');
    try { if (fs.statSync(dir).isDirectory()) return path.resolve(dir); } catch {}
  }
  return null;
}
const startupFolder = folderArg(process.argv);
ipcMain.handle('startup-folder', () => startupFolder);

// The PATH Windows would give a freshly started program: machine + user entries from the
// registry. Our own process.env.PATH can be stale (Operant was started before an agent CLI was
// installed, or by a parent with an old environment), so tiles couldn't find the command.
function registryPath() {
  const read = key => {
    const r = spawnSync('reg.exe', ['query', key, '/v', 'Path'], { encoding: 'utf8', windowsHide: true });
    const m = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/mi.exec(r.stdout || '');
    return m ? m[1].trim().replace(/%([^%]+)%/g, (s, v) => process.env[v] ?? s) : '';
  };
  return [read('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'), read('HKCU\\Environment')]
    .filter(Boolean).join(';');
}

function withFreshPath(env) {
  if (process.platform !== 'win32') return env;
  const key = Object.keys(env).find(k => k.toUpperCase() === 'PATH') || 'Path';
  const seen = new Set();
  env[key] = [...(env[key] || '').split(';'), ...registryPath().split(';')]
    .filter(p => p && !seen.has(p.toLowerCase()) && seen.add(p.toLowerCase()))
    .join(';');
  return env;
}

const findAgent = id => config.agents.find(a => a.id === id) || config.agents.find(a => a.id === config.defaultAgent) || config.agents[0];
// Claude Code gets its own --session-id, which is how its subagents find their parent tile.
const isClaude = agent => /(^|[\\/])claude(\.(exe|cmd|ps1))?$/i.test(String(agent.command).trim());

ipcMain.handle('pty:create', (_e, { kind, agentId, cwd, cols, rows }) => {
  const id = crypto.randomUUID();
  const agent = kind === 'ai' ? findAgent(agentId) : null;
  const sessionId = agent && isClaude(agent) ? crypto.randomUUID() : null;
  const dir = cwd && fs.existsSync(cwd) ? cwd : config.defaultCwd;

  // Run the agent through the shell (PATH lookup, .cmd shims). The tile closes when it
  // exits cleanly; on failure it waits so the error stays readable.
  let command = config.shell;
  let args = ['-NoLogo'];
  if (agent) {
    const q = a => `'${String(a).replace(/'/g, "''")}'`;
    const quoted = [...[].concat(agent.args || []), ...(sessionId ? ['--session-id', sessionId] : [])].map(q).join(' ');
    // A command that isn't installed gets a plain explanation instead of PowerShell's error.
    const missing = `${agent.name}: '${agent.command}' isn't installed or isn't on your PATH.`
      + (agent.install ? ` Install it with: ${agent.install}` : ' Set its command in Settings > Agents.');
    const exe = String(agent.command).trim().split(/\s+/)[0];
    args = ['-NoLogo', '-Command', [
      `if (-not (Get-Command ${q(exe)} -ErrorAction SilentlyContinue)) { Write-Host ${q(missing)} -ForegroundColor Yellow; Read-Host 'Press Enter to close'; exit }`,
      `& ${agent.command} ${quoted}; if (-not $?) { Read-Host ${q(`${agent.name} exited with an error, press Enter to close`)} }`,
    ].join('; ')];
  }

  // If Operant was itself started from inside a Claude session, don't let the
  // child claude think it's nested: that turns off transcript saving, which the
  // subagent tiles depend on.
  const env = withFreshPath({ ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' });
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
  ptys.set(id, p);
  p.onData(data => send('pty:data', { id, data }));
  p.onExit(({ exitCode }) => { ptys.delete(id); send('pty:exit', { id, exitCode }); });
  return { id, sessionId, cwd: dir, agent };
});

ipcMain.on('pty:write', (_e, { id, data }) => ptys.get(id)?.write(data));
ipcMain.on('pty:resize', (_e, { id, cols, rows }) => {
  try { if (cols > 1 && rows > 1) ptys.get(id)?.resize(cols, rows); } catch {}
});
ipcMain.on('pty:kill', (_e, { id }) => { try { ptys.get(id)?.kill(); } catch {} ptys.delete(id); });

ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: config.defaultCwd });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.on('open-config', () => {
  if (!fs.existsSync(CONFIG_PATH)) saveUser();
  shell.openPath(CONFIG_PATH);
});
ipcMain.on('win:minimize', () => win?.minimize());
ipcMain.on('win:maximize', () => (win?.isMaximized() ? win.unmaximize() : win?.maximize()));
ipcMain.on('win:close', () => win?.close());
ipcMain.on('devtools', () => win?.webContents.toggleDevTools());

// The renderer decides when to notify (it knows which tile is focused); clicking brings that tile up.
ipcMain.on('notify', (_e, { title, body, tileId }) => {
  if (!config.notifications || !Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: path.join(__dirname, 'build', 'icon.png') });
  n.on('click', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show(); win.focus();
    send('focus-tile', tileId);
  });
  n.show();
});
ipcMain.handle('win:focused', () => !!win && win.isFocused() && !win.isMinimized());

// ------------------------------------------------------------------ updates

const updater = createUpdater({ send });
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.on('update:check', () => updater.check());
ipcMain.on('update:install', () => { if (updater.install()) app.quit(); });

// -------------------------------------------------------------------- media

const media = createMedia({ send });
ipcMain.handle('media:state', () => media.state());
ipcMain.on('media:command', (_e, cmd) => media.command(String(cmd)));

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
    send('agent:new', {
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
    if (entries.length) send('agent:entries', { agentId: a.agentId, entries: entries.map(slimEntry).filter(Boolean) });
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

function createWindow() {
  win = new BrowserWindow({
    width: 1600, height: 950, minWidth: 700, minHeight: 450,
    frame: false,
    backgroundColor: (THEMES[config.theme] || THEMES.obsidian).bg,
    title: 'Operant',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.once('did-finish-load', () => {
    startWatcher();
    if (config.autoUpdate) updater.start();
    if (config.mediaControls) media.start();
  });
}

// One window: launching again (say from Explorer) opens an agent tile in the running one.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    const dir = folderArg(argv);
    if (dir) send('open-folder', dir);
  });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    createWindow();
    if (app.isPackaged) {
      if (config.explorerContextMenu) shellIntegration.register(process.execPath);
      else shellIntegration.unregister();
    }
  });
}
app.on('window-all-closed', () => {
  for (const p of ptys.values()) { try { p.kill(); } catch {} }
  app.quit();
});
