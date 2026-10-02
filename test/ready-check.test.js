// Tests for the ready check and the brief queue that uses it.
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../messaging.js');
const R = require('../ready-check.js');

test('ready check: process, agent, prompt and busy, in that order', () => {
  const ok = { alive: true, ptyId: 3, started: true, working: false, waitingPrompt: false };
  assert.deepEqual(R.readyCheck(ok), { ready: true });
  assert.match(R.readyCheck(null).reason, /no tile/);
  assert.match(R.readyCheck({ ...ok, alive: false }).reason, /process is not running/);
  assert.match(R.readyCheck({ ...ok, ptyId: null }).reason, /process is not running/);
  assert.match(R.readyCheck({ ...ok, started: false }).reason, /agent has not started/);
  assert.match(R.readyCheck({ ...ok, waitingPrompt: true, working: true }).reason, /permission prompt/);
  assert.match(R.readyCheck({ ...ok, working: true }).reason, /busy/);
});

test('sendBrief: a tile that is not ready keeps the brief queued and says why', async () => {
  const state = M.newState(), self = { id: 1, kind: 'ai', alive: true };
  const w = { id: 2, alive: true, kind: 'ai', agentConf: 'claude', cwd: '/p', lastActivity: 0, notReady: 'its agent has not started yet' };
  const env = { state, teamEnabled: false, agents: [], agentKind: () => 'claude', agentMode: () => 'claude', messageTarget: () => w, deliver: async () => false, flatLine: s => s,
    cwdOf: t => t.cwd || '/p', projectOf: d => d, tiles: () => [w], open: async () => null, notReady: t => t.notReady };
  const r = await M.sendBrief({ text: 'Goal: x', id: 2 }, self, env);
  assert.equal(r.delivered, false);
  assert.match(r.text, /not ready \(its agent has not started yet\).*queued/);
  assert.equal(M.pending(state, 2), 1);
});
