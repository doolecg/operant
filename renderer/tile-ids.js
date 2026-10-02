(function () {
// Tile ids: a new tile takes the lowest id that is free, so the numbers on tiles stay small in a long session.
// An id is free when no live tile has it, its last tile closed at least holdMs ago (an agent that just ran
// `operant read 12` must not reach a different tile), and nothing else still refers to it.
const ID_HOLD_MS = 5 * 60 * 1000;

// Pure: the lowest id >= 1 that is not in use, not held, and not referenced.
// inUse: Set of ids; released: Map id -> closedAt (ms); isReferenced: id -> boolean.
function lowestFreeId({ inUse = new Set(), released = new Map(), isReferenced = () => false, now = Date.now(), holdMs = ID_HOLD_MS } = {}) {
  for (let id = 1; ; id++) {
    if (inUse.has(id)) continue;
    const closedAt = released.get(id);
    if (closedAt != null && now - closedAt < holdMs) continue;
    if (isReferenced(id)) continue;
    return id;
  }
}

function createIdPool({ holdMs = ID_HOLD_MS, now = Date.now } = {}) {
  const active = new Set();
  const released = new Map();
  return {
    take(isReferenced) {
      const t = now();
      const id = lowestFreeId({ inUse: active, released, isReferenced, now: t, holdMs });
      released.delete(id);
      active.add(id);
      return id;
    },
    release(id) {
      if (!active.delete(id)) return;
      const t = now();
      released.set(id, t);
      for (const [k, at] of released) if (t - at >= holdMs && k !== id) released.delete(k);
    },
    has: id => active.has(id),
  };
}

const api = { createIdPool, lowestFreeId, ID_HOLD_MS };
if (typeof module !== 'undefined') module.exports = api; else globalThis.TileIds = api;
})();
