// Seats (2.7, phase 1): a named role with a stable id that outlives its worker. A seat holds its role, default tier,
// standing guidance and a small structured task state built from what the board already records, so a fresh worker
// takes over from a short brief, never the old conversation. Deterministic metadata only: no model calls, no
// transcripts. Stored per project as <project>/.operant/seats.json with a schema version.
// A seat's tier is its default unless the user (or an approved tier-up) says otherwise; nothing here raises one.
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./atomic-write');

const SCHEMA = 1;
const KINDS = ['normal', 'hard', 'master'];
const STATES = ['empty', 'active', 'idle-closed'];
const TIERS = ['free', 'xsmall', 'small', 'medium', 'high', 'max'];
const HISTORY_MAX = 20;
const CAPS = { decisions: [6, 160], constraints: [6, 160], files: [12, 120], verification: 300, lastError: 400, note: 300, guidance: 600 };

// id, role, kind, tier, guidance
const DEFAULTS = [
  ['planner', 'planner', 'normal', 'small', 'Plan before editing; keep steps few and checkable.'],
  ['implementer', 'implementer', 'normal', 'small', 'Make the change the plan names, nothing more.'],
  ['reviewer', 'reviewer', 'normal', 'small', 'Check the diff against the task; report problems, do not rewrite.'],
  ['explorer', 'explorer', 'normal', 'xsmall', 'Read and report; never edit.'],
  ['docs', 'docs', 'normal', 'xsmall', 'Docs and wording only.'],
  ['tester', 'tester', 'normal', 'xsmall', 'Run and write tests; report failures with the first error lines.'],
  ['hard-1', 'hard worker', 'hard', 'medium', 'Only the hard part; hand follow-up work back down.'],
  ['hard-2', 'hard worker', 'hard', 'medium', 'Only the hard part; hand follow-up work back down.'],
  ['lead', 'lead', 'master', 'small', 'Split the work, hand parts to seats, review what comes back.'],
];

const emptyTaskState = () => ({ decisions: [], constraints: [], files: [], verification: '', lastError: '', note: '' });
const oneLine = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const asList = v => (Array.isArray(v) ? v : v == null || v === '' ? [] : String(v).split(/\s*[;\n]\s*/)).map(x => oneLine(x, 1000)).filter(Boolean);
const capList = (v, [n, len]) => [...new Set(asList(v).map(x => x.slice(0, len)))].slice(-n);

function makeSeat([id, role, kind, tier, guidance], now = Date.now()) {
  return { id, role, kind, tier, guidance, state: 'empty', tileId: null, podId: null, history: [], taskState: emptyTaskState(), createdAt: now };
}
const defaultSeats = (now = Date.now()) => ({ schema: SCHEMA, seats: DEFAULTS.map(d => makeSeat(d, now)) });

// Tolerant of a hand-edited or older file: bad fields fall back, unknown seats are kept, missing defaults are added back.
function normalize(data, now = Date.now()) {
  const base = defaultSeats(now);
  if (!data || typeof data !== 'object' || !Array.isArray(data.seats)) return base;
  if (data.schema > SCHEMA) throw new Error(`seats.json is schema ${data.schema}, newer than this Operant understands (${SCHEMA})`);
  const seats = [];
  for (const raw of data.seats) {
    if (!raw || typeof raw.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(raw.id)) continue;
    const d = DEFAULTS.find(x => x[0] === raw.id);
    const s = makeSeat(d || [raw.id, raw.role || raw.id, 'normal', 'small', ''], Number(raw.createdAt) || now);
    if (KINDS.includes(raw.kind)) s.kind = raw.kind;
    if (typeof raw.role === 'string' && raw.role) s.role = raw.role;
    if (TIERS.includes(raw.tier)) s.tier = raw.tier;
    if (typeof raw.guidance === 'string') s.guidance = raw.guidance.slice(0, CAPS.guidance);
    if (STATES.includes(raw.state)) s.state = raw.state;
    s.tileId = raw.tileId == null ? null : raw.tileId;
    s.podId = raw.podId == null ? null : raw.podId;
    if (s.state !== 'active') s.tileId = null;
    if (Array.isArray(raw.history)) s.history = raw.history.filter(e => e && typeof e.event === 'string').slice(-HISTORY_MAX);
    s.taskState = capState({ ...emptyTaskState(), ...(raw.taskState || {}) });
    if (raw.boost && TIERS.includes(raw.boost.tier)) s.boost = { tier: raw.boost.tier, taskId: raw.boost.taskId ?? null };
    seats.push(s);
  }
  for (const s of base.seats) if (!seats.some(x => x.id === s.id)) seats.push(s);
  return { schema: SCHEMA, seats };
}

