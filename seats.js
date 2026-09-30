// Seats (2.7, phase 1): a named role with a stable id that outlives its worker. A seat holds its role, default tier,
// standing guidance and a small structured task state built from what the board already records, so a fresh worker
// takes over from a short brief, never the old conversation. Deterministic metadata only: no model calls, no
// transcripts. Stored per project as <project>/.operant/seats.json with a schema version.
// A seat's tier is its default unless the user (or an approved tier-up) says otherwise; nothing here raises one.
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./atomic-write');
const { readyCheck } = require('./ready-check');
const { redactSecrets } = require('./redact');

const SCHEMA = 1;
const KINDS = ['normal', 'hard', 'master'];
const STATES = ['empty', 'active', 'idle-closed'];
const TIERS = ['free', 'xsmall', 'small', 'medium', 'high', 'max'];
const HISTORY_MAX = 20;
const DELEGATIONS_MAX = 30;
const DROP_BACK_TIER = 'small'; // where follow-up work goes after a hard (medium) part
const CAPS = { decisions: [6, 160], constraints: [6, 160], files: [12, 120], verification: 300, lastError: 400, note: 300, guidance: 600, podBrief: 1500, podName: 60 };

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
  ['master-opencode', 'OpenCode master', 'master', 'free', 'Take the work for OpenCode, hand parts to seats on the cheapest tier that fits.'],
];

// Pods (2.7): seats that share one brief (project facts, rules), stored once here and referenced by id.
// id, name, brief, seatIds (briefs start empty: the user fills them with operant pod set)
const DEFAULT_PODS = [
  ['feature', 'feature', '', ['planner', 'implementer', 'reviewer', 'tester']],
  ['research', 'research', '', ['explorer', 'docs']],
];
const defaultPods = () => DEFAULT_PODS.map(([id, name, brief, seatIds]) => ({ id, name, brief, seatIds: [...seatIds] }));

const emptyTaskState = () => ({ decisions: [], constraints: [], files: [], verification: '', lastError: '', note: '' });
const oneLine = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const asList = v => (Array.isArray(v) ? v : v == null || v === '' ? [] : String(v).split(/\s*[;\n]\s*/)).map(x => oneLine(x, 1000)).filter(Boolean);
const capList = (v, [n, len]) => [...new Set(asList(v).map(x => x.slice(0, len)))].slice(-n);

function makeSeat([id, role, kind, tier, guidance], now = Date.now()) {
  return { id, role, kind, tier, guidance, state: 'empty', tileId: null, podId: null, history: [], taskState: emptyTaskState(), ...(kind === 'master' ? { delegations: [] } : {}), createdAt: now };
}
// A master's delegations: the seats and tasks it handed work to, newest kept.
function normalizeDelegations(raw) {
  const out = [];
  for (const d of Array.isArray(raw) ? raw : []) {
    if (!d || d.taskId == null || out.some(x => x.taskId === d.taskId)) continue;
    out.push({ seatId: typeof d.seatId === 'string' && d.seatId ? d.seatId : null, taskId: d.taskId });
  }
  return out.slice(-DELEGATIONS_MAX);
}
const defaultSeats = (now = Date.now()) => ({ schema: SCHEMA, seats: DEFAULTS.map(d => makeSeat(d, now)), pods: defaultPods(), removed: [] });

// Tolerant of a hand-edited or older file: bad fields fall back, unknown seats are kept, missing defaults are added back.
function normalize(data, now = Date.now()) {
  const base = defaultSeats(now);
  if (!data || typeof data !== 'object' || !Array.isArray(data.seats)) return base;
  if (data.schema > SCHEMA) throw new Error(`seats.json is schema ${data.schema}, newer than this Operant understands (${SCHEMA})`);
  const seats = [], removed = (Array.isArray(data.removed) ? data.removed : []).filter(x => typeof x === 'string');
  for (const raw of data.seats) {
    if (!raw || typeof raw.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(raw.id)) continue;
    if (removed.includes(raw.id)) continue;
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
    if (typeof raw.readyFor === 'string' && raw.readyFor && s.state !== 'active') s.readyFor = oneLine(raw.readyFor, 60);
    if (Number(raw.budget) > 0) s.budget = Math.floor(Number(raw.budget));
    if (raw.boost && TIERS.includes(raw.boost.tier)) s.boost = { tier: raw.boost.tier, taskId: raw.boost.taskId ?? null };
    if (s.kind === 'master') s.delegations = normalizeDelegations(raw.delegations); else delete s.delegations;
    seats.push(s);
  }
  for (const s of base.seats) if (!seats.some(x => x.id === s.id) && !removed.includes(s.id)) seats.push(s);
  return { schema: SCHEMA, seats, pods: normalizePods(data.pods, seats), removed: removed.filter(id => !seats.some(x => x.id === id)) };
}

