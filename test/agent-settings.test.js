// Item 94: the plain-language text, presets and warnings behind Settings > Agents.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const A = require('../agent-settings');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const defTeam = () => {
  const num = re => +re.exec(main)[1];
  const budgets = Object.fromEntries([...(/budgets: \{([^}]*)\}/.exec(main)[1]).matchAll(/(\w+): (\d+)/g)].map(m => [m[1], +m[2]]));
  return { enabled: false, budgets, savingProgress: 'over', dailyCap: num(/dailyCap: (\d+)/), maxWorkers: num(/maxWorkers: (\d+)/), maxTier: /maxTier: '(\w+)'/.exec(main)[1], verifyBeforeReview: true };
};
const cfg = over => ({ agents: [{ id: 'claude', name: 'Claude Code' }, { id: 'opencode', name: 'OpenCode' }], messaging: false,
  team: { ...defTeam(), enabled: true, tiers: { free: { agent: 'opencode', model: 'opencode/big-pickle', fallbacks: [{ local: true }] }, xsmall: { agent: 'opencode', model: 'x' }, small: { agent: 'claude', model: 'claude-sonnet-5-5' } }, ...over } });

test('Balanced is the shipped default, so the default team matches it and nothing else', () => {
  const d = defTeam();
  assert.deepStrictEqual(A.presetDiff(d, 'balanced'), []);
  assert.strictEqual(A.detectPreset(d).id, 'balanced');
  assert.ok(A.presetDiff(d, 'cheapest').length > 5 && A.presetDiff(d, 'best').length > 5);
});

test('a preset previews what it changes without changing anything, then applies exactly that', () => {
  const d = Object.freeze(defTeam());
  const diff = A.presetDiff(d, 'cheapest');
  assert.ok(diff.some(c => c.path === 'maxTier' && c.from === 'small' && c.to === 'xsmall'));
  assert.match(diff.find(c => c.path === 'budgets.small').text, /Small token limit: 300k -> 200k/);
  const next = A.applyPreset(d, 'cheapest');
  assert.strictEqual(d.maxTier, 'small', 'the input is untouched');
  assert.strictEqual(A.detectPreset(next).id, 'cheapest');
  assert.deepStrictEqual(A.presetDiff(next, 'cheapest'), []);
});

test('applying a preset keeps team mode and tiers as they were', () => {
  const t = { ...defTeam(), enabled: true, tiers: { small: { agent: 'claude', model: 'm' } } };
  const next = A.applyPreset(t, 'best');
  assert.strictEqual(next.enabled, true);
  assert.deepStrictEqual(next.tiers, t.tiers);
});

test('own tweaks show as Custom, with the closest preset and how far off', () => {
  const t = { ...defTeam(), dailyCap: 500000 };
  const p = A.detectPreset(t);
  assert.deepStrictEqual([p.id, p.name, p.custom, p.nearest, p.changes], ['custom', 'Custom', true, 'balanced', 1]);
  assert.match(A.summary(cfg({ dailyCap: 500000 })).presetText, /^Custom: 1 setting differs from Balanced\./);
  assert.match(A.summary(cfg()).presetText, /^Preset: Balanced\./);
});

test('the summary is one sentence per line, each aimed at a row that exists', () => {
  const s = A.summary(cfg(), { labelOf: m => (m === 'opencode/big-pickle' ? 'Big Pickle' : m), localStatus: 'ready', localModel: 'gemma4:e4b' });
  assert.match(s.lines[0].text, /^Team mode is on/);
  assert.ok(s.lines.some(l => /Easy jobs go to Big Pickle first, with a backup/.test(l.text)));
  assert.ok(s.lines.some(l => /token limit \(free 100k, xsmall 150k, small 300k\)/.test(l.text)));
  assert.ok(s.lines.some(l => /no daily cap/i.test(l.text)));
  assert.ok(s.lines.some(l => /pauses the task and asks you before it moves up/.test(l.text)));
  assert.ok(s.lines.some(l => /local model \(gemma4:e4b\) is ready/.test(l.text)));
  for (const l of s.lines) { assert.ok(A.byId[l.target], l.target); assert.ok(!/\n/.test(l.text)); }
});

test('with team mode off the summary says so and leaves the worker lines out', () => {
  const s = A.summary(cfg({ enabled: false }));
  assert.match(s.lines[0].text, /^Team mode is off/);
  assert.ok(!s.lines.some(l => /workers run at once|token limit/.test(l.text)));
});

