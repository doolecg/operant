(function () {
// Typing guard: a message for a tile the user is typing in waits until they stop (hold) or is refused. Pure logic, no model calls.
// Only keystrokes from the user count; terminal replies (focus reports, cursor answers) and agent-driven writes do not.

// Whether a chunk from the terminal's onData is something the user typed, not an automatic escape reply.
function isUserKey(data) {
  const d = String(data ?? '');
  if (!d) return false;
  if (d === '\x1b') return true;
  if (/^\x1b\[[\d;?]*[ -\/]*[@-~]$/.test(d) || /^\x1bO[A-Za-z]$/.test(d)) return /^\x1b\[[\d;]*[ABCDHF~]$|^\x1bO[A-D]$/.test(d);
  return true;
}

// `lastKey` is when the user last typed in the tile (ms), `seconds` the idle window; 0 turns the guard off.
const isTyping = (lastKey, seconds, now = Date.now()) => !!lastKey && seconds > 0 && now - lastKey < seconds * 1000;
const msLeft = (lastKey, seconds, now = Date.now()) => isTyping(lastKey, seconds, now) ? lastKey + seconds * 1000 - now : 0;

const REFUSED = (id, seconds) => `not sent: you are typing in tile ${id} right now (keystrokes in the last ${seconds}s): try again in a moment (Settings › Agents › Message for a tile you are typing in)`;

// What to do with a message for a tile: 'deliver', 'hold' or 'refuse'.
function decide({ mode, seconds, lastKey, now = Date.now() }) {
  if (!isTyping(lastKey, seconds, now)) return 'deliver';
  return mode === 'refuse' ? 'refuse' : 'hold';
}

const api = { isUserKey, isTyping, msLeft, decide, REFUSED };
if (typeof module !== 'undefined') module.exports = api; else globalThis.TypingGuard = api;
})();
