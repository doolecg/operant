(function () {
// Task board rules, pure over a board object { tasks, nextTaskId }. A worker's "done" is only a
// handback: the task waits in 'review' until the lead approves it. A failure or a rejection gets one
// retry in the same tile; after that the task is paused and the user asked (tier-guard.js): a move up
// is never automatic. 'verifying': Operant is running the project's checks before the task reaches review.
// 'paused': waiting for the user's answer on the board.
const STATUSES = ['todo', 'doing', 'verifying', 'review', 'done', 'failed', 'blocked', 'cancelled', 'paused'];
const isOpen = t => t.status === 'todo' || t.status === 'doing';

// A worker reports done, blocked or failed. Done waits for review.
function handback(task, status, note) {
  if (!['done', 'blocked', 'failed'].includes(status)) throw new Error(`status must be done, blocked or failed, not "${status}"`);
  task.status = status === 'done' ? 'review' : status;
  if (note != null) task.note = String(note);
  return task;
}

function approve(task) {
  if (task.status !== 'review') throw new Error(`task ${task.id} is ${task.status}, not waiting for review`);
  task.status = 'done';
  return task;
}

// You closed the task (the Terminal's Close / Close with reason): it ends here, is never retried or moved up, and is not
// a model failure. Anything not already finished can be closed.
// Its pending ask, retry, escalation and check stop with it; the note keeps where it stood (task.closedFrom) for whoever picks it up.
function cancel(task, reason) {
  if (task.status === 'done' || task.status === 'cancelled') throw new Error(`task ${task.id} is already ${task.status}`);
  const was = task.status, last = String(task.note || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  task.closedFrom = { status: was, attempt: attempts(task), note: last || null };
  task.status = 'cancelled';
  task.retried = true; // nothing retries it
  delete task.ask;
  const why = reason ? `Closed: ${String(reason).trim()}` : 'Closed';
  task.note = was === 'todo' ? why : `${why} (was ${was}, attempt ${attempts(task)}${last ? `; last note: ${last}` : ''})`;
  return task;
}

// A retry must change something: the prompt (the lead's note), context, strategy, tool or verification.
// -> { kind, text } naming the change, or null when there is none (an empty or generic reason, or the very
// change the last retry already had), and then the user is asked instead of retrying.
const KINDS = ['context', 'prompt', 'strategy', 'tool', 'verification'];
const GENERIC = /^(rejected|failed|checks failed|no reason given|it failed|did not work)?\.?$/i;
function retryChange(task, kind, text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!KINDS.includes(kind) || !t || GENERIC.test(t)) return null;
  const last = (task.changes || []).slice(-1)[0];
  return last && last.text === t.slice(0, 240) ? null : { kind, text: t.slice(0, 240) };
}
// Records a change on the task (every retry, including one the user answers with a hint).
function noteChange(task, change) {
  (task.changes = task.changes || []).push({ ...change, attempt: attempts(task) });
  return task;
}

// First strike on a tier: back to 'doing' with the stated change recorded. Second, or nothing changed: 'ask' (the user
// decides; never a move up by itself).
function strike(task, change) {
  if (!change || task.retried) return 'ask';
  task.retried = true; task.status = 'doing';
  noteChange(task, change);
  return 'retry';
}

function reject(task, note) {
  if (task.status !== 'review') throw new Error(`task ${task.id} is ${task.status}, not waiting for review`);
  task.note = String(note || 'rejected');
  return strike(task, retryChange(task, 'prompt', note));
}

// A failed attempt: retry once (unless noRetry), then 'ask'.
// A retry needs a stated change: `change` is { kind, text }, else the failure itself is the new context for a different strategy.
function failure(task, note, { noRetry, change } = {}) {
  task.note = String(note || 'failed');
  if (noRetry) return 'ask';
  return strike(task, change || retryChange(task, 'strategy', note));
}

// The checks failed on a task in 'verifying': the first time it goes back like a reject, then the lead sees it in review.
function verifyFailed(task, note) {
  task.status = 'review';
  if (task.verifyRetried) { task.note = String(note || 'checks failed'); return 'review'; }
  task.verifyRetried = true;
  task.note = String(note || 'checks failed');
  return strike(task, retryChange(task, 'verification', note)) === 'retry' ? 'retry' : 'review';
}

// The next tier above the task's, up to maxTier; null at the top. `tiers` is an ordered list of names.
function escalation(task, tiers, maxTier) {
  const names = Array.isArray(tiers) ? tiers : Object.keys(tiers || {});
  const at = names.indexOf(task.tier);
  const top = maxTier && names.includes(maxTier) ? names.indexOf(maxTier) : names.length - 1;
  return at < 0 || at + 1 > top ? null : names[at + 1];
}

// Moves the task to `tier` for a fresh worker: attempts counted, strikes reset.
function moveUp(task, tier) {
  task.tier = tier;
  task.attempts = attempts(task) + 1;
  task.retried = false;
  task.owner = null;
  task.status = 'todo';
  return task;
}

const attempts = task => task.attempts || 1;

// Two lines the next worker starts from.
function failureNote(task, why) {
  const clean = s => String(s || 'no reason given').replace(/\s+/g, ' ').trim().slice(0, 240);
  return `Attempt ${attempts(task)} on the ${task.tier || 'previous'} tier did not work: ${clean(why)}\nThe repo may hold its partial changes: check them, do not repeat the same approach.`;
}

// Item 41/11: the task's state for the next worker on a tier change, built from what the board knows:
// decisions (the stated retry changes), constraints (the profile's risk), files (diff stat) and
// verification (the last check). One line. It replaces the failure note, unless it has nothing to add or is longer.
function handoff(task, why) {
  const cut = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const parts = [];
  const decisions = (task.changes || []).slice(-2).map(c => `${c.kind}: ${cut(c.text, 40)}`);
  if (decisions.length) parts.push(`decisions: ${decisions.join('; ')}`);
  if (task.profile) parts.push(`risk ${task.profile.risk}`);
  if (task.diffStat) parts.push(`files: ${cut(task.diffStat, 40)}`);
  if (task.check) parts.push(`checks ${task.check.ok ? 'passed' : 'failed'}: ${cut(task.check.command, 30)}`);
  const note = failureNote(task, why);
  if (!parts.length) return note;
  const text = `Handoff: attempt ${attempts(task)} failed (${cut(why || 'no reason given', 50)}); ${parts.join('; ')}. Repo may hold partial work; change approach.`;
  return text.length <= note.length ? text : note;
}

// A worker went idle without reporting: did it change its folder? before/after: { head, status, stat } from git:snapshot.
// -> { changed, note } ; note is the handback text when changed. Nothing to compare (no snapshot) counts as unchanged.
function unreportedChange(before, after) {
  if (!before || !after) return { changed: false, note: '' };
  const changed = before.head !== after.head || (before.status || '') !== (after.status || '');
  if (!changed) return { changed: false, note: '' };
  const files = (after.status || '').split('\n').filter(Boolean).length;
  const found = after.stat || (files ? `${files} file${files === 1 ? '' : 's'} with uncommitted changes` : 'new commits');
  return { changed: true, note: `The worker made changes but didn't report; Operant found: ${found}` };
}

// A worker tile whose result the lead has read: its task waits in 'review' (handed back as done), it owns no other
// open work, and it is neither busy nor waiting on an ask/plan answer. Rejected or reworked tasks are not 'review'.
// `read` is true once the lead read the tile (operant read) or was handed the note. -> the task, or null.
function readyToClose(board, w, { busy = false, waiting = false, read = false } = {}) {
  if (!read || busy || waiting || !w || !w.tier) return null;
  const mine = (board.tasks || []).filter(t => t.owner === w.id);
  const review = mine.find(t => t.status === 'review');
  if (!review || mine.some(t => t !== review && !['done', 'failed', 'cancelled'].includes(t.status))) return null;
  return review;
}

const api = { retryChange, noteChange, readyToClose, unreportedChange, STATUSES, isOpen, handback, approve, reject, cancel, verifyFailed, failure, escalation, moveUp, failureNote, handoff, attempts };
if (typeof module !== 'undefined') module.exports = api; else globalThis.Board = api;
})();
