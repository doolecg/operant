const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sb = require('../state-backup');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operant-sb-'));
  fs.writeFileSync(path.join(dir, 'config.json'), '{"a":1}');
  fs.writeFileSync(path.join(dir, 'outcomes.jsonl'), 'x\ny\n');
  fs.mkdirSync(path.join(dir, 'memory', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'one.md'), 'fact one');
  fs.writeFileSync(path.join(dir, 'memory', 'sub', 'two.md'), 'fact two');
  return dir;
}
const done = dir => fs.rmSync(dir, { recursive: true, force: true });

test('createBackup copies existing files, writes a manifest and skips missing ones', () => {
  const dir = setup();
  try {
    const b = sb.createBackup({ userDataDir: dir, reason: 'Daily', version: '2.1.0' });
    assert.match(b.id, /^\d{8}-\d{6}-daily$/);
    assert.deepStrictEqual(b.files.map(f => f.path).sort(), ['config.json', 'memory/one.md', 'memory/sub/two.md', 'outcomes.jsonl']);
    const m = JSON.parse(fs.readFileSync(path.join(b.folder, 'manifest.json'), 'utf8'));
    assert.strictEqual(m.version, '2.1.0');
    assert.strictEqual(m.files.find(f => f.path === 'config.json').size, 7);
    assert.match(m.files[0].sha256, /^[0-9a-f]{64}$/);
    assert.strictEqual(fs.readFileSync(path.join(b.folder, 'memory', 'sub', 'two.md'), 'utf8'), 'fact two');
    const [row] = sb.listBackups(dir);
    assert.strictEqual(row.ok, true);
    assert.strictEqual(row.files, 4);
    const b2 = sb.createBackup({ userDataDir: dir, reason: 'manual' });
    assert.ok(!b2.files.some(f => f.path.startsWith('backups')));
  } finally { done(dir); }
});

test('restore refuses a tampered backup, naming the file', () => {
  const dir = setup();
  try {
    const b = sb.createBackup({ userDataDir: dir, reason: 'manual' });
    fs.writeFileSync(path.join(b.folder, 'config.json'), '{"a":2}');
    assert.throws(() => sb.restoreBackup({ userDataDir: dir, id: b.id }), /config\.json/);
    assert.strictEqual(sb.listBackups(dir).length, 1);
  } finally { done(dir); }
});

test('restore takes a safety backup, restores content and keeps newer memory files', () => {
  const dir = setup();
  try {
    const b = sb.createBackup({ userDataDir: dir, reason: 'manual' });
    fs.writeFileSync(path.join(dir, 'config.json'), '{"a":99}');
    fs.writeFileSync(path.join(dir, 'memory', 'one.md'), 'changed');
    fs.writeFileSync(path.join(dir, 'memory', 'newer.md'), 'newer fact');
    const r = sb.restoreBackup({ userDataDir: dir, id: b.id });
    assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), '{"a":1}');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'memory', 'one.md'), 'utf8'), 'fact one');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'memory', 'newer.md'), 'utf8'), 'newer fact');
    assert.ok(r.restored.includes('config.json'));
    const safety = sb.listBackups(dir).find(x => x.reason === 'before-restore');
    assert.ok(safety);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'backups', safety.id, 'config.json'), 'utf8'), '{"a":99}');
  } finally { done(dir); }
});

test('pruneBackups keeps the newest 10 plus the newest of each of the last 7 days', () => {
  const dir = setup();
  try {
    const base = new Date(2026, 5, 30, 12, 0, 0).getTime();
    for (let d = 11; d >= 0; d--) for (let h = 0; h < 3; h++) {
      sb.createBackup({ userDataDir: dir, reason: 'daily', now: new Date(base - d * 86400000 + h * 3600000) });
    }
    assert.strictEqual(sb.listBackups(dir).length, 36);
    sb.pruneBackups(dir, { keepLast: 10, keepDaily: 7 });
    const left = sb.listBackups(dir);
    // the newest 10 cover 4 days; the 3 older days among the last 7 add one each
    assert.strictEqual(left.length, 13);
    assert.strictEqual(left[0].at, new Date(base + 2 * 3600000).toISOString());
  } finally { done(dir); }
});

test('pruneBackups never deletes the newest backup', () => {
  const dir = setup();
  try {
    sb.createBackup({ userDataDir: dir, reason: 'a', now: new Date(2026, 0, 1) });
    sb.createBackup({ userDataDir: dir, reason: 'b', now: new Date(2026, 0, 2) });
    sb.pruneBackups(dir, { keepLast: 0, keepDaily: 0 });
    const left = sb.listBackups(dir);
    assert.strictEqual(left.length, 1);
    assert.strictEqual(left[0].reason, 'b');
  } finally { done(dir); }
});
