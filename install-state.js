// userData/installation.json: a random id made once, when this profile first ran, and what the launch looks like
// compared to the last one. Read at startup by main.js ('app:install-state').
//   first-install  no Operant state in userData at all
//   existing       same version as last launch
//   upgrade        version went up (lastVersion says from what)
//   downgrade      version went down
//   upgrade        also when state files exist but installation.json does not: an Operant from before 2.1 kept no
//                  record (lastVersion is then unknown); a deleted record reads the same way
//   recovery       the launch right after a backup restore
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomic } = require('./atomic-write');

const FILE = 'installation.json';
const STATE_MARKERS = ['config.json', 'session.json', 'usage-tags.json', 'outcomes.jsonl', 'memory-stats.json', 'memory-recalls.jsonl', 'memory'];

function read(userDataDir) {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(userDataDir, FILE), 'utf8'));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch { return null; }
}
function write(userDataDir, o) { fs.mkdirSync(userDataDir, { recursive: true }); writeFileAtomic(path.join(userDataDir, FILE), JSON.stringify(o, null, 2)); }
const hasState = userDataDir => STATE_MARKERS.some(f => fs.existsSync(path.join(userDataDir, f)));

// 1.2.10 > 1.2.9; anything that is not dotted numbers compares equal.
function compareVersions(a, b) {
  const p = v => /^\d+(\.\d+)*/.test(String(v || '')) ? String(v).match(/^\d+(\.\d+)*/)[0].split('.').map(Number) : null;
  const x = p(a), y = p(b);
  if (!x || !y) return 0;
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}

// Call once per launch, before anything else writes state. Returns and stores { state, installationId, firstRunAt,
// lastVersion, version, recovery? }. Never throws: a profile that can't be written still gets its state.
function recordLaunch({ userDataDir, version, now = new Date() }) {
  const prev = read(userDataDir);
  let state, lastVersion = prev && prev.version ? prev.version : '';
  if (prev && prev.postRestore && prev.postRestore.pending) state = 'recovery';
  else if (!prev || !prev.version) state = hasState(userDataDir) ? 'upgrade' : 'first-install';
  else {
    const c = compareVersions(version, prev.version);
    state = c > 0 ? 'upgrade' : c < 0 ? 'downgrade' : 'existing';
  }
  const rec = {
    installationId: prev && /^[0-9a-f]{32}$/.test(prev.installationId || '') ? prev.installationId : crypto.randomBytes(16).toString('hex'),
    firstRunAt: prev && prev.firstRunAt ? prev.firstRunAt : now.toISOString(),
    version, lastVersion: state === 'first-install' || !prev || !prev.version ? '' : lastVersion,
    state, at: now.toISOString(),
    ...(prev && prev.postRestore ? { postRestore: prev.postRestore } : {}),
  };
  // The next start compares against this one; recovery is consumed by it (postRestore stays until its health check is recorded).
  const stored = { ...rec, ...(rec.postRestore ? { postRestore: { ...rec.postRestore, pending: false } } : {}) };
  try { write(userDataDir, stored); } catch { /* read-only profile */ }
  return rec;
}

// The id backups carry; created on first use.
function installationId(userDataDir) {
  const prev = read(userDataDir);
  if (prev && /^[0-9a-f]{32}$/.test(prev.installationId || '')) return prev.installationId;
  const id = crypto.randomBytes(16).toString('hex');
  try { write(userDataDir, { ...(prev || {}), installationId: id, firstRunAt: (prev && prev.firstRunAt) || new Date().toISOString() }); } catch { /* read-only profile */ }
  return id;
}

// A restore calls this so the next launch reports 'recovery'.
function markRestore(userDataDir, id, at = new Date()) {
  const prev = read(userDataDir) || {};
  write(userDataDir, { ...prev, postRestore: { id, at: at.toISOString(), pending: true } });
}

module.exports = { recordLaunch, installationId, markRestore, compareVersions, read, FILE };
