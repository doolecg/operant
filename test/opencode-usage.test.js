const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { readOpenCodeUsage } = require('../opencode-usage');

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-usage-'));
  const file = path.join(dir, 'opencode.db');
  const db = new DatabaseSync(file);
  db.exec(`create table session (id text primary key, parent_id text, directory text not null);
    create table message (id text primary key, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);
    create table part (id text primary key, message_id text not null, session_id text not null, data text not null);`);
  return { dir, file, db };
}
const msg = (over = {}) => JSON.stringify({ role: 'assistant', modelID: 'big-pickle', providerID: 'opencode', cost: 0, time: { created: 2000 },
  tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 1000, write: 20 } }, ...over });

test('sums assistant messages once, rolls a child up to its root, and closes the database', () => {
  const { dir, file, db } = makeDb();
  db.prepare('insert into session values (?, ?, ?)').run('root', null, path.join(dir, 'proj'));
  db.prepare('insert into session values (?, ?, ?)').run('child', 'root', path.join(dir, 'proj'));
  db.prepare('insert into session values (?, ?, ?)').run('grand', 'child', path.join(dir, 'proj'));
  const add = db.prepare('insert into message values (?, ?, ?, ?, ?)');
  add.run('m1', 'root', 2000, 2000, msg());
  add.run('m2', 'grand', 2100, 2100, msg({ modelID: 'claude-haiku-4-5', cost: 0.25, time: { created: 2100 } }));
  add.run('m3', 'root', 2200, 2200, JSON.stringify({ role: 'user', time: { created: 2200 } }));
  add.run('m4', 'root', 100, 100, msg({ time: { created: 100 } }));
  // The step-finish part repeats m1's numbers; it must not be counted again.
  db.prepare('insert into part values (?, ?, ?, ?)').run('p1', 'm1', 'root', JSON.stringify({ type: 'step-finish', tokens: { input: 100, output: 10 } }));
  db.close();

  const ev = readOpenCodeUsage({ dbPath: file, since: 1000 });
  assert.equal(ev.length, 2);
  assert.equal(ev.reduce((n, e) => n + e.input, 0), 200);
  const m2 = ev.find(e => e.sessionId === 'grand');
  assert.equal(m2.rootSessionId, 'root');
  assert.equal(m2.cost, 0.25);
  assert.equal(m2.model, 'claude-haiku-4-5');
  assert.equal(m2.cacheRead, 1000);
  assert.equal(m2.reasoning, 5);
  assert.equal(ev.find(e => e.sessionId === 'root').provider, 'opencode');

  assert.equal(readOpenCodeUsage({ dbPath: file, since: 1000, project: 'proj' }).length, 2);
  assert.equal(readOpenCodeUsage({ dbPath: file, since: 1000, project: 'other' }).length, 0);
  fs.rmSync(dir, { recursive: true, force: true }); // fails on Windows if the handle was left open
});

test('a missing or broken database gives an empty list', () => {
  assert.deepEqual(readOpenCodeUsage({ dbPath: path.join(os.tmpdir(), 'nope-oc.db') }), []);
});
