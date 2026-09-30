// Context engine (plan 2.4 part 2): given a task and candidate pieces (files, symbols, memories, git
// changes, tool output), rank them, drop duplicated and overlapping content, fit what is left to a token
// budget with headroom kept for the answer, and keep where each piece came from. Pure: no file reads,
// no clock unless `now` is left out. A cached piece whose source file hash changed is marked stale.
//
// piece: { kind, source, text, hash?, currentHash?, at? }
//   hash         the source file's hash when the piece was cached; currentHash is the hash now
//   at           ISO time or ms, when the piece was made (recency)
const KIND_WEIGHT = { symbol: 1.0, file: 0.9, git: 0.8, memory: 0.75, output: 0.6 };
const DEFAULT_BUDGET = 4000;    // tokens for the whole prompt share this engine may fill
const DEFAULT_HEADROOM = 1000;  // tokens kept free for the model's output
const MIN_TRUNCATED = 40;       // a piece is cut to fit only when at least this many tokens remain
const OVERLAP = 0.8;            // share of a piece's lines already kept that makes it a duplicate
const STALE_FACTOR = 0.4;

const estimateTokens = text => Math.ceil(String(text || '').length / 4);
const words = text => String(text || '').toLowerCase().split(/[^a-z0-9_]+/).filter(w => w.length > 2);
const normLine = l => l.trim().replace(/\s+/g, ' ').toLowerCase();

// Whether a cached piece no longer matches its source. Nothing to compare = not stale.
function isStale(piece) {
  return !!(piece.hash && piece.currentHash && piece.hash !== piece.currentHash);
}

// Higher = more relevant to the task: share of the task's words the piece (text + source) mentions, the
// kind of piece, a recency bonus (a week half-life), and a penalty when the cache is stale.
function score(task, piece, now) {
  const want = [...new Set(words(task))];
  const have = new Set(words(`${piece.source || ''} ${piece.text || ''}`));
  const hits = want.length ? want.filter(w => have.has(w)).length / want.length : 0;
  const t = typeof piece.at === 'number' ? piece.at : Date.parse(piece.at || '');
  const recency = Number.isFinite(t) ? Math.pow(0.5, Math.max(0, now - t) / (7 * 86400000)) : 0;
  const s = (hits * 2 + recency * 0.3 + 0.05) * (KIND_WEIGHT[piece.kind] || 0.5);
  return isStale(piece) ? s * STALE_FACTOR : s;
}

// Ranks every piece against the task, best first. Each result keeps the piece and adds score, stale, tokens.
function rank(task, pieces, { now = Date.now() } = {}) {
  return (pieces || []).filter(p => p && String(p.text || '').trim())
    .map((p, i) => ({ ...p, text: String(p.text).trim(), score: score(task, p, now), stale: isStale(p), tokens: estimateTokens(p.text), order: i }))
    .sort((a, b) => b.score - a.score || a.order - b.order);
}

// Walks pieces best first; a piece whose text repeats a kept piece, or whose lines are mostly already
// kept, is dropped and its source is noted on the kept one (`alsoFrom`).
function dedupe(ranked) {
  const kept = [], dropped = [];
  const seenLines = new Map(); // normalized line -> kept piece
  for (const p of ranked) {
    const lines = p.text.split(/\r?\n/).map(normLine).filter(l => l.length > 3);
    const owners = lines.map(l => seenLines.get(l)).filter(Boolean);
    const shared = lines.length ? owners.length / lines.length : 0;
    if (lines.length && shared >= OVERLAP) {
      const owner = owners[0];
      (owner.alsoFrom = owner.alsoFrom || []).push(p.source);
      dropped.push({ source: p.source, kind: p.kind, reason: shared === 1 ? 'duplicate' : 'overlap' });
      continue;
    }
    kept.push(p);
    for (const l of lines) if (!seenLines.has(l)) seenLines.set(l, p);
  }
  return { kept, dropped };
}

function label(p) {
  return `[${p.kind}${p.source ? ` ${p.source}` : ''}${p.stale ? ' STALE: source changed' : ''}${p.alsoFrom ? ` +${p.alsoFrom.length} same` : ''}]`;
}
const bytes = s => Buffer.byteLength(s);

// The section as text, one line per piece: its label, then its text. Never longer than maxBytes.
function render(pieces, maxBytes) {
  const out = [];
  let used = 0;
  for (const p of pieces) {
    const line = `${label(p)} ${p.text.replace(/\s*\r?\n\s*/g, ' ⏎ ')}`;
    const cost = bytes(line) + 1;
    if (used + cost > maxBytes) return { text: out.join('\n'), fitted: out.length };
    out.push(line); used += cost;
  }
  return { text: out.join('\n'), fitted: out.length };
}

// buildContext(task, pieces, { budget, headroom, maxBytes, now }) ->
//   { pieces, dropped, text, tokens, budget, headroom }
// The token budget is allocated first: budget - headroom is what the pieces may fill, in rank order.
// A piece that does not fit is cut when enough room remains, else dropped. maxBytes caps `text`.
function buildContext(task, pieces, { budget = DEFAULT_BUDGET, headroom = DEFAULT_HEADROOM, maxBytes = Infinity, now } = {}) {
  const room = Math.max(0, budget - headroom);
  const { kept, dropped } = dedupe(rank(task, pieces, { now }));
  const chosen = [];
  let used = 0;
  for (const p of kept) {
    const left = room - used;
    if (p.tokens <= left) { chosen.push(p); used += p.tokens; continue; }
    if (left >= MIN_TRUNCATED) {
      const text = p.text.slice(0, left * 4).trimEnd();
      chosen.push({ ...p, text, tokens: estimateTokens(text), truncated: true }); used += estimateTokens(text);
    } else dropped.push({ source: p.source, kind: p.kind, reason: 'budget' });
  }
  let { text, fitted } = render(chosen, maxBytes);
  for (const p of chosen.slice(fitted)) { dropped.push({ source: p.source, kind: p.kind, reason: 'bytes' }); used -= p.tokens; }
  return { pieces: chosen.slice(0, fitted), dropped, text, tokens: used, budget, headroom };
}

module.exports = { buildContext, rank, dedupe, isStale, estimateTokens, DEFAULT_BUDGET, DEFAULT_HEADROOM };
