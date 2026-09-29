// Operant is the hub: whatever the user's main agent (config.defaultAgent) already has set up —
// MCP servers, skills, a prompt hook — should reach every other agent Operant launches, per
// process only. Nothing here ever writes into ~/.claude or ~/.config/opencode; everything lives
// in Operant's own userData folder or is passed through env vars / CLI flags for one tile.
//
// Rules and briefing (agent-brief.js) build most of OPENCODE_CONFIG_CONTENT already; this module
// only contributes the `mcp`, `plugin` and `instructions` pieces, as a mergeable partial object,
// so two features can layer onto the same JSON without clobbering each other.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

const isClaudeCmd = cmd => /(^|[\\/])claude(\.(exe|cmd|ps1))?$/i.test(String(cmd || '').trim().split(/\s+/)[0]);
const isOpenCodeCmd = cmd => /(^|[\\/])opencode(\.(exe|cmd|ps1))?$/i.test(String(cmd || '').trim().split(/\s+/)[0]);

// -------------------------------------------------------------------- json / jsonc helpers
function stripJsonComments(text) {
  // Good enough for opencode.jsonc: strips // and /* */ outside of strings, and the trailing commas
  // OpenCode's own parser allows.
  let out = '', inStr = false, strCh = '', i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') { out += text[i + 1] || ''; i += 2; continue; }
      if (c === strCh) inStr = false;
      i++; continue;
    }
    if (c === '"' || c === "'") { inStr = true; strCh = c; out += c; i++; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '}' || c === ']') {
      let j = out.length - 1;
      while (j >= 0 && /\s/.test(out[j])) j--;
      if (out[j] === ',') out = out.slice(0, j) + out.slice(j + 1);
    }
    out += c; i++;
  }
  return out;
}
function readJson(file) {
  try { return JSON.parse(stripJsonComments(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))); } catch { return null; }
}

// -------------------------------------------------------------------- reading Claude's MCP servers
// ~/.claude.json: top-level mcpServers (user scope) plus projects[<cwd>].mcpServers (project scope).
// Also a project-local .mcp.json (Claude's own project-shared server file), if present.
function claudeUserConfigPath() { return path.join(os.homedir(), '.claude.json'); }

function getClaudeMcpServers(cwd) {
  const servers = {};
  const root = readJson(claudeUserConfigPath());
  if (root && typeof root === 'object') {
    Object.assign(servers, root.mcpServers || {});
    const proj = root.projects && (root.projects[cwd] || root.projects[path.resolve(cwd || '.')]);
    if (proj && proj.mcpServers) Object.assign(servers, proj.mcpServers);
  }
  if (cwd) {
    const mcpJson = readJson(path.join(cwd, '.mcp.json'));
    if (mcpJson && mcpJson.mcpServers) Object.assign(servers, mcpJson.mcpServers);
  }
  return servers;
}

// -------------------------------------------------------------------- reading OpenCode's own MCP servers
// Read-only: never written to. Used only to skip servers OpenCode already has (by name).
function getOpenCodeOwnMcpServers() {
  const dir = path.join(os.homedir(), '.config', 'opencode');
  const cfg = readJson(path.join(dir, 'opencode.json')) || readJson(path.join(dir, 'opencode.jsonc')) || {};
  return cfg.mcp || {};
}

// -------------------------------------------------------------------- format conversion
// Claude mcpServers entry -> OpenCode's `mcp` entry.
function claudeServerToOpenCode(def) {
  if (!def || typeof def !== 'object') return null;
  const type = def.type || (def.command ? 'stdio' : (def.url ? 'http' : null));
  if (type === 'stdio' || (!type && def.command)) {
    const command = [def.command, ...(def.args || [])].filter(Boolean);
    if (!command.length) return null;
    return { type: 'local', command, ...(def.env ? { environment: def.env } : {}), enabled: true };
  }
  if (type === 'http' || type === 'sse') {
    if (!def.url) return null;
    return { type: 'remote', url: def.url, ...(def.headers ? { headers: def.headers } : {}), enabled: true };
  }
  return null;
}

