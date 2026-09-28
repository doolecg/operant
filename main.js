// Operant: main process.
// Owns the pseudo-terminals (AI agent CLIs / shell sessions) and watches Claude Code's
// transcript folders so every Claude subagent that starts gets its own tile.

const { app, BrowserWindow, Menu, ipcMain, dialog, shell, Notification, clipboard, crashReporter } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const { spawn, execFile } = require('child_process');
const pty = require('@lydell/node-pty');
const { createUpdater } = require('./updater');
const { createMedia } = require('./media');
const { createUsage } = require('./usage');
const { createOpenCode, isOpenCode } = require('./opencode');
const { createCodex, createGemini } = require('./otherAgents');
const shellIntegration = require('./shell-integration');
const { THEMES } = require('./renderer/themes');
const opencodeTheme = require('./opencode-theme');
const agentBrief = require('./agent-brief');
const agentSetup = require('./agent-setup');

// Dev runs can use their own profile (config + single-instance lock) beside an installed copy.
if (process.env.OPERANT_USER_DATA) app.setPath('userData', process.env.OPERANT_USER_DATA);
// A test build (npm run pack) run with its own profile is packaged but must not take over the installed
// app's Explorer entry, operant:// links or jump list.
const installed = app.isPackaged && !process.env.OPERANT_USER_DATA;
// Windows only shows toast notifications for an app with an AppUserModelID (the installer's shortcut carries the same one).
app.setAppUserModelId('com.doolecg.operant');

// ------------------------------------------------------------ crash + error logging
// Local-only minidumps (never uploaded) plus a plain-text log, so a native crash (Chromium/V8
// fast-fail, OOM abort) leaves a trace instead of just vanishing.
app.setPath('crashDumps', path.join(app.getPath('userData'), 'Crash Reports'));
try { crashReporter.start({ uploadToServer: false, compress: true }); } catch {}
// Keep only the 10 newest dumps.
try {
  const dir = app.getPath('crashDumps');
  const files = fs.readdirSync(dir).map(n => { const p = path.join(dir, n); return { p, t: fs.statSync(p).mtimeMs }; })
    .sort((a, b) => b.t - a.t);
  for (const f of files.slice(10)) fs.rmSync(f.p, { recursive: true, force: true });
} catch {}

