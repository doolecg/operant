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
    sb.pruneBackups(dir, { keepLast: 10, keepDays: 7 });
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
    sb.pruneBackups(dir, { keepLast: 0, keepDays: 0 });
    const left = sb.listBackups(dir);
    assert.strictEqual(left.length, 1);
    assert.strictEqual(left[0].reason, 'b');
  } finally { done(dir); }
});

const tamper = (dir, b) => fs.writeFileSync(path.join(dir, 'backups', b.id, 'outcomes.jsonl'), 'tampered');

test('a tampered backup fails validation, is marked can\'t be restored and a restore refuses it', () => {
  const dir = setup();
  try {
    const b = sb.createBackup({ userDataDir: dir, reason: 'daily' });
    assert.strictEqual(sb.testRestore({ userDataDir: dir }).ok, true);
    assert.strictEqual(sb.listBackups(dir)[0].status, 'valid');
    tamper(dir, b);
    const r = sb.testRestore({ userDataDir: dir });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /outcomes\.jsonl/);
    const row = sb.listBackups(dir)[0];
    assert.strictEqual(row.status, 'cantRestore');
    assert.strictEqual(sb.statusSummary(dir).validated.ok, false);
    fs.writeFileSync(path.join(dir, 'config.json'), '{"a":2}');
    assert.throws(() => sb.restoreBackup({ userDataDir: dir, id: b.id }), /hash/);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), '{"a":2}');
  } finally { done(dir); }
});

test('a backup whose config.json does not parse fails the restore test', () => {
  const dir = setup();
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), '{broken');
    sb.createBackup({ userDataDir: dir, reason: 'daily' });
    const r = sb.testRestore({ userDataDir: dir });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /config\.json/);
  } finally { done(dir); }
});

test('testRestore restores into a temp folder and leaves userData and its own files untouched', () => {
  const dir = setup();
  try {
    const b = sb.createBackup({ userDataDir: dir, reason: 'manual' });
    fs.writeFileSync(path.join(dir, 'config.json'), '{"a":5}');
    fs.writeFileSync(path.join(dir, 'memory', 'new.md'), 'later');
    const before = sb.listBackups(dir).length;
    const r = sb.testRestore({ userDataDir: dir });
    assert.deepStrictEqual([r.ok, r.id], [true, b.id]);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), '{"a":5}');
    assert.ok(fs.existsSync(path.join(dir, 'memory', 'new.md')));
    assert.strictEqual(sb.listBackups(dir).length, before);
    assert.strictEqual(sb.listBackups(dir)[0].validation.ok, true);
    assert.ok(fs.existsSync(path.join(dir, 'backups', 'status.json')));
    assert.strictEqual(sb.testRestore({ userDataDir: dir, id: 'nope' }).ok, false);
  } finally { done(dir); }
});

test('testRestore with no backups says so', () => {
  const dir = setup();
  try {
    const r = sb.testRestore({ userDataDir: dir });
    assert.deepStrictEqual([r.ok, r.id], [false, '']);
    assert.match(r.error, /no backup/i);
  } finally { done(dir); }
});

test('a restore that fails part way leaves the live files as they were and reports it', () => {
  const dir = setup();
  try {
    const b = sb.createBackup({ userDataDir: dir, reason: 'manual' });
    fs.writeFileSync(path.join(dir, 'config.json'), '{"a":2}');
    fs.writeFileSync(path.join(dir, 'outcomes.jsonl'), 'live');
    fs.rmSync(path.join(dir, 'memory', 'one.md'));
    let n = 0;
    const write = (p, d) => { if (++n === 3) throw new Error('disk full'); fs.writeFileSync(p, d); };
    assert.throws(() => sb.restoreBackup({ userDataDir: dir, id: b.id, write }), /disk full.*left as they were/);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), '{"a":2}');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'outcomes.jsonl'), 'utf8'), 'live');
    assert.ok(!fs.existsSync(path.join(dir, 'memory', 'one.md')));
    assert.ok(sb.listBackups(dir).some(x => x.reason === 'before-restore'));
  } finally { done(dir); }
});

