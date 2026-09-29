// Every setting works: each DEFAULT_CONFIG key and each Settings control saves, loads back and is read somewhere.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { applyPatch, mergeUser } = require('../config-migrate');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const mainSrc = read('main.js');
const settingsSrc = read('renderer/settings.js');

// The text of the { ... } that starts at src[open], braces matched (strings and comments skipped).
function block(src, open) {
  let depth = 0, i = open;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') { for (i++; src[i] !== c; i++) if (src[i] === '\\') i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (src[i] !== '\n') i++; continue; }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) break;
  }
  return src.slice(open, i + 1);
}
// The keys written at the top level of an object literal's text.
function topKeys(text) {
  const keys = []; let depth = 0;
  for (const line of text.split('\n')) {
    const code = line.replace(/\/\/.*$/, '');
    if (depth === 1) { const m = /^\s*(\w+)\s*:/.exec(code); if (m) keys.push(m[1]); }
    for (const c of code.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '')) { if (c === '{' || c === '[') depth++; if (c === '}' || c === ']') depth--; }
  }
  return keys;
}

const defStart = mainSrc.indexOf('const DEFAULT_CONFIG = {');
const defText = block(mainSrc, mainSrc.indexOf('{', defStart));
const defKeys = topKeys(defText);
const nested = name => topKeys(block(defText, defText.indexOf('{', defText.indexOf(`\n  ${name}:`))));
const teamKeys = nested('team'), stateBackupKeys = [...defText.match(/\n  backups: \{([^}]*)\}/)[1].matchAll(/(\w+):/g)].map(m => m[1]), backupKeys = [...defText.match(/skillsBackup: \{([^}]*)\}/)[1].matchAll(/(\w+):/g)].map(m => m[1]);

// Keys the Settings page writes: control definitions and set('key', ...) calls.
const controlKeys = new Set([...settingsSrc.matchAll(/\{ key: '(\w+)'/g)].map(m => m[1]));
for (const m of settingsSrc.matchAll(/\bset\('(\w+)'/g)) controlKeys.add(m[1]);
for (const m of settingsSrc.matchAll(/data-browse="(\w+)"/g)) controlKeys.add(m[1]);

// Keys read only by the Settings page itself, or in a way the text search can't see.
const ALLOW = {
  // key: 'why the text search can't see its read'
};

// Source text that may read a setting: everything but tests, Settings' own page and the defaults block.
const files = [];
(function walk(d) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'build', 'test', '.git', '.codegraph', 'evals', 'Frost'].includes(f.name)) continue;
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p); else if (/\.(js|mjs|html)$/.test(f.name)) files.push(p);
  }
})(ROOT);
const corpus = files.filter(p => path.relative(ROOT, p).replace(/\\/g, '/') !== 'renderer/settings.js')
  .map(p => { const s = fs.readFileSync(p, 'utf8'); return path.basename(p) === 'main.js' ? s.replace(defText, '') : s; }).join('\n');
// A read is <receiver>.key or <receiver>?.key on the config object (cfg, config, conf), or config['key'].
const RECV = String.raw`(?:cfg|config|conf|settings|\bcfgNow)`;
const used = (k, recv = RECV) => new RegExp(String.raw`${recv}\)?\??\.${k}\b|${recv}\[['"]${k}['"]\]`).test(corpus);

test('the extractor found the defaults', () => {
  for (const k of ['defaultCwd', 'agents', 'team', 'skillsBackup', 'secondBrowserCommand']) assert.ok(defKeys.includes(k), k);
  assert.ok(defKeys.length > 100);
  assert.ok(teamKeys.includes('maxWorkers') && backupKeys.includes('repos'), `${teamKeys} / ${backupKeys}`);
  assert.deepStrictEqual(stateBackupKeys, ['enabled', 'everyHours', 'keepLast', 'keepDays', 'location', 'beforeUpdate', 'beforeMigration']);
});

test('every Settings control writes a key that has a default', () => {
  const bad = [...controlKeys].filter(k => !defKeys.includes(k));
  assert.deepStrictEqual(bad, []);
});

