const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sb = require('../state-backup');
const is = require('../install-state');
const configMigrate = require('../config-migrate');
const { redactSecrets, redactText } = require('../redact');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operant-sr-'));
  fs.writeFileSync(path.join(dir, 'config.json'), '{"a":1}');
  fs.writeFileSync(path.join(dir, 'outcomes.jsonl'), 'x\ny\n');
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'one.md'), 'fact one');
  return dir;
}
const done = dir => fs.rmSync(dir, { recursive: true, force: true });
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const editManifest = (b, fn) => { const f = path.join(b.folder, 'manifest.json'); const m = readJson(f); fn(m); fs.writeFileSync(f, JSON.stringify(m)); };

test('manifest carries formatVersion, configVersion, installationId, kinds and redacted', () => {
  const dir = setup();
  try {
    const b = sb.createBackup({ userDataDir: dir, reason: 'manual', version: '2.1.0' });
    const m = readJson(path.join(b.folder, 'manifest.json'));
    assert.strictEqual(m.formatVersion, 1);
    assert.strictEqual(m.configVersion, configMigrate.CURRENT);
    assert.match(m.installationId, /^[0-9a-f]{32}$/);
    assert.strictEqual(m.installationId, readJson(path.join(dir, 'installation.json')).installationId);
    assert.deepStrictEqual(m.redacted, []);
    assert.strictEqual(m.files.find(f => f.path === 'config.json').kind, 'required');
    assert.strictEqual(m.files.find(f => f.path === 'memory/one.md').kind, 'required');
    assert.strictEqual(m.files.find(f => f.path === 'outcomes.jsonl').kind, 'optional');
  } finally { done(dir); }
});

test('an old manifest without the new fields still lists and restores', () => {
  const dir = setup();
  try {
    const b = sb.createBackup({ userDataDir: dir, reason: 'manual' });
    editManifest(b, m => { for (const k of ['formatVersion', 'configVersion', 'installationId', 'redacted']) delete m[k]; m.files.forEach(f => delete f.kind); });
    assert.strictEqual(sb.listBackups(dir)[0].ok, true);
    assert.strictEqual(sb.restoreBackup({ userDataDir: dir, id: b.id }).restored.length, 3);
  } finally { done(dir); }
});

test('a backup from a newer Operant is refused before anything changes', () => {
  const dir = setup();
  try {
    const b = sb.createBackup({ userDataDir: dir, reason: 'manual', version: '9.0.0' });
    editManifest(b, m => { m.configVersion = configMigrate.CURRENT + 1; });
    fs.writeFileSync(path.join(dir, 'config.json'), '{"live":1}');
    assert.throws(() => sb.restoreBackup({ userDataDir: dir, id: b.id }), /newer Operant \(9\.0\.0\); update Operant first/);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), '{"live":1}');
    assert.ok(!sb.listBackups(dir).some(x => x.reason === 'before-restore'));
  } finally { done(dir); }
});

test('an older backup migrates forward on restore', () => {
  const dir = setup();
  try {
    const b = sb.createBackup({ userDataDir: dir, reason: 'manual' });
    editManifest(b, m => { m.configVersion = 0; });
    sb.restoreBackup({ userDataDir: dir, id: b.id });
    assert.strictEqual(readJson(path.join(dir, 'config.json')).configVersion, configMigrate.CURRENT);
  } finally { done(dir); }
});

test('a restore that fails validation puts the current files back and names what failed', () => {
  const dir = setup();
  try {
    fs.writeFileSync(path.join(dir, 'session.json'), '{"ok":true}');
    const b = sb.createBackup({ userDataDir: dir, reason: 'manual' });
    const bad = Buffer.from('not json');
    fs.writeFileSync(path.join(b.folder, 'session.json'), bad);
    editManifest(b, m => { const f = m.files.find(x => x.path === 'session.json'); f.size = bad.length; f.sha256 = crypto.createHash('sha256').update(bad).digest('hex'); });
    fs.writeFileSync(path.join(dir, 'config.json'), '{"live":1}');
    assert.throws(() => sb.restoreBackup({ userDataDir: dir, id: b.id }), /session\.json does not parse.*left as they were/);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), '{"live":1}');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'), '{"ok":true}');
  } finally { done(dir); }
});

