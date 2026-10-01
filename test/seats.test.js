// Tests for seats.js: defaults, storage, the tier rule, binding and the handoff brief.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../seats.js');

const T0 = 1700000000000;
const fresh = () => S.defaultSeats(T0);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'seats-'));

test('defaults: six normal seats, two hard seats on medium, two masters', () => {
  const st = fresh();
  assert.deepEqual(st.seats.map(s => s.id), ['planner', 'implementer', 'reviewer', 'explorer', 'docs', 'tester', 'hard-1', 'hard-2', 'lead']);
  const by = id => S.find(st, id);
  for (const id of ['explorer', 'docs', 'tester']) assert.equal(by(id).tier, 'xsmall');
  for (const id of ['planner', 'implementer', 'reviewer', 'lead']) assert.equal(by(id).tier, 'small');
  for (const id of ['hard-1', 'hard-2']) { assert.equal(by(id).kind, 'hard'); assert.equal(by(id).tier, 'medium'); }
  assert.equal(by('lead').kind, 'master');
  assert.ok(st.seats.every(s => s.state === 'empty' && s.tileId === null && s.podId === null && s.createdAt === T0));
});

test('load creates defaults on first use, save/load round-trips, schema version is written', () => {
  const dir = tmp();
  try {
    const a = S.load(dir);
    assert.equal(a.seats.length, 9);
    S.update(dir, st => S.setGuidance(st, 'planner', 'plan small'));
    const raw = JSON.parse(fs.readFileSync(S.fileOf(dir), 'utf8'));
    assert.equal(raw.schema, S.SCHEMA);
    assert.equal(S.find(S.load(dir), 'planner').guidance, 'plan small');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('normalize repairs bad data, restores missing defaults, refuses a newer schema', () => {
  const st = S.normalize({ schema: 1, seats: [{ id: 'planner', tier: 'nonsense', state: 'active', tileId: 5, history: new Array(40).fill({ event: 'seated', at: 1 }) }, { id: 'BAD ID' }, { id: 'custom', role: 'x' }] }, T0);
  const p = S.find(st, 'planner');
  assert.equal(p.tier, 'small');
  assert.equal(p.tileId, 5);
  assert.equal(p.history.length, S.HISTORY_MAX);
  assert.ok(S.find(st, 'custom') && S.find(st, 'hard-2') && !S.find(st, 'BAD ID'));
  assert.equal(S.normalize(null, T0).seats.length, 9);
  assert.equal(S.find(S.normalize({ schema: 1, seats: [{ id: 'docs', state: 'idle-closed', tileId: 9 }] }, T0), 'docs').tileId, null);
  assert.throws(() => S.normalize({ schema: 99, seats: [] }), /newer/);
});

test('tier rule: default tier unless the user names one; boosts return to the default', () => {
  const st = fresh(), p = S.find(st, 'planner');
  assert.equal(S.tierFor(p), 'small');
  assert.equal(S.tierFor(p, { tier: 'free' }), 'free');
  assert.throws(() => S.tierFor(p, { tier: 'huge' }), /unknown tier/);
  S.boost(st, 'planner', 'medium', 7);
  assert.equal(S.tierFor(p), 'medium');
  S.take(st, 'planner', { tileId: 3, now: T0 });
  S.release(st, 'planner', { now: T0 + 1 });
  assert.equal(S.tierFor(p), 'small');
  assert.equal(p.boost, undefined);
});

test('a hard seat is only filled on the user word or an approved tier-up; nothing raises a tier by itself', () => {
  const st = fresh();
  assert.equal(S.canFill(S.find(st, 'hard-1')).ok, false);
  assert.match(S.canFill(S.find(st, 'hard-1')).reason, /hard-worker seat/);
  assert.equal(S.canFill(S.find(st, 'hard-1'), { userAsked: true }).ok, true);
  assert.equal(S.canFill(S.find(st, 'hard-1'), { tierUpApproved: true }).ok, true);
  assert.equal(S.canFill(S.find(st, 'planner')).ok, true);
  S.take(st, 'implementer', { tileId: 1 });
  S.release(st, 'implementer', { task: { status: 'failed', note: 'boom' } });
  assert.equal(S.find(st, 'implementer').tier, 'small');
});

test('setTier and setGuidance change the seat and reject bad input', () => {
  const st = fresh();
  assert.equal(S.setTier(st, 'explorer', 'free').tier, 'free');
  assert.throws(() => S.setTier(st, 'explorer', 'gigantic'), /unknown tier/);
  assert.throws(() => S.setTier(st, 'nope', 'free'), /no seat "nope"/);
  assert.equal(S.setGuidance(st, 'docs', '  keep   it short \n').guidance, 'keep it short');
});

test('take: seated, then replaced when another worker still held it; history keeps the last 20', () => {
  const st = fresh();
  S.take(st, 'planner', { tileId: 4, now: T0 });
  const s = S.take(st, 'planner', { tileId: 6, now: T0 + 1 });
  assert.deepEqual(s.history.map(e => e.event), ['seated', 'replaced']);
  assert.equal(s.history[1].was, 4);
  assert.equal(s.tileId, 6);
  assert.equal(S.seatOfTile(st, 6).id, 'planner');
  for (let i = 0; i < 30; i++) S.take(st, 'planner', { tileId: 10 + i });
  assert.equal(s.history.length, S.HISTORY_MAX);
  assert.throws(() => S.take(st, 'planner', {}), /tile id/);
});

test('release keeps the state built from the board task, goes idle-closed, and is a no-op for a replaced tile', () => {
  const st = fresh();
  S.take(st, 'implementer', { tileId: 4, now: T0 });
  const task = { status: 'failed', note: 'tests broke', checkpoint: { decisions: ['use a map'], files: ['a.js', 'b.js'], next: 'fix b.js' }, check: { ok: false, command: 'npm test', summary: 'x\ny\nAssertionError: nope' } };
  const s = S.release(st, 'implementer', { task, reason: 'token-stop', tileId: 4, now: T0 + 5 });
  assert.equal(s.state, 'idle-closed');
  assert.equal(s.tileId, null);
  assert.deepEqual(s.taskState.decisions, ['use a map']);
  assert.deepEqual(s.taskState.files, ['a.js', 'b.js']);
  assert.match(s.taskState.verification, /^failed: npm test/);
  assert.match(s.taskState.lastError, /AssertionError: nope/);
  assert.match(s.taskState.note, /next: fix b\.js/);
  assert.equal(s.history.at(-1).event, 'closed');
  assert.equal(s.history.at(-1).reason, 'token-stop');
  S.take(st, 'implementer', { tileId: 8 });
  S.release(st, 'implementer', { reason: 'closed', tileId: 4 });
  assert.equal(S.find(st, 'implementer').state, 'active');
  assert.equal(S.find(st, 'implementer').tileId, 8);
  S.release(st, 'implementer', { empty: true, tileId: 8 });
  assert.equal(S.find(st, 'implementer').state, 'empty');
});

test('task state merges across workers, dedupes and stays under the size caps', () => {
  const st = fresh();
  S.take(st, 'reviewer', { tileId: 1 });
  S.release(st, 'reviewer', { task: { status: 'done', checkpoint: { decisions: ['a'], files: ['x.js'] } } });
  S.take(st, 'reviewer', { tileId: 2 });
  const many = Array.from({ length: 40 }, (_, i) => `file${i}.js`);
  const s = S.release(st, 'reviewer', { task: { status: 'done', note: 'n'.repeat(2000), checkpoint: { decisions: ['a', 'b'], files: many } }, extra: { rejectNote: 'r'.repeat(900), lastError: 'e'.repeat(3000) } });
  assert.deepEqual(s.taskState.decisions, ['a', 'b']);
  assert.equal(s.taskState.files.length, S.CAPS.files[0]);
  assert.ok(s.taskState.files.every(f => f.length <= S.CAPS.files[1]));
  assert.ok(s.taskState.lastError.length <= S.CAPS.lastError);
  assert.ok(s.taskState.note.length <= S.CAPS.note);
  assert.ok(JSON.stringify(s.taskState).length < 2500);
});

test('keep updates the state and logs the compact but leaves the seat active', () => {
  const st = fresh();
  S.take(st, 'planner', { tileId: 2 });
  const s = S.keep(st, 'planner', { task: { status: 'doing', checkpoint: { decisions: ['d'] } }, reason: 'compacted', now: T0 + 9 });
  assert.equal(s.state, 'active');
  assert.equal(s.tileId, 2);
  assert.deepEqual(s.taskState.decisions, ['d']);
  assert.equal(s.history.at(-1).event, 'compacted');
});

test('brief: guidance only for a new seat, a short state summary for a seat that has one, never a transcript', () => {
  const st = fresh(), p = S.find(st, 'planner');
  const first = S.brief(p);
  assert.match(first, /"planner" seat/);
  assert.match(first, /Guidance:/);
  assert.doesNotMatch(first, /before you/);
  S.take(st, 'planner', { tileId: 1 });
  S.release(st, 'planner', { task: { status: 'blocked', note: 'needs key', failure: 'auth failed\n401', checkpoint: { decisions: ['use oauth'], files: ['auth.js'] } } });
  const again = S.brief(p);
  assert.match(again, /held this seat before you/);
  assert.match(again, /Decided: use oauth/);
  assert.match(again, /Files touched: auth\.js/);
  assert.match(again, /Last error:\nauth failed\n401/);
  assert.ok(again.length < 1500);
});

test('tables: the seats table and one seat with history', () => {
  const st = fresh();
  S.take(st, 'explorer', { tileId: 12, now: T0 });
  const table = S.formatTable(st).split('\n');
  assert.match(table[0], /^id\s+role\s+kind\s+tier\s+state\s+tile$/);
  assert.equal(table.length, 10);
  assert.match(table.find(l => l.startsWith('explorer')), /xsmall\s+active\s+12$/);
  assert.match(table.find(l => l.startsWith('hard-1')), /hard\s+medium \(pinned\)\s+empty\s+-$/);
  const one = S.formatSeat(S.find(st, 'explorer'));
  assert.match(one, /^explorer .*tier xsmall .*active in tile 12/);
  assert.match(one, /seated tile 12/);
});
