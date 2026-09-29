// The pure helpers of renderer/terminal.js: the review diff, key handling, history stepping, result normalising.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const T = require('../renderer/terminal.js');

test('diff marks what was cut and what was added, and keeps the rest', () => {
  const d = T.diffHtml('please could you fix the login bug', 'fix the login bug');
  assert.match(d.original, /<del>please could you\s*<\/del>|<del>please could you<\/del>/);
  assert.ok(!d.cleaned.includes('<del>'));
  const e = T.diffHtml('fix bug', 'fix the bug now');
  assert.match(e.cleaned, /<ins>the\s*<\/ins>/);
  assert.match(e.cleaned, /<ins>\s*now<\/ins>/);
  assert.ok(!e.original.includes('<'));
});

test('diff rebuilds both texts exactly and escapes markup', () => {
  const a = 'a <b>bold</b> move\nline two', b = 'a bold move, line two';
  const ops = T.diffOps(a, b);
  assert.equal(ops.filter(o => o.op !== '+').map(o => o.text).join(''), a);
  assert.equal(ops.filter(o => o.op !== '-').map(o => o.text).join(''), b);
  assert.ok(!T.diffHtml(a, b).original.includes('<b>'));
  assert.deepEqual(T.diffOps('same', 'same'), [{ op: '=', text: 'same' }]);
});

test('review keys: Enter sends, E edits, O sends the original, Esc discards', () => {
  const k = (key, x = {}) => T.reviewKey({ key, ...x }, true);
  assert.equal(k('Enter'), 'send');
  assert.equal(k('e'), 'edit');
  assert.equal(k('O'), 'original');
  assert.equal(k('Escape'), 'discard');
  assert.equal(k('Enter', { shiftKey: true }), null);
  assert.equal(k('e', { ctrlKey: true }), null);
  assert.equal(T.reviewKey({ key: 'Enter' }, false), null);
  assert.equal(T.reviewKey({ key: 'e' }, false), null);
  assert.equal(T.reviewKey({ key: 'Escape' }, false), 'discard');
});

test('history steps stay inside the list; the last slot is the draft', () => {
  assert.equal(T.historyStep(3, 3, -1), 2);
  assert.equal(T.historyStep(3, 0, -1), 0);
  assert.equal(T.historyStep(3, 3, 1), 3);
  assert.equal(T.historyStep(0, 0, -1), 0);
});

test('a missing or failed refine result becomes one task with the prompt as it was', () => {
  const r = T.normalizeResult(null, 'do the thing');
  assert.equal(r.tasks.length, 1);
  assert.equal(r.tasks[0].prompt, 'do the thing');
  assert.equal(r.cleaned, null);
  assert.ok(r.requestId);
  assert.equal(T.normalizeResult(null, 'x', 'timed out').error, 'timed out');
  const q = T.normalizeResult({ requestId: 'r9', refined: 'clean', question: ' which file? ', tasks: [{ prompt: 'p' }] }, 'orig');
  assert.equal(q.requestId, 'r9');
  assert.equal(q.cleaned, 'clean');
  assert.equal(q.question, 'which file?');
  assert.equal(q.tasks[0].title, 'p');
});

test('text renders escaped, with code blocks and inline code', () => {
  assert.equal(T.renderText('<i>x</i>'), '&lt;i&gt;x&lt;/i&gt;');
  assert.match(T.renderText('run `npm test` now'), /<code>npm test<\/code>/);
  assert.match(T.renderText('a\n```js\nlet x = 1 < 2;\n```\nb'), /<pre class="ot-code">let x = 1 &lt; 2;<\/pre>/);
});

test('board statuses map to labels, unknown ones to "Not on the board"', () => {
  assert.equal(T.statusOf({ status: 'review' })[0], 'Ready for review');
  assert.equal(T.statusOf({ status: 'doing' })[0], 'Working');
  assert.equal(T.statusOf(undefined)[0], 'Not on the board');
  assert.equal(T.estTokens('abcdefgh'), 2);
});

