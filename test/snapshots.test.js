// Tests for team snapshots and restore, adopting a running tile into a seat, and the ready-check setting.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../seats.js');
const R = require('../ready-check.js');

const T0 = 1700000000000;
const fresh = () => S.defaultSeats(T0);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'snap-'));
const tasks = () => [
  { id: 1, seat: 'implementer', status: 'doing', text: 'add the login form', tier: 'small', budget: 40000, checkpoint: { decisions: ['use oauth'], files: ['auth.js'], next: 'wire the button', at: 5 }, actions: [{ cmd: 'rm -rf build', at: 6 }] },
  { id: 2, seat: 'implementer', status: 'done', text: 'old finished task' },
  { id: 3, seat: 'reviewer', status: 'review', text: 'review waiting' },
  { id: 4, seat: 'hard-1', status: 'todo', text: 'the hard part' },
  { id: 5, text: 'no seat', status: 'todo' },
];
function team() {
  const st = fresh();
  S.take(st, 'implementer', { tileId: 7, now: T0 });
  S.take(st, 'reviewer', { tileId: 8, now: T0 });
  S.release(st, 'reviewer', { extra: { lastError: 'Authorization: Bearer abcdefghijklmnop1234' }, now: T0 });
  S.take(st, 'hard-1', { tileId: 9, now: T0 });
  S.boost(st, 'implementer', 'medium', 1);
  S.find(st, 'implementer').budget = 50000;
  S.setPodBrief(st, 'feature', 'Use CodeGraph first.');
  return st;
}

test('snapshot keeps seat state, pod briefs and seat tasks; no tile ids, guidance or history; secrets redacted', () => {
  const snap = S.snapshotOf(team(), { name: 'my team', tasks: tasks(), now: T0 });
  assert.equal(snap.schema, S.SNAPSHOT_SCHEMA);
  assert.deepEqual(snap.seats.map(s => s.id), ['implementer', 'reviewer', 'hard-1']);
  const impl = snap.seats[0];
  assert.deepEqual([impl.state, impl.tier, impl.podId, impl.boost, impl.budget], ['active', 'small', 'feature', { tier: 'medium', taskId: 1 }, 50000]);
  assert.ok(snap.seats.every(s => !('tileId' in s) && !('guidance' in s) && !('history' in s)));
  assert.equal(snap.pods.find(p => p.id === 'feature').brief, 'Use CodeGraph first.');
  assert.deepEqual(snap.tasks.map(t => t.id), [1, 2, 3, 4]);
  assert.equal(snap.tasks[0].checkpointId, '1:5');
  assert.equal(snap.tasks[0].budget, 40000);
  assert.doesNotMatch(JSON.stringify(snap), /abcdefghijklmnop1234/);
});

