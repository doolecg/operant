const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFileAtomic, readJsonSafe } = require('../atomic-write');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'operant-atomic-'));

test('writes, creates the folder, overwrites, and leaves no tmp files', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'sub', 'a.json');
  writeFileAtomic(f, '{"a":1}');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), '{"a":1}');
  writeFileAtomic(f, '{"a":2}');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), '{"a":2}');
  assert.deepStrictEqual(fs.readdirSync(path.dirname(f)), ['a.json']);
});

test('a failed rename leaves the original intact and cleans up the tmp', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'a.json');
  writeFileAtomic(f, 'old');
  const orig = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error('nope'), { code: 'EACCES' }); };
  try { assert.throws(() => writeFileAtomic(f, 'new'), /nope/); } finally { fs.renameSync = orig; }
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'old');
  assert.deepStrictEqual(fs.readdirSync(dir), ['a.json']);
});

test('readJsonSafe parses, falls back on missing, and keeps a corrupt file as .broken', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'a.json');
  assert.deepStrictEqual(readJsonSafe(f, { x: 1 }), { value: { x: 1 }, broken: false });
  fs.writeFileSync(f, '{"ok":true}');
  assert.deepStrictEqual(readJsonSafe(f, null), { value: { ok: true }, broken: false });
  fs.writeFileSync(f, '{half');
  assert.deepStrictEqual(readJsonSafe(f, []), { value: [], broken: true });
  assert.strictEqual(fs.readFileSync(f + '.broken', 'utf8'), '{half');
});