// OpenCode `mcp` entry -> Claude mcpServers entry (for --mcp-config, the reverse direction).
function openCodeServerToClaude(def) {
  if (!def || typeof def !== 'object') return null;
  if (def.type === 'local') {
    const [command, ...args] = [].concat(def.command || []);
    if (!command) return null;
    return { type: 'stdio', command, args, ...(def.environment ? { env: def.environment } : {}) };
  }
  if (def.type === 'remote') {
    if (!def.url) return null;
    return { type: def.url.startsWith('ws') ? 'sse' : 'http', url: def.url, ...(def.headers ? { headers: def.headers } : {}) };
  }
  return null;
}

// Servers Claude knows about (user + project scope for `cwd`) that OpenCode doesn't already have,
// converted to OpenCode's `mcp` shape. Returns {} when there's nothing new to add.
function mcpForOpenCodeTiles(cwd) {
  const claudeServers = getClaudeMcpServers(cwd);
  const existing = getOpenCodeOwnMcpServers();
  const out = {};
  for (const [name, def] of Object.entries(claudeServers)) {
    if (existing[name]) continue; // OpenCode already has one by this name; don't shadow it
    const conv = claudeServerToOpenCode(def);
    if (conv) out[name] = conv;
  }
  return out;
}

// Writes a standalone Claude --mcp-config file (in userDataDir, never ~/.claude*) carrying
// OpenCode's servers converted to Claude's format, for when the main agent IS OpenCode.
function writeClaudeMcpConfigFile(userDataDir, openCodeServers) {
  const servers = {};
  for (const [name, def] of Object.entries(openCodeServers || {})) {
    const conv = openCodeServerToClaude(def);
    if (conv) servers[name] = conv;
  }
  if (!Object.keys(servers).length) return null;
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    const file = path.join(userDataDir, 'claude-mcp.json');
    fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }, null, 2), { mode: 0o600 }); // server env can hold API keys
    return file;
  } catch { return null; }
}

// Extra CLI args for a Claude tile when the main agent is OpenCode and shareSetup is on.
// Only kicks in when OpenCode actually has servers to share.
// The user's main agent: the default one, or with Operant (the Operant Terminal) as the default, the first Claude Code
// agent (else the first agent), since only a CLI has rules, hooks and MCP servers to share.
function mainAgentId(config) {
  const agents = config.agents || [];
  if (config.defaultAgent !== 'operant') return config.defaultAgent;
  return (agents.find(a => isClaudeCmd(a.command)) || agents[0])?.id || null;
}

function claudeExtraArgs({ agent, config, cwd, userDataDir }) {
  if (!config.shareSetup) return [];
  if (!isClaudeCmd(agent && agent.command)) return [];
  const mainAgent = (config.agents || []).find(a => a.id === mainAgentId(config));
  if (!mainAgent || !isOpenCodeCmd(mainAgent.command)) return []; // main agent isn't OpenCode: nothing to bring over
  const file = writeClaudeMcpConfigFile(userDataDir, getOpenCodeOwnMcpServers());
  return file ? ['--mcp-config', file] : [];
}

// -------------------------------------------------------------------- skills
// Claude's own ~/.claude/skills/*/SKILL.md are already discovered natively by OpenCode
// (opencode.ai/docs/skills lists ~/.claude/skills as one of its global search paths), so nothing
// is needed for those. What OpenCode can't see is SKILL.md files that live inside installed
// Claude *plugins* (~/.claude/plugins/cache/<marketplace>/<plugin>/skills/<name>/SKILL.md) — those
// aren't under ~/.claude/skills at all.
function installedPluginDirs() {
  const file = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
  const data = readJson(file);
  const dirs = [];
  if (data && data.plugins) {
    for (const entries of Object.values(data.plugins)) {
      for (const e of [].concat(entries || [])) if (e && e.installPath) dirs.push(e.installPath);
    }
  }
  return dirs;
}

