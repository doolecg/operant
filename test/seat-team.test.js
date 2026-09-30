// Tests for hard and master seats, team norms, and growing or shrinking a running team (seats.js, norms.js, ready-check.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const S = require('../seats.js');
const N = require('../norms.js');
const { idleDue } = require('../ready-check.js');

const T0 = 1700000000000;
const fresh = () => S.defaultSeats(T0);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'seat-team-'));

test('hard seat: released to empty, boost cleared, drop-back suggestion instead of continuing on medium', () => {
  const st = fresh();
  S.take(st, 'hard-1', { tileId: 7, now: T0 });
  S.boost(st, 'hard-1', 'high', 3);
  const s = S.release(st, 'hard-1', { task: { status: 'done', note: 'fixed' }, reason: 'finished', now: T0 + 1 });
  assert.equal(s.state, 'empty');
  assert.equal(s.tileId, null);
  assert.equal(s.boost, undefined);
  assert.equal(s.tier, 'medium');
  assert.match(S.dropBack(s), /drop back.*follow-up.*small.*not medium/);
  assert.equal(S.dropBack(S.find(st, 'planner')), null);
});

test('hard seat: still needs the user word or an approved tier-up', () => {
  const st = fresh();
  assert.equal(S.canFill(S.find(st, 'hard-2')).ok, false);
  assert.equal(S.canFill(S.find(st, 'hard-2'), { userAsked: true }).ok, true);
  assert.equal(S.canFill(S.find(st, 'hard-2'), { tierUpApproved: true }).ok, true);
});

test('a seat pinned to medium is marked in the table and the seat page', () => {
  const st = fresh();
  assert.match(S.formatTable(st), /hard-1\s+hard worker\s+hard\s+medium \(pinned\)/);
  assert.match(S.formatSeat(S.find(st, 'hard-1')), /tier medium \(pinned to medium\)/);
  assert.doesNotMatch(S.formatSeat(S.find(st, 'planner')), /pinned/);
  S.boost(st, 'planner', 'medium', 1);
  assert.match(S.formatSeat(S.find(st, 'planner')), /pinned to medium/);
});

test('master seats: two by default, the second on the free tier', () => {
  const st = fresh();
  assert.equal(S.find(st, 'lead').kind, 'master');
  const oc = S.find(st, 'master-opencode');
  assert.equal(oc.kind, 'master');
  assert.equal(oc.tier, 'free');
  assert.deepEqual(oc.delegations, []);
});

test('master delegations: recorded, deduped by task, shown as "delegates to", master only', () => {
  const st = fresh();
  S.delegate(st, 'lead', { seatId: 'implementer', taskId: 4 });
  S.delegate(st, 'lead', { seatId: null, taskId: 5 });
  S.delegate(st, 'lead', { seatId: 'tester', taskId: 4 });
  assert.deepEqual(S.find(st, 'lead').delegations, [{ seatId: null, taskId: 5 }, { seatId: 'tester', taskId: 4 }]);
  assert.match(S.formatSeat(S.find(st, 'lead')), /delegates to: worker \(task 5\), tester \(task 4\)/);
  assert.throws(() => S.delegate(st, 'planner', { taskId: 1 }), /not a master seat/);
  for (let i = 10; i < 60; i++) S.delegate(st, 'lead', { seatId: 'docs', taskId: i });
  assert.equal(S.find(st, 'lead').delegations.length, S.DELEGATIONS_MAX);
});

test('master delegations and task state survive replacement and a save/load round trip', () => {
  const dir = tmp();
  S.update(dir, st => {
    S.take(st, 'lead', { tileId: 2 });
    S.delegate(st, 'lead', { seatId: 'planner', taskId: 9 });
    S.release(st, 'lead', { task: { status: 'done', note: 'split into 3', checkpoint: { decisions: ['use planner'] } }, reason: 'compacted' });
    S.take(st, 'lead', { tileId: 3 });
  });
  const lead = S.find(S.load(dir), 'lead');
  assert.equal(lead.tileId, 3);
  assert.deepEqual(lead.delegations, [{ seatId: 'planner', taskId: 9 }]);
  assert.deepEqual(lead.taskState.decisions, ['use planner']);
  assert.equal(S.find(S.load(dir), 'planner').delegations, undefined);
});

test('addSeat: validates id, kind and tier; a hard seat defaults to medium', () => {
  const st = fresh();
  const s = S.addSeat(st, { id: 'security', role: 'security review', tier: 'small', now: T0 });
  assert.equal(s.kind, 'normal');
  assert.equal(S.find(st, 'security').role, 'security review');
  assert.equal(S.addSeat(st, { id: 'hard-3', kind: 'hard' }).tier, 'medium');
  assert.equal(S.addSeat(st, { id: 'master-x', kind: 'master' }).delegations.length, 0);
  assert.throws(() => S.addSeat(st, { id: 'security' }), /already exists/);
  assert.throws(() => S.addSeat(st, { id: 'Bad Id' }), /lowercase/);
  assert.throws(() => S.addSeat(st, { id: 'x1', tier: 'huge' }), /unknown tier/);
  assert.throws(() => S.addSeat(st, { id: 'x2', kind: 'boss' }), /unknown kind/);
});

