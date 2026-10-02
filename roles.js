// Role presets: short instructions that make a subagent good at one kind of task. One source of truth,
// agent-plugin/agents/<role>.md: Claude Code loads those as the `operant:<role>` subagents, and roleText()
// gives the same body to OpenCode's `role-<name>` subagents and to worker briefs (bin/operant-prime.js).
const fs = require('fs');
const path = require('path');
const { classifyTask } = require('./task-type');

// tier: the team tier whose model OpenCode uses; claudeModel: the Agent tool's `model` alias.
const ROLES = {
  implement: { tier: 'small', claudeModel: 'sonnet', readOnly: false },
  fix: { tier: 'small', claudeModel: 'sonnet', readOnly: false },
  explore: { tier: 'xsmall', claudeModel: 'haiku', readOnly: true },
  review: { tier: 'small', claudeModel: 'sonnet', readOnly: true },
  docs: { tier: 'xsmall', claudeModel: 'haiku', readOnly: false },
  design: { tier: 'high', claudeModel: 'opus', effort: 'high', readOnly: true },
};
const NAMES = Object.keys(ROLES);

// Asked to design or plan, not a task that merely mentions a plan or a UI design.
const DESIGN = /^\s*(design|architect|plan)\b|\b(design (the|a|an|how)|architecture (for|of)|(write|make|draft) (a|the) plan|plan (out|how))\b/i;
const BY_TYPE = { fix: 'fix', test: 'implement', refactor: 'implement', feature: 'implement', docs: 'docs', lookup: 'explore' };

function roleForTask(text) {
  const type = classifyTask(text);
  if (type !== 'fix' && DESIGN.test(String(text || ''))) return 'design';
  return BY_TYPE[type] || 'implement';
}

const cache = {};
function load(name) {
  if (!ROLES[name]) return null;
  if (!cache[name]) {
    try {
      const raw = fs.readFileSync(path.join(__dirname, 'agent-plugin', 'agents', `${name}.md`), 'utf8').replace(/\r\n/g, '\n');
      const m = /^---\n([\s\S]*?)\n---[ \t]*(\n|$)/.exec(raw);
      cache[name] = { text: (m ? raw.slice(m[0].length) : raw).trim(), description: m ? ((/^description: "(.*)"$/m.exec(m[1]) || [])[1] || '') : '' };
    } catch { return null; }
  }
  return cache[name];
}
const roleText = name => load(name)?.text || '';
const roleDescription = name => load(name)?.description || '';

module.exports = { ROLES, NAMES, roleForTask, roleText, roleDescription };