function findPluginSkillDirs() {
  const found = [];
  for (const dir of installedPluginDirs()) {
    const skillsDir = path.join(dir, 'skills');
    let names = [];
    try { names = fs.readdirSync(skillsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { continue; }
    for (const name of names) {
      const md = path.join(skillsDir, name, 'SKILL.md');
      if (fs.existsSync(md)) found.push({ name, dir: path.join(skillsDir, name), md });
    }
  }
  return found;
}

// Skills load on demand, so plugin skills must not go into `instructions` (that would put every one
// of them into every prompt). They're mirrored into OpenCode's own global skills folder instead,
// the same place Operant installs its own skill; each mirror is marked so only Operant's copies are
// ever updated or pruned, and a skill the user already has there under that name is left alone.
const MIRROR_MARK = '.operant-shared';
function syncPluginSkillsMirror(skillsDir = path.join(os.homedir(), '.config', 'opencode', 'skills')) {
  const skills = findPluginSkillDirs();
  const keep = new Set();
  try {
    fs.mkdirSync(skillsDir, { recursive: true });
    for (const s of skills) {
      const destDir = path.join(skillsDir, s.name);
      if (fs.existsSync(destDir) && !fs.existsSync(path.join(destDir, MIRROR_MARK))) continue;
      keep.add(s.name);
      try {
        fs.mkdirSync(destDir, { recursive: true });
        const destMd = path.join(destDir, 'SKILL.md'), content = fs.readFileSync(s.md, 'utf8');
        let cur = null;
        try { cur = fs.readFileSync(destMd, 'utf8'); } catch {}
        if (cur !== content) fs.writeFileSync(destMd, content);
        fs.writeFileSync(path.join(destDir, MIRROR_MARK), 'Copied by Operant from a Claude Code plugin; removed when the plugin is.\n');
      } catch {}
    }
    // Drop Operant's mirrors of plugins that were uninstalled or disabled since the last sync.
    for (const d of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!d.isDirectory() || keep.has(d.name) || !fs.existsSync(path.join(skillsDir, d.name, MIRROR_MARK))) continue;
      try { fs.rmSync(path.join(skillsDir, d.name), { recursive: true, force: true }); } catch {}
    }
  } catch {}
  return [...keep];
}

// -------------------------------------------------------------------- CodeGraph prompt hook
// Claude's UserPromptSubmit hook (~/.claude/settings.json) that injects CodeGraph context.
// OpenCode's equivalent is the "chat.message" plugin hook, which can push extra text parts onto
// the user's message before it's sent. We only add this when the main agent's own settings
// actually run a codegraph hook, and we run that exact same command.
function claudeSettingsPath() { return path.join(os.homedir(), '.claude', 'settings.json'); }

function findCodegraphPromptHookCommand() {
  const settings = readJson(claudeSettingsPath());
  const submit = settings && settings.hooks && settings.hooks.UserPromptSubmit;
  if (!Array.isArray(submit)) return null;
  for (const group of submit) {
    for (const h of [].concat((group && group.hooks) || [])) {
      if (h && h.type === 'command' && /codegraph/i.test(String(h.command || ''))) return h.command;
    }
  }
  return null;
}

const CODEGRAPH_PLUGIN_SRC = path.join(__dirname, 'hooks', 'codegraph-prompt.js').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

// Returns the plugin's file path (as OpenCode's `plugin` array wants it) only when the main
// agent's config actually runs a codegraph prompt hook, and the plugin file exists.
function codegraphPluginEntry(config) {
  if (!config.shareSetup) return null;
  const mainAgent = (config.agents || []).find(a => a.id === mainAgentId(config));
  if (!mainAgent || !isClaudeCmd(mainAgent.command)) return null; // only Claude's hook is understood here
  const command = findCodegraphPromptHookCommand();
  if (!command) return null;
  if (!fs.existsSync(CODEGRAPH_PLUGIN_SRC)) return null;
  return CODEGRAPH_PLUGIN_SRC.split(path.sep).join('/'); // OpenCode plugin paths are forward-slashed
}

// -------------------------------------------------------------------- the merge
// Builds the {mcp, plugin, instructions} partial this module contributes, and folds it into
// whatever OPENCODE_CONFIG_CONTENT already holds (a JSON string, or undefined/empty), so another
// feature (e.g. the long-commands reroute plugin) adding its own `plugin` entry composes cleanly.
// `base` is the existing OPENCODE_CONFIG_CONTENT string (or an object) to merge onto.
function buildOpencodeConfigContent({ base, cwd, userDataDir, config }) {
  let obj = {};
  if (base && typeof base === 'string') { try { obj = JSON.parse(base) || {}; } catch { obj = {}; } }
  else if (base && typeof base === 'object') obj = { ...base };

  if (!config.shareSetup) return JSON.stringify(obj);

  const mainAgent = (config.agents || []).find(a => a.id === mainAgentId(config));
  if (mainAgent && isClaudeCmd(mainAgent.command)) {
    const mcp = mcpForOpenCodeTiles(cwd);
    if (Object.keys(mcp).length) obj.mcp = { ...(obj.mcp || {}), ...mcp };

    if (!process.env.OPERANT_USER_DATA) syncPluginSkillsMirror(); // dev/test profiles leave ~/.config alone
  }

  const pluginEntry = codegraphPluginEntry(config);
  if (pluginEntry) {
    const existing = Array.isArray(obj.plugin) ? obj.plugin : [];
    if (!existing.includes(pluginEntry)) obj.plugin = [...existing, pluginEntry];
  }

  return JSON.stringify(obj);
}

// -------------------------------------------------------------------- the operant skill, per session
// Versions before 1.19 copied the skill into ~/.claude/skills/operant and ~/.config/opencode/skills/operant,
// where every Claude Code session paid for its listing (OpenCode reads both folders, so it listed it twice)
// and a copy could lag the app. Now the app's own agent-plugin/ folder goes to each tile's session:
// `--plugin-dir` plus CLAUDE_CODE_PLUGIN_DIRS for Claude Code, `skills.paths` in the per-process config
// for OpenCode. Nothing is written into the agents' own folders.
function isOperantSkillFile(content) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content || '');
  return !!m && /^name:\s*operant\s*$/m.test(m[1]);
}

