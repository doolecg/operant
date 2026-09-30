// Tests for evals/bench.mjs and `node evals/run.mjs --bench`: the replayable task set covers every category, the
// arithmetic is right, and replaying starts no model session.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const run = path.join(__dirname, '..', 'evals', 'run.mjs');
const load = () => import('../evals/bench.mjs');

test('the shipped task set has every category, each on a synthetic fixture that exists', async () => {
  const { loadBench, CATEGORIES } = await load();
  const sets = loadBench();
  assert.deepEqual(sets.map(s => s.category), CATEGORIES);
  for (const s of sets) {
    assert.ok(s.tasks.length >= 2, s.category);
    for (const t of s.tasks) assert.ok(fs.existsSync(path.join(__dirname, '..', 'evals', 'fixtures', t.fixture)), `${s.category}/${t.id}`);
  }
});

test('net tokens are gross saved minus Operant\'s own overhead; success and retries are counted per arm', async () => {
  const { summarizeBench } = await load();
  const mk = (bg, og, oh, bs, os, br, or) => ({ runs: { baseline: { gross: bg, cost: 1, success: bs, retries: br }, operant: { gross: og, overhead: oh, cost: 0.5, success: os, retries: or } } });
  const [r] = summarizeBench([{ category: 'x', tasks: [mk(100, 60, 10, true, true, 1, 0), mk(200, 150, 20, false, true, 2, 1)] }]);
  assert.equal(r.grossTokens, 90);
  assert.equal(r.netTokens, 60);
  assert.equal(r.baseline.success, 0.5);
  assert.equal(r.operant.success, 1);
  assert.equal(r.baseline.retries, 3);
  assert.equal(r.operant.retries, 1);
  assert.equal(r.operant.cost, 1);
});

test('an incomplete recorded run is refused, not averaged in', async () => {
  const { loadBench } = await load();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operant-bench-'));
  try {
    fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ category: 'docs', tasks: [{ id: 'a', runs: { baseline: { gross: 1, cost: 1, success: true, retries: 0 } } }] }));
    assert.throws(() => loadBench(dir), /lacks a complete "operant" run/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('run.mjs --bench prints one row per category with tokens, cost, success and retries, and calls no model', () => {
  const r = spawnSync(process.execPath, [run, '--bench'], { encoding: 'utf8', env: { ...process.env, OPERANT_EVAL_CLAUDE: 'no-such-claude-binary' } });
  assert.equal(r.status, 0, r.stderr);
  for (const c of ['simple-coding', 'medium-coding', 'complex-coding', 'debugging', 'refactor', 'exploration', 'docs', 'tests']) assert.match(r.stdout, new RegExp(`^${c}\\s`, 'm'));
  assert.match(r.stdout, /gross saved\s+net saved\s+cost base/);
  assert.match(r.stdout, /no model was called/);
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'evals', 'results', 'undefined')));
});