test('a custom location holds the backups, restores and status; the default folder stays empty', () => {
  const dir = setup(), loc = fs.mkdtempSync(path.join(os.tmpdir(), 'operant-sb-loc-'));
  try {
    assert.strictEqual(sb.checkLocation(loc), '');
    const b = sb.createBackup({ userDataDir: dir, location: loc, reason: 'manual' });
    assert.strictEqual(path.dirname(b.folder), path.resolve(loc));
    assert.ok(!fs.existsSync(path.join(dir, 'backups')));
    assert.strictEqual(sb.listBackups(dir, loc).length, 1);
    assert.strictEqual(sb.listBackups(dir).length, 0);
    assert.strictEqual(sb.testRestore({ userDataDir: dir, location: loc }).ok, true);
    assert.strictEqual(sb.statusSummary(dir, loc).location, path.resolve(loc));
    fs.writeFileSync(path.join(dir, 'config.json'), '{"a":9}');
    sb.restoreBackup({ userDataDir: dir, location: loc, id: b.id });
    assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), '{"a":1}');
  } finally { done(dir); done(loc); }
});

test('a location that is not usable is refused with a message and the old one kept', () => {
  const dir = setup();
  try {
    const file = path.join(dir, 'config.json');
    assert.match(sb.checkLocation(path.join(file, 'sub')), /can't write/);
    assert.match(sb.checkLocation('relative/dir'), /full folder path/);
    const r = sb.normalizeSettings({ location: path.join(file, 'sub'), keepLast: 3 }, { location: dir });
    assert.ok(r.error);
    assert.strictEqual(r.settings.location, dir);
    assert.strictEqual(r.settings.keepLast, 3);
  } finally { done(dir); }
});

test('normalizeSettings fills defaults and clamps numbers', () => {
  const { settings: s } = sb.normalizeSettings({ everyHours: 500, keepLast: 0, keepDays: -2, enabled: false });
  assert.deepStrictEqual(s, { ...sb.DEFAULT_SETTINGS, everyHours: 168, keepLast: 1, keepDays: 0, enabled: false });
  assert.strictEqual(sb.normalizeSettings({ everyHours: 'x' }, { everyHours: 6 }).settings.everyHours, 6);
});

test('retention follows keepLast and keepDays, and removes the status of pruned backups', () => {
  const dir = setup(), loc = fs.mkdtempSync(path.join(os.tmpdir(), 'operant-sb-loc-'));
  try {
    const base = new Date(2026, 5, 30, 12, 0, 0).getTime();
    for (let d = 9; d >= 0; d--) sb.createBackup({ userDataDir: dir, location: loc, reason: 'auto', now: new Date(base - d * 86400000) });
    const old = sb.listBackups(dir, loc).at(-1);
    sb.testRestore({ userDataDir: dir, location: loc, id: old.id });
    assert.strictEqual(sb.pruneBackups(dir, { keepLast: 2, keepDays: 0, location: loc }).length, 8);
    assert.strictEqual(sb.listBackups(dir, loc).length, 2);
    assert.strictEqual(sb.pruneBackups(dir, { keepLast: 1, keepDays: 5, location: loc }).length, 0);
    assert.ok(!(old.id in JSON.parse(fs.readFileSync(path.join(loc, 'status.json'), 'utf8')).validations));
    const dir2 = setup();
    try {
      for (let d = 9; d >= 0; d--) sb.createBackup({ userDataDir: dir2, reason: 'auto', now: new Date(base - d * 86400000) });
      sb.pruneBackups(dir2, { keepLast: 1, keepDays: 4 });
      assert.strictEqual(sb.listBackups(dir2).length, 4);
    } finally { done(dir2); }
  } finally { done(dir); done(loc); }
});
