const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore, projectKey } = require('../terminal-store');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'operant-term-'));

test('append then history returns entries in order, with a time added', () => {
  const dir = tmp(), s = createStore(dir);
  s.append('C:\\work\\demo', { role: 'user', text: 'hello' });
  s.append('C:\\work\\demo', { role: 'operant', text: 'hi', requestId: 'r1' });
  const h = s.history('C:\\work\\demo');
  assert.deepStrictEqual(h.map(e => e.role), ['user', 'operant']);
  assert.strictEqual(h[1].requestId, 'r1');
  assert.ok(typeof h[0].t === 'number');
  assert.strictEqual(s.history('C:\\work\\demo', { limit: 1 })[0].text, 'hi');
});

test('projects are kept apart, and the key is stable and filesystem safe', () => {
  assert.strictEqual(projectKey('C:\\work\\demo'), projectKey('C:/work/demo/'));
  assert.notStrictEqual(projectKey('C:\\work\\demo'), projectKey('C:\\work\\demo2'));
  assert.notStrictEqual(projectKey('C:\\a\\demo'), projectKey('C:\\b\\demo'));
  assert.match(projectKey('C:\\we ird\\na:me?*'), /^[a-z0-9-]+$/);
  const dir = tmp(), s = createStore(dir);
  s.append('/a/one', { role: 'user', text: 'x' });
  assert.deepStrictEqual(s.history('/a/two'), []);
  assert.ok(fs.existsSync(path.join(dir, projectKey('/a/one') + '.jsonl')));
});

test('rejects an entry without a valid role and skips torn lines', () => {
  const dir = tmp(), s = createStore(dir);
  assert.throws(() => s.append('/p', { text: 'no role' }));
  assert.throws(() => s.append('/p', { role: 'wizard' }));
  s.append('/p', { role: 'user', text: 'ok' });
  fs.appendFileSync(s.fileOf('/p'), '{"role":"user","te');
  assert.strictEqual(s.history('/p').length, 1);
});

test('past the cap the oldest turns go, the newest stay, and no tmp files are left', () => {
  const dir = tmp(), s = createStore(dir, { capBytes: 2000 });
  for (let i = 0; i < 40; i++) s.append('/p', { role: 'user', text: 'x'.repeat(100) + i });
  const h = s.history('/p');
  assert.ok(h.length < 40 && h.length > 3);
  assert.ok(h.at(-1).text.endsWith('39'));
  assert.ok(fs.statSync(s.fileOf('/p')).size <= 2000);
  assert.deepStrictEqual(fs.readdirSync(dir).filter(f => f.endsWith('.tmp')), []);
});

test('an entry bigger than the cap is still kept as the newest', () => {
  const s = createStore(tmp(), { capBytes: 300 });
  s.append('/p', { role: 'user', text: 'y'.repeat(1000) });
  assert.strictEqual(s.history('/p').length, 1);
});

test('clear removes the conversation and is safe to repeat', () => {
  const s = createStore(tmp());
  s.append('/p', { role: 'user', text: 'a' });
  s.clear('/p'); s.clear('/p');
  assert.deepStrictEqual(s.history('/p'), []);
});

test('the terminal folder is in state backups as optional', () => {
  const sb = require('../state-backup');
  const dir = tmp(), s = createStore(path.join(dir, 'terminal'));
  s.append('/p', { role: 'user', text: 'a' });
  fs.writeFileSync(path.join(dir, 'config.json'), '{}');
  const b = sb.createBackup({ userDataDir: dir, reason: 'test' });
  const f = b.files.find(x => x.path.startsWith('terminal/'));
  assert.ok(f);
  assert.strictEqual(f.kind, 'optional');
});