// Removes what those versions left, and only Operant's own SKILL.md: a skill someone else called
// "operant" stays. A link (the hub's junction, say) is unlinked without following it, so what it points
// at is never touched. Returns the folders it cleaned; never throws.
function removeLegacySkillCopies({ homeDir = os.homedir() } = {}) {
  const removed = [];
  for (const dir of [path.join(homeDir, '.claude', 'skills', 'operant'), path.join(homeDir, '.config', 'opencode', 'skills', 'operant')]) {
    try {
      let st = null;
      try { st = fs.lstatSync(dir); } catch { continue; }
      const file = path.join(dir, 'SKILL.md');
      let content = null;
      try { content = fs.readFileSync(file, 'utf8'); } catch {}
      if (!isOperantSkillFile(content)) continue;
      if (st.isSymbolicLink()) fs.unlinkSync(dir);
      else {
        fs.unlinkSync(file);
        if (!fs.readdirSync(dir).length) fs.rmdirSync(dir);
      }
      removed.push(dir);
    } catch {}
  }
  return removed;
}

// A tile's CLAUDE_CODE_PLUGIN_DIRS: `current` (what Operant inherited, which may already carry ours when it
// runs inside another Operant tile) with our folder added, or taken out. Shell tiles and other agents get it
// so a `claude` typed in them has the skill too; a Claude Code tile already gets `--plugin-dir`, and both
// could load it twice. Returns the new value, or null when nothing is left (the var is then deleted).
function pluginDirsEnv(current, dir, add) {
  const key = p => { const r = path.resolve(p); return process.platform === 'win32' ? r.toLowerCase() : r; };
  const parts = String(current || '').split(path.delimiter).filter(p => p && key(p) !== key(dir));
  if (add) parts.push(dir);
  return parts.length ? parts.join(path.delimiter) : null;
}