test('install state: first install, existing, upgrade (also with no record from before 2.1), downgrade, recovery', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operant-is-'));
  try {
    const first = is.recordLaunch({ userDataDir: dir, version: '2.0.0' });
    assert.strictEqual(first.state, 'first-install');
    assert.strictEqual(is.recordLaunch({ userDataDir: dir, version: '2.0.0' }).state, 'existing');
    const up = is.recordLaunch({ userDataDir: dir, version: '2.1.0' });
    assert.strictEqual(up.state, 'upgrade');
    assert.strictEqual(up.lastVersion, '2.0.0');
    assert.strictEqual(up.installationId, first.installationId);
    assert.strictEqual(up.firstRunAt, first.firstRunAt);
    assert.strictEqual(is.recordLaunch({ userDataDir: dir, version: '2.0.9' }).state, 'downgrade');
    assert.strictEqual(is.recordLaunch({ userDataDir: dir, version: '2.0.10' }).state, 'upgrade');
    fs.writeFileSync(path.join(dir, 'config.json'), '{"a":1}');
    is.markRestore(dir, 'b1');
    assert.strictEqual(is.recordLaunch({ userDataDir: dir, version: '2.0.10' }).state, 'recovery');
    assert.strictEqual(is.recordLaunch({ userDataDir: dir, version: '2.0.10' }).state, 'existing');
    fs.rmSync(path.join(dir, 'installation.json'));
    assert.strictEqual(is.recordLaunch({ userDataDir: dir, version: '2.1.0' }).state, 'upgrade');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), '{"a":1}');
  } finally { done(dir); }
});

test('a backup made before the first launch record does not make that launch read as existing', () => {
  const dir = setup();
  try {
    sb.createBackup({ userDataDir: dir, reason: 'before-migration' });
    assert.strictEqual(is.recordLaunch({ userDataDir: dir, version: '2.1.0' }).state, 'upgrade');
  } finally { done(dir); }
});

test('a restore marks the next launch as recovery and the post-restore check is kept in status.json', () => {
  const dir = setup();
  try {
    is.recordLaunch({ userDataDir: dir, version: '2.1.0' });
    const b = sb.createBackup({ userDataDir: dir, reason: 'manual' });
    sb.restoreBackup({ userDataDir: dir, id: b.id });
    assert.strictEqual(is.recordLaunch({ userDataDir: dir, version: '2.1.0' }).state, 'recovery');
    sb.recordPostRestore({ userDataDir: dir, id: b.id, ok: true });
    sb.testRestore({ userDataDir: dir });
    const st = readJson(path.join(dir, 'backups', 'status.json'));
    assert.strictEqual(st.postRestore.ok, true);
    assert.strictEqual(st.postRestore.id, b.id);
  } finally { done(dir); }
});

test('redactSecrets and redactText', () => {
  const o = redactSecrets({ apiKey: 'abc', Authorization: 'x', nested: { db_password: 'p', tokenUsage: true, tokenBudget: 5, note: 'key sk-abcdefghijklmnopqrstu here' }, list: ['ghp_' + 'a'.repeat(30)] });
  assert.strictEqual(o.apiKey, '[redacted]');
  assert.strictEqual(o.Authorization, '[redacted]');
  assert.strictEqual(o.nested.db_password, '[redacted]');
  assert.strictEqual(o.nested.tokenUsage, true);
  assert.strictEqual(o.nested.tokenBudget, 5);
  assert.strictEqual(o.nested.note, 'key [redacted] here');
  assert.strictEqual(o.list[0], '[redacted]');
  assert.strictEqual(redactText('Authorization: Bearer abcdefghijklmnop1234'), 'Authorization: Bearer [redacted]');
  assert.strictEqual(redactText('nothing here'), 'nothing here');
});

test('backups leave secrets out, list them in the manifest, and a restore keeps the live ones', () => {
  const dir = setup();
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ a: 1, mcp: { env: { API_KEY: 'live-secret' } } }));
    fs.writeFileSync(path.join(dir, 'outcomes.jsonl'), 'line sk-abcdefghijklmnopqrstu\n');
    const b = sb.createBackup({ userDataDir: dir, reason: 'manual' });
    const all = fs.readdirSync(b.folder).filter(f => fs.statSync(path.join(b.folder, f)).isFile()).map(f => fs.readFileSync(path.join(b.folder, f), 'utf8')).join('');
    assert.ok(!all.includes('live-secret') && !all.includes('sk-abcdefghijklmnopqrstu'));
    const m = readJson(path.join(b.folder, 'manifest.json'));
    assert.deepStrictEqual(m.redacted.sort(), ['config.json:mcp.env.API_KEY', 'outcomes.jsonl']);
    assert.ok(m.redactedNote);
    assert.strictEqual(sb.testRestore({ userDataDir: dir }).ok, true);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ a: 2, mcp: { env: { API_KEY: 'live-secret' } } }));
    sb.restoreBackup({ userDataDir: dir, id: b.id });
    const cfg = readJson(path.join(dir, 'config.json'));
    assert.strictEqual(cfg.a, 1);
    assert.strictEqual(cfg.mcp.env.API_KEY, 'live-secret');
  } finally { done(dir); }
});
