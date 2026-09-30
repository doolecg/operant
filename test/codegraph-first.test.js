// Item 90: CodeGraph-first helpers (codegraph-first.js) and their outcome summary (outcomes.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const cg = require('../codegraph-first.js');
const { summarizeCodegraph } = require('../outcomes.js');

test('classify: CodeGraph calls, greps, reads and edits in Claude Code and OpenCode spelling', () => {
  assert.equal(cg.classify('mcp__codegraph__codegraph_explore', {}).kind, 'codegraph');
  assert.equal(cg.classify('Bash', { command: 'codegraph explore "foo bar"' }).kind, 'codegraph');
  assert.equal(cg.classify('bash', { command: 'cd x && codegraph query foo' }).kind, 'codegraph');
  assert.equal(cg.classify('Grep', { pattern: 'x' }).kind, 'grep');
  assert.equal(cg.classify('glob', { pattern: '**/*.js' }).kind, 'grep');
  assert.equal(cg.classify('Bash', { command: 'git status | grep foo' }).kind, 'grep');
  assert.equal(cg.classify('Bash', { command: 'operant find "where is x"' }).kind, 'other');
  assert.deepEqual(cg.classify('Read', { file_path: 'a.js' }), { kind: 'read', file: 'a.js' });
  assert.deepEqual(cg.classify('read', { filePath: 'b.js' }), { kind: 'read', file: 'b.js' });
  assert.equal(cg.classify('Bash', { command: 'cat src/a.js' }).kind, 'read');
  assert.equal(cg.classify('Edit', {}).kind, 'edit');
  assert.equal(cg.classify('Bash', { command: 'npm test' }).kind, 'other');
});

test('the tracker records the first code action and files read before and after the first CodeGraph call', () => {
  const t = cg.createCgTracker({ enabled: true });
  t.onToolUse('Bash', { command: 'operant prime' });
  t.onToolUse('Read', { file_path: 'a.js' });
  t.onToolUse('Read', { file_path: 'a.js' });
  t.onToolUse('Bash', { command: 'codegraph explore "x"' });
  t.onToolUse('Read', { file_path: 'b.js' });
  t.onToolUse('Read', { file_path: 'c.js' });
  assert.deepEqual(t.stats(), { firstAction: 'read', codegraphCalls: 1, filesBefore: 1, filesAfter: 2, greps: 0, nudged: false });
});

test('a worker gets one nudge after more than 5 distinct files read without CodeGraph', () => {
  const t = cg.createCgTracker({ enabled: true });
  const sigs = [];
  for (let i = 0; i < 8; i++) sigs.push(t.onToolUse('Read', { file_path: `f${i}.js` }));
  assert.deepEqual(sigs.map(s => !!s), [false, false, false, false, false, true, false, false]);
  assert.equal(sigs[5].kind, 'codegraph');
  assert.match(sigs[5].reason, /read 6 files without a CodeGraph query/);
  assert.equal(t.stats().nudged, true);
});

test('three greps nudge once; re-reading one file does not count as many', () => {
  const t = cg.createCgTracker({ enabled: true });
  assert.equal(t.onToolUse('Grep', {}), null);
  assert.equal(t.onToolUse('Bash', { command: 'rg foo' }), null);
  const sig = t.onToolUse('Glob', {});
  assert.match(sig.reason, /grepped 3 times/);
  assert.equal(t.onToolUse('Grep', {}), null);
  const r = cg.createCgTracker({ enabled: true });
  for (let i = 0; i < 9; i++) assert.equal(r.onToolUse('Read', { file_path: 'same.js' }), null);
});

test('no nudge once CodeGraph was used, or when the tracker is not enabled', () => {
  const t = cg.createCgTracker({ enabled: true });
  t.onToolUse('Grep', {});
  t.onToolUse('mcp__codegraph__codegraph_explore', {});
  for (let i = 0; i < 10; i++) assert.equal(t.onToolUse('Read', { file_path: `f${i}` }), null);
  const off = cg.createCgTracker({ enabled: false });
  for (let i = 0; i < 10; i++) assert.equal(off.onToolUse('Read', { file_path: `f${i}` }), null);
  assert.equal(off.stats().filesBefore, 10);
  assert.equal(off.stats().nudged, false);
});