// The `skills.paths` an OpenCode tile gets: `ours` (a folder of skill folders) after the user's own. OpenCode
// replaces that array from one config source to the next instead of merging, so ours alone would switch
// their own skill folders off. Read the way OpenCode finds its config: the global file, then each
// opencode.json(c) and .opencode/ from the project's git root down to `dir`. Their paths stay as written
// (OpenCode resolves relative ones from the tile's folder, the same with or without ours).
// OpenCode's config files in the order it reads them: the global file, then each opencode.json(c) and .opencode/
// from the project's git root down to `dir`.
function opencodeConfigFiles(dir, { homeDir = os.homedir() } = {}) {
  const files = [];
  const globalDir = path.join(homeDir, '.config', 'opencode');
  files.push(path.join(globalDir, 'opencode.json'), path.join(globalDir, 'opencode.jsonc'));
  const chain = [];
  for (let d = path.resolve(dir || '.'), i = 0; i < 12; i++) {
    chain.unshift(d);
    if (fs.existsSync(path.join(d, '.git')) || path.dirname(d) === d) break;
    d = path.dirname(d);
  }
  for (const d of chain) {
    for (const base of [d, path.join(d, '.opencode')]) files.push(path.join(base, 'opencode.json'), path.join(base, 'opencode.jsonc'));
  }
  return files;
}
function opencodeSkillPaths(dir, ours, { homeDir = os.homedir() } = {}) {
  const files = opencodeConfigFiles(dir, { homeDir });
  const same = p => { const s = p.replace(/\\/g, '/').replace(/\/+$/, ''); return process.platform === 'win32' ? s.toLowerCase() : s; };
  const out = [];
  for (const f of files) {
    const list = readJson(f)?.skills?.paths;
    for (const p of Array.isArray(list) ? list : []) if (typeof p === 'string' && p.trim() && !out.some(o => same(o) === same(p))) out.push(p);
  }
  return [...out.filter(p => same(p) !== same(ours)), ours];
}

// What an agent's installed CLI can do, asked by running it: a flag or config key an older version doesn't
// know would stop its tile from starting, so it is only passed once the CLI has said it's there. main.js
// runs each probe once per launch command, in the background, and keeps the answer. Through the shell,
// as a tile starts the command, so a .cmd shim or a command with flags of its own works too.
function runProbe(command, args, { env, timeout }) {
  return new Promise(resolve => {
    try {
      const child = exec(`${String(command || '').trim()} ${args.join(' ')}`, { windowsHide: true, timeout, env: env || process.env, maxBuffer: 8 << 20 },
        (err, stdout, stderr) => resolve({ ok: !err, output: `${stdout}\n${stderr}` }));
      child.stdin?.end(); // some CLIs wait on an open, untouched stdin
    } catch { resolve({ ok: false, output: '' }); }
  });
}
// Claude Code: `--plugin-dir` is in its help.
const probeClaudePluginDir = (command, { env } = {}) =>
  runProbe(command, ['--help'], { env, timeout: 10000 }).then(r => r.ok && /--plugin-dir\b/.test(r.output));
// OpenCode: a config with `skills.paths` is accepted (an older version rejects a key it doesn't know).
const probeOpencodeSkillPaths = (command, { env } = {}) =>
  runProbe(command, ['debug', 'config'], { env: { ...(env || process.env), OPENCODE_CONFIG_CONTENT: '{"skills":{"paths":[]}}' }, timeout: 15000 }).then(r => r.ok);

// The --settings file for a Claude Code tile's own hooks, never the user's settings.json: the long-command
// reroute (`rerouteCmd`, a script) and, for a team worker, the Stop hook that asks for the board report
// (`operantCmd`, the operant wrapper). null when there is nothing to register.
function hookSettingsContent({ reroute, worker, messaging, rerouteCmd, operantCmd }) {
  const hooks = {};
  const permissions = worker ? { allow: workerAllowRules() } : null;
  // "Bash" on macOS/Linux, "PowerShell" on Windows — Claude Code's shell tool is named
  // differently per platform, and a matcher that misses one never even calls the hook script.
  if (reroute) hooks.PreToolUse = [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: `"${rerouteCmd}"` }] }];
  // Messaging: pending agent messages arrive between tool calls, and a turn can't end with some waiting.
  if (messaging) hooks.PostToolUse = [{ hooks: [{ type: 'command', command: `"${operantCmd}" hook post-tool-use`, timeout: 5 }] }];
  if (worker || messaging) hooks.Stop = [{ hooks: [{ type: 'command', command: `"${operantCmd}" hook stop`, timeout: 8 }] }];
  if (!Object.keys(hooks).length && !permissions) return null;
  return { ...(Object.keys(hooks).length ? { hooks } : {}), ...(permissions ? { permissions } : {}) };
}

