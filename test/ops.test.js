const test = require('node:test');
const assert = require('node:assert/strict');
const ops = require('../ops');

test('credentials: presence only, never values', () => {
  const files = { '/h/.claude/.credentials.json': true, '/h/.local/share/opencode/auth.json': { openrouter: { key: 'SECRET' } } };
  const norm = f => f.replace(/\\/g, '/');
  const c = ops.collectCredentials({ env: { OPENAI_API_KEY: 'SECRET2' }, home: '/h', exists: f => norm(f) in files, readJson: f => files[norm(f)] });
  assert.deepEqual(c, { claudeLogin: true, opencodeProviders: ['openrouter'], keys: ['OPENAI_API_KEY'] });
  assert.doesNotMatch(JSON.stringify(ops.credentialRows(c)), /SECRET/);
  const none = ops.credentialRows({ claudeLogin: false, opencodeProviders: [], keys: [] });
  assert.deepEqual(none.map(r => r.state), ['not configured', 'not configured']);
});

test('doctor maps health states to the five and adds versions, store and context providers', () => {
  const rows = ops.buildDoctor({
    health: [{ id: 'app', name: 'Operant', state: 'healthy', detail: 'ok' }, { id: 'models', name: 'Models', state: 'available', detail: 'listed' }, { id: 'mcp', name: 'MCP', state: 'not-configured', detail: 'none' }, { id: 'x', name: 'X', state: 'weird', detail: '' }],
    credentials: { claudeLogin: true, opencodeProviders: [], keys: [] }, versions: { Operant: '2.4.1', Node: '24' },
    store: { version: 1, rows: { taskRuns: 3, modelRuns: 0 }, pruned: 0 }, contextProviders: { codegraph: false, git: true },
  });
  const by = id => rows.find(r => r.id === id);
  assert.deepEqual([by('models').state, by('mcp').state, by('x').state], ['healthy', 'not configured', 'unknown']);
  assert.equal(by('versions').detail, 'Operant 2.4.1 · Node 24');
  assert.match(by('store').detail, /schema 1, taskRuns 3/);
  assert.equal(by('context').state, 'degraded');
  assert.equal(ops.buildDoctor({ health: [] }).find(r => r.id === 'store').state, 'unavailable');
  const text = ops.formatDoctor(rows);
  assert.match(text, /overall: degraded/);
  assert.match(text, /^healthy\s+Operant\s+ok/m);
});

test('providers and models lists', () => {
  const p = ops.providersList({ agents: [{ id: 'claude', name: 'Claude', command: 'claude --x' }, { id: 'opencode', command: 'opencode' }, { id: 'z', command: '' }], installed: { claude: true, opencode: false }, credentials: { claudeLogin: false, keys: [], opencodeProviders: [] } });
  assert.deepEqual(p.map(x => x.state), ['degraded', 'unavailable', 'not configured']);
  assert.match(ops.formatProviders(p), /no credentials found/);
  const m = ops.modelsList({ tiers: [{ name: 'small', agent: 'claude', model: 'm1', active: {} }, { name: 'high', model: 'm2', active: null }, { name: 'xsmall', model: 'm0', active: {} }], routeHealth: { m1: { n: 4, availability: 0.75, avgLatencyMs: 4000, down: null } } });
  assert.deepEqual(m.map(x => x.state), ['healthy', 'unavailable', 'unknown']);
  assert.match(ops.formatModels(m), /75% ok over 4 calls, ~4 s/);
});

test('route explain prints the stored structured reason and the rejected alternative', () => {
  const rej = { tier: 'medium', utility: 0.5, why: 'lower utility (0.5 vs 0.7)' };
  const d = { tier: 'small', model: 'm1', reason: 'small: 90% of 6 fix tasks passed', strategy: { basis: 'utility' }, inputs: { type: 'fix', risk: 'low' },
    structured: { risk: 'low', minTasks: 5, chosen: { tier: 'small', p: 0.9, n: 6, utility: 0.7, evidence: true, scope: 'project' }, rejected: rej },
    rejected: rej, alternatives: [{ tier: 'small', n: 6, p: 0.9, costUsd: 0.1, utility: 0.7 }] };
  const t = ops.formatExplain(d, 8);
  assert.match(t, /^task 8: small \(m1\) · utility/);
  assert.match(t, /chosen: small, p\(success\) 0\.9 from 6 tasks \(project\), utility 0\.7/);
  assert.match(t, /rejected: medium, utility 0\.5 \(lower utility/);
  assert.match(ops.formatExplain({ tier: 'x', structured: { chosen: { tier: 'x', p: 0.6, evidence: false, utility: 0.1 }, risk: 'high' } }, 2), /default, under 5 tasks of evidence[\s\S]*never explored/);
  assert.equal(ops.formatExplain(null, 9), 'no routing decision stored for task 9');
});
