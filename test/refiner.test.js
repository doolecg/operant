const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../refiner');
const { summarize } = require('../outcomes');

const TIERS = {
  xsmall: { agent: 'opencode', model: 'opencode/big-pickle', use: 'very easy tasks' },
  small: { agent: 'claude', model: 'claude-haiku-4-5', use: 'simple edits' },
  medium: { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'low', use: 'a feature across files' },
  high: { agent: 'claude', model: 'claude-opus-5-5', effort: 'high', use: 'hard tasks' },
};
const task = (o = {}) => ({ title: 'T', prompt: 'add a button to the toolbar', type: 'feature', complexity: 'low', risk: 'low', files: ['a.js'], agent: 'claude', model: 'claude-haiku-4-5', effort: 'low', tier: 'small', why: 'simple', ...o });
const answer = (o = {}) => JSON.stringify({ summary: 'shorter', cleaned: 'Add a toolbar button.', tasks: [task()], ...o });

test('brief: caps, order and redaction', () => {
  const files = Array.from({ length: 30 }, (_, i) => `src/f${i}.js`);
  const b = R.buildBrief({
    cwd: 'C:\\code\\proj', gitState: { branch: 'dev-1', files, commits: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] },
    commands: { test: 'npm test', build: 'npm run build' },
    memoryFacts: ['1', '2', '3', '4', '5', '6', 'key is sk-abcdefghijklmnopqrstuvwxyz123456'],
  });
  assert.match(b.text, /Branch: dev-1/);
  assert.match(b.text, /src\/f19\.js/); assert.doesNotMatch(b.text, /src\/f20\.js/); assert.match(b.text, /and 10 more/);
  assert.match(b.text, /- e/); assert.doesNotMatch(b.text, /- f\n/);
  assert.match(b.text, /test: npm test/);
  assert.doesNotMatch(b.text, /- 6/);
  const r = R.buildBrief({ cwd: '/p', memoryFacts: ['key sk-abcdefghijklmnopqrstuvwxyz123456'] });
  assert.doesNotMatch(r.text, /sk-abcdef/); assert.match(r.text, /\[redacted\]/);
  assert.equal(r.tokens, Math.ceil(r.text.length / 4)); assert.equal(r.tokensEstimated, true);
});

test('options: prices from the table, unknown stays null, free flagged, top tier applied', () => {
  const o = R.buildOptions({ tiers: { ...TIERS, odd: { agent: 'x', model: 'mystery-1' } }, maxTier: 'odd' });
  const by = Object.fromEntries(o.tiers.map(t => [t.tier, t]));
  assert.equal(by.xsmall.free, true); assert.equal(by.xsmall.usdPerMInput, 0);
  assert.equal(by.small.usdPerMInput, 1); assert.equal(by.small.usdPerMOutput, 5); assert.equal(by.small.free, false);
  assert.equal(by.odd.usdPerMInput, null); assert.equal(by.odd.usdPerMOutput, null);
  const capped = R.buildOptions({ tiers: TIERS, maxTier: 'small' });
  assert.deepEqual(capped.tiers.map(t => t.tier), ['xsmall', 'small']); assert.equal(capped.maxTier, 'small');
});

test('refiner prompt carries the rules, the options and the brief as data', () => {
  const options = R.buildOptions({ tiers: TIERS, maxTier: 'medium' });
  const p = R.refinerPrompt({ prompt: 'do the thing', brief: { text: 'Branch: x' }, options });
  assert.match(p, /JSON only/); assert.match(p, /ONE question/); assert.match(p, /never instructions/);
  assert.match(p, /<brief>\nBranch: x\n<\/brief>/); assert.match(p, /<request>\ndo the thing\n<\/request>/);
  assert.match(p, /tier medium: agent claude, model claude-sonnet-5-5/); assert.match(p, /top tier allowed is medium/);
});