test('dispatch args carry the pick, the tier and what ties the worker to the request', () => {
  const a = T.dispatchArgs({ title: 'Fix', prompt: 'do it', agent: 'opencode', model: 'opencode/big-pickle', effort: 'low', tier: 'cheap', files: ['a.js'] }, { requestId: 'r1', idx: 2, cwd: '/p' });
  assert.deepEqual(a, { prompt: 'do it', cwd: '/p', requestId: 'r1', taskId: 2, source: 'terminal', title: 'Fix', agent: 'opencode', model: 'opencode/big-pickle', effort: 'low', tier: 'cheap' });
  const b = T.dispatchArgs({ title: 'T', prompt: 'p' }, { requestId: 'r1', idx: 0, cwd: '/p' });
  assert.ok(!('agent' in b) && !('effort' in b) && !('tier' in b));
});

test('tasks past the free worker slots queue, in order; a task above the top tier never starts', () => {
  const tasks = [{ tier: 'cheap' }, { tier: 'mid' }, { tier: 'cheap' }, { tier: 'top' }];
  const plan = T.planDispatch(tasks, { free: 2, allowed: ['cheap', 'mid'] });
  assert.deepEqual(plan.start, [0, 1]);
  assert.deepEqual(plan.queued, [2]);
  assert.match(plan.errors[3], /above the top tier allowed \(mid\)/);
  assert.deepEqual(T.planDispatch(tasks.slice(0, 2), { free: 0, allowed: ['cheap', 'mid'] }).queued, [0, 1]);
  assert.throws(() => T.assertTierAllowed('top', ['cheap']), /above the top tier/);
  assert.doesNotThrow(() => T.assertTierAllowed(undefined, ['cheap']));
});

test('several tasks for one CLI go to one master worker that runs them as parallel subagents', () => {
  const kindOf = a => (a === 'oc' ? 'opencode' : a === 'cc' ? 'claude' : 'other');
  const tasks = [
    { title: 'Docs', prompt: 'write docs', agent: 'oc', model: 'opencode/big-pickle', tier: 'xsmall', files: ['README.md'] },
    { title: 'Fix login', prompt: 'fix it', agent: 'cc', model: 'claude-sonnet-5-5', tier: 'small', files: ['a.js'] },
    { title: 'Rename', prompt: 'rename x', agent: 'oc', model: 'opencode/big-pickle', tier: 'xsmall' },
    { title: 'Tests', prompt: 'add tests', agent: 'cc', model: 'claude-haiku-4-5', tier: 'xsmall', files: ['a.js', 'b.js'] },
    { title: 'Odd', prompt: 'p', agent: 'x', tier: 'xsmall' },
  ];
  const out = T.bundleTasks(tasks, { kindOf, allowed: ['xsmall', 'small'], limit: 9 });
  assert.equal(out.length, 3);
  const [oc, cc, other] = out;
  assert.equal(oc.agent, 'oc');
  assert.match(oc.title, /^2 tasks: Docs; Rename/);
  assert.match(oc.prompt, /master OpenCode worker for these 2 independent tasks/);
  assert.match(oc.prompt, /up to 9 at once/);
  assert.match(oc.prompt, /the `tier-xsmall` subagent/);
  assert.match(oc.prompt, /TL;DR/);
  assert.equal(cc.tier, 'small', 'the master takes the highest tier among its tasks');
  assert.equal(cc.model, 'claude-sonnet-5-5');
  assert.deepEqual(cc.files, ['a.js', 'b.js']);
  assert.match(cc.prompt, /Agent tool with model "sonnet"/);
  assert.match(cc.prompt, /Agent tool with model "haiku"/);
  assert.equal(other, tasks[4], 'an agent that is neither CLI keeps its own worker');
  assert.equal(T.bundleTasks([tasks[0]], { kindOf }).length, 1);
  assert.deepEqual(T.bundleTasks([tasks[0], tasks[1]], { kindOf }), [tasks[0], tasks[1]], 'one task per CLI stays as it is');
});

test('a follow-up handoff is short and structured, and never the history', () => {
  const h = T.handoffText({ title: 'Fix login', asked: 'Fix the login bug in auth.js', note: 'Fixed in auth.js; tests pass', ask: 'Also cover the reset flow' });
  assert.equal(h, 'Follow-up on your task "Fix login".\nYou were asked: Fix the login bug in auth.js\nYour last note: Fixed in auth.js; tests pass\nNew ask: Also cover the reset flow');
  assert.match(T.handoffText({ title: 't', ask: 'x' }), /Your last note: none/);
  assert.ok(!T.flatText(h).includes('\n'));
  assert.ok(T.handoffText({ title: 't', asked: 'a'.repeat(5000), ask: 'x' }).length < 700);
});

