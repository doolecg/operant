// Tests for the desire-path log: what agents try that the CLI doesn't have (agent-setup.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const setup = require('../agent-setup.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'operant-desiretest-'));
test.after(() => { fs.rmSync(root, { recursive: true, force: true }); });
let n = 0;
const dir = name => path.join(root, `${name}-${n++}`);

// ---------------------------------------------------------------- desire paths
const T = new Date('2026-09-29T12:00:00.000Z');

test('desirePathLine has the time and four short strings, and nothing else the agent sent', () => {
  const line = setup.desirePathLine({ kind: 'command', name: 'status', cmd: 'operant status', suggestion: 'operant tiles',
    token: 'secret', text: 'a whole prompt' }, T);
  assert.ok(line.endsWith('\n') && line.indexOf('\n') === line.length - 1);
  assert.deepEqual(JSON.parse(line), { t: '2026-09-29T12:00:00.000Z', kind: 'command', name: 'status', cmd: 'operant status', suggestion: 'operant tiles' });
});

test('desirePathLine caps each string at 80 characters and turns anything else into an empty string', () => {
  const r = JSON.parse(setup.desirePathLine({ kind: 'k', name: 'n'.repeat(500), cmd: { a: 1 }, suggestion: null }, T));
  assert.equal(r.name, 'n'.repeat(80));
  assert.deepEqual([r.kind, r.cmd, r.suggestion], ['k', '', '']);
  assert.deepEqual(JSON.parse(setup.desirePathLine(undefined, T)), { t: r.t, kind: '', name: '', cmd: '', suggestion: '' });
});

test('appendDesirePath appends one line per call', () => {
  const file = path.join(dir('desire'), 'desire-paths.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  setup.appendDesirePath(file, { kind: 'flag', name: '--json' }, { now: T });
  setup.appendDesirePath(file, { kind: 'command', name: 'ls' }, { now: T });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(lines.map(l => l.name), ['--json', 'ls']);
});

test('appendDesirePath keeps only the last 100 KB, from a whole line, once the file passes 200 KB', () => {
  const file = path.join(dir('desire'), 'desire-paths.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let i = 0; fs.existsSync(file) ? fs.statSync(file).size <= 200 * 1024 : true; i++) setup.appendDesirePath(file, { kind: 'command', name: `old-${i}`, cmd: 'x'.repeat(60) }, { now: T });
  const before = fs.readFileSync(file, 'utf8').trim().split('\n').length;
  setup.appendDesirePath(file, { kind: 'command', name: 'newest' }, { now: T });
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.trim().split('\n').map(l => JSON.parse(l)); // every line is whole
  assert.ok(Buffer.byteLength(text) <= 100 * 1024 + 200, `${Buffer.byteLength(text)} bytes`); // the last 100 KB and the new line
  assert.ok(lines.length > 100 && lines.length < before);
  assert.equal(lines.at(-1).name, 'newest');
  assert.equal(lines.at(-2).name, `old-${before - 1}`, 'the newest of the old lines survive');
});

test('appendDesirePath never throws', () => {
  assert.doesNotThrow(() => setup.appendDesirePath(path.join(root, 'no', 'such', 'folder', 'f.jsonl'), { kind: 'x' }));
  assert.doesNotThrow(() => setup.appendDesirePath(root, { kind: 'x' }), 'a folder where the file should be');
});
