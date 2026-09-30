// Keeps credentials out of what Operant writes to disk (backups, the log). A key named like a secret holding a
// string, and any string that looks like an API key or token, is replaced by the marker.
const MARK = '[redacted]';
const SECRET_KEY = /token|secret|passw(or)?d|passwd|api[-_]?key|authorization|credential|private[-_]?key/i;
const SECRET_VALUE = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
];

// Text with anything that looks like a key or token replaced.
function redactText(s) {
  let out = String(s);
  for (const re of SECRET_VALUE) out = out.replace(re, m => (/^bearer/i.test(m) ? `Bearer ${MARK}` : MARK));
  return out;
}

// A deep copy of obj without secrets: { value, paths } (paths are dotted, arrays as [n]). With remove, a secret key
// is dropped instead of set to the marker (backups use that, so a restore can carry the live value back).
function redactWalk(obj, { remove = false } = {}) {
  const paths = [];
  const go = (v, p) => {
    if (typeof v === 'string') { const r = redactText(v); if (r !== v) paths.push(p); return r; }
    if (Array.isArray(v)) return v.map((x, i) => go(x, `${p}[${i}]`));
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) {
        const kp = p ? `${p}.${k}` : k;
        if (SECRET_KEY.test(k) && typeof x === 'string' && x !== '') { paths.push(kp); if (!remove) o[k] = MARK; } else o[k] = go(x, kp);
      }
      return o;
    }
    return v;
  };
  return { value: go(obj, ''), paths };
}

// A deep copy of obj where string values that look like secrets are redacted; key names stay as they are.
function redactValues(obj) {
  const go = v => {
    if (typeof v === 'string') return redactText(v);
    if (Array.isArray(v)) return v.map(go);
    if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = go(x); return o; }
    return v;
  };
  return go(obj);
}

const redactSecrets = (obj, opts) => redactWalk(obj, opts).value;

module.exports = { redactValues, redactSecrets, redactWalk, redactText, MARK };