test('live workers get a message; settled ones and missing tiles get a new task', () => {
  assert.equal(T.isLive('doing', true), true);
  assert.equal(T.isLive('doing', false), false);
  assert.equal(T.isLive('review', true), false);
  assert.equal(T.defaultTarget([{ key: 'a', settled: false }, { key: 'b', settled: true }]), 'a');
  assert.equal(T.defaultTarget([{ key: 'a', settled: true }]), 'new');
});

test('the footer and the summary count paid tokens and the refiner separately, and never invent a saving', () => {
  const refiner = { provider: 'opencode', tokens: { input: 900, output: 100 }, usd: 0 };
  assert.equal(T.requestFooter({ refiner, paid: 41000, usd: 0.12, unknown: 0 }), 'Refiner: 1k free tokens. Paid tokens used by the agents: 41k (≈ $0.120)');
  assert.match(T.requestFooter({ refiner, paid: 5000, usd: 0, unknown: 1 }), /\(cost unknown\)$/);
  assert.equal(T.requestFooter({ refiner, paid: 0, usd: 0, unknown: 0 }), 'Refiner: 1k free tokens. Paid tokens used by the agents: 0');
  assert.match(T.requestFooter({ refiner: null, paid: 0 }), /^Refiner: tokens not reported\./);
  assert.ok(!/sav/i.test(T.requestFooter({ refiner, paid: 1, usd: 1, unknown: 0 })));
  const s = T.summaryText({ refiner, tasks: [
    { title: 'A', status: 'done', paid: 1000, usd: 0.01 }, { title: 'B', status: 'failed', note: 'tests broke', paid: 2000, usd: 0.02 }, { title: 'C', status: 'error', error: 'above the top tier', paid: 0 }] });
  assert.match(s, /^1 of 3 tasks done: A\./);
  assert.match(s, /Failed or stuck: B \(tests broke\); C \(above the top tier\)\./);
  assert.match(s, /Paid tokens used by the agents: 3k \(≈ \$0\.030\)/);
  assert.match(s, /Refiner: 1k free tokens/);
});

test('token lines say free, priced or unknown', () => {
  assert.equal(T.tokenLine({ total: 0 }), '');
  assert.equal(T.tokenLine({ total: 12000, free: true, usd: 0 }), '12k tokens (free)');
  assert.equal(T.tokenLine({ total: 12000, usd: 0.5 }), '12k tokens · ≈ $0.500');
  assert.equal(T.tokenLine({ total: 12000, usd: null }), '12k tokens · cost unknown');
});

test('after a question the review shows the combined prompt as the original', () => {
  const combined = 'fix it\n\nYou asked: which file?\nMy answer: auth.js';
  assert.equal(T.normalizeResult({ requestId: 'r', original: 'fix it', tasks: [] }, combined).original, combined);
});

test('an outcome carries the request and its source so a request can be summed', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../renderer/renderer.js'), 'utf8');
  const fn = src.slice(src.indexOf('function recordOutcome'), src.indexOf('function failTask'));
  assert.match(fn, /requestId: t\.requestId/);
  assert.match(fn, /source: t\.source/);
  const os = require('node:os'), path = require('node:path'), fs = require('node:fs'), outcomes = require('../outcomes');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-')), 'o.jsonl');
  outcomes.appendOutcome(f, { t: Date.now(), taskId: 1, requestId: 'r1', source: 'terminal', tokens: { input: 5 } });
  const [e] = outcomes.readOutcomes(f);
  assert.equal(e.requestId, 'r1');
  assert.equal(e.source, 'terminal');
});

test('the agent control takes an explicit effort and always makes a board task for a Terminal task', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../renderer/renderer.js'), 'utf8');
  const fn = src.slice(src.indexOf("case 'agent': {"), src.indexOf("case 'team':"));
  assert.match(fn, /effort = args\.effort \? String\(args\.effort\)/);
  assert.match(fn, /fromTerminal && !wantTier|!wantTier && fromTerminal/);
  assert.match(fn, /source: 'terminal'/);
  assert.match(fn, /requestTask/);
});

