const test = require('node:test');
const assert = require('node:assert/strict');
const { render } = require('../ops-view');
const { summarize } = require('../analytics');

const data = () => ({
  days: 30, decisions: 4, store: { version: 1, rows: { taskRuns: 2 } }, contextProviders: { codegraph: { used: 3, called: 4, rate: 0.75 } },
  health: [{ id: 'memory', name: 'Memory', state: 'healthy', detail: '12 facts' }, { id: 'mcp', name: '<MCP>', state: 'not configured', detail: 'none' }],
  stats: summarize({ taskRuns: [{ corr: 'a', t: 1, type: 'fix', tier: 'small', model: 'm<1>', status: 'done', attempts: 1, durationMs: 1000 }], modelRuns: [], tokenEvents: [], providerCalls: [], failures: [] }),
});

test('every section of the view is there, in order', () => {
  const html = render(data());
  const ids = [...html.matchAll(/data-ops="(\w+)"/g)].map(m => m[1]);
  assert.deepEqual(ids, ['overview', 'models', 'providers', 'tokens', 'cost', 'latency', 'failures', 'memory', 'context', 'health']);
  assert.match(html, /12 facts/);
  assert.match(html, /hdot not-configured/);
});

test('outside text is escaped; errors and empty data render a note', () => {
  const html = render(data());
  assert.ok(!html.includes('<MCP>') && html.includes('&lt;MCP&gt;') && html.includes('m&lt;1&gt;'));
  assert.match(render({ error: 'the local store is not open' }), /store is not open/);
  assert.match(render(null), /Nothing to show/);
});
