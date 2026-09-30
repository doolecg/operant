const test = require('node:test');
const assert = require('node:assert');
const G = require('../typing-guard');

test('isUserKey: typed text and editing keys count, terminal replies do not', () => {
  for (const d of ['a', 'hello', '\r', '\x7f', '\x03', '\x1b', '\x1b[A', '\x1b[3~', '\x1bOA']) assert.equal(G.isUserKey(d), true, JSON.stringify(d));
  for (const d of ['\x1b[I', '\x1b[O', '\x1b[?1;2c', '\x1b[12;40R', '', null]) assert.equal(G.isUserKey(d), false, JSON.stringify(d));
});

test('isTyping: only within the window; 0 seconds or no keystroke is off', () => {
  assert.equal(G.isTyping(1000, 3, 3999), true);
  assert.equal(G.isTyping(1000, 3, 4000), false);
  assert.equal(G.isTyping(0, 3, 1000), false);
  assert.equal(G.isTyping(1000, 0, 1001), false);
  assert.equal(G.msLeft(1000, 3, 2000), 2000);
  assert.equal(G.msLeft(1000, 3, 5000), 0);
});

test('decide: deliver when idle, else hold or refuse by mode', () => {
  const base = { seconds: 3, lastKey: 1000 };
  assert.equal(G.decide({ ...base, mode: 'hold', now: 2000 }), 'hold');
  assert.equal(G.decide({ ...base, mode: 'refuse', now: 2000 }), 'refuse');
  assert.equal(G.decide({ ...base, mode: 'refuse', now: 9000 }), 'deliver');
  assert.equal(G.decide({ ...base, mode: 'hold', seconds: 0, now: 2000 }), 'deliver');
});

test('REFUSED names the tile and the window', () => {
  assert.match(G.REFUSED(7, 3), /tile 7/);
  assert.match(G.REFUSED(7, 3), /3s/);
});

test('sendBrief: a refusing guard stops the brief before it is queued', async () => {
  const M = require('../messaging');
  const target = { id: 3, alive: true, kind: 'ai', agentConf: 'claude', cwd: '/proj' };
  const self = { id: 7, alive: true, kind: 'ai', agentConf: 'opencode', cwd: '/proj', agentName: 'OpenCode' };
  const state = M.newState();
  const env = {
    state, teamEnabled: true, agents: [{ id: 'claude' }], agentKind: id => id, agentMode: () => 'both', flatLine: s => s,
    cwdOf: t => t.cwd, projectOf: d => d, tiles: () => [self, target], messageTarget: () => target, deliver: async () => true, open: async () => null,
    guard: t => { throw new Error(G.REFUSED(t.id, 3)); },
  };
  await assert.rejects(M.sendBrief({ text: 'Goal', id: 3 }, self, env), /you are typing in tile 3/);
  assert.equal(M.pending(state, 3), 0);
});
