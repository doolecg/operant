// Crash-safe file writes: data goes to a temp file beside the target, is flushed to disk, then renamed over it,
// so a crash or power cut leaves either the old file or the new one, never half of one.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sleepMs = ms => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };

// Windows briefly locks files for antivirus and indexers, so a rename can fail with EPERM/EBUSY for a moment.
function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try { return fs.renameSync(from, to); } catch (e) {
      if (process.platform !== 'win32' || (e.code !== 'EPERM' && e.code !== 'EBUSY') || i >= 5) throw e;
      sleepMs(40);
    }
  }
}

function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    // New files are private (0600); an existing file keeps the mode it has.
    let mode = 0o600;
    try { mode = fs.statSync(file).mode & 0o777; } catch {}
    const fd = fs.openSync(tmp, 'w', mode);
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    renameRetry(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

// { value, broken }: a missing file gives the fallback; a file that doesn't parse is copied to <file>.broken
// (overwriting an older copy) and gives the fallback with broken: true.
function readJsonSafe(file, fallback) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { value: fallback, broken: false }; }
  try { return { value: JSON.parse(text.replace(/^﻿/, '')), broken: false }; } catch {
    try { fs.copyFileSync(file, file + '.broken'); } catch {}
    return { value: fallback, broken: true };
  }
}

// Checks for paths and git refs that come from the renderer or the control CLI.
const EXEC_EXT = new Set(['.exe', '.bat', '.cmd', '.com', '.ps1', '.msi', '.scr', '.lnk', '.sh', '.desktop', '.appimage', '.jar']);
// Would opening this file run it? By type everywhere, and on unix by the executable bit (a directory is fine).
function isExecutableTarget(file, platform = process.platform) {
  if (EXEC_EXT.has(path.extname(String(file)).toLowerCase())) return true;
  if (platform === 'win32') return false;
  try { const st = fs.statSync(file); return !st.isDirectory() && (st.mode & 0o111) !== 0; } catch { return false; }
}
// A branch or ref name git must not read as an option.
function isSafeRef(ref) {
  return typeof ref === 'string' && ref.length > 0 && !ref.startsWith('-') && !/[\0\r\n]/.test(ref);
}

module.exports = { writeFileAtomic, readJsonSafe, isExecutableTarget, isSafeRef };
