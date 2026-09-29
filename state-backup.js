// Operant's own state backups: config, session, usage tags, outcomes, memory telemetry and the personal memory
// folder are copied into userData/backups/<YYYYMMDD-HHMMSS>-<reason>/ with a manifest of sizes and sha256 hashes.
// Every copy is read back and checked, and a restore checks the hashes again first. Paths are injected so it can
// be tested against temp dirs.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomic } = require('./atomic-write');

const BACKUPS_DIR = 'backups';
const STATE_FILES = ['config.json', 'session.json', 'usage-tags.json', 'outcomes.jsonl', 'memory-stats.json', 'memory-recalls.jsonl'];
const MEMORY_DIR = 'memory';

const backupsRoot = userDataDir => path.join(userDataDir, BACKUPS_DIR);
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

function createBackup({ userDataDir, reason, version = '', now = new Date() }) {
  const root = backupsRoot(userDataDir);
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
function listBackups(userDataDir) {
  const root = backupsRoot(userDataDir);
  let names;
  try { names = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { return []; }
  const rows = names.map(id => {
    const m = readManifest(path.join(root, id));
    return {
      id, at: m && Date.parse(m.at) ? m.at : '', reason: m ? m.reason || '' : '', version: m ? m.version || '' : '',
      files: m ? m.files.length : 0, bytes: m ? m.files.reduce((s, f) => s + (f.size || 0), 0) : 0, ok: !!m,
    };
  });
  return rows.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0) || (a.id < b.id ? 1 : -1));
}

// Keeps the newest keepLast backups and the newest of each of the last keepDaily days that have one; the newest
// backup is never deleted. Returns the ids removed.
function pruneBackups(userDataDir, { keepLast = 10, keepDaily = 7 } = {}) {
  const rows = listBackups(userDataDir);
  const keep = new Set(rows.slice(0, Math.max(1, keepLast)).map(r => r.id));
  const days = new Set();
  for (const r of rows) {
    const t = Date.parse(r.at);
    if (!t) continue;
    const d = new Date(t);
    const day = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (days.has(day)) continue;
    if (days.size >= keepDaily) break;
    days.add(day);
    keep.add(r.id);
  }
  const removed = [];
  for (const r of rows) {
    if (keep.has(r.id)) continue;
    try { fs.rmSync(path.join(backupsRoot(userDataDir), r.id), { recursive: true, force: true }); removed.push(r.id); } catch { /* best effort */ }
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

// The caller relaunches afterwards: config and session are read at startup.
function restoreBackup({ userDataDir, id, version = '' }) {
  if (!id || /[\\/]/.test(id) || id === '.' || id === '..') throw new Error('Unknown backup');
  const folder = path.join(backupsRoot(userDataDir), id);
  const m = verifyBackup(folder);
  const safety = createBackup({ userDataDir, reason: 'before-restore', version });
  // Files in the manifest are written over the current ones. Anything else already in the memory folder (facts
  // saved after the backup) is left alone, not deleted.
  const restored = [];
  for (const f of m.files) {
    writeFileAtomic(inside(userDataDir, f.path), fs.readFileSync(inside(folder, f.path)));
    restored.push(f.path);
  }
  return { id, restored, safety: safety.id };
}

module.exports = { createBackup, listBackups, pruneBackups, restoreBackup, verifyBackup, backupsRoot, STATE_FILES };
