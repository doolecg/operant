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
const free = { id: 'big-pickle', providerID: 'opencode', cost: { input: 0, output: 0 }, variants: {} };
const openai = { id: 'gpt-5.5', providerID: 'openai', release_date: '2026-05-01', cost: { input: 1 }, variants: { low: {}, medium: {}, high: {}, xhigh: {} } };

test('parseModels reads opencode models --verbose output', () => {
  const text = `opencode/big-pickle\n${JSON.stringify(free, null, 2)}\nopenai/gpt-5.5\n${JSON.stringify(openai, null, 2)}\n`;
  assert.deepEqual(tt.parseModels(text).map(m => m.id), ['big-pickle', 'gpt-5.5']);
});

test('Claude Code as default keeps only the configured Claude tiers', () => {
  const t = tt.activeTiers({ team: { tiers: base }, agents, defaultAgent: 'claude', models: [free, openai] });
  assert.deepEqual(t, { small: base.small, medium: base.medium });
});

test('OpenCode with only free Zen models has one tier', () => {
  const t = tt.activeTiers({ team: { tiers: base }, agents, defaultAgent: 'opencode', models: [free] });
  assert.deepEqual(t, { xsmall: { agent: 'opencode', model: 'opencode/big-pickle', use: 'easy' } });
});

test('OpenCode with an OpenAI model gets a tier per effort variant', () => {
  const t = tt.activeTiers({ team: { tiers: base }, agents, defaultAgent: 'opencode', models: [free, openai] });
  assert.deepEqual(Object.keys(t), ['xsmall', 'small', 'medium', 'high', 'max']);
  assert.deepEqual(t.small, { agent: 'opencode', model: 'openai/gpt-5.5', effort: 'low', use: 'smaller' });
  assert.equal(t.max.effort, 'xhigh');
});

test('free Zen models with variants do not add tiers', () => {
  const t = tt.activeTiers({ team: { tiers: base }, agents, defaultAgent: 'opencode', models: [{ ...free, variants: { high: {} } }] });
  assert.deepEqual(Object.keys(t), ['xsmall']);
});

const full = {
  xsmall: { agent: 'opencode', model: 'opencode/big-pickle', use: 'very easy tasks: look things up in the code, read and summarise files, renames, run tests, docs tweaks (no web research)' },
  small: { agent: 'claude', model: 'claude-haiku-4-5', use: 'simple tasks: simple edits, small bug fixes, tests' },
  medium: { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'low', use: 'medium tasks: a feature across a few files, a normal bug fix, research' },
  high: { agent: 'claude', model: 'claude-opus-5-5', effort: 'high', use: 'hard tasks: tricky debugging, a multi-file refactor' },
  max: { agent: 'claude', model: 'claude-opus-5-5', effort: 'max', use: 'the hardest problems: architecture' },
};
const act = (installed, models, defaultAgent = 'claude') => tt.activeTiers({ team: { tiers: full }, agents, defaultAgent, models, installed });
const byCli = (installed, models, b = full) => tt.tiersByMode({ base: b, agents, installed, models });

test('a Claude team never borrows an OpenCode tier: the OpenCode slot is dropped', () => {
  const r = byCli({ claude: true, opencode: true }, [free]).claude;
  assert.deepEqual(Object.keys(r.tiers), ['small', 'medium', 'high', 'max']);
  assert.ok(Object.values(r.tiers).every(t => t.agent === 'claude'));
  assert.equal(r.tiers.small, full.small);
  assert.deepEqual(r.removed, ['xsmall']);
  assert.deepEqual(act(undefined, null), r.tiers);
});

test('a slot on another CLI with a fallback route on this CLI runs that route, marked', () => {
  const b = { ...full, xsmall: { ...full.xsmall, fallbacks: [{ agent: 'claude', model: 'claude-haiku-4-5' }] } };
  const r = byCli({}, null, b);
  assert.equal(r.claude.tiers.xsmall.agent, 'claude');
  assert.equal(r.claude.tiers.xsmall.model, 'claude-haiku-4-5');
  assert.equal(r.claude.tiers.xsmall.use, full.xsmall.use);
  assert.equal(r.claude.tiers.xsmall.fallback, 'Claude Code team');
  assert.equal(r.opencode.tiers.xsmall.fallbacks, undefined, 'the Claude route is left out of the OpenCode tier');
});

test('fallback routes on another CLI are left out; the local model only stays for OpenCode', () => {
  const b = { free: { agent: 'opencode', model: 'opencode/big-pickle', fallbacks: [{ local: true }], use: 'f' },
    small: { agent: 'claude', model: 'claude-sonnet-5-5', fallbacks: [{ agent: 'opencode', model: 'openai/gpt-5.5' }, { model: 'claude-opus-5-5' }, { local: true }], use: 's' } };
  const r = byCli({}, null, b);
  assert.deepEqual(r.claude.tiers.small.fallbacks, [{ model: 'claude-opus-5-5' }]);
  assert.deepEqual(r.opencode.tiers.free.fallbacks, [{ local: true }]);
  assert.equal(r.claude.tiers.free, undefined, 'no OpenCode free tier in a Claude team');
});