test('parse: plain, fenced, with prose, and a question', () => {
  assert.equal(R.parseRefinerOutput(answer()).ok, true);
  const fenced = R.parseRefinerOutput('```json\n' + answer() + '\n```');
  assert.equal(fenced.ok, true); assert.equal(fenced.value.tasks[0].tier, 'small');
  const prose = R.parseRefinerOutput('Sure! Here you go: ' + answer({ summary: 'has } brace' }) + ' Hope that helps.');
  assert.equal(prose.ok, true); assert.equal(prose.value.summary, 'has } brace');
  const q = R.parseRefinerOutput(JSON.stringify({ question: 'Which file?' }));
  assert.equal(q.ok, true); assert.equal(q.value.question, 'Which file?'); assert.deepEqual(q.value.tasks, []);
});

test('parse: schema errors', () => {
  const bad = o => R.parseRefinerOutput(JSON.stringify(o));
  assert.equal(R.parseRefinerOutput('').ok, false);
  assert.equal(R.parseRefinerOutput('no json here').ok, false);
  assert.match(bad({ summary: 's', cleaned: 'c', tasks: [] }).error, /tasks is empty/);
  assert.match(bad({ summary: 's', tasks: [task()] }).error, /cleaned/);
  assert.match(bad({ summary: 's', cleaned: 'c', tasks: 'x' }).error, /list/);
  assert.match(bad({ summary: 's', cleaned: 'c', tasks: [task({ complexity: 'huge' })] }).error, /complexity/);
  assert.match(bad({ summary: 's', cleaned: 'c', tasks: [task({ risk: undefined })] }).error, /risk/);
  assert.match(bad({ summary: 's', cleaned: 'c', tasks: [task({ prompt: '' })] }).error, /prompt/);
});

const ctx = (o = {}) => ({ tiers: TIERS, maxTier: 'medium', ...o });
const check = (t, o) => R.checkPicks({ tasks: [t] }, ctx(o)).tasks[0];

test('checkPicks: a valid pick is kept and given a reason', () => {
  const t = check(task());
  assert.equal(t.tier, 'small'); assert.equal(t.model, 'claude-haiku-4-5'); assert.equal(t.pickedBy, 'refiner');
  assert.match(t.pickReason, /simple/);
});

test('checkPicks: unknown model, agent or tier is replaced by routing with the reason', () => {
  const m = check(task({ model: 'gpt-nonexistent' }));
  assert.equal(m.pickedBy, 'routing'); assert.match(m.pickReason, /not what tier small runs/); assert.ok(TIERS[m.tier]);
  assert.equal(m.model, TIERS[m.tier].model);
  const t = check(task({ tier: 'ultra', agent: '', model: '' }));
  assert.equal(t.pickedBy, 'routing'); assert.match(t.pickReason, /unknown tier "ultra"/);
});

test('checkPicks: above the top tier is capped', () => {
  const t = check(task({ agent: 'claude', model: 'claude-opus-5-5', effort: 'high', tier: 'high' }), { maxTier: 'small' });
  assert.equal(t.tier, 'small'); assert.equal(t.model, 'claude-haiku-4-5'); assert.match(t.pickReason, /above the top tier/);
});

test('checkPicks: an unavailable model is replaced', () => {
  const t = check(task(), { available: ['opencode/big-pickle', 'claude-sonnet-5-5'] });
  assert.equal(t.pickedBy, 'routing'); assert.notEqual(t.model, 'claude-haiku-4-5'); assert.match(t.pickReason, /not available/);
});

test('checkPicks: a tier failing for this kind of task gives way to routing\'s proven pick', () => {
  const entries = [];
  for (let i = 0; i < 6; i++) entries.push({ type: 'feature', tier: 'small', status: i < 2 ? 'done' : 'failed' });
  for (let i = 0; i < 6; i++) entries.push({ type: 'feature', tier: 'xsmall', status: 'done' });
  const stats = summarize(entries);
  const t = check(task(), { outcomesStats: stats });
  assert.equal(t.tier, 'xsmall'); assert.equal(t.pickedBy, 'routing'); assert.match(t.pickReason, /passed only 2\/6/);
  assert.equal(check(task(), { outcomesStats: {} }).tier, 'small');
});

