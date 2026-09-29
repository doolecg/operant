// Operant's own state backups: config, session, usage tags, outcomes, memory telemetry and the personal memory
// folder are copied into userData/backups/<YYYYMMDD-HHMMSS>-<reason>/ with a manifest of sizes and sha256 hashes.
// Every copy is read back and checked, and a restore checks the hashes again first. Paths are injected so it can
// be tested against temp dirs. A custom location (Settings > Backups) replaces userData/backups; status.json in
// the backups folder keeps the result of the last restore test of each backup.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { writeFileAtomic } = require('./atomic-write');
const { redactWalk, redactText } = require('./redact');
const installState = require('./install-state');
const configMigrate = require('./config-migrate');

const BACKUPS_DIR = 'backups';
const STATE_FILES = ['config.json', 'session.json', 'usage-tags.json', 'outcomes.jsonl', 'memory-stats.json', 'memory-recalls.jsonl'];
const MEMORY_DIR = 'memory';
const TERMINAL_DIR = 'terminal'; // the Operant Terminal's per-project conversations (optional history)
const FORMAT_VERSION = 1;
// 84J: without these a restore is pointless (required), the rest is history that can be lost (optional).
const kindOf = f => f === 'config.json' || f === 'session.json' || f.startsWith(`${MEMORY_DIR}/`) ? 'required' : 'optional';
const parseJson = buf => JSON.parse(Buffer.from(buf).toString('utf8').replace(/^﻿/, ''));

// What goes into a backup for a file: JSON loses keys named like secrets (the redacted list says which, so a restore
// carries the live values back), any other text loses strings that look like keys or tokens.
function redactFile(rel, data) {
  if (rel.endsWith('.json')) {
    try {
      const { value, paths } = redactWalk(parseJson(data), { remove: true });
      return paths.length ? { data: Buffer.from(JSON.stringify(value, null, 2)), paths } : { data, paths: [] };
    } catch { /* not JSON: treat as text */ }
  }
  const text = data.toString('utf8'), r = redactText(text);
  return r === text ? { data, paths: [] } : { data: Buffer.from(r), paths: [''] };
}

const STATUS_FILE = 'status.json';
const DEFAULT_SETTINGS = { enabled: true, everyHours: 24, keepLast: 10, keepDays: 7, location: '', beforeUpdate: true, beforeMigration: true };

const backupsRoot = (userDataDir, location = '') => location ? path.resolve(location) : path.join(userDataDir, BACKUPS_DIR);
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const pad = n => String(n).padStart(2, '0');
const stamp = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const safeReason = r => String(r || 'manual').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'manual';

// Relative paths (forward slashes) of the state that exists now.
function collect(userDataDir) {
  const out = [];
  for (const f of STATE_FILES) {
    try { if (fs.statSync(path.join(userDataDir, f)).isFile()) out.push(f); } catch { /* not there yet */ }
  }
  const walk = rel => {
    let entries;
    try { entries = fs.readdirSync(path.join(userDataDir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r);
      else if (e.isFile() && !/\.tmp$/.test(e.name)) out.push(r);
    }
  };
  walk(MEMORY_DIR);
  walk(TERMINAL_DIR);
  return out;
}

// A manifest path must stay inside the folder it is joined to.
function inside(root, rel) {
  const full = path.resolve(root, ...String(rel).split('/'));
  const r = path.relative(path.resolve(root), full);
  if (!r || r.startsWith('..') || path.isAbsolute(r)) throw new Error(`Backup lists a path outside its folder: ${rel}`);
  return full;
}

function createBackup({ userDataDir, location = '', reason, version = '', now = new Date() }) {
  const root = backupsRoot(userDataDir, location);
  const base = `${stamp(now)}-${safeReason(reason)}`;
  let id = base, n = 1;
  while (fs.existsSync(path.join(root, id))) id = `${base}-${++n}`;
  const folder = path.join(root, id);
  fs.mkdirSync(folder, { recursive: true });
  try {
    const files = [], redacted = [];
    for (const rel of collect(userDataDir)) {
      const r = redactFile(rel, fs.readFileSync(inside(userDataDir, rel)));
      const data = r.data;
      writeFileAtomic(inside(folder, rel), data);
      files.push({ path: rel, kind: kindOf(rel), size: data.length, sha256: sha256(data) });
      for (const p of r.paths) redacted.push(p ? `${rel}:${p}` : rel);
    }
    for (const f of files) {
      const back = fs.readFileSync(inside(folder, f.path));
      if (back.length !== f.size || sha256(back) !== f.sha256) throw new Error(`Backup check failed for ${f.path}`);
    }
    const manifest = {
      formatVersion: FORMAT_VERSION, version, configVersion: configMigrate.CURRENT, installationId: installState.installationId(userDataDir),
      reason: String(reason || 'manual'), at: now.toISOString(), files,
      redacted, ...(redacted.length ? { redactedNote: 'Keys, tokens and passwords are left out of backups; a restore keeps the ones already in Operant.' } : {}),
    };
    writeFileAtomic(path.join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2));
    return { ...manifest, id, folder };
  } catch (e) {
    try { fs.rmSync(folder, { recursive: true, force: true }); } catch { /* best effort */ }
    throw e;
  }
}

