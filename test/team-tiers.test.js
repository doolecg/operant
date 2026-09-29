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
  assert.equal(tt.activeTiers({ team: { tiers: base }, agents, defaultAgent: 'claude', isOpenCode, models: [free, openai] }), base);
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

const full = {
  xsmall: { agent: 'opencode', model: 'opencode/big-pickle', use: 'very easy tasks: look things up in the code, read and summarise files, renames, run tests, docs tweaks (no web research)' },
  small: { agent: 'claude', model: 'claude-haiku-4-5', use: 'simple tasks: simple edits, small bug fixes, tests' },
  medium: { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'low', use: 'medium tasks: a feature across a few files, a normal bug fix, research' },
  high: { agent: 'claude', model: 'claude-opus-5-5', effort: 'high', use: 'hard tasks: tricky debugging, a multi-file refactor' },
  max: { agent: 'claude', model: 'claude-opus-5-5', effort: 'max', use: 'the hardest problems: architecture' },
};
const isClaude = a => a.command === 'claude';
const act = (installed, models, defaultAgent = 'claude') => tt.activeTiers({ team: { tiers: full }, agents, defaultAgent, isOpenCode, isClaude, models, installed });

test('both installed: configured tiers unchanged', () => {
  assert.equal(act({ claude: true, opencode: true }, [free]), full);
  assert.equal(act(undefined, null), full);
});

test('OpenCode missing: xsmall falls back to Claude Haiku, marked', () => {
  const t = act({ claude: true, opencode: false }, null);
  assert.equal(t.xsmall.model, 'claude-haiku-4-5');
  assert.equal(t.xsmall.agent, 'claude');
  assert.equal(t.xsmall.fallback, 'OpenCode not installed');
  assert.equal(t.xsmall.use, full.xsmall.use);
  assert.equal(t.small, full.small);
});

test('OpenCode model missing from its list also falls back', () => {
  const t = act({ claude: true, opencode: true }, [openai]);
  assert.match(t.xsmall.fallback, /not available in OpenCode/);
});

test('Claude missing: slots come from OpenCode, others dropped', () => {
  const t = act({ claude: false, opencode: true }, [free, openai]);
  assert.deepEqual(Object.keys(t), ['xsmall', 'small', 'medium', 'high', 'max']);
  assert.equal(t.xsmall, full.xsmall);
  assert.equal(t.small.model, 'openai/gpt-5.5');
  assert.equal(t.small.fallback, 'Claude Code not installed');
  const free1 = act({ claude: false, opencode: true }, [free]);
  assert.deepEqual(Object.keys(free1), ['xsmall']);
});

test('neither installed leaves nothing', () => {
  assert.deepEqual(act({ claude: false, opencode: false }, null), {});
});

test('opencodeSubagents makes tier-<name> entries for OpenCode tiers only', () => {
  const t = tt.opencodeSubagents({ ...full, small: { ...full.small, agent: 'opencode', model: 'openai/gpt-5.5', effort: 'low' } }, id => id === 'opencode');
  assert.deepEqual(Object.keys(t), ['tier-xsmall', 'tier-small']);
  assert.deepEqual(t['tier-small'], { mode: 'subagent', model: 'openai/gpt-5.5', variant: 'low', description: full.small.use });
  assert.equal(t['tier-xsmall'].variant, undefined);
  assert.deepEqual(tt.mergeSubagents({ build: { x: 1 }, 'tier-xsmall': { mine: 1 } }, t)['tier-xsmall'], { mine: 1 });
});

test('suggestTier scores, floors and defaults', () => {
  const s = p => tt.suggestTier(p, full);
  assert.equal(s('rename the variable foo to bar and run tests').tier, 'xsmall');
  assert.equal(s('fix a small bug in the parser').tier, 'small');
  assert.equal(s('add a feature across a few files').tier, 'medium');
  assert.equal(s('tricky debugging of the race').tier, 'high');
  assert.equal(s('do the thing').tier, 'small');
  assert.equal(s('do the thing').reason, 'default');
  assert.equal(s('research how the docs lookup works and rename it').tier, 'small');
  assert.equal(s('x '.repeat(500) + 'rename').tier, 'medium');
  assert.equal(tt.suggestTier('rename it', { xsmall: full.xsmall, small: full.small }).tier, 'xsmall');
  assert.equal(tt.suggestTier('x '.repeat(500), { xsmall: full.xsmall, small: full.small }).tier, 'small');
});