test('removeSeat: refuses an active seat; hard and master defaults need --force; removed defaults stay gone', () => {
  const dir = tmp();
  S.update(dir, st => { S.take(st, 'docs', { tileId: 4 }); });
  assert.throws(() => S.update(dir, st => S.removeSeat(st, 'docs')), /active in tile 4/);
  assert.throws(() => S.update(dir, st => S.removeSeat(st, 'hard-2')), /needs --force/);
  assert.throws(() => S.update(dir, st => S.removeSeat(st, 'lead')), /needs --force/);
  assert.throws(() => S.update(dir, st => S.removeSeat(st, 'nope')), /no seat/);
  S.update(dir, st => { S.removeSeat(st, 'tester'); S.removeSeat(st, 'hard-2', { force: true }); });
  const st = S.load(dir);
  assert.equal(S.find(st, 'tester'), null);
  assert.equal(S.find(st, 'hard-2'), null);
  assert.ok(!S.podOf(st, 'tester'));
  assert.ok(!S.findPod(st, 'feature').seatIds.includes('tester'));
  S.update(dir, s => S.addSeat(s, { id: 'tester', tier: 'free' }));
  assert.equal(S.find(S.load(dir), 'tester').tier, 'free');
});

test('removeSeat drops the removed seat from masters delegations', () => {
  const st = fresh();
  S.addSeat(st, { id: 'extra' });
  S.delegate(st, 'lead', { seatId: 'extra', taskId: 1 });
  S.removeSeat(st, 'extra');
  assert.deepEqual(S.find(st, 'lead').delegations, []);
});

test('idleDue: never with 0 minutes, never while busy, only once the idle time has passed', () => {
  const now = T0 + 20 * 60000;
  assert.equal(idleDue({ busy: false, since: T0, minutes: 15, now }), true);
  assert.equal(idleDue({ busy: false, since: T0 + 10 * 60000, minutes: 15, now }), false);
  assert.equal(idleDue({ busy: true, since: T0, minutes: 15, now }), false);
  assert.equal(idleDue({ busy: false, since: T0, minutes: 0, now }), false);
  assert.equal(idleDue({ busy: false, since: 0, minutes: 15, now }), false);
});

test('an idle-closed seat reopens from its stored state', () => {
  const st = fresh();
  S.take(st, 'implementer', { tileId: 8 });
  S.release(st, 'implementer', { task: { status: 'done', note: 'half done', checkpoint: { files: ['a.js'], next: 'add tests' } }, reason: 'closed' });
  const s = S.find(st, 'implementer');
  assert.equal(s.state, 'idle-closed');
  assert.match(S.brief(s), /a\.js/);
  assert.match(S.brief(s), /next: add tests/);
  S.take(st, 'implementer', { tileId: 9 });
  assert.equal(s.state, 'active');
});

test('norms: default is trust but verify; a project preset is stored under .operant and read back', () => {
  const dir = tmp();
  assert.equal(N.load(dir), 'trust-but-verify');
  assert.equal(N.load(dir, 'exploratory'), 'exploratory');
  assert.equal(N.save(dir, 'Exploratory'), 'exploratory');
  assert.ok(fs.existsSync(path.join(dir, '.operant', 'norms.json')));
  assert.equal(N.load(dir, 'trust-but-verify'), 'exploratory');
  assert.throws(() => N.save(dir, 'reckless'), /unknown preset/);
  assert.equal(N.load(dir, 'garbage'), 'exploratory');
  fs.writeFileSync(N.fileOf(dir), '{ nope');
  assert.equal(N.load(dir, 'garbage'), 'trust-but-verify');
});

test('norms profiles: trust but verify keeps full verification and review advice; exploratory loosens both', () => {
  const tv = N.profile('trust-but-verify'), ex = N.profile('exploratory');
  assert.deepEqual([tv.extraChecks, tv.independentReview, tv.preferCheap], [true, true, false]);
  assert.deepEqual([ex.extraChecks, ex.independentReview, ex.preferCheap], [false, false, true]);
  assert.equal(N.profile('unknown').id, 'trust-but-verify');
});

test('tierFor: exploratory prefers xsmall for ordinary small seats only; default norms change nothing', () => {
  const st = fresh();
  const planner = S.find(st, 'planner'), hard = S.find(st, 'hard-1'), lead = S.find(st, 'lead');
  assert.equal(S.tierFor(planner), 'small');
  assert.equal(S.tierFor(planner, { norms: N.profile('trust-but-verify') }), 'small');
  assert.equal(S.tierFor(planner, { norms: N.profile('exploratory') }), 'xsmall');
  assert.equal(S.tierFor(hard, { norms: N.profile('exploratory') }), 'medium');
  assert.equal(S.tierFor(lead, { norms: N.profile('exploratory') }), 'small');
  assert.equal(S.tierFor(planner, { tier: 'high', norms: N.profile('exploratory') }), 'high');
});

test('a normalized older file gains master-opencode and an empty removed list', () => {
  const st = S.normalize({ schema: 1, seats: [{ id: 'planner' }] }, T0);
  assert.ok(S.find(st, 'master-opencode'));
  assert.deepEqual(st.removed, []);
});