test('checkPicks: effort kept when valid, otherwise the tier\'s', () => {
  assert.equal(check(task({ effort: 'medium' })).effort, 'medium');
  assert.equal(check(task({ effort: 'banana' })).effort, 'low');
  assert.equal(check(task({ agent: 'claude', model: 'claude-sonnet-5-5', tier: 'medium', effort: '' })).effort, 'low');
});

const OK = { ...{ input: 100, output: 50 } };
function deps(over = {}) {
  const events = [];
  return {
    events,
    d: {
      inputs: async () => ({ cwd: '/p', gitState: { branch: 'b', files: [], commits: [] } }),
      tiers: TIERS, maxTier: 'medium', outcomesStats: {}, newId: () => 'req-1', now: (() => { let n = 0; return () => (n += 10); })(),
      record: e => events.push(e),
      providers: { opencode: async () => ({ text: answer(), tokens: OK, cost: 0 }) },
      ...over,
    },
  };
}

test('refine: success shape, accounting and the orchestration event', async () => {
  const { d, events } = deps();
  const r = await R.refine({ project: '/p', prompt: 'add a toolbar button pls', settings: { refiner: 'opencode', refinerModel: 'opencode/big-pickle', maxTasks: 4 }, deps: d });
  assert.equal(r.requestId, 'req-1'); assert.equal(r.original, 'add a toolbar button pls');
  assert.deepEqual(r.refined, { summary: 'shorter', cleaned: 'Add a toolbar button.' });
  assert.equal(r.tasks.length, 1); assert.equal(r.tasks[0].tier, 'small'); assert.equal(r.error, undefined);
  assert.equal(typeof r.brief.tokens, 'number');
  assert.deepEqual(r.refiner.tokens, { input: 100, output: 50 }); assert.equal(r.refiner.usd, 0); assert.equal(r.refiner.provider, 'opencode');
  assert.equal(events.length, 1);
  assert.deepEqual({ ...events[0], t: 0, ms: 0 }, { t: 0, kind: 'orchestration', requestId: 'req-1', what: 'refine', provider: 'opencode', model: 'opencode/big-pickle', tokens: { input: 100, output: 50 }, free: { input: 100, output: 50, total: 150 }, paid: { input: 0, output: 0, total: 0 }, usd: 0, ms: 0 });
});

test('refine: a question is passed through with no tasks', async () => {
  const { d } = deps({ providers: { opencode: async () => ({ text: JSON.stringify({ question: 'Which project?' }), tokens: OK }) } });
  const r = await R.refine({ project: '/p', prompt: 'fix it', settings: {}, deps: d });
  assert.equal(r.question, 'Which project?'); assert.equal(r.refined, null); assert.deepEqual(r.tasks, []);
});

test('refine: provider error falls back to the original as one routed task', async () => {
  const { d, events } = deps({ providers: { opencode: async () => { throw new Error('timed out'); } } });
  const r = await R.refine({ project: '/p', prompt: 'fix the crash on save', settings: {}, deps: d });
  assert.equal(r.refined, null); assert.equal(r.tasks.length, 1); assert.equal(r.tasks[0].prompt, 'fix the crash on save');
  assert.ok(TIERS[r.tasks[0].tier]); assert.match(r.error, /timed out/); assert.match(r.error, /original prompt/);
  assert.equal(events[0].kind, 'orchestration');
});

test('refine: bad JSON twice falls back; bad then good succeeds with one retry', async () => {
  let calls = 0;
  const bad = deps({ providers: { opencode: async () => { calls++; return { text: 'sorry, cannot', tokens: OK }; } } });
  const r = await R.refine({ project: '/p', prompt: 'add x', settings: {}, deps: bad.d });
  assert.equal(calls, 2); assert.equal(r.refined, null); assert.match(r.error, /twice/); assert.equal(r.tasks[0].prompt, 'add x');
  assert.deepEqual(r.refiner.tokens, { input: 200, output: 100 });
  const seen = [];
  const once = deps({ providers: { opencode: async a => { seen.push(a.prompt); return { text: seen.length === 1 ? 'nope' : answer(), tokens: OK }; } } });
  const g = await R.refine({ project: '/p', prompt: 'add x', settings: {}, deps: once.d });
  assert.equal(g.error, undefined); assert.equal(seen.length, 2); assert.match(seen[1], /JSON object only/);
});

