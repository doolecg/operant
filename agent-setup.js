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

const isClaudeCmd = cmd => /(^|[\\/])claude(\.(exe|cmd|ps1))?$/i.test(String(cmd || '').trim().split(/\s+/)[0]);
const isOpenCodeCmd = cmd => /(^|[\\/])opencode(\.(exe|cmd|ps1))?$/i.test(String(cmd || '').trim().split(/\s+/)[0]);

// -------------------------------------------------------------------- json / jsonc helpers
function stripJsonComments(text) {
  // Good enough for opencode.jsonc: strips // and /* */ outside of strings.
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
    fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }, null, 2));
    return file;
  } catch { return null; }
}

// Extra CLI args for a Claude tile when the main agent is OpenCode and shareSetup is on.
// Only kicks in when OpenCode actually has servers to share.
function claudeExtraArgs({ agent, config, cwd, userDataDir }) {
  if (!config.shareSetup) return [];
  if (!isClaudeCmd(agent && agent.command)) return [];
  const mainAgent = (config.agents || []).find(a => a.id === config.defaultAgent);
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
  const mainAgent = (config.agents || []).find(a => a.id === config.defaultAgent);
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

  const mainAgent = (config.agents || []).find(a => a.id === config.defaultAgent);
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
  claudeExtraArgs, writeClaudeMcpConfigFile,
  findPluginSkillDirs, syncPluginSkillsMirror,
  findCodegraphPromptHookCommand, codegraphPluginEntry,
  buildOpencodeConfigContent,
  desirePathLine, appendDesirePath,
};
