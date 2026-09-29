// A worker's raw final output is kept on its board task.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const hook = require('../bin/operant-hook.js');

test('the Stop hook passes last_assistant_message to Operant', async () => {
  const calls = [];
  const real = global.fetch;
  process.env.OPERANT_API = 'http://x'; process.env.OPERANT = '1';
  global.fetch = async (u, o) => { calls.push(JSON.parse(o.body)); return { json: async () => ({ ok: true, result: {} }) }; };
  try { await hook.HANDLERS.stop({ last_assistant_message: 'final words' }); } finally { global.fetch = real; }
  assert.equal(calls[0].args.output, 'final words');
});