function capState(ts) {
  return {
    decisions: capList(ts.decisions, CAPS.decisions), constraints: capList(ts.constraints, CAPS.constraints), files: capList(ts.files, CAPS.files),
    verification: oneLine(ts.verification, CAPS.verification), lastError: lastLines(ts.lastError, CAPS.lastError), note: oneLine(ts.note, CAPS.note),
  };
}
// The last few lines of an error, whitespace kept per line, cut from the front so the end (the failure) survives.
function lastLines(text, cap) {
  const lines = String(text == null ? '' : text).split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(-5).join('\n');
  return lines.length > cap ? lines.slice(lines.length - cap) : lines;
}

// ---- storage: <project>/.operant/seats.json
const fileOf = dir => path.join(dir, '.operant', 'seats.json');
function load(dir, now = Date.now()) {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(fileOf(dir), 'utf8')); } catch {}
  return normalize(raw, now);
}
function save(dir, store) {
  fs.mkdirSync(path.join(dir, '.operant'), { recursive: true });
  writeFileAtomic(fileOf(dir), JSON.stringify(store, null, 2));
  return store;
}
// Load, change, save: fn(store) mutates and may return a value; the store is only written when fn does not throw.
function update(dir, fn, now = Date.now()) {
  const store = load(dir, now);
  const out = fn(store);
  save(dir, store);
  return out;
}

const find = (store, id) => store.seats.find(s => s.id === id) || null;
function need(store, id) {
  const s = find(store, id);
  if (!s) throw new Error(`no seat "${id}" (seats: ${store.seats.map(x => x.id).join(', ')})`);
  return s;
}
function log(seat, event, extra, now) {
  seat.history.push({ event, at: now, ...extra });
  if (seat.history.length > HISTORY_MAX) seat.history.splice(0, seat.history.length - HISTORY_MAX);
}

// ---- tier rule
// The tier a seat starts a worker on: the user's --tier, else a one-off boost the user approved, else the seat default.
function tierFor(seat, { tier } = {}) {
  if (tier) { if (!TIERS.includes(tier)) throw new Error(`unknown tier "${tier}"`); return tier; }
  return seat.boost ? seat.boost.tier : seat.tier;
}
// A hard seat is filled only when the user names it (--seat hard-1 counts) or a tier-up was approved; a normal or
// master seat is fine to fill by name. -> { ok, reason }
function canFill(seat, { userAsked = false, tierUpApproved = false } = {}) {
  if (seat.kind !== 'hard') return { ok: true };
  if (userAsked || tierUpApproved) return { ok: true };
  return { ok: false, reason: `seat ${seat.id} is a hard-worker seat: it is only filled when you ask for it or a tier-up is approved` };
}
// A one-off boost for a task the user or an approved tier-up moved up. Cleared when the seat is released.
function boost(store, id, tier, taskId = null) {
  if (!TIERS.includes(tier)) throw new Error(`unknown tier "${tier}"`);
  need(store, id).boost = { tier, taskId };
}
// Change the seat's own default (operant seat set --tier): the user's word, so allowed.
function setTier(store, id, tier) {
  if (!TIERS.includes(tier)) throw new Error(`unknown tier "${tier}" (${TIERS.join(', ')})`);
  const s = need(store, id); s.tier = tier; delete s.boost; return s;
}
function setGuidance(store, id, text) {
  const s = need(store, id); s.guidance = oneLine(text, CAPS.guidance); return s;
}

// ---- binding
// A worker takes the seat: recorded as seated, or replaced when another worker still held it.
function take(store, id, { tileId, podId = null, now = Date.now() } = {}) {
  if (tileId == null) throw new Error('a tile id is required to take a seat');
  const s = need(store, id);
  const prev = s.state === 'active' && s.tileId != null && s.tileId !== tileId ? s.tileId : null;
  s.state = 'active'; s.tileId = tileId; s.podId = podId;
  log(s, prev != null ? 'replaced' : 'seated', prev != null ? { tileId, was: prev } : { tileId }, now);
  return s;
}
// The seat's state after a task ends: what the board recorded, merged into what the seat already knew.
// task: the board task ({ checkpoint, check, note, failure, closedFrom, ... }); extra: { constraints, lastError, rejectNote }.
function taskStateFrom(task, prev = emptyTaskState(), extra = {}) {
  const t = task || {}, cp = t.checkpoint || {};
  const fails = t.check && t.check.ok === false ? t.check.summary : '';
  const verification = t.check ? `${t.check.ok ? 'passed' : 'failed'}: ${t.check.command || 'checks'}${t.check.summary ? ' - ' + oneLine(t.check.summary, 200) : ''}` : prev.verification;
  const note = extra.rejectNote ? `rejected: ${extra.rejectNote}` : t.note || prev.note;
  return capState({
    decisions: [...asList(prev.decisions), ...asList(cp.decisions)],
    constraints: [...asList(prev.constraints), ...asList(t.constraints), ...asList(extra.constraints)],
    files: [...asList(prev.files), ...asList(cp.files), ...asList(extra.files)],
    verification,
    lastError: extra.lastError || fails || (['failed', 'blocked'].includes(t.status) ? t.failure || t.note : '') || '',
    note: [note, cp.next ? `next: ${cp.next}` : ''].filter(Boolean).join(' · '),
  });
}
// The worker is gone (closed, finished, stopped at its token limit or compacted): keep the state, free the tile.
// reason: 'closed' | 'finished' | 'token-stop' | 'compacted' | 'crashed'. empty: true leaves the seat empty, else idle-closed.
// tileId, when given, makes it a no-op unless that tile still holds the seat (a replaced worker closing later must not evict its successor).
function release(store, id, { task, reason = 'closed', empty = false, extra, tileId, now = Date.now() } = {}) {
  const s = need(store, id);
  if (tileId != null && s.tileId !== tileId) return s;
  const was = s.tileId;
  if (task || extra) s.taskState = taskStateFrom(task, s.taskState, extra);
  s.state = empty ? 'empty' : 'idle-closed'; s.tileId = null;
  delete s.boost; // a one-off boost returns to the seat default
  log(s, 'closed', { reason, ...(was != null ? { tileId: was } : {}) }, now);
  return s;
}
// The worker stays (a compact): keep what the board knows now, note the event, leave the seat active.
function keep(store, id, { task, reason = 'compacted', extra, now = Date.now() } = {}) {
  const s = need(store, id);
  s.taskState = taskStateFrom(task, s.taskState, extra);
  log(s, reason, s.tileId != null ? { tileId: s.tileId } : {}, now);
  return s;
}
// The seat a tile holds, if any.
const seatOfTile = (store, tileId) => store.seats.find(s => s.state === 'active' && s.tileId === tileId) || null;