// Pods: bad entries dropped, a member that is no seat dropped, the default pods added back when missing.
function normalizePods(raw, seats) {
  const ids = new Set(seats.map(s => s.id)), pods = [];
  for (const p of Array.isArray(raw) ? raw : []) {
    if (!p || typeof p.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(p.id) || pods.some(x => x.id === p.id)) continue;
    const seatIds = [...new Set((Array.isArray(p.seatIds) ? p.seatIds : []).filter(x => ids.has(x)))];
    pods.push({ id: p.id, name: oneLine(p.name || p.id, CAPS.podName), brief: String(p.brief == null ? '' : p.brief).trim().slice(0, CAPS.podBrief), seatIds });
  }
  for (const d of defaultPods()) if (!pods.some(x => x.id === d.id)) pods.push({ ...d, seatIds: d.seatIds.filter(x => ids.has(x)) });
  return pods;
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
// norms (norms.js profile, optional): "exploratory" prefers the cheapest tier for ordinary seats; it never touches a hard seat or a seat the user set.
function tierFor(seat, { tier, norms } = {}) {
  if (tier) { if (!TIERS.includes(tier)) throw new Error(`unknown tier "${tier}"`); return tier; }
  if (seat.boost) return seat.boost.tier;
  return norms && norms.preferCheap && seat.kind === 'normal' && seat.tier === 'small' ? 'xsmall' : seat.tier;
}
// A seat is pinned to medium when its default is medium (every hard seat) or a boost put it there.
const isPinnedMedium = seat => seat.tier === 'medium' || (!!seat.boost && seat.boost.tier === 'medium');
// Follow-up after a hard part goes back down: a suggestion recorded on the task, never a silent continue on medium.
function dropBack(seat) {
  if (seat.kind !== 'hard' && !isPinnedMedium(seat)) return null;
  return `drop back: the hard part is done; do follow-up work (tests, docs, cleanup) on ${DROP_BACK_TIER}, not medium (seat ${seat.id} is empty again)`;
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

// ---- pods
const findPod = (store, id) => (store.pods || []).find(p => p.id === id) || null;
function needPod(store, id) {
  const p = findPod(store, id);
  if (!p) throw new Error(`no pod "${id}" (pods: ${(store.pods || []).map(x => x.id).join(', ')})`);
  return p;
}
// The pod a seat belongs to: the one it was bound to, else the first pod listing it.
function podOf(store, seatId) {
  const s = find(store, seatId);
  return (s && s.podId && findPod(store, s.podId)) || (store.pods || []).find(p => p.seatIds.includes(seatId)) || null;
}
// The shared brief is edited in one place; seats never carry a copy.
function setPodBrief(store, id, text) {
  const p = needPod(store, id); p.brief = String(text == null ? '' : text).trim().slice(0, CAPS.podBrief); return p;
}
// What a worker launched into a seat starts from: a one-line reference to its pod, the pod brief text once, then the seat brief.
function launchBrief(store, seatId) {
  const seat = need(store, seatId), pod = podOf(store, seatId);
  if (!pod || !pod.brief) return brief(seat);
  return [`Pod "${pod.id}" (${pod.seatIds.join(', ')}) shares the brief below; it is the same for every seat in it.`, pod.brief, '', brief(seat)].join('\n');
}

// ---- binding
// A worker takes the seat: recorded as seated, or replaced when another worker still held it.
function take(store, id, { tileId, podId, now = Date.now() } = {}) {
  if (tileId == null) throw new Error('a tile id is required to take a seat');
  const s = need(store, id);
  const prev = s.state === 'active' && s.tileId != null && s.tileId !== tileId ? s.tileId : null;
  s.state = 'active'; s.tileId = tileId; s.podId = podId !== undefined ? podId : (podOf(store, id) || {}).id || null; delete s.readyFor;
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
  if (s.kind === 'hard') empty = true; // a hard seat returns to empty (idle cost zero) once its part is done
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

// A master seat handed a task to a seat (or, with none named, to a worker or subagent): recorded on the master. Only master seats keep them.
function delegate(store, masterId, { seatId = null, taskId } = {}) {
  const m = need(store, masterId);
  if (m.kind !== 'master') throw new Error(`seat ${masterId} is not a master seat`);
  if (taskId == null) throw new Error('a task id is required');
  m.delegations = normalizeDelegations([...(m.delegations || []).filter(d => d.taskId !== taskId), { seatId, taskId }]);
  return m;
}

// ---- grow and shrink: add a seat, remove one (a removed default stays gone), close the ones idle too long.
const SEAT_ID = /^[a-z0-9][a-z0-9-]*$/;
function addSeat(store, { id, role, tier, kind = 'normal', now = Date.now() } = {}) {
  if (!id || !SEAT_ID.test(id)) throw new Error('a seat id is lowercase letters, digits and dashes (operant seat add <id> --role <role> --tier <tier> --kind <kind>)');
  if (find(store, id)) throw new Error(`seat "${id}" already exists`);
  if (!KINDS.includes(kind)) throw new Error(`unknown kind "${kind}" (${KINDS.join(', ')})`);
  const t = tier || (kind === 'hard' ? 'medium' : 'small');
  if (!TIERS.includes(t)) throw new Error(`unknown tier "${t}" (${TIERS.join(', ')})`);
  const seat = makeSeat([id, role ? oneLine(role, 60) : id, kind, t, ''], now);
  store.seats.push(seat);
  store.removed = (store.removed || []).filter(x => x !== id);
  return seat;
}
// Refuses a seat that is active. A hard or master default goes only with force. Its delegations and pod memberships go with it.
function removeSeat(store, id, { force = false } = {}) {
  const s = need(store, id);
  if (s.state === 'active') throw new Error(`seat ${id} is active${s.tileId != null ? ` in tile ${s.tileId}` : ''}: close its worker first`);
  if (!force && DEFAULTS.some(d => d[0] === id && d[2] !== 'normal')) throw new Error(`seat ${id} is a default ${s.kind} seat: removing it needs --force`);
  store.seats = store.seats.filter(x => x.id !== id);
  for (const p of store.pods || []) p.seatIds = p.seatIds.filter(x => x !== id);
  for (const m of store.seats) if (m.delegations) m.delegations = m.delegations.filter(d => d.seatId !== id);
  if (DEFAULTS.some(d => d[0] === id)) store.removed = [...new Set([...(store.removed || []), id])];
  return s;
}

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
  const rows = store.seats.map(s => [s.id, s.role, s.kind, (s.boost ? `${s.tier}>${s.boost.tier}` : s.tier) + (isPinnedMedium(s) ? ' (pinned)' : ''), s.state, s.tileId == null ? '-' : String(s.tileId)]);
  const head = ['id', 'role', 'kind', 'tier', 'state', 'tile'];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
  const line = r => r.map((c, i) => pad(c, w[i])).join('  ').trimEnd();
  return [line(head), ...rows.map(line)].join('\n');
}
function formatSeat(seat) {
  const ts = seat.taskState;
  const L = [`${seat.id}  ${seat.role}  ${seat.kind}  tier ${seat.tier}${isPinnedMedium(seat) ? ' (pinned to medium)' : ''}${seat.boost ? ` (boosted to ${seat.boost.tier} for task ${seat.boost.taskId ?? '-'})` : ''}  ${seat.state}${seat.tileId != null ? ` in tile ${seat.tileId}` : ''}`];
  L.push(`guidance: ${seat.guidance || '-'}`);
  if (seat.kind === 'master') L.push(`delegates to: ${(seat.delegations || []).map(d => `${d.seatId || 'worker'} (task ${d.taskId})`).join(', ') || '-'}`);
  L.push(`decisions: ${ts.decisions.join('; ') || '-'}`, `constraints: ${ts.constraints.join('; ') || '-'}`, `files: ${ts.files.join(', ') || '-'}`);
  L.push(`verification: ${ts.verification || '-'}`, `last error: ${ts.lastError ? ts.lastError.replace(/\n/g, ' | ') : '-'}`, `note: ${ts.note || '-'}`);
  L.push('history:');
  if (!seat.history.length) L.push('  (none)');
  for (const e of seat.history.slice().reverse()) L.push(`  ${new Date(e.at).toISOString().slice(0, 19).replace('T', ' ')}  ${e.event}${e.tileId != null ? ` tile ${e.tileId}` : ''}${e.was != null ? ` (was ${e.was})` : ''}${e.reason ? ` (${e.reason})` : ''}`);
  return L.join('\n');
}

function formatPods(store) {
  const pods = store.pods || [];
  if (!pods.length) return '(no pods)';
  return pods.map(p => `${p.id}  ${p.name}  seats: ${p.seatIds.join(', ') || '-'}\n  brief: ${p.brief ? oneLine(p.brief, 200) : '-'}`).join('\n');
}

// ---- team templates: small JSON in the user data dir; the shipped defaults sit beneath what the user saved
// {name, seats:[{seat, tier, budget?}], podBriefs:{podId: text}}. Defaults use the cheapest tier that fits and no medium seat.
const DEFAULT_TEMPLATES = [
  { name: 'feature team', seats: [{ seat: 'planner', tier: 'small' }, { seat: 'implementer', tier: 'small' }, { seat: 'reviewer', tier: 'xsmall' }, { seat: 'tester', tier: 'free' }], podBriefs: {} },
  { name: 'review team', seats: [{ seat: 'reviewer', tier: 'xsmall' }, { seat: 'explorer', tier: 'free' }, { seat: 'tester', tier: 'free' }], podBriefs: {} },
];
const templatesFile = userDir => path.join(userDir, 'team-templates.json');
function normalizeTemplate(raw) {
  if (!raw || typeof raw.name !== 'string' || !oneLine(raw.name, 60) || !Array.isArray(raw.seats)) return null;
  const seats = [];
  for (const e of raw.seats) {
    if (!e || typeof e.seat !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(e.seat) || seats.some(x => x.seat === e.seat)) continue;
    const o = { seat: e.seat, tier: TIERS.includes(e.tier) ? e.tier : 'small' };
    if (Number(e.budget) > 0) o.budget = Math.floor(Number(e.budget));
    seats.push(o);
  }
  const podBriefs = {};
  if (raw.podBriefs && typeof raw.podBriefs === 'object') for (const [k, v] of Object.entries(raw.podBriefs)) if (typeof v === 'string' && v.trim()) podBriefs[k] = v.trim().slice(0, CAPS.podBrief);
  return { name: oneLine(raw.name, 60), seats, podBriefs };
}
function savedTemplates(userDir) {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(templatesFile(userDir), 'utf8')); } catch {}
  return (Array.isArray(raw && raw.templates) ? raw.templates : []).map(normalizeTemplate).filter(Boolean);
}
// Defaults first, then the user's; a saved template with a default's name replaces it.
function loadTemplates(userDir) {
  const mine = savedTemplates(userDir), key = n => n.toLowerCase();
  return [...DEFAULT_TEMPLATES.filter(d => !mine.some(m => key(m.name) === key(d.name))).map(normalizeTemplate), ...mine];
}
const findTemplate = (list, name) => list.find(t => t.name.toLowerCase() === String(name).trim().toLowerCase()) || null;
function saveTemplate(userDir, tpl) {
  const t = normalizeTemplate(tpl);
  if (!t) throw new Error('a template needs a name and a seats list');
  const mine = savedTemplates(userDir).filter(x => x.name.toLowerCase() !== t.name.toLowerCase());
  fs.mkdirSync(userDir, { recursive: true });
  writeFileAtomic(templatesFile(userDir), JSON.stringify({ schema: SCHEMA, templates: [...mine, t] }, null, 2));
  return t;
}
// A template from the seats in use now (any seat that is not empty): their tiers, budgets and their pods' briefs.
function templateFromSeats(store, name) {
  const used = store.seats.filter(s => s.state !== 'empty');
  if (!used.length) throw new Error('no seats are in use: nothing to save as a template');
  const podBriefs = {};
  for (const s of used) { const p = podOf(store, s.id); if (p && p.brief) podBriefs[p.id] = p.brief; }
  return { name, seats: used.map(s => ({ seat: s.id, tier: s.tier, ...(s.budget ? { budget: s.budget } : {}) })), podBriefs };
}
// Mark a template's seats ready to fill (tier and budget applied, pod briefs set). Launches nothing. -> { ready, skipped }
function startTemplate(store, tpl) {
  const ready = [], skipped = [];
  for (const e of tpl.seats) {
    const s = find(store, e.seat);
    if (!s) { skipped.push(`${e.seat} (no such seat)`); continue; }
    if (s.state === 'active') { skipped.push(`${e.seat} (already active)`); continue; }
    s.tier = e.tier; delete s.boost;
    if (e.budget) s.budget = e.budget; else delete s.budget;
    s.readyFor = tpl.name;
    ready.push(e.seat);
  }
  for (const [id, text] of Object.entries(tpl.podBriefs || {})) { const p = findPod(store, id); if (p) p.brief = text.slice(0, CAPS.podBrief); }
  return { ready, skipped };
}
// ---- adopt: attach a tile that is already running to a seat, without restarting it or sending it anything.
// tile: { id, alive, agent (a Claude Code or Codex tile), seatId }. userAsked: the user named the seat (a worker adopting a hard seat does not count).
function adopt(store, id, tile, { userAsked = false, now = Date.now() } = {}) {
  const s = need(store, id);
  if (!tile || tile.id == null) throw new Error('a tile id is required (--tile <id>)');
  if (!tile.alive) throw new Error(`tile ${tile.id} is not running`);
  if (!tile.agent) throw new Error(`tile ${tile.id} is not a Claude Code or Codex tile`);
  const held = tile.seatId || (seatOfTile(store, tile.id) || {}).id;
  if (held) throw new Error(`tile ${tile.id} already holds seat ${held}`);
  if (s.state === 'active' && s.tileId != null) throw new Error(`seat ${id} is already held by tile ${s.tileId}`);
  const can = canFill(s, { userAsked });
  if (!can.ok) throw new Error(can.reason);
  s.state = 'active'; s.tileId = tile.id; s.podId = (podOf(store, id) || {}).id || null; delete s.readyFor;
  log(s, 'adopted', { tileId: tile.id }, now);
  return s;
}