function readManifest(folder) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
    return m && Array.isArray(m.files) ? m : null;
  } catch { return null; }
}

// Newest first. A folder without a readable manifest is listed with ok: false.
// status: valid / cantRestore (the last restore test failed) / failed (no readable manifest) / '' (not tested yet).
function listBackups(userDataDir, location = '') {
  const root = backupsRoot(userDataDir, location);
  const tested = readStatus(root).validations;
  let names;
  try { names = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { return []; }
  const rows = names.map(id => {
    const m = readManifest(path.join(root, id));
    const v = tested[id] || null;
    return {
      validation: v, status: !m ? 'failed' : v ? (v.ok ? 'valid' : 'cantRestore') : '',
      id, at: m && Date.parse(m.at) ? m.at : '', reason: m ? m.reason || '' : '', version: m ? m.version || '' : '',
      files: m ? m.files.length : 0, bytes: m ? m.files.reduce((s, f) => s + (f.size || 0), 0) : 0, ok: !!m,
    };
  });
  return rows.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0) || (a.id < b.id ? 1 : -1));
}

// Keeps the newest keepLast backups and the newest of each of the last keepDays days that have one; the newest
// backup is never deleted. Returns the ids removed.
function pruneBackups(userDataDir, { keepLast = 10, keepDays = 7, location = '' } = {}) {
  const rows = listBackups(userDataDir, location);
  const keep = new Set(rows.slice(0, Math.max(1, keepLast)).map(r => r.id));
  const days = new Set();
  for (const r of rows) {
    const t = Date.parse(r.at);
    if (!t) continue;
    const d = new Date(t);
    const day = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (days.has(day)) continue;
    if (days.size >= keepDays) break;
    days.add(day);
    keep.add(r.id);
  }
  const removed = [];
  for (const r of rows) {
    if (keep.has(r.id)) continue;
    try { fs.rmSync(path.join(backupsRoot(userDataDir, location), r.id), { recursive: true, force: true }); removed.push(r.id); } catch { /* best effort */ }
  }
  if (removed.length) {
    const root = backupsRoot(userDataDir, location), st = readStatus(root);
    for (const id of removed) delete st.validations[id];
    try { writeStatus(root, st); } catch { /* best effort */ }
  }
  return removed;
}

// Throws naming the first file that is missing or differs from the manifest.
function verifyBackup(folder) {
  const m = readManifest(folder);
  if (!m) throw new Error('This backup has no readable manifest');
  for (const f of m.files) {
    let data;
    try { data = fs.readFileSync(inside(folder, f.path)); } catch { throw new Error(`Backup file is missing: ${f.path}`); }
    if (data.length !== f.size || sha256(data) !== f.sha256) throw new Error(`Backup file does not match its hash: ${f.path}`);
  }
  return m;
}

function readStatus(root) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(root, STATUS_FILE), 'utf8'));
    if (s && typeof s === 'object' && s.validations && typeof s.validations === 'object') return { validations: s.validations, lastValidated: s.lastValidated || null, ...(s.postRestore ? { postRestore: s.postRestore } : {}) };
  } catch { /* none yet */ }
  return { validations: {}, lastValidated: null };
}
function writeStatus(root, st) { fs.mkdirSync(root, { recursive: true }); writeFileAtomic(path.join(root, STATUS_FILE), JSON.stringify(st, null, 2)); }

// The newest backup and the last restore test: what Settings > Backups shows above the list.
function statusSummary(userDataDir, location = '') {
  const root = backupsRoot(userDataDir, location);
  const rows = listBackups(userDataDir, location).filter(b => b.ok);
  const last = rows[0] || null;
  return { location: root, last: last && { id: last.id, at: last.at, bytes: last.bytes, files: last.files, reason: last.reason }, validated: readStatus(root).lastValidated, count: rows.length };
}

// config.json, when the backup has one, has to parse: a backup of a broken file is not one worth restoring.
function checkConfigParses(folder, m) {
  if (!m.files.some(f => f.path === 'config.json')) return;
  try { JSON.parse(fs.readFileSync(inside(folder, 'config.json'), 'utf8').replace(/^\uFEFF/, '')); } catch { throw new Error('config.json in this backup does not parse'); }
}