test('symbolsFromTask picks the names a task mentions and skips plain words', () => {
  assert.deepEqual(cg.symbolsFromTask('Fix the off-by-one in `sumList()` so it passes'), ['sumList']);
  assert.deepEqual(cg.symbolsFromTask('Rename createStuckTracker and on_tool_use in src/stuck.js'), ['stuck', 'createStuckTracker', 'on_tool_use']);
  assert.deepEqual(cg.symbolsFromTask('make the button look nicer'), []);
  assert.equal(cg.symbolsFromTask('a fooBar bazQux quxQuux corgeGrault graultGarply waldoFred plughXyzzy', 3).length, 3);
});

test('flatten gives one line without double quotes and cuts with a mark', () => {
  const s = cg.flatten('line "one"\n\n  two\r\nthree', 200);
  assert.equal(s, "line 'one' ¶ two ¶ three");
  const long = cg.flatten('word '.repeat(2000), 300);
  assert.ok(long.length <= 300);
  assert.match(long, /… \(cut\)$/);
});

const exists = ok => () => ok;
const okStatus = (pending = 0) => ({ code: 0, stdout: JSON.stringify({ initialized: true, index: { state: 'complete' }, pendingChanges: { added: 0, modified: pending, removed: 0 } }) });
const execWith = (status, extra = {}) => async args => {
  if (extra.calls) extra.calls.push(args.join(' '));
  if (args[0] === 'status') return status;
  if (args[0] === 'sync') return { code: 0, stdout: '' };
  if (args[0] === 'explore') return extra.explore || { code: 0, stdout: 'function sumList\n  return x' };
  return { code: 1, stdout: '' };
};

test('indexState: off, fresh, stale, degraded', async () => {
  assert.deepEqual(await cg.indexState('/p', { exists: exists(false), exec: execWith(okStatus()) }), { state: 'off' });
  assert.deepEqual(await cg.indexState('/p', { exists: exists(true), exec: execWith(okStatus()) }), { state: 'fresh' });
  assert.deepEqual(await cg.indexState('/p', { exists: exists(true), exec: execWith(okStatus(3)) }), { state: 'stale', pending: 3 });
  assert.equal((await cg.indexState('/p', { exists: exists(true), exec: execWith({ code: -1, stdout: '' }) })).state, 'degraded');
  assert.equal((await cg.indexState('/p', { exists: exists(true), exec: execWith({ code: 0, stdout: 'garbage' }) })).state, 'degraded');
  assert.equal((await cg.indexState('/p', { exists: exists(true), exec: execWith({ code: 0, stdout: JSON.stringify({ initialized: false }) }) })).reason, 'the index is missing');
  const broken = { code: 0, stdout: JSON.stringify({ initialized: true, index: { state: 'building' } }) };
  assert.equal((await cg.indexState('/p', { exists: exists(true), exec: execWith(broken) })).state, 'degraded');
});

test('prepareBrief: no index means nothing is added', async () => {
  const r = await cg.prepareBrief({ cwd: '/p', task: 'fix `sumList()`', exists: exists(false), exec: execWith(okStatus()) });
  assert.deepEqual(r, { state: 'off', text: '', explored: false });
});

