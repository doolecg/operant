// The agent plugin (agent-plugin/): the folder Operant hands to each Claude Code and OpenCode session so
// it has the `operant` skill and, for Claude Code, the hooks that give it its live context. Claude Code
// loads only what the manifest and hooks.json describe, and the installer ships only what package.json
// lists, so a slip in any of them leaves agents without the skill and nothing says so.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pkg = require('../package.json');
const { HANDLERS } = require('../bin/operant-hook.js');

const plugin = path.join(__dirname, '..', 'agent-plugin');
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(plugin, ...p), 'utf8'));

test('plugin.json names the plugin and carries the app\'s version', () => {
  const m = readJson('.claude-plugin', 'plugin.json');
  assert.equal(m.name, 'operant', 'the skill is then operant:operant, the name the brief gives Claude Code');
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
  assert.equal(m.version, pkg.version, `set "version" in agent-plugin/.claude-plugin/plugin.json to ${pkg.version}: a release changes both`);
  assert.ok(typeof m.description === 'string' && m.description.trim());
  assert.ok(typeof m.author?.name === 'string' && m.author.name.trim());
});

test('the plugin has two skills, operant and refine', () => {
  assert.deepEqual(fs.readdirSync(path.join(plugin, 'skills')).sort(), ['operant', 'refine']);
  for (const name of ['operant', 'refine']) assert.ok(fs.statSync(path.join(plugin, 'skills', name, 'SKILL.md')).isFile());
});

test('every hook runs `operant hook <event>` for an event the CLI handles', () => {
  const { hooks } = readJson('hooks', 'hooks.json');
  const commands = Object.values(hooks).flatMap(groups => groups.flatMap(g => g.hooks.map(h => h.command)));
  assert.ok(commands.length > 0);
  for (const c of commands) {
    assert.match(c, /^operant hook [a-z-]+$/, c);
    assert.ok(c.slice('operant hook '.length) in HANDLERS, `no handler in bin/operant-hook.js for: ${c}`);
  }
});

// A matcher would leave out some of the starts (startup, resume, /clear, compact, fork), and after a
// compact the context from before it is gone, so it has to be given again. PreToolUse is the CodeGraph-first
// gate: it only sees the tools that can search or call CodeGraph.
test('the SessionStart and SubagentStart hooks have no matcher, the PreToolUse gate matches search and CodeGraph tools', () => {
  const { hooks } = readJson('hooks', 'hooks.json');
  assert.deepEqual(Object.keys(hooks).sort(), ['PreToolUse', 'SessionStart', 'SubagentStart']);
  for (const k of ['SessionStart', 'SubagentStart']) for (const group of hooks[k]) assert.ok(!('matcher' in group));
  assert.equal(hooks.PreToolUse.length, 1);
  assert.equal(hooks.PreToolUse[0].matcher, 'Grep|Bash|PowerShell|mcp__codegraph.*');
  assert.equal(hooks.PreToolUse[0].hooks[0].command, 'operant hook pre-tool-use');
});

test('the installer ships the plugin folder, unpacked, and nothing of the evals', () => {
  for (const [name, list] of [['files', pkg.build.files], ['asarUnpack', pkg.build.asarUnpack]]) {
    assert.ok(list.includes('agent-plugin/**'), `${name} needs agent-plugin/**`);
    assert.ok(!list.some(p => /evals/.test(p)), `${name} lists an evals folder`);
  }
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      assert.ok(e.name !== 'evals', `${path.join(dir, e.name)} would be shipped`);
      if (e.isDirectory()) walk(path.join(dir, e.name));
    }
  })(plugin);
});

test('the plugin has one subagent per role, which Claude Code loads as operant:<role>', () => {
  const { NAMES } = require('../roles.js');
  assert.deepEqual(fs.readdirSync(path.join(plugin, 'agents')).sort(), NAMES.map(n => `${n}.md`).sort());
});