test('refine: off makes no call; extra tasks are merged; secrets are not sent', async () => {
  let called = false;
  const off = deps({ providers: { opencode: async () => { called = true; return {}; } } });
  const r = await R.refine({ project: '/p', prompt: 'add x', settings: { refiner: 'off' }, deps: off.d });
  assert.equal(called, false); assert.equal(r.tasks.length, 1); assert.equal(off.events.length, 0); assert.equal(r.error, undefined);
  const many = deps({ providers: { opencode: async () => ({ text: answer({ tasks: [task(), task({ prompt: 'two', files: ['b.js'] }), task({ prompt: 'three' })] }), tokens: OK }) } });
  const m = await R.refine({ project: '/p', prompt: 'x', settings: { maxTasks: 2 }, deps: many.d });
  assert.equal(m.tasks.length, 2); assert.match(m.tasks[1].prompt, /Also: three/); assert.match(m.tasks[1].pickReason, /merged/);
  let sent = '';
  const sec = deps({ providers: { opencode: async a => { sent = a.prompt; return { text: answer(), tokens: OK }; } } });
  await R.refine({ project: '/p', prompt: 'use sk-abcdefghijklmnopqrstuvwxyz123456', settings: {}, deps: sec.d });
  assert.doesNotMatch(sent, /sk-abcdef/);
});

test('opencode events: text and tokens are read', () => {
  const out = [
    '{"type":"step_start","part":{}}',
    '{"type":"text","part":{"text":"{\\"ok\\":"}}', '{"type":"text","part":{"text":"true}"}}',
    '{"type":"step_finish","part":{"tokens":{"total":9,"input":5,"output":2,"reasoning":1,"cache":{"write":0,"read":4}},"cost":0}}',
  ].join('\n');
  const r = R.parseOpencodeEvents(out);
  assert.equal(r.text, '{"ok":true}'); assert.deepEqual(r.tokens, { input: 5, output: 3, cacheRead: 4, cacheWrite: 0 });
  assert.equal(R.parseOpencodeEvents('{"type":"error","error":{"name":"X","data":{"message":"bad key"}}}').error, 'bad key');
  assert.equal(R.parseOpencodeEvents('plain').tokens, null);
});

test('local provider: url, JSON mode, usage, retry without JSON mode', async () => {
  assert.equal(R.chatUrl('http://localhost:11434'), 'http://localhost:11434/v1/chat/completions');
  assert.equal(R.chatUrl('http://h/v1/'), 'http://h/v1/chat/completions');
  const bodies = [];
  const fetchImpl = async (url, o) => {
    const b = JSON.parse(o.body); bodies.push(b);
    if (b.response_format) return { ok: false, status: 400 };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"a":1}' } }], usage: { prompt_tokens: 7, completion_tokens: 3 } }) };
  };
  const r = await R.runLocal({ url: 'http://h', model: 'gemma', prompt: 'hi', fetchImpl });
  assert.equal(r.text, '{"a":1}'); assert.deepEqual(r.tokens, { input: 7, output: 3 });
  assert.equal(bodies.length, 2); assert.deepEqual(bodies[0].response_format, { type: 'json_object' }); assert.equal(bodies[1].response_format, undefined);
  await assert.rejects(() => R.runLocal({ url: '', model: 'g', prompt: 'x', fetchImpl }), /no local model URL/);
});

test('outcomes.summarize ignores orchestration events', () => {
  const s = summarize([{ kind: 'orchestration', what: 'refine', tokens: { input: 5 } }, { type: 'fix', tier: 'small', status: 'done' }]);
  assert.deepEqual(Object.keys(s), ['fix']); assert.equal(s.fix.small.n, 1);
});