test('prepareBrief: a fresh index and a code task carry a capped explore result', async () => {
  const calls = [];
  const big = { code: 0, stdout: 'line of source\n'.repeat(2000) };
  const r = await cg.prepareBrief({ cwd: '/p', task: 'fix `sumList()` in src/sum.js', exists: exists(true), exec: execWith(okStatus(), { calls, explore: big }) });
  assert.equal(r.state, 'fresh');
  assert.equal(r.explored, true);
  assert.ok(r.text.length <= cg.MAX_BRIEF_CHARS, `${r.text.length} characters`);
  assert.match(r.text, /^CodeGraph result for sumList, sum /);
  assert.doesNotMatch(r.text, /["\n]/);
  assert.deepEqual(calls.filter(c => !c.startsWith('status')), ['explore sumList sum --max-files 4']);
});

test('prepareBrief: a task that is not code, or names nothing, runs no explore', async () => {
  const calls = [];
  const a = await cg.prepareBrief({ cwd: '/p', task: 'fix `sumList()`', isCode: false, exists: exists(true), exec: execWith(okStatus(), { calls }) });
  const b = await cg.prepareBrief({ cwd: '/p', task: 'make it nicer', exists: exists(true), exec: execWith(okStatus(), { calls }) });
  assert.deepEqual([a.text, a.explored, b.text, b.explored], ['', false, '', false]);
  assert.ok(!calls.some(c => c.startsWith('explore')));
});

test('prepareBrief: a stale index is synced first, and stays fresh when the sync worked', async () => {
  const calls = [];
  let pending = 4;
  const exec = async args => {
    calls.push(args[0]);
    if (args[0] === 'status') return okStatus(pending);
    if (args[0] === 'sync') { pending = 0; return { code: 0, stdout: '' }; }
    return { code: 0, stdout: 'source' };
  };
  const r = await cg.prepareBrief({ cwd: '/p', task: 'fix `sumList()`', exists: exists(true), exec });
  assert.deepEqual(calls, ['status', 'sync', 'status', 'explore']);
  assert.equal(r.state, 'fresh');
});

test('prepareBrief: a stale index that will not sync is degraded, with the plain fall-back message', async () => {
  const r = await cg.prepareBrief({ cwd: '/p', task: 'fix `sumList()`', exists: exists(true), exec: async a => a[0] === 'status' ? okStatus(2) : { code: 1, stdout: '' } });
  assert.equal(r.state, 'degraded');
  assert.match(r.text, /^CodeGraph is degraded here \(.+\): use grep and file reads for this task, and say so in your note\.$/);
  assert.equal(r.explored, false);
});

test('prepareBrief: a missing CLI is degraded', async () => {
  const r = await cg.prepareBrief({ cwd: '/p', task: 'fix `sumList()`', exists: exists(true), exec: execWith({ code: -1, stdout: '' }) });
  assert.equal(r.state, 'degraded');
  assert.match(r.text, /use grep and file reads/);
});

test('summarizeCodegraph averages the measurements and splits tokens by CodeGraph use', () => {
  const e = (g, tok) => ({ t: 1, status: 'done', tokens: { input: tok, output: 0 }, codegraph: g });
  const s = summarizeCodegraph([
    e({ firstAction: 'codegraph', codegraphCalls: 2, filesBefore: 0, filesAfter: 2, nudged: false, index: 'fresh' }, 1000),
    e({ firstAction: 'read', codegraphCalls: 1, filesBefore: 4, filesAfter: 0, nudged: true, index: 'fresh' }, 3000),
    e({ firstAction: 'grep', codegraphCalls: 0, filesBefore: 8, filesAfter: 0, nudged: true, index: 'degraded' }, 6000),
    { t: 1, status: 'done' },
    { t: 1, kind: 'orchestration', codegraph: { firstAction: 'read' } },
  ]);
  assert.equal(s.tasks, 3);
  assert.ok(Math.abs(s.firstCodegraph - 1 / 3) < 1e-9);
  assert.equal(s.avgFilesBefore, 4);
  assert.ok(Math.abs(s.avgFilesAfter - 2 / 3) < 1e-9);
  assert.deepEqual([s.nudged, s.degraded, s.tokensWith, s.tokensWithout], [2, 1, 2000, 6000]);
  assert.deepEqual(summarizeCodegraph([]), { tasks: 0, firstCodegraph: 0, avgFilesBefore: 0, avgFilesAfter: 0, nudged: 0, degraded: 0, tokensWith: null, tokensWithout: null });
});