// Read-only commands a team worker may run without a permission prompt (nothing that runs arbitrary code),
// and the operant subcommands it needs to report. Never `run`, `test`, `build`, `agent`, `send`, `close`...
// (they launch processes or type into other tiles). Claude Code splits compound commands (`;`, `&&`, `|`)
// and needs every part to match, so `git status; rm x` still prompts.
const WORKER_GIT = ['status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'ls-files', 'blame'];
const WORKER_OPERANT = ['task', 'board', 'read', 'wait', 'notify', 'prime', 'team', 'recall', 'remember', 'help', 'msg', 'inbox', 'usage', 'tiles', 'ports', 'title'];
const WORKER_COMMANDS = [...WORKER_GIT.map(c => `git ${c}`), ...WORKER_OPERANT.map(c => `operant ${c}`), 'ls', 'pwd'];
function workerAllowRules() {
  return [
    ...WORKER_COMMANDS.map(c => `Bash(${c} *)`),
    ...[...WORKER_COMMANDS.filter(c => c !== 'ls' && c !== 'pwd'), 'Get-ChildItem', 'Get-Location'].map(c => `PowerShell(${c} *)`),
  ];
}

// The same list as OpenCode `permission.bash` patterns (wildcard -> "allow"). A bare command is listed too,
// since OpenCode's `git status *` needs the trailing text. Ours are merged after the user's and a later pattern
// wins there, so a command one of the user's own "deny"/"ask" patterns covers is left out (and none at all when
// their bash permission is a plain "deny"/"ask"): the user's rule stays in charge.
function opencodeWorkerPermission({ dir, homeDir } = {}) {
  let userBash = {};
  for (const f of dir ? opencodeConfigFiles(dir, { homeDir }) : []) {
    const b = readJson(f)?.permission?.bash;
    if (typeof b === 'string') userBash = { '*': b };
    else if (b && typeof b === 'object') userBash = { ...userBash, ...b };
  }
  const blockers = Object.entries(userBash).filter(([, v]) => v !== 'allow')
    .map(([pat]) => new RegExp('^' + String(pat).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i'));
  const bash = {};
  for (const c of [...WORKER_COMMANDS, 'Get-ChildItem', 'Get-Location']) {
    if (blockers.some(re => re.test(c) || re.test(`${c} x`))) continue;
    bash[c] = 'allow'; bash[`${c} *`] = 'allow';
  }
  return { bash };
}

// -------------------------------------------------------------------- desire paths
// `operant _desire`: the CLI reports what an agent tried that isn't there (a command, a flag) and what it
// was pointed to instead, so the commands agents keep reaching for can be seen. One JSON line each, in the
// app's own folder, and only these four short strings, nothing else the agent sent.
const DESIRE_FIELDS = ['kind', 'name', 'cmd', 'suggestion'];
function desirePathLine(args, now = new Date()) {
  const line = { t: now.toISOString() };
  for (const k of DESIRE_FIELDS) line[k] = typeof args?.[k] === 'string' ? args[k].slice(0, 80) : '';
  return JSON.stringify(line) + '\n';
}
// Past `maxBytes` the file keeps only its last `keepBytes`, starting at a whole line. Never throws.
function appendDesirePath(file, args, { now, maxBytes = 200 * 1024, keepBytes = 100 * 1024 } = {}) {
  try {
    let size = 0;
    try { size = fs.statSync(file).size; } catch {}
    if (size > maxBytes) {
      const tail = fs.readFileSync(file).subarray(-keepBytes);
      const start = tail.indexOf(10) + 1; // the first partial line goes
      fs.writeFileSync(file, tail.subarray(start));
    }
    fs.appendFileSync(file, desirePathLine(args, now));
  } catch {}
}

module.exports = {
  getClaudeMcpServers, getOpenCodeOwnMcpServers, mcpForOpenCodeTiles,
  claudeExtraArgs, writeClaudeMcpConfigFile, mainAgentId,
  findPluginSkillDirs, syncPluginSkillsMirror,
  findCodegraphPromptHookCommand, codegraphPluginEntry,
  buildOpencodeConfigContent, workerAllowRules, opencodeWorkerPermission, opencodeConfigFiles,
  isOperantSkillFile, removeLegacySkillCopies, pluginDirsEnv, opencodeSkillPaths,
  probeClaudePluginDir, probeOpencodeSkillPaths,
  desirePathLine, appendDesirePath, hookSettingsContent,
};
