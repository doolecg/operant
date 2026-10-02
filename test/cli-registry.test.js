// Tests for cli-registry.js: one table of the agent CLIs, and the project's lead CLI a team runs on.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../cli-registry.js');

test('every CLI describes its command, install, flags, brief, skill, busy detection and tiers', () => {
  assert.deepEqual(R.IDS, ['claude', 'opencode', 'codex', 'gemini']);
  for (const id of R.IDS) {
    const c = R.CLIS[id];
    assert.equal(c.id, id);
    for (const k of ['label', 'command', 'install', 'brief', 'busy']) assert.ok(c[k], `${id}.${k}`);
    for (const k of ['prompt', 'model', 'effort', 'session']) assert.ok(k in c.flags, `${id}.flags.${k}`);
    assert.ok('skill' in c && 'tiers' in c, id);
  }
  assert.deepEqual(R.CLIS.claude.flags.model, ['--model', '{}']);
  assert.deepEqual(R.CLIS.opencode.flags.prompt, ['--prompt', '{}']);
  assert.match(R.CLIS.codex.install, /@openai\/codex/);
  assert.match(R.CLIS.gemini.install, /@google\/gemini-cli/);
  assert.equal(R.CLIS.codex.busy, 'output');
  assert.equal(R.CLIS.gemini.busy, 'output');
});

test("flag fills in each CLI's own launch arguments", () => {
  assert.deepEqual(R.flag('claude', 'model', 'claude-opus-5-5'), ['--model', 'claude-opus-5-5']);
  assert.deepEqual(R.flag('claude', 'effort', 'high'), ['--effort', 'high']);
  assert.deepEqual(R.flag('claude', 'prompt', 'hi'), ['hi']);
  assert.deepEqual(R.flag('claude', 'session', 'abc'), ['--session-id', 'abc']);
  assert.deepEqual(R.flag('opencode', 'prompt', 'hi'), ['--prompt', 'hi']);
  assert.deepEqual(R.flag('opencode', 'effort', 'high'), [], 'OpenCode takes effort as a model variant, not a flag');
  assert.deepEqual(R.flag('opencode', 'port', 4096), ['--port', '4096']);
  assert.deepEqual(R.flag('codex', 'prompt', 'fix it'), ['fix it']);
  assert.deepEqual(R.flag('codex', 'model', 'gpt-5.1-codex'), ['-m', 'gpt-5.1-codex']);
  assert.deepEqual(R.flag('codex', 'effort', 'high'), ['-c', 'model_reasoning_effort=high']);
  assert.deepEqual(R.flag('codex', 'brief', 'a "b"\nc'), ['-c', 'developer_instructions="a \\"b\\"\\nc"'], 'the brief is a TOML string');
  assert.deepEqual(R.flag('gemini', 'prompt', 'fix it'), ['-i', 'fix it']);
  assert.deepEqual(R.flag('gemini', 'model', 'gemini-2.5-pro'), ['-m', 'gemini-2.5-pro']);
  assert.deepEqual(R.flag('gemini', 'effort', 'high'), []);
  assert.deepEqual(R.flag('gemini', 'brief', 'x'), [], 'Gemini gets the brief in its first prompt');
  assert.deepEqual(R.flag('codex', 'session', 'abc'), []);
  assert.deepEqual(R.flag('claude', 'model', ''), []);
  assert.deepEqual(R.flag('other', 'prompt', 'hi'), ['hi'], 'a custom agent takes the prompt positionally');
  assert.deepEqual(R.flag('other', 'model', 'x'), []);
});

test('Codex and Gemini have default tiers; Codex by reasoning effort, Gemini flash-lite, flash, pro', () => {
  assert.deepEqual(Object.keys(R.CLIS.codex.tiers), ['xsmall', 'small', 'medium', 'high', 'max']);
  for (const t of Object.values(R.CLIS.codex.tiers)) { assert.match(t.model, /^gpt-5/); assert.match(t.effort, /^(low|medium|high|xhigh)$/); }
  const g = R.CLIS.gemini.tiers;
  assert.deepEqual([g.xsmall.model, g.small.model, g.medium.model, g.high.model, g.max.model].map(m => m.replace(/^gemini-[\d.]+-/, '')), ['flash-lite', 'flash', 'pro', 'pro', 'pro']);
  assert.ok(Object.values(g).every(t => !t.effort));
});