test('every setting is read somewhere outside Settings and the defaults', () => {
  const dead = defKeys.filter(k => !ALLOW[k] && !used(k));
  assert.deepStrictEqual(dead, [], 'set but never read: ' + dead.join(', '));
  const deadTeam = teamKeys.filter(k => !used(k, String.raw`team`));
  assert.deepStrictEqual(deadTeam, [], 'team keys never read: ' + deadTeam);
  const deadBackup = backupKeys.filter(k => !new RegExp(String.raw`\b(?:skillsBackup|c|cfg|config)\)?\??\.${k}\b`).test(corpus));
  assert.deepStrictEqual(deadBackup, []);
  const deadState = stateBackupKeys.filter(k => !new RegExp(String.raw`(?:\bbk|bkCfg\(\))\.${k}\b`).test(corpus));
  assert.deepStrictEqual(deadState, [], 'backups keys never read: ' + deadState);
});

test('allowlisted keys still exist and each has a reason', () => {
  for (const [k, why] of Object.entries(ALLOW)) { assert.ok(defKeys.includes(k), k); assert.ok(why.length > 10); }
});

test('every setting saves and loads back', () => {
  const defaults = { ...Object.fromEntries(defKeys.map(k => [k, 'default'])), team: { tiers: { a: 1 }, budgets: { a: 1 }, enabled: false, maxWorkers: 4 }, backups: { enabled: true, keepLast: 10, location: '' }, keybinds: {} };
  for (const k of defKeys.filter(k => k !== 'team' && k !== 'keybinds' && k !== 'backups')) {
    const user = applyPatch({}, { [k]: 'changed' }, defaults);
    const reloaded = mergeUser(defaults, JSON.parse(JSON.stringify(user)), {});
    assert.strictEqual(reloaded[k], 'changed', k);
    assert.strictEqual(mergeUser(defaults, applyPatch(user, { [k]: null }, defaults), {})[k], 'default', k + ' resets');
  }
  const user = applyPatch({}, { team: { enabled: true, tiers: { a: 2 } }, notAKey: 1 }, defaults);
  assert.ok(!('notAKey' in user));
  const t = mergeUser(defaults, JSON.parse(JSON.stringify(user)), {}).team;
  assert.strictEqual(t.enabled, true); assert.strictEqual(t.maxWorkers, 4); assert.strictEqual(t.tiers.a, 2);
  const b = mergeUser(defaults, JSON.parse(JSON.stringify(applyPatch({}, { backups: { keepLast: 3 } }, defaults))), {}).backups;
  assert.strictEqual(b.keepLast, 3); assert.strictEqual(b.enabled, true); assert.strictEqual(b.location, '');
});

test('every Settings control with a min/max is covered by validation, with the same limits', () => {
  const { RANGES } = require('../config-migrate');
  const controls = [...settingsSrc.matchAll(/\{ key: '(\w+)'[^\n]*?type: '(?:range|number)', min: ([\d.]+), max: ([\d.]+)/g)];
  assert.ok(controls.length > 20, 'found ' + controls.length);
  for (const [, key, min, max] of controls) {
    assert.ok(RANGES[key], key + ' has no validation range');
    assert.deepStrictEqual([RANGES[key].min, RANGES[key].max], [+min, +max], key);
  }
});

test('every validation range and enum names a real setting, and its default passes', () => {
  const { RANGES, ENUMS, validatePatch } = require('../config-migrate');
  for (const k of [...Object.keys(RANGES), ...Object.keys(ENUMS)]) assert.ok(defKeys.includes(k), k);
  const defaults = Object.fromEntries(defKeys.map(k => [k, new RegExp(`\n  ${k}: ('[^']*'|[\d.]+|true|false)`).exec(defText)?.[1]]).filter(([, t]) => t !== undefined).map(([k, t]) => [k, JSON.parse(t.replace(/'/g, '"'))]));
  for (const k of [...Object.keys(RANGES), ...Object.keys(ENUMS)]) {
    if (!(k in defaults)) continue;
    assert.deepStrictEqual(validatePatch({ [k]: defaults[k] }, defaults), [], k + ' default must be valid');
  }
});
