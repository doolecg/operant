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

const BACKUPS_DIR = 'backups';
const STATE_FILES = ['config.json', 'session.json', 'usage-tags.json', 'outcomes.jsonl', 'memory-stats.json', 'memory-recalls.jsonl'];
const MEMORY_DIR = 'memory';

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
    const files = [];
    for (const rel of collect(userDataDir)) {
      const data = fs.readFileSync(inside(userDataDir, rel));
      writeFileAtomic(inside(folder, rel), data);
      files.push({ path: rel, size: data.length, sha256: sha256(data) });
    }
    for (const f of files) {
      const back = fs.readFileSync(inside(folder, f.path));
      if (back.length !== f.size || sha256(back) !== f.sha256) throw new Error(`Backup check failed for ${f.path}`);
    }
    const manifest = { version, reason: String(reason || 'manual'), at: now.toISOString(), files };
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
    if (s && typeof s === 'object' && s.validations && typeof s.validations === 'object') return { validations: s.validations, lastValidated: s.lastValidated || null };
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

// The caller relaunches afterwards: config and session are read at startup. If a write fails part way, the files
// already replaced are put back from the safety backup (and ones the restore created are removed), so the live
// state stays as it was; the error says so. write is injectable for tests.
function restoreBackup({ userDataDir, location = '', id, version = '', write = writeFileAtomic }) {
  if (!id || /[\\/]/.test(id) || id === '.' || id === '..') throw new Error('Unknown backup');
  const folder = path.join(backupsRoot(userDataDir, location), id);
  const m = verifyBackup(folder);
  checkConfigParses(folder, m);
  const safety = createBackup({ userDataDir, location, reason: 'before-restore', version });
  // Files in the manifest are written over the current ones. Anything else already in the memory folder (facts
  // saved after the backup) is left alone, not deleted.
  const had = new Set(safety.files.map(f => f.path));
  const restored = [];
  try {
    for (const f of m.files) {
      restored.push(f.path);
      write(inside(userDataDir, f.path), fs.readFileSync(inside(folder, f.path)));
    }
  } catch (e) {
    let undone = true;
    for (const rel of restored) {
      try {
        if (had.has(rel)) writeFileAtomic(inside(userDataDir, rel), fs.readFileSync(inside(safety.folder, rel)));
        else fs.rmSync(inside(userDataDir, rel), { force: true });
      } catch { undone = false; }
    }
    throw new Error(`Restore failed (${e.message || e}). ${undone ? 'Your current files were left as they were.' : `Some files could not be put back; the copy taken just before is ${safety.id}.`}`);
  }
  return { id, restored, safety: safety.id };
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

module.exports = { createBackup, listBackups, pruneBackups, restoreBackup, verifyBackup, testRestore, statusSummary, checkLocation, normalizeSettings, backupsRoot, STATE_FILES, DEFAULT_SETTINGS };