const LOG_PATH = path.join(app.getPath('userData'), 'operant.log');
function logLine(msg) {
  try {
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] Operant ${app.getVersion()} ${msg}\n`);
    const st = fs.statSync(LOG_PATH);
    if (st.size > 1 << 20) { // cap ~1MB: keep the newer half
      const buf = fs.readFileSync(LOG_PATH);
      fs.writeFileSync(LOG_PATH, buf.subarray(buf.length >> 1));
    }
  } catch {}
}
app.on('child-process-gone', (_e, d) => logLine(`child-process-gone type=${d.type} reason=${d.reason} exitCode=${d.exitCode} serviceName=${d.serviceName || ''} name=${d.name || ''}`));
process.on('uncaughtException', err => logLine(`uncaughtException ${err?.stack || err}`));
process.on('unhandledRejection', err => logLine(`unhandledRejection ${err?.stack || err}`));

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
// Lives in %APPDATA%/Operant so it survives updates (the install dir is replaced).
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
// The file OpenCode's per-process `instructions` config points at (item 43); Claude Code gets the
// same text inline via --append-system-prompt.
const BRIEF_PATH = agentBrief.briefPath(app.getPath('userData'));
// Item 37: the optional PreToolUse hook that reroutes long-running commands (test/build/install)
// through `operant test`/`operant build`/`operant run`+`wait` instead of the agent's own shell.
// Off by default; wired into Claude Code's args via --settings when config.longCommandHook is on
// (see below, next to the --append-system-prompt brief). Written unconditionally at startup, like
// the brief file, so turning the setting on doesn't need a restart.
const HOOK_CMD_PATH = path.join(__dirname, 'hooks', 'long-commands.cmd').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const HOOK_SETTINGS_PATH = path.join(app.getPath('userData'), 'hook-settings.json');
// Same setting, for OpenCode: a plugin (tool.execute.before) rather than a --settings hook, wired up
// below next to OPENCODE_CONFIG_CONTENT.
const OC_HOOK_PATH = path.join(__dirname, 'hooks', 'opencode-long-commands.mjs').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
function writeHookSettings() {
  try {
    const content = JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `"${HOOK_CMD_PATH}"` }] }] },
    });
    let existing = null;
    try { existing = fs.readFileSync(HOOK_SETTINGS_PATH, 'utf8'); } catch {}
    if (existing !== content) fs.writeFileSync(HOOK_SETTINGS_PATH, content);
  } catch (e) { console.error('hook settings write failed', e.message); }
}
writeHookSettings();
// Where agent-setup.js keeps generated, per-process-only files (a mirrored skills folder, a
// --mcp-config file for Claude tiles) — never ~/.claude or ~/.config/opencode.
const AGENT_SETUP_DIR = path.join(app.getPath('userData'), 'agent-setup');

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
  stopAgent: ['Alt+Shift+X'], // interrupt the focused tile's agent (runaway guard); Windows keeps Alt+Esc
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
  showChanges: ['Alt+G'], // the changes tile (git) for the focused tile's project
  saveQuit: ['Alt+Shift+Q'], // save every editor tile, snapshot the session, and quit
  openBrowser: [], // browser tile
  notifications: ['Alt+I'], // the notification panel
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
  installSkill: true,             // teach Claude Code & OpenCode the `operant` command via a skill file (Settings > Agents)
  briefAgents: true,              // give every agent tile Operant's rules from its first message, not just when it loads the skill (Settings > Agents)
  longCommandHook: false,         // Claude Code hook: reroute long commands (test/build/install) through operant run/wait automatically (Settings > Agents)
  shareSetup: true,               // share your main agent's setup (rules, MCP servers, skills) with every agent you launch, per process (Settings > Agents)
  opencodeTheme: true,            // OpenCode tiles use Operant's current theme/accent (Settings > Agents)
  autoCompact: 80,                // percent of an agent tile's context that triggers automatic /compact (Settings > Agents) · 0 = off
  masterOnStartup: true,          // open a "master" agent terminal when Operant starts
  defaultLayout: 'master',        // 'master' (big left pane + stack) or 'dwindle'
  masterRatio: 0.55,
  // Idle reaping (0 disables each). The focused tile and the master terminal are never reaped.
  autoCloseDoneAgentsSeconds: 15, // finished agent tiles, counted from when you first see them
  idleCloseTerminalMinutes: 10,   // Claude/shell tiles with no output and no typing
  maxTilesPerWorkspace: 6,        // new agents spill onto the next workspace past this
  moveFollowsTile: true,          // Alt+Shift+1-9 takes you with the tile to its new workspace
  confirmClose: true,             // ask before closing a window that still has terminals running
  restoreSession: 'update',       // reopen the tiles you had open: 'update' (after an update) | 'always' | 'never'
  updateWhenIdle: true,           // clicking Update while an agent is working waits until it finishes
  saveQuitWaits: true,            // Save and quit asks working agents to save a progress note and stop first; Force quit skips it
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
  copyOnSelect: true,              // selecting text in a terminal, viewer or diff copies it, with a short toast
  gpuTerminals: true,             // terminals drawn with WebGL; off (or no WebGL) uses the normal renderer
  hardwareAcceleration: true,     // the GPU for the whole window; applies after a restart
  theme: 'obsidian',              // see renderer/themes.js
  accent: '',                     // '' = the theme's own; otherwise a hex color
  wallpaper: 'glow-dots',         // 'glow-dots' | 'glow' | 'plain'
  borderAnimation: 'active',      // 'active' (focused + running agents) | 'focused' | 'off'
  borderAnimationSeconds: 8,
  animations: 'normal',           // 'normal' | 'fast' | 'off'
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
  mediaSize: 'compact',           // 'compact' | 'full'
  tokenUsage: true,               // Claude Code's tokens today in the top bar; click for the graph
  contextBadge: true,             // show context size in the agent tile info bar (needs tileTokens on)
  tileTokens: true,               // the info bar under each agent tile: model, context, tokens since it opened, folder, branch
  usageSeries: ['input', 'output', 'cacheWrite'], // what the pill and graph count; cache reads would swamp the rest
  planLimits: true,               // Claude plan limits (5-hour session, week) in the token pill's tooltip
  planLimitAlerts: true,          // a notification at 80% and 95% of the 5-hour session, and its ring on the pill
  tokenBudget: 0,                // counted tokens a day; the pill turns orange near it and red past it · 0 = off
  clockFormat: 'auto',            // the bar's clock: 'auto' (from Windows) | '24' | '12'
  clockSeconds: false,
  clockDate: true,
  barTitle: false,                // the focused tile's title beside the clock
  gitButton: true,                // the Git tile in the gear's quick menu: the focused project's branch and changes · click to see and commit
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
  // Runaway guard: flags a tile whose agent may be stuck.
  runawayGuard: 'warn',           // 'warn' (badge + notification) | 'stop' (also interrupts) | 'off'
  runawayLoopRepeats: 5,          // same tool + same input this many times in a tile's last 20 tool calls
  runawayTokens: 3000000,         // tokens (in+out+cache) one tile's session used in 10 minutes · 0 = off
  runawayMinutes: 60,             // busy without a break this long (checked by the renderer) · 0 = off
  runawaySubagents: 10,           // subagents running at once for one tile · 0 = off
  keybinds: DEFAULT_KEYBINDS,
  // where links open: 'tile' (Operant's own browser tile) | 'default' (Windows' choice) | an installed browser id | 'custom'
  linkBrowser: 'tile',
  linkBrowserCommand: '',         // custom exe path, when linkBrowser is 'custom'
  // second browser (Shift+click a link, or a browser tile's ↗): 'auto' (Zen if installed, else Windows' choice) |
  // 'default' | an installed browser id | 'custom'
  secondBrowser: 'auto',
  secondBrowserCommand: '',       // custom exe path, when secondBrowser is 'custom'
};

// Only what the user changed is stored, so new defaults reach existing installs.
let user = {};
try { user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^﻿/, '')); } catch (e) {
  // Keep a config that doesn't parse, so the next save (which writes only what changed) can't lose it.
  if (e.code !== 'ENOENT') try { fs.copyFileSync(CONFIG_PATH, CONFIG_PATH.replace(/\.json$/, '.broken.json')); } catch {}
} // a BOM from Notepad or PowerShell would fail the parse
const merged = () => ({ ...DEFAULT_CONFIG, ...user, keybinds: { ...DEFAULT_KEYBINDS, ...(user.keybinds || {}) } });
const config = merged();
// Read before the app is ready, so it only changes on a restart.
if (!config.hardwareAcceleration) app.disableHardwareAcceleration();

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
  if ('installSkill' in patch) syncSkill();
  if ('theme' in patch || 'accent' in patch) opencodeTheme.writeTheme(config);
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
// Where a subagent with no known parent tile should land: the window with a master tile
// (preferring the last-focused one among those), else primary(). Uses the session snapshots
// each renderer keeps main.js updated with (see session:save below).
const agentWindow = () => {
  const withMaster = [...windows].filter(w => alive(w) && snapshots.get(w.webContents.id)?.tiles?.some(t => t.master));
  if (!withMaster.length) return primary();
  return (alive(lastFocused) && withMaster.includes(lastFocused) && lastFocused) || withMaster[0];
};
const winOf = e => BrowserWindow.fromWebContents(e.sender);
const sessionOwner = new Map(); // Claude --session-id -> window (also holds OpenCode's oc:<id> and Codex/Gemini's <kind>:<id>)
const sessionOpenTime = new Map(); // same keys -> when its tile opened (tile token counting starts here)
// Codex/Gemini CLI tiles waiting for their session file to be spotted by cwd (otherAgents.js), FIFO per kind.
let otherAgentPending = [];
// Windows only lets a background app take the foreground in some cases; briefly going
// always-on-top gets the window in front even when it doesn't.
// Test runs (OPERANT_BACKGROUND=1) open behind other windows and never take focus.
function bringUp(w) {
  if (!alive(w)) return;
  if (process.env.OPERANT_BACKGROUND) return;
  if (w.isMinimized()) w.restore();
  w.show();
  w.setAlwaysOnTop(true); w.focus(); w.setAlwaysOnTop(false);
}

// -------------------------------------------------------------- browser tile
// The <webview> guest gets no preload and no Node, its own session, and only http(s) navigation.
// Its keyboard doesn't reach the host page (before-input-event is main's only hook on it), so
// Alt/Ctrl combos that are Operant keybinds are forwarded to the host renderer to run instead.
const BROWSER_URL_RE = /^https?:\/\//i;
const GUEST_NORM = c => c.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Arrow/, '').replace(/^NumpadEnter$/, 'Enter');
function guestCombo(input) {
  return [...(input.control ? ['Ctrl'] : []), ...(input.alt ? ['Alt'] : []), ...(input.shift ? ['Shift'] : []), GUEST_NORM(input.code)].join('+');
}
function boundCombos() {
  const set = new Set();
  for (const combos of Object.values(config.keybinds || {})) for (const c of [].concat(combos)) if (c) set.add(c);
  for (let i = 1; i <= 9; i++) { set.add(`Alt+${i}`); set.add(`Alt+Shift+${i}`); }
  return set;
}
app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return;
  contents.on('will-navigate', (e, url) => { if (!BROWSER_URL_RE.test(url)) e.preventDefault(); });
  // target=_blank / window.open: navigate the same tile instead of opening a new Electron window.
  contents.setWindowOpenHandler(({ url }) => {
    if (BROWSER_URL_RE.test(url)) contents.loadURL(url);
    return { action: 'deny' };
  });
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || (!input.alt && !input.control)) return;
    const combo = guestCombo(input);
    if (!boundCombos().has(combo)) return;
    event.preventDefault();
    const host = contents.hostWebContents;
    if (host && !host.isDestroyed()) host.send('browser:key', combo);
  });
});

// ------------------------------------------------------------- skill install
// Teaches Claude Code / OpenCode the `operant` CLI command (bin/operant.cmd) via a skill file,
// so an agent running inside a tile knows it can drive Operant. Copied in, or removed, to match
// Settings > Agents > installSkill. Never throws: a failure here shouldn't break startup.

const SKILL_SRC = path.join(__dirname, 'skill', 'operant', 'SKILL.md').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const SKILL_TARGETS = [
  path.join(os.homedir(), '.claude', 'skills', 'operant', 'SKILL.md'),
  path.join(os.homedir(), '.config', 'opencode', 'skills', 'operant', 'SKILL.md'),
];
function isOperantSkillFile(content) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content || '');
  return !!m && /^name:\s*operant\s*$/m.test(m[1]);
}
function syncSkill() {
  try {
    if (!fs.existsSync(SKILL_SRC)) return; // not built yet (e.g. a fresh dev checkout)
    const content = fs.readFileSync(SKILL_SRC, 'utf8');
    for (const t of SKILL_TARGETS) {
      try {
        if (config.installSkill) {
          let cur = null;
          try { cur = fs.readFileSync(t, 'utf8'); } catch {}
          if (cur !== content) { fs.mkdirSync(path.dirname(t), { recursive: true }); fs.writeFileSync(t, content); }
        } else {
          let cur = null;
          try { cur = fs.readFileSync(t, 'utf8'); } catch {}
          if (cur != null && isOperantSkillFile(cur)) {
            fs.unlinkSync(t);
            const dir = path.dirname(t);
            try { if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch {}
          }
        }
      } catch (e) { console.error('skill sync failed', t, e); }
    }
  } catch (e) { console.error('skill sync failed', e); }
}

// -------------------------------------------------------------- control API
// An HTTP API (127.0.0.1, random port + token) that lets an agent running in a tile drive Operant
// through the `operant` CLI (bin/operant-cli.js), e.g. `operant view plan.md` or `operant wait <id>`.
// Commands Operant itself owns (ask/open/version) are answered here; everything else is forwarded
// to the window that owns the calling tile and answered by the renderer over IPC.

let controlPort = null, controlToken = null;
let controlReadyResolve;
const controlReady = new Promise(res => { controlReadyResolve = res; });
const pendingControl = new Map(); // reqId -> { owner, resolve, timer }

function ownerForTile(tile) {
  const p = [...ptys.values()].find(p => p.tileId != null && String(p.tileId) === String(tile));
  return (p && alive(p.owner) && p.owner) || primary();
}

function forwardControl(owner, cmd, args, tile, timeoutMs) {
  return new Promise(resolve => {
    if (!alive(owner)) return resolve({ ok: false, error: 'no Operant window is open' });
    const reqId = crypto.randomUUID();
    const timer = setTimeout(() => { pendingControl.delete(reqId); resolve({ ok: false, error: 'timed out' }); }, timeoutMs);
    pendingControl.set(reqId, { owner, resolve, timer });
    sendTo(owner, 'control', { reqId, cmd, args, tile });
  });
}
ipcMain.on('control:reply', (e, { reqId, ok, result, error, warn }) => {
  const pend = pendingControl.get(reqId);
  if (!pend) return;
  if (pend.owner !== winOf(e)) return; // only the window that was asked may answer
  clearTimeout(pend.timer);
  pendingControl.delete(reqId);
  pend.resolve({ ok, result, error, warn });
});

async function controlAsk(owner, args = {}) {
  if (!alive(owner)) owner = primary();
  if (!alive(owner)) return { ok: false, error: 'no Operant window is open' };
  bringUp(owner);
  const options = Array.isArray(args.options) && args.options.length ? args.options : ['Yes', 'No'];
  // cancelId -1: closing the dialog (Escape/X) resolves to answer: null, distinct from clicking a button.
  const r = await dialog.showMessageBox(owner, {
    type: 'question', title: 'Operant', message: String(args.question || ''), detail: args.detail,
    buttons: options, defaultId: 0, cancelId: -1, noLink: true,
  });
  return { ok: true, result: { answer: options[r.response] ?? null } };
}
async function controlOpen(args = {}, owner = null) {
  const target = String(args.target || '');
  if (/^https?:\/\//i.test(target)) {
    try { await openUrl(target, { owner }); return { ok: true, result: {} }; }
    catch (e) { return { ok: false, error: e.message }; }
  }
  const full = args.cwd && !path.isAbsolute(target) ? path.join(args.cwd, target) : target;
  const err = await shell.openPath(full);
  return err ? { ok: false, error: err } : { ok: true, result: {} };
}

function startControlServer() {
  controlToken = crypto.randomBytes(32).toString('hex');
  const server = http.createServer((req, res) => {
    const reply = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'POST' || req.url !== '/v1') return reply(404, { ok: false, error: 'not found' });
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${controlToken}`) return reply(401, { ok: false, error: 'unauthorized' });
    let body = '';
    let tooBig = false;
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1 << 20) { tooBig = true; reply(400, { ok: false, error: 'request too large' }); req.destroy(); }
    });
    req.on('end', async () => {
      if (tooBig) return;
      let data;
      try { data = JSON.parse(body || '{}'); } catch { return reply(400, { ok: false, error: 'invalid JSON' }); }
      const { cmd, args = {}, tile } = data || {};
      if (!cmd) return reply(400, { ok: false, error: 'missing cmd' });
      try {
        if (cmd === 'version') return reply(200, { ok: true, result: { version: app.getVersion() } });
        if (cmd === 'ask') { const r = await controlAsk(ownerForTile(tile), args); return reply(r.ok ? 200 : 400, r); }
        if (cmd === 'open') { const r = await controlOpen(args, ownerForTile(tile)); return reply(r.ok ? 200 : 400, r); }
        if (cmd === 'usage') {
          // The renderer knows the calling tile's own context size and project; main owns the Claude
          // plan limits and (item 39) computes the token breakdown from the transcripts on demand.
          const r = await forwardControl(ownerForTile(tile), cmd, args, tile, 20000);
          if (!r.ok) return reply(400, r);
          const extra = { limits: await fetchLimits() };
          if (args.breakdown) extra.breakdown = await usage.breakdown({ days: args.days === 7 ? 7 : 1, project: r.result.project || null });
          return reply(200, { ok: true, result: { ...r.result, ...extra }, warn: r.warn });
        }
        const owner = ownerForTile(tile);
        // plan: waits on the user, same as ask, so it gets an ask-length leash rather than the 20s default.
        const timeoutMs = cmd === 'wait' ? (Number(args.timeout) || 600) * 1000 + 5000 : cmd === 'plan' ? 7 * 24 * 3600 * 1000 : 20000;
        const r = await forwardControl(owner, cmd, args, tile, timeoutMs);
        return reply(r.ok ? 200 : 400, r);
      } catch (e) { return reply(400, { ok: false, error: e.message }); }
    });
    req.on('error', () => {});
  });
  server.listen(0, '127.0.0.1', () => { controlPort = server.address().port; controlReadyResolve(); });
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

