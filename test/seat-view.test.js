const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../renderer/seat-view');

const seat = (o = {}) => ({ id: 'implementer', role: 'implementer', kind: 'normal', tier: 'small', effTier: 'small', state: 'empty', history: [], ...o });

test('seat state: needs input wins, then active, restored, idle-closed, empty', () => {
  assert.equal(V.seatState(seat({ state: 'active' }), { needsInput: true }), 'needs');
  assert.equal(V.seatState(seat({ state: 'active' })), 'active');
  assert.equal(V.seatState(seat({ state: 'idle-closed', history: [{ event: 'closed' }] })), 'idle');
  assert.equal(V.seatState(seat({ state: 'idle-closed', history: [{ event: 'restored' }] })), 'restored');
  assert.equal(V.seatState(seat()), 'empty');
});

test('worker replaced counts takeovers after the first worker', () => {
  assert.equal(V.replacedCount(seat({ history: [{ event: 'seated' }] })), 0);
  assert.equal(V.replacedCount(seat({ history: [{ event: 'seated' }, { event: 'closed' }, { event: 'seated' }, { event: 'replaced' }] })), 2);
  assert.equal(V.replacedCount(seat()), 0);
});

test('why this tier: default, norms, boost, hard, master', () => {
  assert.match(V.tierWhy(seat()), /cheapest tier that fits/);
  assert.match(V.tierWhy(seat({ effTier: 'xsmall' })), /small by default, xsmall under the team norms/);
  assert.match(V.tierWhy(seat({ boost: { tier: 'medium', taskId: 7 } })), /moved to medium for task #7.*back to small/);
  assert.match(V.tierWhy(seat({ kind: 'hard', tier: 'medium', effTier: 'medium' })), /pinned to medium/);
  assert.match(V.tierWhy(seat({ kind: 'master' })), /master seat/);
});

test('groupBySeat: pods first, tasks under their seat, open apart from closed', () => {
  const seats = [seat({ id: 'planner' }), seat({ id: 'implementer' }), seat({ id: 'lead', kind: 'master' })];
  const pods = [{ id: 'feature', name: 'feature', seatIds: ['planner', 'implementer', 'gone'] }];
  const tasks = [{ id: 1, seat: 'implementer', status: 'doing' }, { id: 2, seat: 'implementer', status: 'done' }, { id: 3, seat: null, status: 'doing' }];
  const g = V.groupBySeat({ seats, pods }, tasks, t => t.status !== 'done');
  assert.equal(g.length, 2);
  assert.deepEqual(g[0].cards.map(c => c.seat.id), ['planner', 'implementer']);
  assert.deepEqual(g[0].cards[1].open.map(t => t.id), [1]);
  assert.equal(g[0].cards[1].closed, 1);
  assert.equal(g[1].pod, null);
  assert.deepEqual(g[1].cards.map(c => c.seat.id), ['lead']);
});
