const test = require('node:test');
const assert = require('node:assert/strict');
const r = require('../registry');

const rows = [
  { id: 'codegraph', name: 'CodeGraph', state: 'healthy', detail: 'ok', checkedAt: 1700000000000 },
  { id: 'localmodel', name: 'Local model', state: 'not-configured', detail: '', checkedAt: null },
  { id: 'mcp', name: 'MCP servers', state: 'unavailable', detail: '', checkedAt: 1700000000000 },
];

test('component registry: state, decision, reason and security note per component', () => {
  const l = r.componentRegistry({ rows });
  const cg = l.find(c => c.id === 'codegraph');
  assert.equal(cg.installed, true); assert.equal(cg.healthy, true); assert.equal(cg.lastChecked, 1700000000000);
  assert.equal(cg.decision, 'adopted'); assert.ok(cg.reason && cg.security && cg.capabilities.length);
  const lm = l.find(c => c.id === 'localmodel');
  assert.equal(lm.installed, false); assert.equal(lm.lastChecked, null); assert.equal(lm.decision, 'optional');
  assert.equal(l.find(c => c.id === 'mcp').installed, false);
  assert.equal(l.find(c => c.id === 'app').state, 'unknown');
  assert.match(r.formatComponents(l), /security:/);
});

test('records are updatable and validated', () => {
  const rec = r.withRecord({}, 'mcp', { decision: 'rejected', reason: 'too broad', capabilities: 'a, b' });
  const mcp = r.componentRegistry({ rows, records: rec }).find(c => c.id === 'mcp');
  assert.equal(mcp.decision, 'rejected'); assert.equal(mcp.reason, 'too broad'); assert.deepEqual(mcp.capabilities, ['a', 'b']);
  assert.throws(() => r.withRecord({}, 'mcp', { decision: 'maybe' }));
  const unknown = r.componentRegistry({ rows: [], records: r.withRecord({}, 'app', {}) });
  assert.ok(unknown.length);
});

test('model registry fills from tiers, opencode and the local model', () => {
  const oc = [{ providerID: 'opencode', id: 'big-pickle', cost: { input: 0, output: 0 }, limit: { context: 200000 }, capabilities: { toolcall: true, reasoning: false } },
    { providerID: 'openai', id: 'gpt-x', cost: { input: 2, output: 8 }, limit: { context: 400000 }, variants: { low: {}, high: {} } }];
  const l = r.modelRegistry({ tiers: [{ name: 'free', agent: 'opencode', model: 'opencode/big-pickle' }, { name: 'small', agent: 'claude', model: 'claude-haiku-4-5' }], opencodeModels: oc, local: { model: 'gemma4:e4b', status: 'ready' } });
  const bp = l.find(m => m.id === 'opencode/big-pickle');
  assert.equal(bp.costTier, 'free'); assert.equal(bp.contextWindow, 200000); assert.equal(bp.tools, true); assert.deepEqual(bp.tiers, ['free']);
  assert.equal(l.find(m => m.id === 'openai/gpt-x').costTier, 'medium');
  assert.equal(l.find(m => m.id === 'openai/gpt-x').reasoning, true);
  assert.equal(l.find(m => m.id === 'claude-haiku-4-5').costTier, 'low');
  assert.equal(l.find(m => m.id === 'ollama/gemma4:e4b').installed, true);
  assert.match(r.formatModelRegistry(l), /big-pickle/);
  assert.equal(r.modelRegistry({}).length >= 1, true);
});