test('terminal settings are validated', () => {
  const { validatePatch } = require('../config-migrate');
  const d = { terminal: { refiner: 'opencode', autoSend: {}, maxTasks: 4, localUrl: '' } };
  const n = t => validatePatch({ terminal: t }, d).length;
  assert.equal(n({ refiner: 'local', localUrl: 'http://localhost:11434', maxTasks: 8 }), 0);
  assert.equal(n({ refiner: 'gpt' }), 1); assert.equal(n({ maxTasks: 0 }), 1); assert.equal(n({ maxTasks: 9 }), 1);
  assert.equal(n({ localUrl: 'not a url' }), 1); assert.equal(n({ autoSend: { '/p': 'yes' } }), 1);
});

test('splitTokens: free and local calls on the free side, cache counts as input', () => {
  const t = { input: 10, output: 5, cacheRead: 100, cacheWrite: 1 };
  assert.deepEqual(R.splitTokens('opencode/big-pickle', t), { free: { input: 111, output: 5, total: 116 }, paid: { input: 0, output: 0, total: 0 } });
  assert.deepEqual(R.splitTokens('claude-haiku-4-5', t).paid, { input: 111, output: 5, total: 116 });
  assert.equal(R.splitTokens('llama3', t, { local: true }).paid.total, 0);
  assert.equal(R.splitTokens('opencode/big-pickle', null).free.total, 0);
});

test('refine: free and paid tokens are reported apart', async () => {
  const d = deps({ providers: { opencode: async () => ({ text: answer(), tokens: { input: 10, output: 5, cacheRead: 90, cacheWrite: 0 } }) } });
  const free = await R.refine({ project: '/p', prompt: 'add x', settings: {}, deps: d.d });
  assert.deepEqual(free.refiner.free, { input: 100, output: 5, total: 105 }); assert.equal(free.refiner.paid.total, 0);
  const paid = await R.refine({ project: '/p', prompt: 'add x', settings: { refinerModel: 'claude-haiku-4-5' }, deps: d.d });
  assert.equal(paid.refiner.free.total, 0); assert.equal(paid.refiner.paid.total, 105);
});

test('lean OpenCode config keeps bash and read listed and asks instead of denying', () => {
  const c = JSON.parse(R.leanConfig());
  assert.equal(c.tools.task, false); assert.equal(c.tools.webfetch, false); assert.equal(c.tools.bash, undefined); assert.equal(c.tools.read, undefined);
  assert.deepEqual(c.permission, { bash: 'ask', read: 'ask' });
});

test('runOpencode: the lean config goes in the environment unless turned off', async () => {
  const { EventEmitter } = require('node:events');
  const envs = [];
  const spawnImpl = (cmd, args, o) => {
    envs.push(o.env);
    const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = { on() {}, end() {} };
    setImmediate(() => { c.stdout.emit('data', '{"type":"text","part":{"text":"hi"}}\n'); c.emit('close', 0); });
    return c;
  };
  await R.runOpencode({ prompt: 'p', env: { A: '1' }, spawnImpl });
  await R.runOpencode({ prompt: 'p', env: { A: '1' }, lean: false, spawnImpl });
  assert.equal(envs[0].A, '1'); assert.equal(envs[0].OPENCODE_CONFIG_CONTENT, R.leanConfig()); assert.equal(envs[1].OPENCODE_CONFIG_CONTENT, undefined);
});