// ---- snapshots: a team saved by name in the user data dir. State only: no transcripts, no prompt text, no tile ids.
const SNAPSHOT_SCHEMA = 1;
const UNFINISHED = ['todo', 'planning', 'doing', 'waiting', 'recovery', 'verifying', 'paused', 'blocked'];
const snapshotDir = userDir => path.join(userDir, 'team-snapshots');
const snapshotSlug = name => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
function snapshotFile(userDir, name) {
  const slug = snapshotSlug(name);
  if (!slug) throw new Error('a snapshot needs a name');
  return path.join(snapshotDir(userDir), `${slug}.json`);
}
const budgetOf = v => (typeof v === 'number' && v > 0 ? Math.floor(v) : v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : undefined);
// tasks: the board's tasks; only those tied to a seat are kept. Keys and text that look like secrets are redacted (redact.js).
function snapshotOf(store, { name, tasks = [], now = Date.now() } = {}) {
  const blank = JSON.stringify(emptyTaskState());
  const used = s => s.state !== 'empty' || s.readyFor || s.budget || JSON.stringify(s.taskState) !== blank;
  const seats = store.seats.filter(used).map(s => {
    const pod = podOf(store, s.id);
    return { id: s.id, role: s.role, kind: s.kind, state: s.state, tier: s.tier, podId: pod ? pod.id : null,
      ...(s.boost ? { boost: s.boost } : {}), ...(s.budget ? { budget: s.budget } : {}), ...(s.readyFor ? { readyFor: s.readyFor } : {}), taskState: s.taskState };
  });
  const ids = new Set(seats.map(s => s.id)), podIds = new Set(seats.map(s => s.podId).filter(Boolean));
  const pods = (store.pods || []).filter(p => podIds.has(p.id) || p.brief).map(p => ({ id: p.id, name: p.name, brief: p.brief, seatIds: [...p.seatIds] }));
  const kept = tasks.filter(t => t && t.seat && ids.has(t.seat)).map(t => {
    const cp = t.checkpoint, b = budgetOf(t.budget);
    return {
      id: t.id, seat: t.seat, status: t.status, text: oneLine(t.text, 300), ...(t.tier ? { tier: t.tier } : {}), ...(b !== undefined ? { budget: b } : {}),
      ...(cp ? { checkpointId: `${t.id}:${cp.at || 0}`, checkpoint: { decisions: cp.decisions || [], files: cp.files || [], next: cp.next || '', at: cp.at || 0 } } : {}),
      ...((t.actions || []).length ? { actions: t.actions.map(a => ({ cmd: oneLine(a.cmd, 240), at: a.at || 0 })) } : {}),
    };
  });
  return redactSecrets({ schema: SNAPSHOT_SCHEMA, name: oneLine(name, 60), at: now, seats, pods, tasks: kept });
}
function saveSnapshot(userDir, snap) {
  const file = snapshotFile(userDir, snap.name);
  fs.mkdirSync(snapshotDir(userDir), { recursive: true });
  writeFileAtomic(file, JSON.stringify(snap, null, 2));
  return file;
}
// An unknown or newer schema is refused with a clear message, never guessed at.
function parseSnapshot(raw, label) {
  if (!raw || typeof raw !== 'object' || !Number.isInteger(raw.schema) || raw.schema < 1 || !Array.isArray(raw.seats)) throw new Error(`snapshot ${label} has an unknown format and was not restored`);
  if (raw.schema > SNAPSHOT_SCHEMA) throw new Error(`snapshot ${label} is schema ${raw.schema}, newer than this Operant understands (${SNAPSHOT_SCHEMA}); update Operant to restore it`);
  return raw;
}
function loadSnapshot(userDir, name) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(snapshotFile(userDir, name), 'utf8')); }
  catch (e) { throw new Error(e.code === 'ENOENT' ? `no snapshot "${name}" (operant team snapshots)` : `snapshot "${name}" could not be read`); }
  return parseSnapshot(raw, `"${name}"`);
}
function listSnapshots(userDir) {
  let files = [];
  try { files = fs.readdirSync(snapshotDir(userDir)).filter(f => f.endsWith('.json')); } catch {}
  return files.map(f => {
    const fallback = f.replace(/\.json$/, '');
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(snapshotDir(userDir), f), 'utf8'));
      if (!raw || !Number.isInteger(raw.schema) || raw.schema < 1 || !Array.isArray(raw.seats)) return { name: fallback, unreadable: true };
      return { name: raw.name || fallback, at: raw.at || 0, seats: raw.seats.length, tasks: (raw.tasks || []).length, ...(raw.schema > SNAPSHOT_SCHEMA ? { newer: true } : {}) };
    } catch { return { name: fallback, unreadable: true }; }
  }).sort((a, b) => (b.at || 0) - (a.at || 0));
}
const formatSnapshots = list => (list.length
  ? list.map(s => s.unreadable ? `${s.name}  (unreadable)` : `${s.name}  ${new Date(s.at).toISOString().slice(0, 16).replace('T', ' ')}  ${s.seats} seats, ${s.tasks} tasks${s.newer ? '  (newer format: cannot be restored here)' : ''}`).join('\n')
  : '(no snapshots; operant team snapshot <name>)');