// The short brief a fresh worker starts from: standing guidance plus the kept state, no transcript.
function brief(seat) {
  const ts = seat.taskState || emptyTaskState();
  const lines = [`You hold the "${seat.id}" seat (${seat.role}).`];
  if (seat.guidance) lines.push(`Guidance: ${seat.guidance}`);
  const has = ts.decisions.length || ts.constraints.length || ts.files.length || ts.verification || ts.lastError || ts.note;
  if (has) {
    lines.push('A worker held this seat before you. Carry on from where it stopped:');
    if (ts.decisions.length) lines.push(`Decided: ${ts.decisions.join('; ')}`);
    if (ts.constraints.length) lines.push(`Constraints: ${ts.constraints.join('; ')}`);
    if (ts.files.length) lines.push(`Files touched: ${ts.files.join(', ')}`);
    if (ts.verification) lines.push(`Last verification: ${ts.verification}`);
    if (ts.lastError) lines.push(`Last error:\n${ts.lastError}`);
    if (ts.note) lines.push(`Note: ${ts.note}`);
  }
  return lines.join('\n');
}

// ---- CLI text
const pad = (s, n) => String(s).padEnd(n);
function formatTable(store) {
  const rows = store.seats.map(s => [s.id, s.role, s.kind, s.boost ? `${s.tier}>${s.boost.tier}` : s.tier, s.state, s.tileId == null ? '-' : String(s.tileId)]);
  const head = ['id', 'role', 'kind', 'tier', 'state', 'tile'];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
  const line = r => r.map((c, i) => pad(c, w[i])).join('  ').trimEnd();
  return [line(head), ...rows.map(line)].join('\n');
}
function formatSeat(seat) {
  const ts = seat.taskState;
  const L = [`${seat.id}  ${seat.role}  ${seat.kind}  tier ${seat.tier}${seat.boost ? ` (boosted to ${seat.boost.tier} for task ${seat.boost.taskId ?? '-'})` : ''}  ${seat.state}${seat.tileId != null ? ` in tile ${seat.tileId}` : ''}`];
  L.push(`guidance: ${seat.guidance || '-'}`);
  L.push(`decisions: ${ts.decisions.join('; ') || '-'}`, `constraints: ${ts.constraints.join('; ') || '-'}`, `files: ${ts.files.join(', ') || '-'}`);
  L.push(`verification: ${ts.verification || '-'}`, `last error: ${ts.lastError ? ts.lastError.replace(/\n/g, ' | ') : '-'}`, `note: ${ts.note || '-'}`);
  L.push('history:');
  if (!seat.history.length) L.push('  (none)');
  for (const e of seat.history.slice().reverse()) L.push(`  ${new Date(e.at).toISOString().slice(0, 19).replace('T', ' ')}  ${e.event}${e.tileId != null ? ` tile ${e.tileId}` : ''}${e.was != null ? ` (was ${e.was})` : ''}${e.reason ? ` (${e.reason})` : ''}`);
  return L.join('\n');
}

module.exports = {
  SCHEMA, KINDS, STATES, TIERS, HISTORY_MAX, CAPS, DEFAULTS, defaultSeats, normalize, load, save, update, fileOf, find, need,
  tierFor, canFill, boost, setTier, setGuidance, take, release, keep, taskStateFrom, seatOfTile, brief, formatTable, formatSeat, emptyTaskState,
};
