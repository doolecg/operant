(function () {
// Ready check (2.7): before a task goes to an existing seat tile, is the tile up, its agent started and is it idle? Plain facts
// the app already tracks (process, session, working flag, permission prompt); no model call. A tile that is not ready keeps the
// task queued on the board with the reason.
// tile: { alive, ptyId, started, working, waitingPrompt }, or null when the seat holds no tile. -> { ready, reason? }
// enabled: false (Settings › Agents) skips the check, so every tile counts as ready.
function readyCheck(tile, { enabled = true } = {}) {
  if (!enabled) return { ready: true };
  if (!tile) return { ready: false, reason: 'the seat has no tile' };
  if (!tile.alive || tile.ptyId == null || tile.ptyId === '') return { ready: false, reason: 'its process is not running' };
  if (!tile.started) return { ready: false, reason: 'its agent has not started yet' };
  if (tile.waitingPrompt) return { ready: false, reason: 'it is waiting on a permission prompt' };
  if (tile.working) return { ready: false, reason: 'it is busy' };
  return { ready: true };
}

const api = { readyCheck };
if (typeof module !== 'undefined') module.exports = api; else globalThis.ReadyCheck = api;
})();
