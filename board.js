(function () {
// Task board rules, pure over a board object { tasks, nextTaskId }. A worker's "done" is only a
// handback: the task waits in 'review' until the lead approves it. A failure or a rejection gets one
// retry in the same tile, then the task moves one tier up (as far as the top tier allowed) or fails.
// 'verifying': Operant is running the project's checks before the task reaches review.
const STATUSES = ['todo', 'doing', 'verifying', 'review', 'done', 'failed', 'blocked', 'cancelled'];
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
function cancel(task, reason) {
  if (task.status === 'done' || task.status === 'cancelled') throw new Error(`task ${task.id} is already ${task.status}`);
  task.status = 'cancelled';
  task.note = reason ? `Closed: ${String(reason).trim()}` : 'Closed';
  return task;
}

// First strike on a tier: back to 'doing' with the note. Second: 'escalate'.
function strike(task) {
  if (!task.retried) { task.retried = true; task.status = 'doing'; return 'retry'; }
  return 'escalate';
}

function reject(task, note) {
  if (task.status !== 'review') throw new Error(`task ${task.id} is ${task.status}, not waiting for review`);
  task.note = String(note || 'rejected');
  return strike(task);
}

// A failed attempt: retry once (unless noRetry), then 'escalate'.
function failure(task, note, { noRetry } = {}) {
  task.note = String(note || 'failed');
  if (noRetry) return 'escalate';
  return strike(task);
}

// The checks failed on a task in 'verifying': the first time it goes back like a reject, then the lead sees it in review.
function verifyFailed(task, note) {
  task.status = 'review';
  if (task.verifyRetried) { task.note = String(note || 'checks failed'); return 'review'; }
  task.verifyRetried = true;
  return reject(task, note);
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

const api = { unreportedChange, STATUSES, isOpen, handback, approve, reject, cancel, verifyFailed, failure, escalation, moveUp, failureNote, attempts };
if (typeof module !== 'undefined') module.exports = api; else globalThis.Board = api;
})();