test('snapshot files: save, list and load by name; unknown and newer schemas are refused', () => {
  const dir = tmp();
  try {
    assert.equal(S.formatSnapshots(S.listSnapshots(dir)), '(no snapshots; operant team snapshot <name>)');
    S.saveSnapshot(dir, S.snapshotOf(team(), { name: 'My Team', tasks: tasks(), now: T0 }));
    const list = S.listSnapshots(dir);
    assert.deepEqual([list[0].name, list[0].seats, list[0].tasks], ['My Team', 3, 4]);
    assert.match(S.formatSnapshots(list), /^My Team  .*3 seats, 4 tasks$/);
    assert.equal(S.loadSnapshot(dir, 'my team').name, 'My Team');
    assert.throws(() => S.loadSnapshot(dir, 'nope'), /no snapshot "nope"/);
    const file = S.snapshotFile(dir, 'my team');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...raw, schema: 99 }));
    assert.throws(() => S.loadSnapshot(dir, 'my team'), /schema 99, newer than this Operant understands \(1\)/);
    assert.match(S.formatSnapshots(S.listSnapshots(dir)), /newer format/);
    fs.writeFileSync(file, JSON.stringify({ hello: 1 }));
    assert.throws(() => S.loadSnapshot(dir, 'my team'), /unknown format/);
    fs.writeFileSync(file, '{not json');
    assert.throws(() => S.loadSnapshot(dir, 'my team'), /could not be read/);
    assert.match(S.formatSnapshots(S.listSnapshots(dir)), /unreadable/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('restore: seats come back idle, unfinished tasks are re-queued, finished ones and review are not', () => {
  const snap = S.snapshotOf(team(), { name: 't', tasks: tasks(), now: T0 });
  const st = fresh();
  const r = S.restoreSnapshot(st, snap, { now: T0 });
  const by = Object.fromEntries(r.results.map(x => [x.seat, x]));
  assert.equal(by.reviewer.result, 'restored');
  assert.equal(by.implementer.result, 'needs input'); // it had a live worker when saved
  const impl = S.find(st, 'implementer');
  assert.deepEqual([impl.state, impl.tileId, impl.tier, impl.budget, impl.podId, impl.boost], ['idle-closed', null, 'small', 50000, 'feature', { tier: 'medium', taskId: 1 }]);
  assert.equal(S.findPod(st, 'feature').brief, 'Use CodeGraph first.');
  assert.match(S.find(st, 'reviewer').taskState.lastError, /\[redacted\]/);
  assert.deepEqual(r.requeue.map(t => t.text), ['add the login form', 'the hard part']);
  const t1 = r.requeue[0];
  assert.deepEqual([t1.status, t1.seat, t1.tier, t1.budget, t1.checkpoint.next, t1.actions[0].cmd], ['todo', 'implementer', 'small', 40000, 'wire the button', 'rm -rf build']);
  assert.match(S.formatRestore('t', r), /3 seats|implementer: needs input/);
});

test('restore never launches or fills a hard seat: it comes back idle with a needs-input result', () => {
  const snap = S.snapshotOf(team(), { name: 't', tasks: tasks(), now: T0 });
  const st = fresh();
  const r = S.restoreSnapshot(st, snap, { now: T0 });
  const hard = r.results.find(x => x.seat === 'hard-1');
  assert.equal(hard.result, 'needs input');
  assert.match(hard.reason, /not launched/);
  assert.equal(S.find(st, 'hard-1').state, 'idle-closed');
  assert.equal(S.find(st, 'hard-1').tileId, null);
  assert.ok(st.seats.every(s => s.tileId === null));
});

test('restore twice does not duplicate tasks already on the board, and a seat held right now is left alone', () => {
  const snap = S.snapshotOf(team(), { name: 't', tasks: tasks(), now: T0 });
  const st = fresh();
  const first = S.restoreSnapshot(st, snap, { now: T0 });
  const board = first.requeue.map((t, i) => ({ ...t, id: 10 + i }));
  assert.equal(S.restoreSnapshot(st, snap, { boardTasks: board, now: T0 }).requeue.length, 0);
  S.take(st, 'reviewer', { tileId: 3, now: T0 });
  const r = S.restoreSnapshot(st, snap, { now: T0 });
  assert.match(r.results.find(x => x.seat === 'reviewer').reason, /held by tile 3/);
  assert.equal(S.find(st, 'reviewer').tileId, 3);
});

test('restore: a bad saved seat fails with a reason, the rest still restore; a newer schema throws', () => {
  const snap = S.snapshotOf(team(), { name: 't', tasks: [], now: T0 });
  snap.seats.push({ id: 'Bad Id!' });
  const r = S.restoreSnapshot(fresh(), snap, { now: T0 });
  assert.deepEqual([r.results.at(-1).result, r.results.at(-1).reason], ['failed', 'the saved seat has no valid id']);
  assert.equal(r.results[0].seat, 'implementer');
  assert.throws(() => S.restoreSnapshot(fresh(), { ...snap, schema: 2 }), /newer than this Operant understands/);
});

test('adopt: a running agent tile takes the seat with no restart, and the seat then behaves like a launched one', () => {
  const st = fresh();
  const seat = S.adopt(st, 'reviewer', { id: 12, alive: true, agent: true }, { now: T0 });
  assert.deepEqual([seat.state, seat.tileId, seat.podId], ['active', 12, 'feature']);
  assert.equal(S.seatOfTile(st, 12).id, 'reviewer');
  assert.equal(seat.history.at(-1).event, 'adopted');
  S.release(st, 'reviewer', { tileId: 12, now: T0 });
  assert.equal(S.find(st, 'reviewer').state, 'idle-closed');
});

test('adopt refuses a dead tile, a non-agent tile, a tile already seated, a held seat and an unnamed hard seat', () => {
  const st = fresh();
  assert.throws(() => S.adopt(st, 'reviewer', { id: 1, alive: false, agent: true }), /not running/);
  assert.throws(() => S.adopt(st, 'reviewer', { id: 1, alive: true, agent: false }), /not a Claude Code, Codex or Gemini CLI tile/);
  assert.throws(() => S.adopt(st, 'reviewer', { id: 1, alive: true, agent: true, seatId: 'planner' }), /already holds seat planner/);
  S.adopt(st, 'planner', { id: 2, alive: true, agent: true });
  assert.throws(() => S.adopt(st, 'reviewer', { id: 2, alive: true, agent: true }), /already holds seat planner/);
  assert.throws(() => S.adopt(st, 'planner', { id: 3, alive: true, agent: true }), /already held by tile 2/);
  assert.throws(() => S.adopt(st, 'hard-1', { id: 4, alive: true, agent: true }), /hard-worker seat/);
  assert.equal(S.adopt(st, 'hard-1', { id: 4, alive: true, agent: true }, { userAsked: true }).tileId, 4);
  assert.throws(() => S.adopt(st, 'nope', { id: 5, alive: true, agent: true }), /no seat "nope"/);
  assert.throws(() => S.adopt(st, 'docs', {}), /tile id is required/);
});

test('ready check setting: off means every tile counts as ready, on (default) still checks', () => {
  assert.equal(R.readyCheck(null).ready, false);
  assert.equal(R.readyCheck(null, { enabled: true }).ready, false);
  assert.deepEqual(R.readyCheck({ alive: false }, { enabled: false }), { ready: true });
  assert.deepEqual(R.readyCheck(null, { enabled: false }), { ready: true });
  assert.equal(R.readyCheck({ alive: true, ptyId: 1, started: true, working: true }, { enabled: true }).ready, false);
});
