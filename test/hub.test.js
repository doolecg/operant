// Tests for hub.js: audit is read-only, apply moves skills/rules into the hub behind junctions,
// and undo restores every touched file byte for byte. Runs on a synthetic ~/.claude in a temp dir.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const hub = require('../hub.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'operant-hubtest-'));
test.after(() => { fs.rmSync(root, { recursive: true, force: true }); });

const write = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };

// Hash of a whole tree: file bytes, and where links point (without following them).
function snapshot(dir) {
  const out = {};
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name), rel = path.relative(dir, p);
      if (fs.lstatSync(p).isSymbolicLink()) out[rel] = 'link:' + path.resolve(d, fs.readlinkSync(p));
      else if (e.isDirectory()) { out[rel] = 'dir'; walk(p); }
      else out[rel] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  })(dir);
  return out;
}

function fixture(name) {
  const base = path.join(root, name);
  const claudeDir = path.join(base, 'claude'), hubDir = path.join(base, 'hub'), memDir = path.join(base, 'memory');
  write(path.join(claudeDir, 'CLAUDE.md'), '# My rules\n- be brief\n');
  write(path.join(claudeDir, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\n---\nalpha\n');
  write(path.join(claudeDir, 'skills', 'alpha', 'ref', 'notes.txt'), Buffer.from([0x6e, 0x0d, 0x0a, 0x00, 0xff, 0xfe]));
  write(path.join(claudeDir, 'skills', 'beta', 'SKILL.md'), '---\nname: beta\n---\nbeta\n');
  write(path.join(claudeDir, 'skills', 'big', 'SKILL.md'), 'x'.repeat(30 * 1024));
  write(path.join(claudeDir, 'plugins', 'marketplaces', 'm', 'skills', 'beta', 'SKILL.md'), '---\nname: beta\n---\nplugin beta\n');
  fs.mkdirSync(path.join(base, 'gone'));
  fs.symlinkSync(path.join(base, 'gone'), path.join(claudeDir, 'skills', 'dead'), 'junction');
  fs.rmdirSync(path.join(base, 'gone'));
  write(path.join(memDir, 'a.md'), '---\nname: a\ndescription: same fact\ntype: project\n---\nsame fact\n');
  write(path.join(memDir, 'b.md'), '---\nname: b\ndescription: Same  fact\ntype: project\n---\nsame fact\n');
  return { base, claudeDir, hubDir, memoryDirs: [{ dir: memDir, writable: true }] };
}

test('audit reports drift and changes nothing', () => {
  const f = fixture('audit');
  const before = snapshot(f.base);
  const r = hub.audit(f);
  const ids = r.findings.map(x => x.id);
  for (const id of ['adopt-skill:alpha', 'adopt-skill:beta', 'adopt-skill:big', 'remove-broken:dead', 'adopt-rules', 'dup-plugin:beta', 'big-skill:big'])
    assert.ok(ids.includes(id), id);
  assert.ok(ids.some(i => i.startsWith('dup-memory:')));
  assert.ok(r.drift);
  assert.deepEqual(snapshot(f.base), before);
  assert.ok(!fs.existsSync(f.hubDir));
});

test('apply -> undo restores byte-identical files, and junctions resolve', () => {
  const f = fixture('roundtrip');
  const before = snapshot(f.base);
  const ids = hub.audit(f).findings.filter(x => x.fix).map(x => x.id);
  const r = hub.apply({ ...f, ids });
  assert.deepEqual(r.errors, []);

  const alpha = path.join(f.claudeDir, 'skills', 'alpha');
  assert.ok(fs.lstatSync(alpha).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(alpha, 'SKILL.md')));
  assert.deepEqual([...fs.readFileSync(path.join(f.hubDir, 'skills', 'alpha', 'ref', 'notes.txt'))], [0x6e, 0x0d, 0x0a, 0x00, 0xff, 0xfe]);
  assert.equal(fs.readFileSync(path.join(f.hubDir, 'rules.md'), 'utf8'), '# My rules\n- be brief\n');
  assert.equal(fs.readFileSync(path.join(f.claudeDir, 'CLAUDE.md'), 'utf8').trim(), hub.importLine(f.claudeDir));
  assert.equal(fs.readFileSync(path.join(f.claudeDir, hub.LINK_NAME, 'rules.md'), 'utf8'), '# My rules\n- be brief\n');
  assert.ok(!fs.existsSync(path.join(f.claudeDir, 'skills', 'dead')) && !hub.audit(f).findings.some(x => x.fix && x.id.startsWith('adopt')));
  assert.ok(fs.existsSync(path.join(f.memoryDirs[0].dir, 'a.md')) !== fs.existsSync(path.join(f.memoryDirs[0].dir, 'b.md')));

  const u = hub.undo(f);
  assert.equal(u.backup, r.backup);
  fs.rmSync(path.join(f.hubDir), { recursive: true, force: true }); // backups + empty scaffolding live in the hub
  const after = snapshot(f.base);
  delete after.hub;
  const expect = { ...before };
  assert.deepEqual(after, expect);
  assert.equal(hub.lastBackup(f.hubDir), null);
});

test('only ticked fixes are applied', () => {
  const f = fixture('partial');
  hub.apply({ ...f, ids: ['adopt-skill:beta'] });
  assert.ok(fs.lstatSync(path.join(f.claudeDir, 'skills', 'beta')).isSymbolicLink());
  assert.ok(!fs.lstatSync(path.join(f.claudeDir, 'skills', 'alpha')).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(f.claudeDir, 'CLAUDE.md'), 'utf8'), '# My rules\n- be brief\n');
});

test('an existing junction to elsewhere is left alone, and a second audit is quiet', () => {
  const f = fixture('elsewhere');
  const other = path.join(f.base, 'agents', 'gamma');
  write(path.join(other, 'SKILL.md'), 'gamma');
  fs.symlinkSync(other, path.join(f.claudeDir, 'skills', 'gamma'), 'junction');
  hub.apply({ ...f, ids: hub.audit(f).findings.filter(x => x.fix).map(x => x.id) });
  assert.ok(fs.existsSync(path.join(other, 'SKILL.md')));
  assert.ok(!hub.audit(f).drift);
});
