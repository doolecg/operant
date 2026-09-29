const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CURRENT, MIGRATIONS, migrate } = require('../config-migrate');
const { writeFileAtomic } = require('../atomic-write');

test('fresh config gets the current version and nothing else', () => {
  const r = migrate({});
  assert.deepStrictEqual(r.user, { configVersion: CURRENT });
  assert.strictEqual(r.from, 0);
  assert.strictEqual(r.changed, true);
});

test('an old config without a version is migrated and keeps its keys', () => {
  const old = { theme: 'dark', keybinds: { a: 'B' } };
  const r = migrate(old);
  assert.deepStrictEqual(r.user, { ...old, configVersion: CURRENT });
  assert.strictEqual(r.changed, true);
  assert.strictEqual(old.configVersion, undefined, 'input is not modified');
});

test('a current config is unchanged', () => {
  const cur = { theme: 'dark', configVersion: CURRENT };
  const r = migrate(cur);
  assert.strictEqual(r.changed, false);
  assert.deepStrictEqual(r.user, cur);
});

test('a config from a newer Operant is returned untouched', () => {
  const fut = { theme: 'x', configVersion: CURRENT + 5, other: 1 };
  const r = migrate(fut);
  assert.strictEqual(r.future, true);
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.user, fut);
});

test('a migration that throws returns the original with the error', () => {
  const bad = { to: CURRENT + 1, run(u) { u.half = true; throw new Error('boom'); } };
  MIGRATIONS.push(bad);
  try {
    // CURRENT is fixed at load, so a config at the old version runs only migrations above it
    const orig = { theme: 'dark', configVersion: CURRENT };
    const r = migrate(orig);
    assert.ok(r.error);
    assert.strictEqual(r.user, orig);
    assert.strictEqual(r.changed, false);
    assert.strictEqual(orig.half, undefined);
  } finally { MIGRATIONS.pop(); }
});

test('migrating twice gives the same result', () => {
  const once = migrate({ theme: 'dark' });
  const twice = migrate(once.user);
  assert.deepStrictEqual(twice.user, once.user);
  assert.strictEqual(twice.changed, false);
});

test('an interrupted migration leaves a file that migrates to the same result', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-cfg-'));
  try {
    const file = path.join(dir, 'config.json');
    const original = JSON.stringify({ theme: 'dark' }, null, 2);
    fs.writeFileSync(file, original);
    const expected = migrate(JSON.parse(original)).user;
    // crash after the backup copy, before the save: the old file is still there and migrates again
    fs.copyFileSync(file, path.join(dir, 'config.v0.json'));
    assert.strictEqual(fs.readFileSync(file, 'utf8'), original);
    assert.deepStrictEqual(migrate(JSON.parse(fs.readFileSync(file, 'utf8'))).user, expected);
    // crash after the save: the new file is complete and needs nothing more
    writeFileAtomic(file, JSON.stringify(expected, null, 2));
    const r = migrate(JSON.parse(fs.readFileSync(file, 'utf8')));
    assert.strictEqual(r.changed, false);
    assert.deepStrictEqual(r.user, expected);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'config.v0.json'), 'utf8'), original);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
