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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'w');
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

module.exports = { writeFileAtomic, readJsonSafe };
