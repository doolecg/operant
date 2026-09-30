(function () {
// Provider and model health (2.5): from recorded calls ({ t, key, ok, kind, latencyMs }; key is the model, kind is
// 'timeout' | 'rate-limit' | 'auth' | 'error') to availability, latency and error rates per key. Every call counts with
// a weight that halves each HALF_LIFE_MS, so an outage last week barely moves today's score. A key is "down" only while
// its newest call failed and that kind's hold-off has not passed: it is skipped, with the reason, instead of retried
// blindly; when the hold-off ends the next task tries it again and that result decides. Pure.
const HALF_LIFE_MS = 6 * 3600e3;
const HOLD_MS = { 'rate-limit': 10 * 60e3, timeout: 5 * 60e3, error: 5 * 60e3, auth: 60 * 60e3 };
const TEXT = { 'rate-limit': 'was rate limited', timeout: 'timed out', auth: 'failed authentication', error: 'errored' };

const weight = (age, half) => Math.pow(0.5, Math.max(0, age) / half);
const ago = ms => (ms < 90e3 ? 'just now' : ms < 90 * 60e3 ? `${Math.round(ms / 60e3)} min ago` : `${Math.round(ms / 3600e3)} h ago`);

// -> { "<key>": { n, availability, errorRate, timeoutRate, rateLimitRate, avgLatencyMs, score, down: { kind, reason, until } | null, lastAt } }
function summarize(events, now = Date.now(), { halfLifeMs = HALF_LIFE_MS } = {}) {
  const acc = {};
  for (const e of events || []) {
    if (!e || !e.key || typeof e.t !== 'number') continue;
    const w = weight(now - e.t, halfLifeMs);
    const a = (acc[e.key] ||= { w: 0, ok: 0, err: 0, timeout: 0, limit: 0, lat: 0, latW: 0, n: 0, last: null });
    a.w += w; a.n++;
    if (e.ok) a.ok += w; else {
      a.err += w;
      if (e.kind === 'timeout') a.timeout += w;
      if (e.kind === 'rate-limit') a.limit += w;
    }
    if (e.ok && typeof e.latencyMs === 'number') { a.lat += e.latencyMs * w; a.latW += w; }
    if (!a.last || e.t >= a.last.t) a.last = e;
  }
  const out = {};
  for (const [key, a] of Object.entries(acc)) {
    const l = a.last, hold = l && !l.ok ? (HOLD_MS[l.kind] || HOLD_MS.error) : 0;
    const down = l && !l.ok && now - l.t < hold ? { kind: l.kind || 'error', reason: `${TEXT[l.kind] || TEXT.error} ${ago(now - l.t)}`, until: l.t + hold } : null;
    out[key] = {
      n: a.n, availability: a.w ? a.ok / a.w : 1, errorRate: a.w ? a.err / a.w : 0, timeoutRate: a.w ? a.timeout / a.w : 0, rateLimitRate: a.w ? a.limit / a.w : 0,
      avgLatencyMs: a.latW ? Math.round(a.lat / a.latW) : null,
      score: (a.ok + 1) / (a.w + 1), // one imagined success, so a single failure does not zero a key
      down, lastAt: l ? l.t : null,
    };
  }
  return out;
}

// The { down(key) } shape tier-routes.js asks (its own createHealth has the same one): kind 'busy' or 'unavailable' with the reason.
function asHealth(snapshot, now = Date.now) {
  return { down(key) { const d = snapshot?.[key]?.down; return d && now() < d.until ? { kind: d.kind === 'auth' ? 'unavailable' : 'busy', reason: d.reason, until: d.until } : null; } };
}

const api = { summarize, asHealth, HALF_LIFE_MS, HOLD_MS };
if (typeof module !== 'undefined') module.exports = api; else globalThis.RouteHealth = api;
})();