test('warnings sit on the row: tiny limit, lower tier bigger, cap under a limit, unknown agent, missing CLI', () => {
  const t = cfg({ budgets: { free: 100000, xsmall: 150000, small: 10000, medium: 600000, high: 1200000, max: 2000000 }, dailyCap: 5000, maxWorkers: 12, savingProgress: 'inside',
    tiers: { free: { agent: 'nope', model: 'm' }, small: { agent: 'claude', model: 'm' } } });
  const w = A.warnings(t, { missingAgents: ['claude'] });
  assert.match(w['budget.small'].join(' '), /10k is very small.*needs 20k/);
  assert.match(w['budget.small'].join(' '), /Smaller than a lower tier/);
  assert.match(w.dailyCap[0], /Below one worker's limit/);
  assert.match(w.maxWorkers[0], /Many workers/);
  assert.match(w['tier.free'][0], /not in your agent list/);
  assert.match(w['tier.small'][0], /claude, which is not installed/);
  assert.match(w.savingProgress[0], /under 20k/);
  assert.ok(!A.warnings(cfg())['budget.small']);
});

test('every setting has a label, a one-line what-it-does, when it applies and a developer term, in one of the five groups', () => {
  assert.deepStrictEqual(A.GROUPS, ['Who does the work', 'How much they may spend', 'When they get stuck', 'What they use', 'Local model']);
  for (const m of A.META) {
    for (const f of ['label', 'does', 'when', 'dev', 'group']) assert.ok(m[f], `${m.id} lacks ${f}`);
    assert.ok(A.GROUPS.includes(m.group), m.id);
    assert.ok(!/\n/.test(m.does) && m.does.length < 200, m.id);
    assert.ok(!m.label.includes('team.'), 'developer terms stay out of the label');
  }
  assert.strictEqual(new Set(A.META.map(m => m.id)).size, A.META.length);
});

test('items 91/92/96 are all there: ask before moving up, limits, suggestions, saving, daily cap, routes', () => {
  for (const id of ['askBeforeMoveUp', 'budget.free', 'suggest', 'savingProgress', 'dailyCap', 'routing']) assert.ok(A.byId[id], id);
});

test('search finds a setting by its label, its description or its developer term', () => {
  assert.ok(A.matches(A.byId.dailyCap, 'daily cap'));
  assert.ok(A.matches(A.byId.dailyCap, 'team.dailycap'));
  assert.ok(A.matches(A.byId.maxTier, 'above this tier'));
  assert.ok(!A.matches(A.byId.dailyCap, 'sandwich'));
  assert.ok(A.META.filter(m => A.matches(m, 'token limit')).length >= 6);
});

test('effective values read plainly', () => {
  const c = cfg({ dailyCap: 2000000 });
  assert.strictEqual(A.effective(c, 'dailyCap'), '2M tokens a day');
  assert.strictEqual(A.effective(c, 'budget.small'), '300k tokens per task');
  assert.strictEqual(A.effective(c, 'maxTier'), 'Small and below');
  assert.strictEqual(A.effective(cfg({ verifyBeforeReview: false }), 'verifyBeforeReview'), 'Off');
});

test('changedFrom lists the team settings that differ from the defaults', () => {
  const d = defTeam();
  assert.deepStrictEqual(A.changedFrom(d, d), []);
  assert.deepStrictEqual(A.changedFrom({ ...d, dailyCap: 1, budgets: { ...d.budgets, free: 5 } }, d), ['dailyCap', 'budgets.free']);
});

test('Refined prompts go to is a Who does the work setting: a Claude tile by default, team work when chosen', () => {
  const m = A.byId.refineTo;
  assert.strictEqual(m.group, A.GROUPS[0]);
  assert.ok(m.label && m.does && m.when && m.dev === 'refineTo');
  assert.strictEqual(A.effective(cfg(), 'refineTo'), 'A Claude tile');
  assert.strictEqual(A.effective({ ...cfg(), refineTo: 'team' }, 'refineTo'), 'Team work');
  assert.match(A.effective({ ...cfg({ enabled: false }), refineTo: 'team' }, 'refineTo'), /team mode is off, so a send is refused/);
  assert.ok(A.matches(m, 'refined'));
  assert.match(main, /refineTo: 'claude'/);
});