test('OpenCode model missing from its list: its own derived tier, marked', () => {
  const b = { ...full, xsmall: { ...full.xsmall, model: 'opencode/gone' } };
  const t = byCli({ claude: true, opencode: true }, [free], b).opencode.tiers;
  assert.equal(t.xsmall.model, 'opencode/big-pickle');
  assert.match(t.xsmall.fallback, /not available in OpenCode/);
});

test('Claude missing: the Claude team is empty, nothing comes from OpenCode', () => {
  assert.deepEqual(act({ claude: false, opencode: true }, [free, openai]), {});
  const r = byCli({ claude: false, opencode: true }, [free, openai]);
  assert.equal(r.claude.empty, true);
  assert.equal(r.opencode.tiers.small.model, 'openai/gpt-5.5');
  assert.equal(r.opencode.tiers.small.fallback, undefined);
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

// Single-CLI teams: each CLI gets only its own tiers.
test('OpenCode team: its own tiers and derived ones, never a Claude tier', () => {
  const r = byCli({}, null).opencode;
  assert.deepEqual(Object.keys(r.tiers), ['xsmall']);
  assert.deepEqual(r.removed, ['small', 'medium', 'high', 'max']);
  const withPaid = byCli({}, [free, openai]).opencode;
  assert.equal(withPaid.tiers.small.model, 'openai/gpt-5.5');
  assert.equal(withPaid.tiers.small.use, full.small.use);
  assert.equal(withPaid.tiers.max.effort, 'xhigh');
  assert.ok(Object.values(withPaid.tiers).every(t => t.agent === 'opencode'));
});

test('a CLI that is not installed has an empty team; only CLIs with an agent get one', () => {
  const r = byCli({ claude: true, opencode: false }, null);
  assert.equal(r.opencode.empty, true); assert.equal(r.opencode.removed.length, 5);
  assert.equal(r.claude.empty, false);
  assert.deepEqual(Object.keys(tt.tiersByMode({ base: full, agents: [agents[0]] })), ['claude']);
  assert.deepEqual(tt.AGENT_MODES, ['claude', 'opencode', 'codex', 'gemini']);
});

test('Codex and Gemini teams take their registry tiers, with the configured use text, never another CLI\'s', () => {
  const all = [...agents, { id: 'codex', command: 'codex' }, { id: 'gemini', command: 'gemini' }];
  const r = tt.tiersByMode({ base: full, agents: all });
  assert.deepEqual(Object.keys(r), ['claude', 'opencode', 'codex', 'gemini']);
  const cx = r.codex.tiers, gm = r.gemini.tiers;
  assert.deepEqual(Object.keys(cx), ['xsmall', 'small', 'medium', 'high', 'max']);
  assert.ok(Object.values(cx).every(t => t.agent === 'codex' && /^gpt-5/.test(t.model) && t.effort));
  assert.deepEqual([cx.small.effort, cx.medium.effort, cx.high.effort], ['low', 'medium', 'high']);
  assert.equal(cx.high.use, full.high.use);
  assert.deepEqual(Object.values(gm).map(t => t.model.replace(/^gemini-[\d.]+-/, '')), ['flash-lite', 'flash', 'pro', 'pro', 'pro']);
  assert.ok(Object.values(gm).every(t => t.agent === 'gemini' && !t.effort));
  assert.equal(tt.tiersByMode({ base: full, agents: all, installed: { codex: false } }).codex.empty, true, 'not installed: no Codex team');
  const own = { ...full, small: { agent: 'codex', model: 'gpt-5.1-codex-mini', effort: 'high', use: 'mine' } };
  assert.deepEqual(tt.tiersByMode({ base: own, agents: all }).codex.tiers.small, own.small, 'a tier set to Codex in Settings wins');
  assert.equal(tt.activeTiers({ team: { tiers: full }, agents: all, defaultAgent: 'gemini' }).small.model, gm.small.model);
});

test('modeConflict: naming another CLI than the team uses is refused with how to change it', () => {
  assert.equal(tt.modeConflict('claude', 'agent "claude"', 'claude'), null);
  assert.equal(tt.modeConflict('claude', 'model "x"', 'other'), null);
  const m = tt.modeConflict('claude', 'agent "opencode"', 'opencode');
  assert.match(m, /team runs on Claude Code/); assert.match(m, /agent "opencode" runs on OpenCode/); assert.match(m, /one CLI/);
  assert.match(m, /sidebar menu/); assert.match(m, /Settings/);
  assert.match(tt.modeConflict('opencode', 'tier "small"', 'claude'), /OpenCode.*Claude Code/);
  assert.match(tt.modeConflict('claude', 'agent "codex"', 'codex'), /runs on Codex/);
});