test('opencode server: one session per call, deleted afterwards; a dead server is serverDown', async () => {
  const { EventEmitter } = require('node:events');
  let spawned = 0, args = null;
  const spawnImpl = (cmd, a, o) => {
    spawned++; args = { a, env: o.env };
    const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.pid = 4242;
    setImmediate(() => c.stdout.emit('data', 'opencode server listening on http://127.0.0.1:1\n'));
    return c;
  };
  const calls = []; let n = 0;
  const fetchImpl = async (url, o) => {
    calls.push(`${o.method} ${url.replace(/^http:\/\/127\.0\.0\.1:\d+/, '')}`);
    assert.match(o.headers.authorization, /^Basic /);
    const body = url.endsWith('/session') && o.method === 'POST' ? { id: 'ses_' + ++n } : url.endsWith('/message') ? { info: { tokens: { input: 4, output: 2, reasoning: 1, cache: { read: 30, write: 0 } }, cost: 0 }, parts: [{ type: 'text', text: 'ans' }] } : {};
    return { ok: true, json: async () => body };
  };
  const s = R.createOpencodeServer({ spawnImpl, fetchImpl, env: { A: '1' } });
  const r1 = await s.run({ prompt: 'q', model: 'opencode/big-pickle' });
  await s.run({ prompt: 'q2' });
  assert.equal(spawned, 1); assert.equal(args.a[0], 'serve'); assert.ok(args.env.OPENCODE_SERVER_PASSWORD); assert.equal(args.env.OPENCODE_CONFIG_CONTENT, R.leanConfig());
  assert.deepEqual(r1, { text: 'ans', tokens: { input: 4, output: 3, cacheRead: 30, cacheWrite: 0 }, cost: 0 });
  assert.equal(calls.filter(c => c === 'POST /session').length, 2); assert.ok(calls.includes('DELETE /session/ses_1'));
  s.stop();
  const bad = R.createOpencodeServer({ spawnImpl, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  await assert.rejects(bad.run({ prompt: 'q' }), e => e.serverDown === true);
  bad.stop();
  const err = R.createOpencodeServer({ spawnImpl, fetchImpl: async url => ({ ok: true, json: async () => (url.endsWith('/message') ? { info: { error: { name: 'APIError', data: { message: 'no key' } } }, parts: [] } : { id: 's' }) }) });
  await assert.rejects(err.run({ prompt: 'q' }), e => /no key/.test(e.message) && !e.serverDown);
  err.stop();
});

test('refiner eval grading', async () => {
  const G = await import('../evals/refiner/grade.mjs');
  const v = (o = {}) => ({ ok: true, value: { summary: 's', cleaned: 'Return 0 for an empty array in src/avg.js', tasks: [{ title: 'Fix avg', prompt: 'edit src/avg.js', risk: 'low', tier: 'xsmall', agent: 'opencode', model: 'opencode/big-pickle' }], ...o } });
  assert.deepEqual(G.gradeKeep(v().value, [['src/avg.js'], ['empty array'], ['test/avg.test.js', 'tests']]), { ok: false, missing: ['test/avg.test.js'] });
  const good = G.gradeCase({ keep: [['src/avg.js']], tasks: [1, 2], cheap: 'xsmall' }, v());
  assert.equal(G.passed(good), true);
  assert.equal(G.passed(G.gradeCase({ tasks: [2, 3] }, v())), false);
  assert.equal(G.passed(G.gradeCase({ question: true }, v())), false);
  assert.equal(G.passed(G.gradeCase({ question: true }, v({ question: 'which?' }))), true);
  assert.equal(G.passed(G.gradeCase({}, v({ question: 'which?' }))), false);
  assert.equal(G.passed(G.gradeCase({ minTier: 'small' }, v())), false);
  assert.equal(G.passed(G.gradeCase({ highRisk: true }, v())), false);
  const off = v({ tasks: [{ title: 't', prompt: 'p', risk: 'low', tier: 'high', agent: 'claude', model: 'claude-opus-5-5' }] });
  assert.equal(G.gradeCase({}, off).picks.pass, false);
  assert.equal(G.passed(G.gradeCase({}, { ok: false, error: 'x' })), false);
});

test('checkPicks raises a high-risk task off the cheapest tier', () => {
  const tiers = { xsmall: { agent: 'opencode', model: 'opencode/big-pickle' }, small: { agent: 'claude', model: 'claude-haiku-4-5' }, medium: { agent: 'claude', model: 'claude-sonnet-5-5' } };
  const out = R.checkPicks({ tasks: [{ prompt: 'migrate the auth tables', tier: 'xsmall', agent: 'opencode', model: 'opencode/big-pickle', risk: 'high' }] }, { tiers, maxTier: 'medium' });
  assert.equal(out.tasks[0].tier, 'small');
  assert.match(out.tasks[0].pickReason, /high-risk/);
});