// Item 82: per-project agent choice.
const tierKinds = { isClaude: t => t.agent === 'claude', isOpenCode: t => t.agent === 'opencode' };

test('tiersForMode: both leaves the tiers as they are', () => {
  const r = tt.tiersForMode(full, 'both', tierKinds);
  assert.equal(r.tiers, full); assert.deepEqual(r.removed, []); assert.equal(r.empty, false);
  assert.equal(tt.tiersForMode(full, undefined, tierKinds).tiers, full);
});

test('tiersForMode: Claude only swaps the OpenCode slot for the next Claude tier, marked', () => {
  const r = tt.tiersForMode(full, 'claude', tierKinds);
  assert.deepEqual(Object.keys(r.tiers), ['xsmall', 'small', 'medium', 'high', 'max']);
  assert.ok(Object.values(r.tiers).every(t => t.agent === 'claude'));
  assert.equal(r.tiers.xsmall.model, 'claude-haiku-4-5');
  assert.equal(r.tiers.xsmall.use, full.xsmall.use);
  assert.equal(r.tiers.xsmall.fallback, 'Claude only');
  assert.equal(r.tiers.small, full.small);
  assert.deepEqual(r.removed, []); assert.equal(r.empty, false);
});

test('tiersForMode: OpenCode only drops Claude slots it has no tier for, never faking one', () => {
  const r = tt.tiersForMode(full, 'opencode', tierKinds);
  assert.deepEqual(Object.keys(r.tiers), ['xsmall']);
  assert.deepEqual(r.removed, ['small', 'medium', 'high', 'max']);
  assert.equal(r.empty, false);
  const d = tt.opencodeTiers([free, openai], full, 'opencode');
  const withPaid = tt.tiersForMode(full, 'opencode', { ...tierKinds, derived: d });
  assert.equal(withPaid.tiers.small.model, 'openai/gpt-5.5');
  assert.equal(withPaid.tiers.small.use, full.small.use);
  assert.equal(withPaid.tiers.max.effort, 'xhigh');
  assert.ok(Object.values(withPaid.tiers).every(t => t.agent === 'opencode'));
});

test('tiersForMode: OpenCode only with OpenCode not installed is empty', () => {
  const avail = act({ claude: true, opencode: false }, null);
  const r = tt.tiersForMode(avail, 'opencode', tierKinds);
  assert.deepEqual(r.tiers, {}); assert.equal(r.empty, true); assert.equal(r.removed.length, 5);
  const byMode = tt.tiersByMode({ base: full, agents, isOpenCode, isClaude, installed: { claude: true, opencode: false }, models: null });
  assert.equal(byMode.opencode.empty, true);
  assert.equal(byMode.claude.empty, false);
  assert.equal(tt.tiersByMode({ base: full, agents, isOpenCode, isClaude, installed: { claude: false, opencode: true }, models: [free] }).claude.empty, true);
});

test('modeConflict: an explicit choice for the other CLI names the mode and how to change it', () => {
  assert.equal(tt.modeConflict('both', 'agent "opencode"', 'opencode'), null);
  assert.equal(tt.modeConflict('claude', 'agent "claude"', 'claude'), null);
  assert.equal(tt.modeConflict('claude', 'model "x"', 'other'), null);
  const m = tt.modeConflict('claude', 'agent "opencode"', 'opencode');
  assert.match(m, /Claude only/); assert.match(m, /agent "opencode"/); assert.match(m, /sidebar menu/); assert.match(m, /Settings/);
  assert.match(tt.modeConflict('opencode', 'tier "small"', 'claude'), /OpenCode only.*Claude/);
});
