(function () {
// Overflow recovery, pure: an early warning before auto compact, a checkpoint taken before a compact and
// handed back after it, and a count of compacts per tile so a second one suggests splitting the task.

const oneLine = s => String(s || '').replace(/\s+/g, ' ').trim();
const clip = (s, n) => s.length > n ? s.slice(0, n - 1) + '…' : s;

// Percent of the context at which to warn: a few points under auto compact, or 70 when it's off.
function warnLevel(autoCompact) {
  const a = Number(autoCompact) || 0;
  return a > 0 ? Math.max(a - 10, 1) : 70;
}

const WARN_MSG = pct => `Context is ${Math.round(pct)}% full. Finish the current step, keep replies and tool output short, and avoid re-reading files you already have.`;
const SPLIT_MSG = 'This task has now filled the context twice. Split it: finish the smallest piece that stands alone, then tell the lead the rest as separate tasks.';

// The checkpoint as text for the worker: the task, files touched, and the next step.
function checkpointText(cp) {
  const lines = ['Checkpoint from before the compact:'];
  if (cp.task) lines.push('Task: ' + clip(oneLine(cp.task), 200));
  if (cp.files && cp.files.length) lines.push('Files touched: ' + cp.files.slice(0, 15).join(', ') + (cp.files.length > 15 ? ` and ${cp.files.length - 15} more` : ''));
  lines.push('Next step: ' + (oneLine(cp.next) || 'read .operant/progress.md and carry on from there'));
  return lines.join(' ');
}

function createRecovery({ splitAfter = 2 } = {}) {
  const above = new Map();      // id -> was over the warn level on the last look
  const compacts = new Map();   // id -> compacts so far
  const checkpoints = new Map();
  return {
    // true once per crossing of the warn level; the flag resets when the tile drops back under it.
    shouldWarn(id, pct, warnAt, compactAt) {
      const now = pct >= warnAt && !(compactAt > 0 && pct >= compactAt), was = above.get(id);
      if (pct < warnAt) above.set(id, false);
      else if (now && !was) { above.set(id, true); return true; }
      else if (now) above.set(id, true);
      return false;
    },
    // Called as a compact starts: keeps the checkpoint, counts the compact, says whether to suggest a split.
    beginCompact(id, { task, files, next } = {}) {
      const n = (compacts.get(id) || 0) + 1;
      compacts.set(id, n);
      const cp = { task: task || '', files: [...new Set(files || [])], next: next || '', count: n };
      checkpoints.set(id, cp);
      above.set(id, false);
      return { checkpoint: cp, split: n === splitAfter };
    },
    checkpointFor: id => checkpoints.get(id) || null,
    count: id => compacts.get(id) || 0,
    forget(id) { above.delete(id); compacts.delete(id); checkpoints.delete(id); },
  };
}

const api = { warnLevel, WARN_MSG, SPLIT_MSG, checkpointText, createRecovery };
if (typeof module !== 'undefined') module.exports = api; else globalThis.ContextRecovery = api;
})();
