(function () {
// The agent CLIs Operant knows, in one table: how each is recognised from an agent's command, how it is installed,
// which flags carry a prompt, model, effort and session, how it gets Operant's brief and skill, how a tile knows it
// is busy, and its default tiers. A team is a team of one CLI: the project's lead CLI (see leadCli).
// Flags are argument templates: '{}' is the value as is, '{toml}' the value as a TOML string (Codex's -c); null = the
// CLI has no such flag. Codex and Gemini flags and model ids are from their docs, not checked against an installed CLI.
const CLIS = {
  claude: {
    id: 'claude', label: 'Claude Code', command: 'claude', install: 'npm i -g @anthropic-ai/claude-code',
    flags: { prompt: ['{}'], model: ['--model', '{}'], effort: ['--effort', '{}'], session: ['--session-id', '{}'], resume: ['--resume', '{}'], brief: ['--append-system-prompt', '{}'] },
    brief: 'append-system-prompt', skill: 'plugin-dir', busy: 'hooks', adopt: true, tiers: null,
    delegate: 'the Agent tool with `model` set to the tier\'s alias (haiku, sonnet or opus)',
  },
  opencode: {
    id: 'opencode', label: 'OpenCode', command: 'opencode', install: 'npm i -g opencode-ai',
    flags: { prompt: ['--prompt', '{}'], model: ['-m', '{}'], effort: null, session: null, resume: null, port: ['--port', '{}'], brief: null },
    brief: 'config-instructions', skill: 'skill-paths', busy: 'server', adopt: false, tiers: null,
    delegate: 'the `tier-<name>` subagent',
  },
  // Codex: prompt positional; effort and the brief go in as config overrides (-c key=value, the value read as TOML).
  codex: {
    id: 'codex', label: 'Codex', command: 'codex', install: 'npm i -g @openai/codex',
    flags: { prompt: ['{}'], model: ['-m', '{}'], effort: ['-c', 'model_reasoning_effort={}'], session: null, resume: null, brief: ['-c', 'developer_instructions={toml}'] },
    brief: 'developer-instructions', skill: 'brief', busy: 'output', adopt: true,
    tiers: {
      xsmall: { model: 'gpt-5.1-codex-mini', effort: 'medium' },
      small: { model: 'gpt-5.1-codex', effort: 'low' },
      medium: { model: 'gpt-5.1-codex', effort: 'medium' },
      high: { model: 'gpt-5.1-codex', effort: 'high' },
      max: { model: 'gpt-5.1-codex-max', effort: 'xhigh' },
    },
    delegate: null,
  },
  // Gemini CLI: -i runs the prompt and stays interactive. It has no flag for extra instructions that leaves the user's
  // GEMINI.md files and system prompt alone, so the brief goes in ahead of the first prompt.
  gemini: {
    id: 'gemini', label: 'Gemini CLI', command: 'gemini', install: 'npm i -g @google/gemini-cli',
    flags: { prompt: ['-i', '{}'], model: ['-m', '{}'], effort: null, session: null, resume: null, brief: null },
    brief: 'prompt-prefix', skill: 'brief', busy: 'output', adopt: true,
    tiers: {
      xsmall: { model: 'gemini-2.5-flash-lite' },
      small: { model: 'gemini-2.5-flash' },
      medium: { model: 'gemini-2.5-pro' },
      high: { model: 'gemini-2.5-pro' },
      max: { model: 'gemini-2.5-pro' },
    },
    delegate: null,
  },
};
const IDS = Object.keys(CLIS);

// 'claude', 'opencode', 'codex', 'gemini' from a command line's program ("C:\x\claude.exe --foo" -> claude), else 'other'.
// The whole command is tried first, so a path with spaces in it still counts.
function kindOfCommand(command) {
  const s = String(command || '').trim();
  for (const exe of [s, s.split(/\s+/)[0]]) {
    const m = /(?:^|[\\/])([^\\/]+?)(?:\.(?:exe|cmd|ps1))?$/i.exec(exe);
    const name = m ? m[1].toLowerCase() : '';
    if (Object.prototype.hasOwnProperty.call(CLIS, name)) return name;
  }
  return 'other';
}
// An agent entry ({ id, command, ... }) -> its CLI id or 'other'.
const kindOf = agent => kindOfCommand(agent && agent.command);
const is = (agent, id) => kindOf(agent) === id;
const get = id => (Object.prototype.hasOwnProperty.call(CLIS, id) ? CLIS[id] : null);
const labelOf = id => (get(id) ? CLIS[id].label : String(id || 'an agent'));

// A CLI's flag filled in with a value -> argument list; [] when the CLI has no such flag or there is no value.
// Any other agent (a custom command) takes only a prompt, positionally.
function flag(id, name, value) {
  if (value == null || value === '') return [];
  const t = get(id) ? CLIS[id].flags[name] : name === 'prompt' ? ['{}'] : null;
  return t ? t.map(p => p.replace('{toml}', () => JSON.stringify(String(value))).replace('{}', () => String(value))) : [];
}

// The CLI a project's team runs on: the project's saved choice (projectDefaults.agents), else the CLI of its
// default agent (the project's own, then the app's). `agents` is the configured agents list.
function leadCli({ agents, defaultAgent, project } = {}) {
  const p = project || {};
  if (Object.prototype.hasOwnProperty.call(CLIS, p.agents)) return p.agents;
  const list = agents || [];
  const a = list.find(x => x.id === p.agent) || list.find(x => x.id === defaultAgent) || list[0];
  return kindOf(a);
}

const api = { CLIS, IDS, kindOfCommand, kindOf, is, get, labelOf, flag, leadCli };
if (typeof module !== 'undefined') module.exports = api; else globalThis.CliRegistry = api;
})();