// ------------------------------------------------------------------ links: which browser they open in

const KNOWN_BROWSERS = [
  { id: 'zen', name: 'Zen', exeName: 'zen.exe', paths: () => [path.join(process.env.ProgramFiles || '', 'Zen Browser', 'zen.exe')] },
  { id: 'firefox', name: 'Firefox', exeName: 'firefox.exe', paths: () => [
    path.join(process.env.ProgramFiles || '', 'Mozilla Firefox', 'firefox.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Mozilla Firefox', 'firefox.exe') ] },
  { id: 'chrome', name: 'Chrome', exeName: 'chrome.exe', paths: () => [
    path.join(process.env.ProgramFiles || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LocalAppData || '', 'Google', 'Chrome', 'Application', 'chrome.exe') ] },
  { id: 'edge', name: 'Edge', exeName: 'msedge.exe', paths: () => [
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe') ] },
  { id: 'brave', name: 'Brave', exeName: 'brave.exe', paths: () => [
    path.join(process.env.ProgramFiles || '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    path.join(process.env.LocalAppData || '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') ] },
  { id: 'vivaldi', name: 'Vivaldi', exeName: 'vivaldi.exe', paths: () => [
    path.join(process.env.LocalAppData || '', 'Vivaldi', 'Application', 'vivaldi.exe'),
    path.join(process.env.ProgramFiles || '', 'Vivaldi', 'Application', 'vivaldi.exe') ] },
  { id: 'opera', name: 'Opera', exeName: 'opera.exe', paths: () => [
    path.join(process.env.LocalAppData || '', 'Programs', 'Opera', 'launcher.exe') ] },
  { id: 'floorp', name: 'Floorp', exeName: 'floorp.exe', paths: () => [path.join(process.env.ProgramFiles || '', 'Floorp', 'floorp.exe')] },
  { id: 'librewolf', name: 'LibreWolf', exeName: 'librewolf.exe', paths: () => [path.join(process.env.ProgramFiles || '', 'LibreWolf', 'librewolf.exe')] },
];

// Detected once, then cached: static known install paths, plus the registry's list of browsers
// Windows itself offers ("Default apps" > web browser), for installs off the beaten path. Matched
// by the resolved exe's filename, not the registry key's name: Gecko-fork browsers (Zen, LibreWolf,
// Floorp) often register under a "Firefox-<hash>" key, so the key name alone would misidentify them.
let browserCache = null; // Promise<[{ id, name, exe }]>
function detectBrowsers() {
  if (browserCache) return browserCache;
  browserCache = (async () => {
    const found = new Map();
    for (const b of KNOWN_BROWSERS) {
      const exe = b.paths().find(p => p && fs.existsSync(p));
      if (exe) found.set(b.id, { id: b.id, name: b.name, exe });
    }
    for (const root of ['HKLM', 'HKCU']) {
      const base = `${root}\\SOFTWARE\\Clients\\StartMenuInternet`;
      const list = await run('reg.exe', ['query', base]);
      const keys = [...list.stdout.matchAll(/^(HK\w+\\.*)$/gm)].map(m => m[1].trim()).filter(k => k.toLowerCase() !== base.toLowerCase());
      for (const key of keys) {
        const cmd = await run('reg.exe', ['query', `${key}\\shell\\open\\command`, '/ve']);
        const m = /^\s*\(Default\)\s+REG_SZ\s+(.*)$/mi.exec(cmd.stdout);
        if (!m) continue;
        const exe = m[1].trim().replace(/^"/, '').split('"')[0];
        const known = KNOWN_BROWSERS.find(b => b.exeName === path.basename(exe).toLowerCase());
        if (known && !found.has(known.id) && fs.existsSync(exe)) found.set(known.id, { id: known.id, name: known.name, exe });
      }
    }
    return [...found.values()];
  })();
  return browserCache;
}
ipcMain.handle('browsers:list', async () => (await detectBrowsers()).map(({ id, name }) => ({ id, name })));

// Where a link goes: 'tile' opens Operant's own browser tile (in the asking window, or the
// primary one); 'default' is shell.openExternal (Windows' own choice); otherwise it's a detected
// browser id, or 'custom' (linkBrowserCommand/secondBrowserCommand). `second` picks secondBrowser
// instead of linkBrowser (Shift+click, a browser tile's "open in system browser"). Never spawns
// through a shell, so the URL can't inject arguments; only http(s)/file URLs go anywhere.
async function openUrl(url, { second = false, owner = null } = {}) {
  if (!/^(https?|file):\/\//i.test(String(url))) return;
  let choice = second ? config.secondBrowser : config.linkBrowser;
  if (choice === 'auto') { // secondBrowser's default: Zen if installed, else Windows' choice
    const browsers = await detectBrowsers();
    choice = browsers.some(b => b.id === 'zen') ? 'zen' : 'default';
  }
  if (choice === 'tile' && !second) {
    const w = alive(owner) ? owner : primary();
    if (w) return void sendTo(w, 'browse', url);
    choice = 'default'; // no window to host a tile in
  }
  if (choice === 'default') return shell.openExternal(url);
  const exe = choice === 'custom' ? (second ? config.secondBrowserCommand : config.linkBrowserCommand)
    : (await detectBrowsers()).find(b => b.id === choice)?.exe;
  if (!exe || !fs.existsSync(exe)) return shell.openExternal(url);
  try { spawn(exe, [url], { detached: true, windowsHide: false, stdio: 'ignore' }).unref(); }
  catch { shell.openExternal(url); }
}

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

ipcMain.handle('pty:create', async (e, { kind, agentId, cwd, cols, rows, run, resume, edit, tileId, prompt }) => {
  await controlReady;
  const id = crypto.randomUUID();
  const agent = kind === 'ai' ? findAgent(agentId) : null;
  const exeBase = agent ? path.basename(String(agent.command).trim().split(/\s+/)[0]).replace(/\.(exe|cmd|ps1)$/i, '').toLowerCase() : null;
  const resuming = !!(agent && isClaude(agent) && /^[0-9a-f-]{36}$/i.test(resume || '') && hasTranscript(resume));
  const sessionId = agent && isClaude(agent) ? (resuming ? resume : crypto.randomUUID()) : null;
  // Codex and Gemini CLI don't take an explicit session id from Operant, so a made-up one (like
  // OpenCode's oc:<id>) is registered up front and matched to their own session file by cwd, once
  // that file's token reader (otherAgents.js) sees it (see the otherAgentPending queue below).
  const otherKind = !sessionId && !isOpenCode(agent || {}) && (exeBase === 'codex' || exeBase === 'gemini') ? exeBase : null;
  const otherId = otherKind ? `${otherKind}:${id}` : null;
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
  let ocPort = null;
  const isOc = agent && isOpenCode(agent);
  if (isOc) { try { ocPort = await opencode.freePort(); } catch {} }
  if (agent) {
    // PowerShell single-quoted string: '' escapes a literal quote, and newlines pass through as-is.
    const q = a => `'${String(a).replace(/'/g, "''")}'`;
    const extra = String(proj.args || '').trim().split(/\s+/).filter(Boolean);
    // Claude Code and Codex take the prompt positionally, OpenCode as --prompt, Gemini as -i;
    // anything else (a custom agent) also gets it positional, appended after the other args.
    const promptArgs = !prompt ? [] : isOpenCode(agent) ? ['--prompt', prompt] : exeBase === 'gemini' ? ['-i', prompt] : [prompt];
    // Item 43: Claude Code gets the brief on every launch, including resumed/reopened tiles —
    // --append-system-prompt combines fine with --resume/--session-id. OpenCode gets it through its
    // own env below; Codex and Gemini CLI have no equivalent flag, so they're skipped.
    // With another agent as main, the main agent's own rules file rides along (Settings > Agents > Share).
    const rules = config.shareSetup ? agentBrief.mainRulesText(config.defaultAgent, 'claude') : '';
    const briefText = [config.briefAgents && agentBrief.BRIEF, rules].filter(Boolean).join('\n\n');
    const briefArgs = briefText && isClaude(agent) ? ['--append-system-prompt', briefText] : [];
    // Item 37: same idea as the brief above, but as a --settings file so Claude Code's own
    // PreToolUse hook mechanism does the rewriting (never touches the user's own settings.json).
    const hookArgs = config.longCommandHook && isClaude(agent) ? ['--settings', HOOK_SETTINGS_PATH] : [];
    // When the main agent (Settings > Agents) is OpenCode, a Claude tile gets its MCP servers too.
    const setupArgs = agentSetup.claudeExtraArgs({ agent, config, cwd: dir, userDataDir: AGENT_SETUP_DIR });
    const quoted = [...[].concat(agent.args || []), ...extra, ...briefArgs, ...hookArgs, ...setupArgs, ...(sessionId ? [resuming ? '--resume' : '--session-id', sessionId] : []), ...(ocPort ? ['--port', String(ocPort)] : []), ...promptArgs].map(q).join(' ');
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
  const envBase = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  // Every tile gets the control API in its env, and Operant's bin folder on PATH so `operant`
  // is found. Spread from process.env above, so this also overwrites any of these vars Operant
  // itself inherited (it may be running inside another Operant tile).
  const binDir = path.join(__dirname, 'bin').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  const pathKey = Object.keys(envBase).find(k => k.toUpperCase() === 'PATH') || 'Path';
  envBase[pathKey] = binDir + path.delimiter + (envBase[pathKey] || '');
  Object.assign(envBase, {
    OPERANT: '1',
    OPERANT_API: `http://127.0.0.1:${controlPort}`,
    OPERANT_TOKEN: controlToken,
    OPERANT_TILE: String(tileId ?? ''),
    OPERANT_EXE: process.execPath,
  });
  // Selects the operant.json theme (renderer/themes.js) for just this OpenCode process, without
  // touching the user's own ~/.config/opencode/tui.json.
  if (isOc && config.opencodeTheme) envBase.OPENCODE_TUI_CONFIG = opencodeTheme.TUI_CONFIG_PATH;
  // Item 43: the brief as an `instructions` file, through OpenCode's own per-process config env var
  // (merged with the user's real opencode.json/opencode.jsonc, never replacing it). Item 37: the same
  // env var also carries the long-command reroute plugin when that setting is on, merged into the
  // same object rather than a second env var.
  if (isOc && (config.briefAgents || config.longCommandHook || config.shareSetup)) {
    envBase.OPENCODE_CONFIG_CONTENT = agentBrief.opencodeConfigContent(config.briefAgents ? BRIEF_PATH : null, {
      mainAgent: config.shareSetup ? config.defaultAgent : null,
      pluginPath: config.longCommandHook ? OC_HOOK_PATH : null,
    });
  }
  // Folds the main agent's MCP servers, plugin skills and CodeGraph hook into whatever
  // OPENCODE_CONFIG_CONTENT already carries (brief instructions, rules, other plugin entries),
  // rather than replacing it. Per process only — never touches ~/.config/opencode.
  if (isOc && config.shareSetup) {
    envBase.OPENCODE_CONFIG_CONTENT = agentSetup.buildOpencodeConfigContent({
      base: envBase.OPENCODE_CONFIG_CONTENT, cwd: dir, userDataDir: AGENT_SETUP_DIR, config,
    });
  }
  const env = await withFreshPath(envBase);
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
  p.tileId = tileId;
  p.label = agent ? agent.name : 'Shell';
  ptys.set(id, p);
  if (sessionId) { sessionOwner.set(sessionId, owner); sessionOpenTime.set(sessionId, Date.now()); }
  if (ocPort) opencode.watch(id, ocPort, owner);
  if (otherId) {
    sessionOwner.set(otherId, owner); sessionOpenTime.set(otherId, Date.now());
    otherAgentPending.push({ kind: otherKind, otherId, owner, cwd: dir, at: Date.now() });
  }
  p.onData(data => sendTo(owner, 'pty:data', { id, data }));
  p.onExit(({ exitCode }) => {
    ptys.delete(id); opencode.unwatch(id); sendTo(owner, 'pty:exit', { id, exitCode });
    if (otherId) { otherAgentPending = otherAgentPending.filter(x => x.otherId !== otherId); sessionOwner.delete(otherId); sessionOpenTime.delete(otherId); }
  });
  return { id, sessionId: ocPort ? `oc:${id}` : otherId || sessionId, cwd: dir, agent };
});

ipcMain.on('pty:write', (_e, { id, data }) => ptys.get(id)?.write(data));
ipcMain.on('pty:resize', (_e, { id, cols, rows }) => {
  try { if (cols > 1 && rows > 1) ptys.get(id)?.resize(cols, rows); } catch {}
});
ipcMain.on('pty:kill', (_e, { id }) => { try { ptys.get(id)?.kill(); } catch {} ptys.delete(id); opencode.unwatch(id); });

ipcMain.handle('pick-folder', async e => {
  const r = await dialog.showOpenDialog(winOf(e), { properties: ['openDirectory'], defaultPath: config.defaultCwd });
  return r.canceled ? null : r.filePaths[0];
});
// Ctrl+V in a terminal: an image on the clipboard (and no text) should reach the agent CLI itself,
// not be typed as text. Electron's clipboard.read() works whether or not the window has focus,
// unlike the renderer's navigator.clipboard.
ipcMain.handle('clipboard:has-image', async () => {
  const items = await clipboard.read();
  if (!items.some(i => i.types.some(t => t.startsWith('image/')))) return false;
  return !(await clipboard.readText());
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
ipcMain.on('open-releases', e => openUrl('https://github.com/doolecg/operant/releases', { owner: winOf(e) }));
ipcMain.on('open-log-folder', () => { if (!fs.existsSync(LOG_PATH)) logLine('log started'); shell.showItemInFolder(LOG_PATH); });
// links in release notes, and viewer/agent tile output
ipcMain.on('open-link', (e, { url, second } = {}) => openUrl(url, { second, owner: winOf(e) }));
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

const usage = createUsage({
  projectsDir: PROJECTS_DIR, send: broadcast,
  onContext: (sessionId, tokens, max, model) => {
    if (!config.contextBadge) return;
    const owner = sessionOwner.get(sessionId);
    if (owner) sendTo(owner, 'context', { sessionId, tokens, max, model });
  },
  // A subagent's tool calls/tokens count toward its parent tile (usage.js already resolves the
  // session id to the parent for subagent transcripts, and gates out pre-startup history).
  onToolUse: (sessionId, name, input, agentId) => {
    const owner = sessionOwner.get(sessionId);
    if (owner) noteToolUse(sessionId, owner, name, input, agentId ? (agents.get(agentId)?.description || null) : null);
  },
  onTokens: (sessionId, tokens, breakdown, t) => {
    const owner = sessionOwner.get(sessionId);
    if (owner) noteTokens(sessionId, owner, tokens);
    if (breakdown) addTileTokens(sessionId, owner, breakdown, t, false);
  },
});
ipcMain.handle('usage:summary', () => usage.summary());
ipcMain.handle('usage:series', (_e, range) => usage.series(String(range)));
ipcMain.handle('usage:breakdown', (_e, opts) => usage.breakdown(opts));

const opencode = createOpenCode({
  sendTo, primary: agentWindow, config,
  onToolUse: (sessionId, owner, name, input, label) => noteToolUse(sessionId, owner, name, input, label),
  onTokens: (sessionId, owner, tokens, breakdown, free, project) => {
    noteTokens(sessionId, owner, tokens);
    if (breakdown) {
      addTileTokens(sessionId, owner, breakdown, null, free);
      usage.addEvent(Date.now(), breakdown.input, breakdown.output, breakdown.cacheWrite, breakdown.cacheRead, project || 'opencode');
    }
  },
  onSubagentCount: (sessionId, owner, count) => checkSubagents(sessionId, owner, count),
});
ipcMain.handle('opencode:abort', (_e, { ptyId }) => opencode.abort(ptyId));
ipcMain.handle('opencode:summarize', (_e, { ptyId }) => opencode.summarize(ptyId));

// ------------------------------------------------------- Codex / Gemini CLI usage (otherAgents.js)
// Neither takes an explicit session id, so their session file is matched to the tile that started
// it (otherAgentPending, filled in pty:create) by cwd, the first time that file's cwd is seen.

const otherFileOwner = new Map(); // rollout/session file -> { otherId, project }, once matched
function matchOtherAgent(kind, file, fileCwd) {
  if (otherFileOwner.has(file) || !fileCwd) return;
  const norm = p => String(p).replace(/[\\/]+$/, '').toLowerCase();
  const i = otherAgentPending.findIndex(x => x.kind === kind && norm(x.cwd) === norm(fileCwd));
  if (i < 0) return;
  const [entry] = otherAgentPending.splice(i, 1);
  otherFileOwner.set(file, { otherId: entry.otherId, project: path.basename(fileCwd) || kind });
}
function otherAgentUsage(file, ev) {
  const m = otherFileOwner.get(file);
  const owner = m && sessionOwner.get(m.otherId);
  if (!owner) return;
  if (config.contextBadge && ev.ctxMax) sendTo(owner, 'context', { sessionId: m.otherId, tokens: ev.ctxTokens, max: ev.ctxMax, model: ev.model || null });
  if (ev.last) {
    addTileTokens(m.otherId, owner, ev.last, ev.t, false);
    usage.addEvent(ev.t, ev.last.input, ev.last.output, ev.last.cacheWrite, ev.last.cacheRead, m.project);
  }
}
createCodex({ onSession: (file, cwd) => matchOtherAgent('codex', file, cwd), onUsage: otherAgentUsage }).start();
createGemini({ onSession: (file, cwd) => matchOtherAgent('gemini', file, cwd), onUsage: otherAgentUsage }).start();

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

// ---------------------------------------------------------------- runaway guard
// Flags a tile whose agent may be stuck: a repeated tool call, a token burst, or too many
// subagents at once. usage.js and opencode.js feed the raw signals in (already resolved to the
// owning tile's session id — a subagent's activity counts toward its parent); the checks here
// decide when to send `runaway { sessionId, reason, detail }`, rate-limited per (session, reason)
// to once per 10 minutes. 'time' (busy too long) is detected client-side by the renderer.

const toolHistory = new Map();  // sessionId -> [{ key, display }] last 20 tool calls
const tokenEvents = new Map();  // sessionId -> [{ t, tokens }] in the last 10 minutes
const runawaySent = new Map();  // "sessionId|reason" -> last-sent time

// name+input -> a stable match key (sorted object keys, truncated) and a short display string.
function stableToolKey(name, input) {
  const norm = v => Array.isArray(v) ? v.map(norm)
    : v && typeof v === 'object' ? Object.keys(v).sort().reduce((o, k) => (o[k] = norm(v[k]), o), {}) : v;
  let s;
  try { s = JSON.stringify(norm(input)); } catch { s = String(input); }
  if (s && s.length > 500) s = s.slice(0, 500);
  return `${name}\u0001${s}`;
}
function toolDisplay(name, input) {
  const v = input && typeof input === 'object' ? (input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.query ?? input.url) : input;
  return `${name}(${v == null ? '' : JSON.stringify(String(v)).slice(0, 60)})`;
}

function flagRunaway(sessionId, owner, reason, detail) {
  if (config.runawayGuard === 'off' || !alive(owner)) return;
  const key = `${sessionId}|${reason}`;
  if (Date.now() - (runawaySent.get(key) || 0) < 10 * 60 * 1000) return;
  runawaySent.set(key, Date.now());
  sendTo(owner, 'runaway', { sessionId, reason, detail });
}

function noteToolUse(sessionId, owner, name, input, label) {
  if (!config.runawayLoopRepeats) return;
  const list = toolHistory.get(sessionId) || [];
  list.push({ key: stableToolKey(name, input), display: toolDisplay(name, input) });
  while (list.length > 20) list.shift();
  toolHistory.set(sessionId, list);
  const counts = new Map();
  for (const c of list) counts.set(c.key, (counts.get(c.key) || 0) + 1);
  for (const [key, n] of counts) {
    if (n < config.runawayLoopRepeats) continue;
    const display = list.find(c => c.key === key).display;
    flagRunaway(sessionId, owner, 'loop', `${display}${label ? ` (${label})` : ''} ${n}× in its last 20 tool calls`);
    break;
  }
}

function noteTokens(sessionId, owner, tokens) {
  if (!config.runawayTokens || !tokens) return;
  const now = Date.now();
  const list = tokenEvents.get(sessionId) || [];
  list.push({ t: now, tokens });
  const since = now - 10 * 60 * 1000;
  while (list.length && list[0].t < since) list.shift();
  tokenEvents.set(sessionId, list);
  const sum = list.reduce((a, e) => a + e.tokens, 0);
  if (sum >= config.runawayTokens) flagRunaway(sessionId, owner, 'tokens', `${(sum / 1e6).toFixed(1)}M tokens in 10 min`);
}

function checkSubagents(sessionId, owner, count) {
  if (config.runawaySubagents && count >= config.runawaySubagents) flagRunaway(sessionId, owner, 'subagents', `${count} subagents running`);
}

// Tokens each tile has used since it opened (item 42): sessionId -> running { input, output,
// cacheWrite, cacheRead, free }, sent to the tile as a 'tokens' event. A resumed Claude session's
// history before the tile reopened is skipped (t is the transcript entry's own timestamp);
// OpenCode tiles pass t = null since they're watched fresh from the moment the tile opens.
const tileTokens = new Map();
function addTileTokens(sessionId, owner, breakdown, t, free) {
  if (!config.tileTokens || !owner) return;
  if (t != null) { const openAt = sessionOpenTime.get(sessionId); if (openAt && t < openAt) return; }
  const acc = tileTokens.get(sessionId) || { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, free: false };
  acc.input += breakdown.input; acc.output += breakdown.output; acc.cacheWrite += breakdown.cacheWrite; acc.cacheRead += breakdown.cacheRead;
  acc.free = !!free;
  tileTokens.set(sessionId, acc);
  sendTo(owner, 'tokens', { sessionId, ...acc });
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
    a.description = meta?.description || a.agentId;
    a.owner = sessionOwner.get(a.sessionId) || agentWindow();
    sendTo(a.owner, 'agent:new', {
      agentId: a.agentId, sessionId: a.sessionId, project: a.project,
      agentType: meta?.agentType || 'agent', description: a.description,
      spawnDepth: meta?.spawnDepth || 1,
    });
    let live = 0;
    for (const x of agents.values()) if (x.sessionId === a.sessionId && x.announced && !x.done) live++;
    checkSubagents(a.sessionId, a.owner, live);
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
    if (entries.length) {
      const slim = entries.map(slimEntry).filter(Boolean);
      if (slim.some(x => x.role === 'assistant' && x.stop)) a.done = true;
      sendTo(a.owner, 'agent:entries', { agentId: a.agentId, entries: slim });
    }
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
// "Save and quit": the renderer has already saved its editors and sent a fresh snapshot by the
// time this arrives. Reopen everything next start, and skip the "terminals still running" dialog.
ipcMain.on('app:save-quit', () => {
  session.restoreNext = true;
  writeSession();
  for (const w of windows) w.closeConfirmed = true;
  app.quit();
});

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
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, webviewTag: true },
    ...(process.env.OPERANT_BACKGROUND ? { show: false } : {}),
  });
  const wcId = w.webContents.id;
  // Guest webviews (browser tiles): no preload, no Node, isolated + sandboxed, own persistent session.
  w.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload; delete webPreferences.preloadURL;
    Object.assign(webPreferences, { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: 'persist:operant-browser' });
    if (params.src && params.src !== 'about:blank' && !BROWSER_URL_RE.test(params.src)) event.preventDefault();
  });
  // Run from source the process is electron.exe, whose icon the taskbar would show; point it at Operant's.
  if (process.platform === 'win32' && !app.isPackaged) {
    w.setAppDetails({ appId: 'com.doolecg.operant', appIconPath: path.join(__dirname, 'build', 'icon.ico'), appIconIndex: 0, relaunchDisplayName: 'Operant' });
  }
  windows.add(w);
  lastFocused = w;
  if (startDir) startDirs.set(wcId, startDir);
  if (restore) restoreFor.set(wcId, restore);
  if (process.env.OPERANT_BACKGROUND) w.once('ready-to-show', () => w.showInactive());
  w.on('focus', () => { lastFocused = w; });
  // A crashed renderer (not a normal reload/navigation) gets reloaded so the window comes back;
  // its ptys are orphaned (main owns them, the fresh renderer knows no ids), so they're killed and
  // the window's last snapshot is queued for session:take, which reopens its tiles (Claude conversations resume).
  w.webContents.on('render-process-gone', (_e, d) => {
    logLine(`render-process-gone reason=${d.reason} exitCode=${d.exitCode} window=${wcId}`);
    if (d.reason === 'clean-exit') return;
    const snap = snapshots.get(wcId);
    if (snap) restoreFor.set(wcId, snap);
    for (const [id, p] of ptys) if (p.owner === w) { try { p.kill(); } catch {} ptys.delete(id); opencode.unwatch(id); }
    if (config.notifications && Notification.isSupported()) {
      const n = new Notification({ title: 'Operant', body: "Operant's window crashed and was reloaded", icon: ICON });
      liveNotes.add(n);
      n.show();
    }
    if (alive(w)) w.webContents.reload();
  });
  w.webContents.on('unresponsive', () => logLine(`unresponsive window=${wcId}`));
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
    for (const [id, p] of ptys) if (p.owner === w) { try { p.kill(); } catch {} ptys.delete(id); opencode.unwatch(id); }
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
    opencode.start();
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
    startControlServer();
    syncSkill();
    opencodeTheme.writeTheme(config);
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
