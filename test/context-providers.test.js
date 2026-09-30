// Tests for context-providers.js: choice by question shape, the degradation chain, usefulness counters.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('../context-providers.js');

test('questions pick a provider by shape', () => {
  assert.equal(cp.choose('who calls remember()').provider, 'codegraph');
  assert.equal(cp.choose('what changed in the last commit').provider, 'git');
  assert.equal(cp.choose('what did we decide about commit messages, our rule').provider, 'git'); // git word wins over memory
  assert.equal(cp.choose('what is our convention for release tags').provider, 'memory');
  assert.equal(cp.choose('find all occurrences of "TODO"').provider, 'ripgrep');
  assert.equal(cp.choose('where is the auto compact threshold checked').provider, 'ripgrep');
  assert.equal(cp.choose('how does loginRedirect work').provider, 'codegraph');
});

test('a missing provider degrades codegraph -> ripgrep -> manual', () => {
  const q = 'who calls remember()';
  const c = cp.choose(q, { available: { codegraph: false } });
  assert.equal(c.provider, 'ripgrep'); assert.equal(c.wanted, 'codegraph'); assert.equal(c.degraded, true);
  const m = cp.choose(q, { available: { codegraph: false, ripgrep: false } });
  assert.equal(m.provider, 'manual'); assert.deepEqual(m.chain, ['codegraph', 'ripgrep', 'manual']);
  assert.equal(cp.choose(q).degraded, false);
});

test('memory and git chains degrade too', () => {
  assert.equal(cp.choose('our convention for tags', { available: { memory: false } }).provider, 'ripgrep');
  assert.equal(cp.choose('recent commits', { available: { git: false } }).provider, 'manual');
});

test('counters are stored in .operant and read back with a rate', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'operant-cp-'));
  try {
    assert.deepEqual(cp.readStats(cwd), {});
    cp.recordCall(cwd, 'codegraph'); cp.recordCall(cwd, 'codegraph'); cp.recordUse(cwd, 'codegraph'); cp.recordCall(cwd, 'memory');
    cp.recordCall(cwd, 'bogus');
    assert.ok(fs.existsSync(path.join(cwd, '.operant', 'context-providers.json')));
    const s = cp.readStats(cwd);
    assert.deepEqual(s.codegraph, { called: 2, used: 1, rate: 0.5 });
    assert.equal(s.memory.used, 0);
    assert.equal(s.bogus, undefined);
    assert.match(cp.formatStats(s), /codegraph 1\/2 used \(50%\)/);
    assert.equal(cp.formatStats({}), '');
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('tool noter: CodeGraph and git lookups are calls, the next edit makes them used', () => {
  const seen = [];
  const note = cp.createToolNoter((p, f) => seen.push(`${p}:${f}`));
  note('Bash', { command: 'codegraph explore "foo"' });
  note('mcp__codegraph__codegraph_explore', {});
  note('Bash', { command: 'git log --oneline -5' });
  note('Bash', { command: 'git commit -m x' }); // not a lookup
  note('Read', { file_path: 'a.js' });
  assert.deepEqual(seen, ['codegraph:called', 'codegraph:called', 'git:called']);
  note('Edit', { file_path: 'a.js' });
  assert.deepEqual(seen.slice(3).sort(), ['codegraph:used', 'git:used']);
  note('Edit', { file_path: 'b.js' }); // nothing new to credit
  assert.equal(seen.length, 5);
});
