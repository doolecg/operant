// Item 43: the short brief every agent tile gets from its first message (master, `operant agent`
// workers, reopened/resumed agents), so Operant's rules don't depend on the model deciding to load
// the skill. Kept short, and identical every launch, so it stays cheap and cache-friendly.
const fs = require('fs');
const path = require('path');

const BRIEF = [
  "You're running inside Operant. Use the `operant` skill/CLI (`operant help`) for its commands.",
  'If `.codegraph/` exists in this project, your first step for any question about the code is CodeGraph (`codegraph explore "<symbols or question>"`, or its MCP tool): not grep, glob or reading files. Fall back to those only for what CodeGraph did not answer.',
  'If `.operant/progress.md` exists, read it first and continue from it.',
  'Run long commands (tests, builds, installs, dev servers) with `operant run`, then `operant wait <id> --errors`.',
  'At start, run `operant team`. If team mode is on, hand each task that fits a tier\'s "use" to a worker with `operant agent "<self-contained task>" --tier <name>`, always the cheapest tier that fits and never above the top tier it lists (the user sets that slider); do only what fits no tier yourself. If you were started as a worker (you have a board task), do the task yourself.',
  'At start, run `operant recall` for this project\'s memory; save durable facts you learn (user preferences, decisions, gotchas) with `operant remember`.',
].join('\n');

// Written once into Operant's userData, never touching the user's own files. Claude Code gets this
// text directly via --append-system-prompt; OpenCode reads it as an `instructions` file through its
// own per-process OPENCODE_CONFIG_CONTENT env var (see opencodeConfigContent below).
function briefPath(userDataDir) {
  const p = path.join(userDataDir, 'agent-brief.md');
  try {
    let existing = null;
    try { existing = fs.readFileSync(p, 'utf8'); } catch {}
    if (existing !== BRIEF) { fs.mkdirSync(userDataDir, { recursive: true }); fs.writeFileSync(p, BRIEF); }
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
  codex: path.join(home, '.codex', 'AGENTS.md'),
  gemini: path.join(home, '.gemini', 'GEMINI.md'),
};
// The main agent's rules file, when the tile being launched is a different agent.
function mainRules(mainAgent, launching) {
  const p = mainAgent !== launching && RULES[mainAgent];
  return p && fs.existsSync(p) ? p : null;
}
function mainRulesText(mainAgent, launching) {
  const p = mainRules(mainAgent, launching);
  try { return p ? fs.readFileSync(p, 'utf8') : ''; } catch { return ''; }
}
// `pluginPath`, when given, is the long-command reroute (hooks/opencode-long-commands.mjs), in the
// same object so everything merges into one config.
const opencodeConfigContent = (filePath, { mainAgent, pluginPath } = {}) => {
  const content = {};
  const instructions = [filePath, mainRules(mainAgent, 'opencode')].filter(Boolean);
  if (instructions.length) content.instructions = instructions;
  if (pluginPath) content.plugin = [pluginPath];
  return JSON.stringify(content);
};

module.exports = { BRIEF, briefPath, opencodeConfigContent, mainRulesText };
