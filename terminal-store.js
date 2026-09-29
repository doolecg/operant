// The Operant Terminal's conversation, one file per project: userData/terminal/<key>.jsonl, one JSON entry per line
// ({ t, role: 'user'|'refiner'|'operant'|'task', requestId?, ... }). Appends add a line; past the size cap the oldest
// turns are dropped with an atomic rewrite. Included in Operant's state backups (state-backup.js).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomic } = require('./atomic-write');

const CAP_BYTES = 5 * 1024 * 1024;
const ROLES = ['user', 'refiner', 'operant', 'task'];

// Same project, same key: separators, case (on Windows) and a trailing slash don't matter.
function projectKey(project) {
  let p = String(project || '').replace(/[\\]/g, '/').replace(/\/+$/, '');
  if (process.platform === 'win32') p = p.toLowerCase();
  const slug = (p.split('/').pop() || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'project';
  return `${slug}-${crypto.createHash('sha1').update(p).digest('hex').slice(0, 10)}`;
}

function createStore(dir, { capBytes = CAP_BYTES } = {}) {
  const fileOf = project => path.join(dir, projectKey(project) + '.jsonl');
  const parse = raw => {
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { const e = JSON.parse(line); if (e && typeof e === 'object' && ROLES.includes(e.role)) out.push(e); } catch { /* a torn last line */ }
    }
    return out;
  };
  const read = project => { try { return parse(fs.readFileSync(fileOf(project), 'utf8')); } catch { return []; } };

  function append(project, entry) {
    if (!entry || typeof entry !== 'object' || !ROLES.includes(entry.role)) throw new Error('entry needs a role: ' + ROLES.join(', '));
    const e = { t: Date.now(), ...entry };
    const line = JSON.stringify(e) + '\n', file = fileOf(project);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, line);
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* gone */ }
    if (size > capBytes) {
      // Keep the newest turns that fit in 80% of the cap, so the rewrite doesn't happen on every append.
      const all = read(project), lines = all.map(x => JSON.stringify(x) + '\n');
      let from = lines.length - 1, total = Buffer.byteLength(lines[from]);
      while (from > 0 && total + Buffer.byteLength(lines[from - 1]) <= capBytes * 0.8) total += Buffer.byteLength(lines[--from]);
      writeFileAtomic(file, lines.slice(from).join(''));
    }
    return e;
  }

  function history(project, { limit } = {}) {
    const all = read(project);
    return limit > 0 ? all.slice(-limit) : all;
  }

  function clear(project) { try { fs.rmSync(fileOf(project), { force: true }); } catch { /* nothing to clear */ } }

  return { append, history, clear, fileOf };
}

module.exports = { createStore, projectKey, CAP_BYTES };