// Restores the backup into a temp folder (never the live one), reads every file back against the manifest and
// parses config.json, then records the result in status.json. id defaults to the newest backup with a manifest.
// Never throws: { id, ok, error, at } (id is '' when there is no backup).
function testRestore({ userDataDir, location = '', id = '', now = new Date() }) {
  const root = backupsRoot(userDataDir, location);
  const at = now.toISOString();
  if (!id) id = (listBackups(userDataDir, location).find(b => b.ok) || {}).id || '';
  if (!id) return { id: '', ok: false, error: 'There is no backup to test yet. Take one with Back up now.', at };
  let temp = '', error = '';
  try {
    if (/[\\/]/.test(id) || id === '.' || id === '..') throw new Error('Unknown backup');
    const folder = path.join(root, id);
    const m = verifyBackup(folder);
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'operant-restore-test-'));
    for (const f of m.files) writeFileAtomic(inside(temp, f.path), fs.readFileSync(inside(folder, f.path)));
    for (const f of m.files) {
      const back = fs.readFileSync(inside(temp, f.path));
      if (back.length !== f.size || sha256(back) !== f.sha256) throw new Error(`Restored file does not read back correctly: ${f.path}`);
    }
    checkConfigParses(temp, m);
  } catch (e) { error = String(e.message || e); }
  if (temp) try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* best effort */ }
  const result = { id, ok: !error, error, at };
  try {
    const st = readStatus(root);
    st.validations[id] = { at, ok: result.ok, error };
    st.lastValidated = result;
    writeStatus(root, st);
  } catch { /* the result is still returned */ }
  return result;
}

// The version a backup's config needs: newer than this Operant means it can't be read here.
function checkCompatible(folder, m) {
  let cv = Number.isInteger(m.configVersion) ? m.configVersion : 0;
  if (!cv && m.files.some(f => f.path === 'config.json')) { try { cv = +parseJson(fs.readFileSync(inside(folder, 'config.json'))).configVersion || 0; } catch { /* checkConfigParses names it */ } }
  if ((Number.isInteger(m.formatVersion) && m.formatVersion > FORMAT_VERSION) || cv > configMigrate.CURRENT) {
    throw new Error(`This backup is from a newer Operant (${m.version || 'unknown version'}); update Operant first.`);
  }
}

