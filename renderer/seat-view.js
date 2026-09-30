(function () {
// Seat view helpers (2.7 UI): plain data in, plain data out, so the tile badge, the board's Seats view and the later office view all
// read a seat the same way. Seat records come from `seatOp list` (main.js); nothing here asks a model.
const STATE_LABEL = { active: 'active', idle: 'idle-closed', needs: 'needs input', restored: 'restored', empty: 'empty' };

// A seat's display state. needsInput: the board has a paused task or the tile is waiting on the user.
function seatState(seat, { needsInput = false } = {}) {
  if (needsInput) return 'needs';
  if (seat.state === 'active') return 'active';
  const last = (seat.history || [])[(seat.history || []).length - 1];
  if (seat.state === 'idle-closed') return last && last.event === 'restored' ? 'restored' : 'idle';
  return 'empty';
}

// How many times a new worker took over this seat (the history shows a worker seated again after the first one).
const TAKES = ['seated', 'replaced', 'adopted'];
const replacedCount = seat => Math.max(0, (seat.history || []).filter(e => TAKES.includes(e.event)).length - 1);

// The one line under a seat's tier: why it starts on that tier. seat.effTier is the tier tierFor() gave it (main.js list op).
function tierWhy(seat) {
  const tier = seat.effTier || seat.tier;
  if (seat.boost) return `moved to ${seat.boost.tier} for ${seat.boost.taskId != null ? `task #${seat.boost.taskId}` : 'one task'} on your word; goes back to ${seat.tier} when it closes`;
  if (seat.kind === 'hard') return 'hard-worker seat: pinned to medium, filled only when you ask or a tier-up is approved, then empty again';
  if (seat.kind === 'master') return `master seat: it routes and hands work out, so ${tier} is enough`;
  if (tier !== seat.tier) return `${seat.tier} by default, ${tier} under the team norms preset (cheapest tier that fits)`;
  return `default for a ${seat.role}: the cheapest tier that fits`;
}

// Seats of one project laid out for the board: pods first (in order), then seats in no pod. Tasks belong to the seat they name.
function groupBySeat({ seats = [], pods = [] }, tasks = [], isOpen = () => true) {
  const byId = new Map(seats.map(s => [s.id, s]));
  const cards = new Map(seats.map(s => [s.id, { seat: s, open: [], closed: 0 }]));
  for (const t of tasks) {
    const c = t.seat && cards.get(t.seat);
    if (!c) continue;
    if (isOpen(t)) c.open.push(t); else c.closed++;
  }
  const seen = new Set(), groups = [];
  for (const p of pods) {
    const ids = (p.seatIds || []).filter(id => byId.has(id));
    ids.forEach(id => seen.add(id));
    if (ids.length) groups.push({ pod: p, cards: ids.map(id => cards.get(id)) });
  }
  const rest = seats.filter(s => !seen.has(s.id)).map(s => cards.get(s.id));
  if (rest.length) groups.push({ pod: null, cards: rest });
  return groups;
}

const api = { STATE_LABEL, seatState, replacedCount, tierWhy, groupBySeat };
if (typeof module !== 'undefined') module.exports = api; else globalThis.SeatView = api;
})();
