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
// OpenCode skips ~/.claude/CLAUDE.md once a global AGENTS.md exists, so it's listed explicitly:
// OpenCode tiles follow the same personal rules as Claude Code tiles.
const CLAUDE_RULES = path.join(require('os').homedir(), '.claude', 'CLAUDE.md');
const opencodeConfigContent = filePath =>
  JSON.stringify({ instructions: [filePath, ...(fs.existsSync(CLAUDE_RULES) ? [CLAUDE_RULES] : [])] });

module.exports = { BRIEF, briefPath, opencodeConfigContent };
