// Tests for team-tiers.js: tiers follow the default agent, and OpenCode's come from its models.
const test = require('node:test');
const assert = require('node:assert/strict');
const tt = require('../team-tiers.js');

const base = {
  xsmall: { agent: 'opencode', model: 'opencode/big-pickle', use: 'easy' },
  small: { agent: 'claude', model: 'claude-sonnet-5-5', use: 'smaller' },
  medium: { agent: 'claude', model: 'claude-opus-5-5', effort: 'medium', use: 'hard' },
};
const agents = [{ id: 'claude', command: 'claude' }, { id: 'opencode', command: 'opencode' }];
const isOpenCode = a => a.command === 'opencode';
const free = { id: 'big-pickle', providerID: 'opencode', cost: { input: 0, output: 0 }, variants: {} };
const openai = { id: 'gpt-5.5', providerID: 'openai', release_date: '2026-05-01', cost: { input: 1 }, variants: { low: {}, medium: {}, high: {}, xhigh: {} } };

test('parseModels reads opencode models --verbose output', () => {
  const text = `opencode/big-pickle\n${JSON.stringify(free, null, 2)}\nopenai/gpt-5.5\n${JSON.stringify(openai, null, 2)}\n`;
  assert.deepEqual(tt.parseModels(text).map(m => m.id), ['big-pickle', 'gpt-5.5']);
});

test('Claude Code as default keeps the configured tiers', () => {
  assert.equal(tt.activeTiers({ team: { tiers: base }, agents, defaultAgent: 'claude', isOpenCode, models: [openai] }), base);
});

test('OpenCode with only free Zen models has one tier', () => {
  const t = tt.activeTiers({ team: { tiers: base }, agents, defaultAgent: 'opencode', isOpenCode, models: [free] });
  assert.deepEqual(t, { xsmall: { agent: 'opencode', model: 'opencode/big-pickle', use: 'easy' } });
});

test('OpenCode with an OpenAI model gets a tier per effort variant', () => {
  const t = tt.activeTiers({ team: { tiers: base }, agents, defaultAgent: 'opencode', isOpenCode, models: [free, openai] });
  assert.deepEqual(Object.keys(t), ['xsmall', 'small', 'medium', 'high', 'max']);
  assert.deepEqual(t.small, { agent: 'opencode', model: 'openai/gpt-5.5', effort: 'low', use: 'smaller' });
  assert.equal(t.max.effort, 'xhigh');
});

test('free Zen models with variants do not add tiers', () => {
  const t = tt.activeTiers({ team: { tiers: base }, agents, defaultAgent: 'opencode', isOpenCode, models: [{ ...free, variants: { high: {} } }] });
  assert.deepEqual(Object.keys(t), ['xsmall']);
});