// Rebuild the seats from a snapshot. Never launches a worker: a restored seat is idle-closed (or empty) and a hard seat is left for the
// user to fill. Unfinished tasks come back as `requeue` (todo, no owner); a finished one, one in review, or one already on the board does not.
// Destructive commands a task already ran travel with it, so the board's guard still blocks them.
// -> { results: [{ seat, result: 'restored' | 'needs input' | 'failed', reason? }], requeue: [task] }
function restoreSnapshot(store, snap, { boardTasks = [], now = Date.now() } = {}) {
  parseSnapshot(snap, snap && snap.name ? `"${snap.name}"` : '');
  const results = [], requeue = [], plural = n => `${n} task${n === 1 ? '' : 's'}`;
  for (const pod of (snap.pods || []).filter(p => p && typeof p.id === 'string')) {
    const cur = findPod(store, pod.id);
    if (cur) cur.brief = String(pod.brief || '').trim().slice(0, CAPS.podBrief);
    else store.pods = normalizePods([...(store.pods || []), pod], store.seats);
  }
  for (const e of snap.seats) {
    if (!e || typeof e.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(e.id)) { results.push({ seat: e && e.id ? String(e.id) : '?', result: 'failed', reason: 'the saved seat has no valid id' }); continue; }
    let s = find(store, e.id);
    if (s && s.state === 'active' && s.tileId != null) { results.push({ seat: e.id, result: 'needs input', reason: `it is held by tile ${s.tileId} right now; release it first` }); continue; }
    if (!s) { s = makeSeat([e.id, e.role || e.id, KINDS.includes(e.kind) ? e.kind : 'normal', 'small', ''], now); store.seats.push(s); }
    if (TIERS.includes(e.tier)) s.tier = e.tier;
    if (KINDS.includes(e.kind)) s.kind = e.kind;
    s.taskState = capState({ ...emptyTaskState(), ...(e.taskState || {}) });
    if (Number(e.budget) > 0) s.budget = Math.floor(Number(e.budget)); else delete s.budget;
    if (e.boost && TIERS.includes(e.boost.tier)) s.boost = { tier: e.boost.tier, taskId: e.boost.taskId ?? null }; else delete s.boost;
    s.podId = e.podId && findPod(store, e.podId) ? e.podId : null;
    delete s.readyFor; if (typeof e.readyFor === 'string' && e.readyFor) s.readyFor = oneLine(e.readyFor, 60);
    s.tileId = null; s.state = e.state === 'empty' ? 'empty' : 'idle-closed';
    log(s, 'restored', {}, now);
    const mine = (snap.tasks || []).filter(t => t && t.seat === e.id && UNFINISHED.includes(t.status));
    let queued = 0;
    for (const t of mine) {
      const text = oneLine(t.text, 300), b = budgetOf(t.budget);
      if (!text || boardTasks.some(x => x.seat === e.id && x.text === text && !['done', 'cancelled', 'failed'].includes(x.status)) || requeue.some(x => x.seat === e.id && x.text === text)) continue;
      requeue.push({ text, seat: e.id, status: 'todo', ...(TIERS.includes(t.tier) ? { tier: t.tier } : {}), ...(b !== undefined ? { budget: b } : {}),
        ...(t.checkpoint ? { checkpoint: { decisions: asList(t.checkpoint.decisions), files: asList(t.checkpoint.files), next: oneLine(t.checkpoint.next, 200), at: Number(t.checkpoint.at) || 0 } } : {}),
        ...(Array.isArray(t.actions) && t.actions.length ? { actions: t.actions.map(a => ({ cmd: oneLine(a.cmd, 240), at: Number(a.at) || 0 })) } : {}) });
      queued++;
    }
    if (s.kind === 'hard' && mine.length) results.push({ seat: e.id, result: 'needs input', reason: `hard-worker seat, not launched; ${plural(queued)} queued for when you fill it (operant agent --seat ${e.id})` });
    else if (e.state === 'active') results.push({ seat: e.id, result: 'needs input', reason: `it had a worker when saved; ${plural(queued)} re-queued, fill it to carry on (operant agent --seat ${e.id})` });
    else results.push({ seat: e.id, result: 'restored', ...(queued ? { reason: `${plural(queued)} re-queued` } : {}) });
  }
  return { results, requeue };
}
const formatRestore = (name, r) => [`restored "${name}":`, ...r.results.map(x => `  ${x.seat}: ${x.result}${x.reason ? ` - ${x.reason}` : ''}`), `${r.requeue.length} task${r.requeue.length === 1 ? '' : 's'} re-queued on the board (nothing launched)`].join('\n');

const formatTemplates = list => list.map(t => `${t.name}  ${t.seats.map(e => `${e.seat} ${e.tier}${e.budget ? ` (${e.budget})` : ''}`).join(', ')}`).join('\n');

module.exports = {
  SCHEMA, KINDS, STATES, TIERS, HISTORY_MAX, CAPS, DEFAULTS, defaultSeats, normalize, load, save, update, fileOf, find, need,
  DEFAULT_PODS, defaultPods, findPod, needPod, podOf, setPodBrief, launchBrief, formatPods, DEFAULT_TEMPLATES, templatesFile, normalizeTemplate,
  loadTemplates, findTemplate, saveTemplate, templateFromSeats, startTemplate, formatTemplates, readyCheck,
  adopt, addSeat, removeSeat, delegate, dropBack, isPinnedMedium, DROP_BACK_TIER, DELEGATIONS_MAX, SNAPSHOT_SCHEMA, snapshotOf, saveSnapshot, loadSnapshot, listSnapshots, formatSnapshots, restoreSnapshot, formatRestore, snapshotFile,
  tierFor, canFill, boost, setTier, setGuidance, take, release, keep, taskStateFrom, seatOfTile, brief, formatTable, formatSeat, emptyTaskState,
};
