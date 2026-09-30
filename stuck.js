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

const short = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36) + ':' + s.length; };
const TEST_CMD = /\b(npm (run )?test|npm t|yarn test|pnpm test|jest|vitest|mocha|pytest|cargo test|go test|gradlew? test|mvn test|dotnet test|node --test|operant test)\b/i;
// The changed lines of a unified diff, hunk and file headers left out; and the same change undone.
const patchLines = text => String(text || '').split('\n').filter(l => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).map(l => l.trimEnd());
const reversed = lines => lines.map(l => (l[0] === '+' ? '-' : '+') + l.slice(1)).reverse();
// What a failing test run says, without the command: its failure lines, else the start of the output.
const failureOf = text => {
  const lines = String(text || '').split('\n').filter(l => /\b(not ok|FAIL|FAILED|AssertionError|Assertion|Error)\b|✗|✖/.test(l)).slice(0, 3);
  return normalise(lines.length ? lines.join(' ') : text).slice(0, 200);
};
const TEST_CYCLES = 3;

// A repeat counts as evidence when nothing was edited in between (retrying unchanged), or on the third time
// whatever happened in between (fixes that don't change the failure). stuckTurns counts tool calls.
function createStuckTracker({ stuckTurns = 30 } = {}) {
  let seen, turns, fired, edits, files, cycles;
  const reset = () => { seen = new Map(); turns = 0; fired = false; edits = 0; files = new Map(); cycles = new Map(); };
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
    let cycle = null;
    if (cmd && TEST_CMD.test(cmd)) {
      const sig = failureOf(text), c = cycles.get(sig) || { n: 0, edits: -1, fired: false };
      if (c.edits !== edits) { c.n++; c.edits = edits; }
      if (!c.fired && c.n >= TEST_CYCLES) { c.fired = true; cycle = { kind: 'test-cycle', reason: `${c.n} test runs with edits in between, and still failing the same way: '${clip(sig, 100)}'` }; }
      cycles.set(sig, c);
    }
    if (cmd && repeat('c|' + cmd + '|' + norm)) {
      return { kind: 'command', reason: `the same command keeps failing: ${clip(cmd, 80)} → '${clip(norm, 100)}'` };
    }
    if (cycle) return cycle;
    if (!cmd && norm && repeat('e|' + norm)) return { kind: 'error', reason: `the same error keeps coming back: '${clip(norm, 120)}'` };
    return null;
  }

  function onTurn() {
    if (!stuckTurns || fired) return null;
    if (++turns < stuckTurns) return null;
    fired = true;
    return { kind: 'progress', reason: `${turns} tool calls without editing a file` };
  }

  // An edit resets the no-progress count. With what it changed ({ file, before, after } for a replacement, after alone for
  // a whole-file write, or { patch } for a diff) it also spots the same change reverted and then applied again.
  function onFileEdit({ file, before, after, patch } = {}) {
    turns = 0; fired = false; edits++;
    let key, undo, name = file;
    if (patch != null) {
      const lines = patchLines(patch);
      if (!lines.length) return null;
      key = short(lines.join('\n')); undo = short(reversed(lines).join('\n')); name = name || 'the patch';
    } else {
      if (file == null || after == null) return null;
      const f0 = files.get(file) || {};
      if (before == null) { before = f0.content; f0.content = after; files.set(file, f0); }
      if (before == null || before === after) return null;
      key = short(before) + '>' + short(after); undo = short(after) + '>' + short(before);
    }
    const f = files.get(name) || {};
    const h = f.hist || (f.hist = { applied: new Set(), reverted: new Set(), fired: false });
    files.set(name, f);
    if (h.applied.has(undo)) h.reverted.add(undo);
    const again = h.reverted.has(key) && !h.fired;
    h.applied.add(key);
    if (!again) return null;
    h.fired = true;
    return { kind: 'edit-loop', reason: `the same edit to ${clip(oneLine(name), 80)} was reverted and then applied again` };
  }

  return { onToolResult, onTurn, onFileEdit, reset };
}

const api = { normalise, createStuckTracker };
if (typeof module !== 'undefined') module.exports = api; else globalThis.Stuck = api;
})();