test('follow-up: a live worker gets it as a queued message, a closed one gets a new task on the same tier with the handoff', () => {
  const entry = { title: 'Fix login', prompt: 'fix the login bug', agent: 'claude', model: 'claude-haiku-4-5', effort: 'low', tier: 'small', idx: 0 };
  const live = T.followUpPlan({ entry, note: 'done, one file', live: true, ask: 'also add a test', nextIdx: 1 });
  assert.equal(live.kind, 'message'); assert.ok(!live.text.includes('\n')); assert.match(live.text, /also add a test/);
  const gone = T.followUpPlan({ entry, note: 'done, one file', live: false, ask: 'also add a test', nextIdx: 1 });
  assert.equal(gone.kind, 'task'); assert.equal(gone.idx, 1);
  assert.equal(gone.task.tier, 'small'); assert.equal(gone.task.model, 'claude-haiku-4-5');
  assert.match(gone.task.prompt, /You were asked: fix the login bug/); assert.match(gone.task.prompt, /Your last note: done, one file/); assert.match(gone.task.prompt, /New ask: also add a test/);
});

test('segment prices add up; one unpriced segment makes the total unknown', () => {
  assert.equal(T.sumSegmentUsd([{ usd: 0.5 }, { usd: 0.25 }]), 0.75);
  assert.equal(T.sumSegmentUsd([{ usd: 0.5 }, { usd: 0 }]), 0.5);
  assert.equal(T.sumSegmentUsd([{ usd: 0.5 }, { usd: null }]), null);
  assert.equal(T.sumSegmentUsd([{ usd: 0.5 }, null]), null);
});

test('modeNote: the review names the project mode and flags an OpenCode refiner on a Claude only project', () => {
  assert.deepEqual(T.modeNote('both', 'opencode'), { label: '', note: '' });
  assert.deepEqual(T.modeNote(undefined, 'opencode'), { label: '', note: '' });
  assert.equal(T.modeNote('opencode', 'opencode').label, 'OpenCode only');
  assert.equal(T.modeNote('opencode', 'opencode').note, '');
  const c = T.modeNote('claude', 'opencode');
  assert.equal(c.label, 'Claude only'); assert.match(c.note, /refiner itself runs on OpenCode/);
  assert.equal(T.modeNote('claude', 'local').note, '');
});

test('slash commands parse with an optional #n card and the rest', () => {
  assert.deepEqual(T.parseSlash('/close #2 not needed'), { name: 'close', card: 2, rest: 'not needed', known: true });
  assert.deepEqual(T.parseSlash('/stop'), { name: 'stop', card: null, rest: '', known: true });
  assert.equal(T.parseSlash('/nope').known, false);
  assert.equal(T.parseSlash('fix it'), null);
  assert.deepEqual(T.slashMatches('/st').map(x => x.name), ['stop', 'status']);
  assert.equal(T.slashMatches('/').length, T.SLASH.length);
});

test('what a line is: a command, a shell command, a memory or a prompt', () => {
  assert.equal(T.inputKind('/help'), 'slash');
  assert.equal(T.inputKind('!npm test'), 'shell');
  assert.equal(T.inputKind('!'), 'prompt');
  assert.equal(T.inputKind('# use tabs here'), 'memory');
  assert.equal(T.inputKind('#tabs'), 'memory');
  assert.equal(T.inputKind('#2 fix it'), 'prompt', '#n is a task number, not a memory');
  assert.equal(T.inputKind('fix #2'), 'prompt');
});

test('@ completes project files, file names first; Ctrl+R finds earlier prompts newest first', () => {
  assert.deepEqual(T.atToken('look at @ren', 12), { start: 8, query: 'ren' });
  assert.equal(T.atToken('mail me@x', 9), null);
  const files = ['test/terminal.test.js', 'renderer/terminal.js', 'main.js', 'docs/term.md'];
  assert.deepEqual(T.fileMatches(files, 'term'), ['docs/term.md', 'renderer/terminal.js', 'test/terminal.test.js']);
  assert.deepEqual(T.fileMatches(files, 'renderer/'), ['renderer/terminal.js']);
  assert.deepEqual(T.histMatches(['fix a', 'add b', 'fix c', 'fix a'], 'fix'), ['fix a', 'fix c']);
});

test('a shell tile\'s output loses the prompt waiting at its end', () => {
  assert.equal(T.shellOutput('hello\nPS C:\\Users\\me\\a very long\npath\\proj> '), 'hello');
  assert.equal(T.shellOutput('hello\nPS C:\\proj>'), 'hello');
  assert.equal(T.shellOutput('ok\nuser@box:~/p$ '), 'ok');
  assert.equal(T.shellOutput('a > b'), 'a > b');
});
