// Item 43: the brief every agent tile gets in its system prompt (master, `operant agent` workers,
// reopened/resumed agents), so Operant's rules don't depend on the model deciding to load the skill.
// Only the pointer lives here: the live part (role, team tiers while team mode is on, board task,
// progress note, memory, CodeGraph) comes from `operant prime`, injected at every start and compact
// (bin/operant-prime.js). So this stays identical every launch, short and cache-friendly.
const fs = require('fs');
const path = require('path');

// The skill's name as each agent sees it: Claude Code namespaces plugin skills.
const SKILL_NAME = { claude: 'operant:operant', opencode: 'operant' };
function briefFor(agent) {
  return [
    "You're running inside Operant, a terminal for agents; the `operant` CLI is on PATH (`operant help`).",
    'Your live Operant context (tile, role, team, board task, memory) is in an <operant-context> block (refreshed on compact); if you have none, run `operant prime`.',
    'Run tests, builds, installs and dev servers through `operant test`, `operant build` or `operant run "<cmd>"` then `operant wait <id> --errors` (only failures come back).',
    'When asked to tell or ping the user when work finishes, end with `operant notify "<text>"`, not a chat message.',
    `For parallel work, plans, questions, context and memory, use the \`${SKILL_NAME[agent] || 'operant'}\` skill.`,
  ].join('\n');
}
const BRIEF = briefFor('claude');

// Written once into Operant's userData, never touching the user's own files. Claude Code gets its
// brief directly via --append-system-prompt; OpenCode reads this file as an `instructions` entry
// through its own per-process OPENCODE_CONFIG_CONTENT env var (see opencodeConfigContent below).
function briefPath(userDataDir) {
  const p = path.join(userDataDir, 'agent-brief.md');
  const text = briefFor('opencode');
  try {
    let existing = null;
    try { existing = fs.readFileSync(p, 'utf8'); } catch {}
    if (existing !== text) { fs.mkdirSync(userDataDir, { recursive: true }); fs.writeFileSync(p, text); }
  } catch (e) { console.error('agent brief write failed', e.message); }
  return p;
}

// OPENCODE_CONFIG_CONTENT is merged by OpenCode with the user's own opencode.json/opencode.jsonc
// (models, providers, keys, mcp servers) rather than replacing it — confirmed with
// `opencode debug config`.
// Every agent follows the personal rules of the user's main agent (defaultAgent): e.g. with Claude
// Code as main, OpenCode tiles also load ~/.claude/CLAUDE.md (which OpenCode skips once a global
// AGENTS.md exists). The main agent itself already loads its own file.
const home = require('os').homedir();
const RULES = {
  claude: path.join(home, '.claude', 'CLAUDE.md'),
  opencode: path.join(home, '.config', 'opencode', 'AGENTS.md'),
};
// Once Operant's hub holds the rules (hub.js), that file is the main agent's rules for Claude Code:
// ~/.claude/CLAUDE.md is then only an @import line pointing at it.
let hubDir = null;
function setHubDir(dir) { hubDir = dir; }
function rulesFile(agent) {
  const h = agent === 'claude' && hubDir && path.join(hubDir, 'rules.md');
  return h && fs.existsSync(h) ? h : RULES[agent];
}
// The main agent's rules file, when the tile being launched is a different agent.
function mainRules(mainAgent, launching) {
  const p = mainAgent !== launching && rulesFile(mainAgent);
  return p && fs.existsSync(p) ? p : null;
}
function mainRulesText(mainAgent, launching) {
  const p = mainRules(mainAgent, launching);
  try { return p ? fs.readFileSync(p, 'utf8') : ''; } catch { return ''; }
}
// `pluginPath`, when given, is the long-command reroute (hooks/opencode-long-commands.mjs), in the
// same object so everything merges into one config. `skillPaths` are folders of skill folders (the agent
// plugin's skills/); OpenCode replaces `skills.paths` instead of merging, so the caller passes the user's own too.
const opencodeConfigContent = (filePath, { mainAgent, plugins = [], skillPaths = [] } = {}) => {
  const content = {};
  const instructions = [filePath, mainRules(mainAgent, 'opencode')].filter(Boolean);
  if (instructions.length) content.instructions = instructions;
  if (plugins.length) content.plugin = plugins;
  if (skillPaths.length) content.skills = { paths: skillPaths };
  return JSON.stringify(content);
};

module.exports = { BRIEF, briefFor, briefPath, setHubDir, opencodeConfigContent, mainRulesText };