test('kindOf recognises a CLI however its command is written', () => {
  for (const [cmd, kind] of [['claude', 'claude'], ['claude --verbose', 'claude'], ['C:\\tools\\claude.exe', 'claude'], ['/usr/bin/opencode', 'opencode'],
    ['opencode.cmd run', 'opencode'], ['C:\\Program Files\\OpenCode\\opencode.exe', 'opencode'], ['codex', 'codex'], ['gemini.ps1', 'gemini'],
    ['aider', 'other'], ['claudette', 'other'], ['', 'other'], ['constructor', 'other']]) {
    assert.equal(R.kindOfCommand(cmd), kind, cmd);
  }
  assert.equal(R.kindOf({ id: 'x', command: 'opencode' }), 'opencode');
  assert.equal(R.kindOf(undefined), 'other');
  assert.equal(R.is({ command: 'claude' }, 'claude'), true);
  assert.equal(R.is({ command: 'claude' }, 'opencode'), false);
  assert.equal(R.labelOf('opencode'), 'OpenCode');
  assert.equal(R.get('nope'), null);
});

test('leadCli: the project\'s pick, else its default agent\'s CLI, else the app default agent\'s', () => {
  const agents = [{ id: 'claude', command: 'claude' }, { id: 'oc', command: 'opencode' }, { id: 'aider', command: 'aider' }];
  assert.equal(R.leadCli({ agents, defaultAgent: 'claude' }), 'claude');
  assert.equal(R.leadCli({ agents, defaultAgent: 'oc' }), 'opencode');
  assert.equal(R.leadCli({ agents, defaultAgent: 'claude', project: { agent: 'oc' } }), 'opencode');
  assert.equal(R.leadCli({ agents, defaultAgent: 'claude', project: { agent: 'claude', agents: 'opencode' } }), 'opencode');
  assert.equal(R.leadCli({ agents, defaultAgent: 'claude', project: { agents: 'both' } }), 'claude', "an old 'both' follows the default agent");
  assert.equal(R.leadCli({ agents, defaultAgent: 'aider' }), 'other');
});

test('the old detection helpers go through the registry', () => {
  const { isOpenCode } = require('../opencode.js');
  assert.equal(isOpenCode({ command: 'C:\\x\\opencode.exe --port 1' }), true);
  assert.equal(isOpenCode({ command: 'claude' }), false);
  assert.equal(isOpenCode(undefined), false);
});

test('flag replaces {} and {toml} in one pass, so a literal {} in the text survives', () => {
  assert.deepEqual(R.flag('codex', 'brief', 'use {} here'), ['-c', 'developer_instructions="use {} here"']);
  assert.deepEqual(R.flag('claude', 'prompt', 'a {toml} b {}'), ['a {toml} b {}']);
});

test('kindOfCommand sees through npx, bunx and pnpm dlx wrappers and .cmd/.exe suffixes', () => {
  const k = R.kindOfCommand;
  assert.equal(k('npx @openai/codex'), 'codex');
  assert.equal(k('npx -y @google/gemini-cli@latest --x'), 'gemini');
  assert.equal(k('bunx opencode-ai'), 'opencode');
  assert.equal(k('pnpm dlx @openai/codex'), 'codex');
  assert.equal(k('C:\\Users\\a b\\AppData\\Roaming\\npm\\NPX.CMD @openai/codex'), 'codex');
  assert.equal(k('C:\\npm\\Codex.CMD'), 'codex');
  assert.equal(k('C:\\npm\\GEMINI.exe --yolo'), 'gemini');
  assert.equal(k('npx cowsay'), 'other');
  assert.equal(k('npm install'), 'other');
});

test('Codex launches keep Operant env vars in the shell tool', () => {
  assert.ok(R.CLIS.codex.launch.includes('shell_environment_policy.ignore_default_excludes=true'));
});