// After the files are back: config.json parses and migrates (an older backup moves forward, written back), session.json
// parses, memory files read. Throws naming what failed. carry: the live config, for the keys a backup leaves out.
function validateRestored(userDataDir, m, carry) {
  const has = f => m.files.some(x => x.path === f);
  if (has('config.json')) {
    const file = inside(userDataDir, 'config.json');
    let cfg;
    try { cfg = parseJson(fs.readFileSync(file)); } catch { throw new Error('config.json does not parse after the restore'); }
    for (const p of (m.redacted || []).filter(r => r.startsWith('config.json:')).map(r => r.slice(12))) {
      const keys = p.split('.');
      if (keys.some(k => /\[/.test(k))) continue;
      let live = carry, dst = cfg;
      for (const k of keys.slice(0, -1)) { live = live && live[k]; if (!dst[k] || typeof dst[k] !== 'object') dst[k] = {}; dst = dst[k]; }
      const last = keys[keys.length - 1];
      if (live && typeof live[last] === 'string' && !(last in dst)) dst[last] = live[last];
    }
    const mig = configMigrate.migrate(cfg);
    if (mig.future) throw new Error(`config.json is version ${mig.from}, newer than this Operant (${configMigrate.CURRENT}); update Operant first`);
    if (mig.error) throw new Error(`config.json could not be migrated to version ${configMigrate.CURRENT} (${mig.error.message || mig.error})`);
    writeFileAtomic(file, JSON.stringify(mig.user, null, 2));
  }
  if (has('session.json')) { try { parseJson(fs.readFileSync(inside(userDataDir, 'session.json'))); } catch { throw new Error('session.json does not parse after the restore'); } }
  for (const f of m.files.filter(x => x.path.startsWith(`${MEMORY_DIR}/`))) {
    try { fs.readFileSync(inside(userDataDir, f.path), 'utf8'); } catch { throw new Error(`${f.path} can't be read after the restore`); }
  }
}

// The caller relaunches afterwards: config and session are read at startup. A backup from a newer Operant is refused
// before anything is touched. Files are then written over the current ones and the result validated (validateRestored);
// if a write or the validation fails, the files already replaced are put back exactly as they were (and ones the restore
// created are removed), so the live state stays as it was; the error says what failed. write is injectable for tests.
function restoreBackup({ userDataDir, location = '', id, version = '', write = writeFileAtomic }) {
  if (!id || /[\\/]/.test(id) || id === '.' || id === '..') throw new Error('Unknown backup');
  const folder = path.join(backupsRoot(userDataDir, location), id);
  const m = verifyBackup(folder);
  checkConfigParses(folder, m);
  checkCompatible(folder, m);
  const safety = createBackup({ userDataDir, location, reason: 'before-restore', version });
  // Files in the manifest are written over the current ones. Anything else already in the memory folder (facts
  // saved after the backup) is left alone, not deleted.
  const before = new Map();
  for (const f of m.files) { try { before.set(f.path, fs.readFileSync(inside(userDataDir, f.path))); } catch { /* not there now */ } }
  let carry = {};
  try { carry = before.has('config.json') ? parseJson(before.get('config.json')) : {}; } catch { /* live config was broken */ }
  const restored = [];
  try {
    for (const f of m.files) {
      restored.push(f.path);
      write(inside(userDataDir, f.path), fs.readFileSync(inside(folder, f.path)));
    }
    validateRestored(userDataDir, m, carry);
  } catch (e) {
    let undone = true;
    for (const rel of restored) {
      try {
        if (before.has(rel)) writeFileAtomic(inside(userDataDir, rel), before.get(rel));
        else fs.rmSync(inside(userDataDir, rel), { force: true });
      } catch { undone = false; }
    }
    throw new Error(`Restore failed (${e.message || e}). ${undone ? 'Your current files were left as they were.' : `Some files could not be put back; the copy taken just before is ${safety.id}.`}`);
  }
  try { installState.markRestore(userDataDir, id); } catch { /* the next launch just reads as a normal one */ }
  return { id, restored, safety: safety.id };
}

// The post-restore health check: the 'recovery' launch records ok: null, the window loading (app:ready) records ok: true.
function recordPostRestore({ userDataDir, location = '', id, ok = null, at = new Date() }) {
  const root = backupsRoot(userDataDir, location);
  const st = readStatus(root);
  st.postRestore = { id, ok, at: at.toISOString() };
  writeStatus(root, st);
  return st.postRestore;
}

// A backup location: '' (the default) is fine, anything else must be an absolute folder that can be written to.
// Returns '' or a message saying what to do.
function checkLocation(location) {
  if (!location) return '';
  if (!path.isAbsolute(location)) return `${location} is not a full folder path. Pick a folder with Browse, or clear the field to use Operant's data folder.`;
  try {
    fs.mkdirSync(location, { recursive: true });
    const probe = path.join(location, `.operant-write-test-${process.pid}.tmp`);
    fs.writeFileSync(probe, 'x');
    fs.rmSync(probe, { force: true });
    return '';
  } catch (e) {
    return `Operant can't write to ${location} (${e.code || e.message}). Pick a folder you can write to, or clear the field to use Operant's data folder.`;
  }
}

// The backups setting a patch supplies, on top of what was stored: defaults for missing keys, numbers clamped to
// their range, and a location that fails checkLocation replaced by the previous one. -> { settings, error }
function normalizeSettings(input, prev = DEFAULT_SETTINGS) {
  const cur = { ...DEFAULT_SETTINGS, ...(prev || {}) }, i = input && typeof input === 'object' ? input : {};
  const num = (k, lo, hi) => k in i && i[k] !== '' && i[k] !== null && Number.isFinite(+i[k]) ? Math.min(hi, Math.max(lo, Math.round(+i[k]))) : cur[k];
  const s = {
    enabled: 'enabled' in i ? !!i.enabled : cur.enabled,
    everyHours: num('everyHours', 1, 168),
    keepLast: num('keepLast', 1, 1000),
    keepDays: num('keepDays', 0, 3650),
    location: cur.location,
    beforeUpdate: 'beforeUpdate' in i ? !!i.beforeUpdate : cur.beforeUpdate,
    beforeMigration: 'beforeMigration' in i ? !!i.beforeMigration : cur.beforeMigration,
  };
  let error = '';
  if ('location' in i) {
    const loc = String(i.location || '').trim();
    error = checkLocation(loc);
    if (!error) s.location = loc;
  }
  return { settings: s, error };
}

module.exports = { createBackup, listBackups, pruneBackups, restoreBackup, verifyBackup, testRestore, statusSummary, recordPostRestore, FORMAT_VERSION, checkLocation, normalizeSettings, backupsRoot, STATE_FILES, DEFAULT_SETTINGS };
