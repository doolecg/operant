(function () {
// Evidence that a worker is stuck, pure. Fed tool results, assistant turns and file edits for one tile
// session; each call returns null or { kind, reason }. Fires once per piece of evidence.

// Strips what differs between two runs of the same failure, then keeps the first ~300 characters.
function normalise(text) {
  return String(text || '')
    .replace(/\d{4}-\d\d-\d\d[T ]\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:?\d\d)?/g, '')
    .replace(/\b\d+(\.\d+)?\s?(ms|s|sec|secs|seconds|m|min)\b/gi, '')
    .replace(/\b0x[0-9a-f]+\b|\b[0-9a-f]{7,}\b/gi, '')
    .replace(/[A-Za-z]:\\[^\s'"]*\\Temp\\[^\s'"]*|\/(?:var\/folders|tmp)\/[^\s'"]*/gi, '')
    .replace(/\s+/g, ' ').trim().slice(0, 300);
}

const oneLine = s => String(s || '').replace(/\s+/g, ' ').trim();
const clip = (s, n) => s.length > n ? s.slice(0, n - 1) + '…' : s;

// A repeat counts as evidence when nothing was edited in between (retrying unchanged), or on the third time
// whatever happened in between (fixes that don't change the failure). stuckTurns counts tool calls.
function createStuckTracker({ stuckTurns = 30 } = {}) {
  let seen, turns, fired, edits;
  const reset = () => { seen = new Map(); turns = 0; fired = false; edits = 0; };
  reset();
  // true once this key repeats with no edit since its last sighting, or reaches 3; each key fires once.
  const repeat = key => {
    const s = seen.get(key) || { n: 0, edits: -1, fired: false };
    s.n++;
    const hit = !s.fired && s.n >= 2 && (s.edits === edits || s.n >= 3);
    s.edits = edits;
    if (hit) s.fired = true;
    seen.set(key, s);
    return hit;
  };

  function onToolResult({ command, text, isError } = {}) {
    if (!isError) return null;
    const norm = normalise(text);
    const cmd = command ? oneLine(command) : '';
    if (cmd && repeat('c|' + cmd + '|' + norm)) {
      return { kind: 'command', reason: `the same command keeps failing: ${clip(cmd, 80)} → '${clip(norm, 100)}'` };
    }
    if (!cmd && norm && repeat('e|' + norm)) return { kind: 'error', reason: `the same error keeps coming back: '${clip(norm, 120)}'` };
    return null;
  }

  function onTurn() {
    if (!stuckTurns || fired) return null;
    if (++turns < stuckTurns) return null;
    fired = true;
    return { kind: 'progress', reason: `${turns} tool calls without editing a file` };
  }

  function onFileEdit() { turns = 0; fired = false; edits++; return null; }

  return { onToolResult, onTurn, onFileEdit, reset };
}

const api = { normalise, createStuckTracker };
if (typeof module !== 'undefined') module.exports = api; else globalThis.Stuck = api;
})();
