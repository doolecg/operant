const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CURRENT, MIGRATIONS, migrate, applyPatch, validatePatch } = require('../config-migrate');
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

// ------------------------------------------------------------ validatePatch
const DEF = {
  fontSize: 13, updateCheckHours: 3, runawayGuard: 'warn', updateChannel: 'stable', cursorBlink: true, defaultCwd: '/home',
  agents: [{ id: 'claude', name: 'Claude', command: 'claude', args: [] }, { id: 'opencode', name: 'OpenCode', command: 'opencode', args: [] }],
  defaultAgent: 'claude', usageSeries: ['input'], accent: '',
  team: { enabled: false, maxWorkers: 4, maxTier: 'small', tiers: { small: { agent: 'claude' }, high: { agent: 'claude' } }, budgets: {} },
  projectDefaults: {},
};
const v = (patch, opts) => validatePatch(patch, DEF, { isDir: p => p === '/home' || p === '/work', ...opts });
const keys = errs => errs.map(e => e.key);

test('a valid patch, and null resets, pass', () => {
  assert.deepStrictEqual(v({ fontSize: 16, runawayGuard: 'stop', cursorBlink: false, defaultCwd: '/work', notAKey: 'x' }), []);
  assert.deepStrictEqual(v({ fontSize: null, updateCheckHours: null }), []);
});

test('the wrong type is refused with what was expected and what was kept', () => {
  const [e] = v({ fontSize: '16' });
  assert.strictEqual(e.key, 'fontSize');
  assert.match(e.expected, /number/);
  assert.match(e.message, /kept 13/);
  assert.deepStrictEqual(keys(v({ cursorBlink: 'yes', agents: 'x', fontSize: NaN })).sort(), ['agents', 'cursorBlink', 'fontSize']);
});

test('numbers outside their range or not whole are refused', () => {
  const [e] = v({ updateCheckHours: 99 });
  assert.strictEqual(e.message, 'Must be a whole number 0-24 hours; kept 3');
  assert.deepStrictEqual(keys(v({ fontSize: 8 })), ['fontSize']);
  assert.deepStrictEqual(keys(v({ fontSize: 12.5 })), ['fontSize']);
  assert.deepStrictEqual(v({ fontSize: 24 }), []);
});

test('an unknown enum value is refused', () => {
  assert.match(v({ runawayGuard: 'explode' })[0].expected, /warn, stop, off/);
  assert.deepStrictEqual(keys(v({ updateChannel: 'nightly' })), ['updateChannel']);
});

test('a default agent or tier agent that does not exist is refused', () => {
  assert.deepStrictEqual(keys(v({ defaultAgent: 'ghost' })), ['defaultAgent']);
  assert.deepStrictEqual(v({ defaultAgent: 'opencode' }), []);
  assert.deepStrictEqual(keys(v({ defaultAgent: 'operant' })), ['defaultAgent']);
  assert.deepStrictEqual(keys(v({ team: { tiers: { small: { agent: 'ghost' } } } })), ['team']);
  assert.deepStrictEqual(v({ team: { tiers: { small: { agent: 'claude' } }, maxWorkers: 8 } }), []);
  assert.deepStrictEqual(keys(v({ projectDefaults: { '/p': { agent: 'ghost' } } })), ['projectDefaults']);
  assert.deepStrictEqual(keys(v({ team: { maxTier: 'huge' } })), ['team']);
});

test('a folder that does not exist is refused', () => {
  const [e] = v({ defaultCwd: '/nope' });
  assert.strictEqual(e.key, 'defaultCwd');
  assert.match(e.message, /kept "\/home"/);
});

test('conflicting keys in one patch: removing the default agent', () => {
  const only = [DEF.agents[1]];
  assert.deepStrictEqual(keys(v({ agents: only })), ['defaultAgent']);
  assert.deepStrictEqual(v({ agents: only, defaultAgent: 'opencode' }), []);
  assert.deepStrictEqual(keys(v({ agents: [DEF.agents[0], DEF.agents[0]] })), ['agents']);
  assert.deepStrictEqual(keys(v({ agents: [] })), ['agents']);
});

test('all or nothing: one bad key means the patch reports it and applyPatch is not reached', () => {
  const errs = v({ fontSize: 16, updateCheckHours: 99, runawayGuard: 'off' });
  assert.deepStrictEqual(keys(errs), ['updateCheckHours']);
  const user = { fontSize: 14 };
  if (!errs.length) applyPatch(user, { fontSize: 16 }, DEF);
  assert.deepStrictEqual(user, { fontSize: 14 });
});

test('a project agent choice must be both, claude or opencode', () => {
  assert.deepStrictEqual(v({ projectDefaults: { '/p': { agents: 'claude' } } }), []);
  assert.deepStrictEqual(v({ projectDefaults: { '/p': { agents: 'both' } } }), []);
  assert.deepStrictEqual(keys(v({ projectDefaults: { '/p': { agents: 'gemini' } } })), ['projectDefaults']);
});

test('the Operant Terminal settings are dropped and a default agent of operant is reset', () => {
  const r = migrate({ configVersion: 1, terminal: { maxTasks: 4 }, defaultAgent: 'operant', projectDefaults: { '/p': { agent: 'operant', agents: 'claude' } }, theme: 'dark' });
  assert.deepStrictEqual(r.user, { configVersion: CURRENT, projectDefaults: { '/p': { agents: 'claude' } }, theme: 'dark' });
  assert.deepStrictEqual(migrate({ configVersion: 1, defaultAgent: 'claude' }).user.defaultAgent, 'claude');
});
