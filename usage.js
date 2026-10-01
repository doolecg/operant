// Token usage: reads the per-message usage Claude Code writes into its transcripts
// (~/.claude/projects/<project>/<session>.jsonl, and each subagent's under <session>/subagents)
// and keeps the last month of it for the top bar's pill and its graph.

const path = require('path');
const fs = require('fs');
const { priceOf, isFreeModel, info: pricingInfo } = require('./pricing');

const KEEP_MS = 31 * 86400e3;
const CHUNK = 4 << 20;
// range -> [span, bucket] in ms. Hour and day buckets start on local hours and midnights.
const RANGES = { '5h': [5 * 3600e3, 10 * 60e3], '24h': [24 * 3600e3, 30 * 60e3], '7d': [7 * 86400e3, 4 * 3600e3], '30d': [30 * 86400e3, 86400e3] };

function createUsage({ projectsDir, send, onContext, onToolUse, onToolResult, onTokens }) {
  const files = new Map(); // path -> { offset, partial, size }
  const seen = new Set();  // message id + request id: each content block repeats its message's usage
  let events = [];         // [time, input, output, cacheWrite, cacheRead, project]
  let timer = null, busy = false, scanned = false, lastSig = '';
  const ctxLatest = new Map(); // sessionId -> { tokens, max }, the latest assistant turn seen this scan
  const ctxSent = new Map();   // sessionId -> { tokens, max, at }, last value onContext was told about
  const START = Date.now();    // the runaway guard ignores transcript history from before this run

  // Every transcript changed in the last month, down to the subagents folders.
  async function list(dir, depth, out) {
    let ents;
    try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return out; }
    for (const d of ents) {
      const p = path.join(dir, d.name);
      if (d.isDirectory() && depth < 3) await list(p, depth + 1, out);
      else if (d.isFile() && d.name.endsWith('.jsonl')) out.push(p);
    }
    return out;
  }

  // sessionId/isSubagent: the transcript's own session id and whether it's a subagent
  // file (<session>/subagents/<id>.jsonl) — subagents don't count toward the tile's context, but
  // their tool calls and tokens count toward the runaway guard on their PARENT session (owner).
  // A user entry's tool_result blocks, live only, for the stuck detector (paired with their tool_use by id).
  function takeResults(line, sessionId, isSubagent, parentSessionId) {
    let o;
    try { o = JSON.parse(line); } catch { return; }
    if (o.type !== 'user' || !(Date.parse(o.timestamp) >= START) || !Array.isArray(o.message?.content)) return;
    for (const b of o.message.content) {
      if (b.type !== 'tool_result') continue;
      const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map(c => c.text || '').join('\n') : '';
      onToolResult(isSubagent ? parentSessionId : sessionId, b.tool_use_id, text, !!b.is_error);
    }
  }

  function take(line, fallbackProject, sessionId, isSubagent, parentSessionId, agentId) {
    if (onToolResult && line.includes('"tool_result"')) return takeResults(line, sessionId, isSubagent, parentSessionId);
    if (!line.includes('"assistant"')) return;
    let o;
    try { o = JSON.parse(line); } catch { return; }
    const m = o.message;
    if (o.type !== 'assistant' || !m) return;
    const t = Date.parse(o.timestamp);
    const runawaySession = isSubagent ? parentSessionId : sessionId;
    // Live only: history read back on startup (before this process existed) never flags a loop.
    if (onToolUse && t >= START && Array.isArray(m.content)) {
      for (const b of m.content) if (b.type === 'tool_use') onToolUse(runawaySession, b.name, b.input, isSubagent ? agentId : null, b.id);
    }
    const u = m.usage;
    if (!u || m.model === '<synthetic>') return;
    const key = `${m.id}:${o.requestId || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (!isSubagent && sessionId) {
      const tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      ctxLatest.set(sessionId, { tokens, max: contextMax(m.model, tokens), model: m.model || null });
    }
    if (onTokens && t >= START) {
      const breakdown = { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0 };
      onTokens(runawaySession, breakdown.input + breakdown.output + breakdown.cacheWrite + breakdown.cacheRead, breakdown, t);
    }
    if (!(t > Date.now() - KEEP_MS)) return;
    // A session in a worktree (<repo>/.claude/worktrees/<name>) counts toward its repo.
    const cwd = o.cwd && o.cwd.replace(/[\\/]\.claude[\\/]worktrees[\\/].*$/i, '');
    const project = cwd ? path.basename(cwd) || cwd : fallbackProject;
    events.push([t, u.input_tokens || 0, u.output_tokens || 0, u.cache_creation_input_tokens || 0, u.cache_read_input_tokens || 0, project]);
  }

  async function readFile(file, st) {
    let f = files.get(file);
    if (!f) files.set(file, f = { offset: 0, partial: '', size: -1 });
    if (st.size === f.size) return;
    if (st.size < f.offset) { f.offset = 0; f.partial = ''; }
    f.size = st.size;
    const relParts = path.relative(projectsDir, file).split(path.sep);
    const fallback = relParts[0];
    const isSubagent = relParts.includes('subagents');
    const sessionId = path.basename(file, '.jsonl');
    // Subagent layout: <project>/<parentSessionId>/subagents/agent-<id>.jsonl
    const parentSessionId = isSubagent ? relParts[1] : null;
    const agentId = isSubagent ? sessionId.replace(/^agent-/, '') : null;
    const fh = await fs.promises.open(file, 'r');
    try {
      while (f.offset < st.size) {
        const len = Math.min(CHUNK, st.size - f.offset);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, f.offset);
        if (!bytesRead) break;
        f.offset += bytesRead;
        const lines = (f.partial + buf.toString('utf8', 0, bytesRead)).split('\n');
        f.partial = lines.pop();
        for (const l of lines) take(l, fallback, sessionId, isSubagent, parentSessionId, agentId);
      }
    } finally { await fh.close(); }
  }

  // Tells main which sessions' context size changed, at most once per session per 2s.
  function flushContext() {
    if (!onContext) return;
    const now = Date.now();
    for (const [sessionId, v] of ctxLatest) {
      const prev = ctxSent.get(sessionId);
      if (prev && prev.tokens === v.tokens && prev.max === v.max && prev.model === v.model) continue;
      if (prev && now - prev.at < 2000) continue;
      ctxSent.set(sessionId, { tokens: v.tokens, max: v.max, model: v.model, at: now });
      onContext(sessionId, v.tokens, v.max, v.model);
    }
  }

  async function scan() {
    if (busy) return;
    busy = true;
    try {
      const since = Date.now() - KEEP_MS;
      for (const file of await list(projectsDir, 0, [])) {
        let st;
        try { st = await fs.promises.stat(file); } catch { continue; }
        if (st.mtimeMs < since) continue;
        try { await readFile(file, st); } catch {}
      }
      flushContext();
      if (events.length && events[0][0] < since) { events = events.filter(e => e[0] >= since); }
      events.sort((a, b) => a[0] - b[0]);
      scanned = true;
      const s = summary();
      const sig = JSON.stringify(s);
      if (sig !== lastSig) { lastSig = sig; send('usage:changed', s); }
    } finally { busy = false; }
  }

  const sum = list => list.reduce((a, e) => { a.input += e[1]; a.output += e[2]; a.cacheWrite += e[3]; a.cacheRead += e[4]; return a; },
    { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
  const midnight = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

  // The pill: today so far, and the last hour.
  function summary() {
    const now = Date.now();
    return { ready: scanned, today: sum(events.filter(e => e[0] >= midnight(now))), hour: sum(events.filter(e => e[0] >= now - 3600e3)) };
  }

  // One project's counted tokens today (input + output + cache writes), for its daily cap.
  function todayFor(project) {
    const t = sum(events.filter(e => e[0] >= midnight(Date.now()) && e[5] === project));
    return t.input + t.output + t.cacheWrite;
  }

  // The graph: stacked buckets over the range, plus each project's share of it.
  function series(range) {
    const [span, step] = RANGES[range] || RANGES['24h'];
    const now = Date.now();
    const days = step >= 86400e3;
    const offset = new Date(now).getTimezoneOffset() * 60e3;
    const last = days ? midnight(now) : Math.floor((now - offset) / step) * step + offset;
    const count = Math.round(span / step);
    const buckets = [];
    for (let i = count - 1; i >= 0; i--) {
      let t = last - i * step;
      if (days) { const d = new Date(last); d.setDate(d.getDate() - i); t = d.getTime(); } // DST days aren't 24h
      buckets.push({ t, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
    }
    const first = buckets[0].t;
    const inRange = events.filter(e => e[0] >= first);
    const byProject = new Map();
    let b = 0;
    for (const e of inRange) {
      while (b + 1 < buckets.length && e[0] >= buckets[b + 1].t) b++;
      const k = buckets[b];
      k.input += e[1]; k.output += e[2]; k.cacheWrite += e[3]; k.cacheRead += e[4];
      let p = byProject.get(e[5]);
      if (!p) byProject.set(e[5], p = { name: e[5], input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
      p.input += e[1]; p.output += e[2]; p.cacheWrite += e[3]; p.cacheRead += e[4];
    }
    const projects = [...byProject.values()];
    return { range, step, buckets, totals: sum(inRange), projects };
  }

  function start() {
    if (timer) return;
    scan();
    timer = setInterval(scan, 5000);
  }
  function stop() { clearInterval(timer); timer = null; }

  // Usage from outside a Claude Code transcript (OpenCode): same shape as a
  // transcript entry, so it counts toward the top-bar pill and graph too. Picked up on the next scan.
  function addEvent(t, input, output, cacheWrite, cacheRead, project) {
    events.push([t, input || 0, output || 0, cacheWrite || 0, cacheRead || 0, project || 'other']);
  }

  return { start, stop, summary, todayFor, series, refresh: scan, addEvent, breakdown: opts => computeBreakdown(projectsDir, opts) };
}

// ------------------------------------------------------------ "where the tokens go"
// A fresh, on-demand read of the JSONL (not the running scan above): per project and per tile
// (Claude Code session, subagents folded into their parent) totals, the biggest single turns with
// the tool call that likely caused them, files read more than 3 times in a session, and each
// session's fixed first-turn overhead. Claude Code transcripts carry no free/paid flag (unlike
// OpenCode's free Zen models), so Claude rows are all "paid". The pricing table adds OpenCode's database events
// (free Zen models count as free), a price per model (pricing.js) and rows per model, tier and task.

const shortPath = p => String(p).replace(/\\/g, '/').split('/').slice(-2).join('/');
function toolArg(input) {
  if (!input) return '';
  const v = input.file_path || input.path || input.command || input.pattern || input.url || input.query || '';
  return shortPath(String(v)).slice(0, 60);
}
function projectOf(o, fallback) {
  const cwd = o.cwd && o.cwd.replace(/[\\/]\.claude[\\/]worktrees[\\/].*$/i, '');
  return cwd ? path.basename(cwd) || cwd : fallback;
}
const shortLabel = (sessionId, project) => `${project} · ${String(sessionId || '').slice(0, 8)}`;

async function listJsonl(dir, depth, out) {
  let ents;
  try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const d of ents) {
    const p = path.join(dir, d.name);
    if (d.isDirectory() && depth < 3) await listJsonl(p, depth + 1, out);
    else if (d.isFile() && d.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// opencode: readOpenCodeUsage events; tags: session id -> { tier, taskId } (a Claude session id, or an OpenCode root session id);
// sinceMs overrides the window (the usage panel's ranges).
async function computeBreakdown(projectsDir, { days = 1, project = null, sinceMs = 0, opencode = [], tags = {} } = {}) {
  const now = Date.now();
  const since = sinceMs > 0 ? sinceMs : days <= 1 ? new Date(now).setHours(0, 0, 0, 0) : now - 7 * 86400e3;
  const files = await listJsonl(projectsDir, 0, []);
  const seen = new Set();
  const perProject = new Map(), perTile = new Map(), fileReads = new Map(), overhead = [], turns = [];
  const perModel = new Map(), perTier = new Map(), perTask = new Map();

  // e.free: a free OpenCode model; e.usd: the priced cost of the event, null when its model has no price.
  const bump = (map, key, label, e) => {
    let a = map.get(key);
    if (!a) map.set(key, { key, label, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, free: 0, paid: 0, usdKnown: 0, unpriced: 0 });
    a = map.get(key);
    a.input += e.input; a.output += e.output; a.cacheWrite += e.cacheWrite; a.cacheRead += e.cacheRead;
    a[e.free ? 'free' : 'paid'] += e.input + e.output + e.cacheWrite + e.cacheRead;
    if (e.usd == null) a.unpriced++; else a.usdKnown += e.usd;
  };
  // Model, tier and task rows share the event; a session's tag (tier, task) comes from tags.
  const bumpCost = (sessionKey, model, e) => {
    const tag = tags[sessionKey] || {};
    bump(perModel, model || 'unknown', model || 'unknown', e);
    bump(perTier, tag.tier || '', tag.tier || 'No tier', e);
    if (tag.taskId != null) bump(perTask, String(tag.taskId), `#${tag.taskId}`, e);
  };

  for (const file of files) {
    let st;
    try { st = await fs.promises.stat(file); } catch { continue; }
    if (st.mtimeMs < since) continue;
    let text;
    try { text = await fs.promises.readFile(file, 'utf8'); } catch { continue; }
    const relParts = path.relative(projectsDir, file).split(path.sep);
    const fallback = relParts[0];
    const isSubagent = relParts.includes('subagents');
    const sessionId = path.basename(file, '.jsonl');
    const parentSessionId = isSubagent ? relParts[1] : null;
    const agentId = isSubagent ? sessionId.replace(/^agent-/, '') : null;
    const mergedKey = isSubagent ? parentSessionId : sessionId;
    let meta = null;
    if (isSubagent) { try { meta = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')); } catch {} }
    let lastTool = null, firstUsageSeen = false;
    for (const line of text.split('\n')) {
      if (!line || !line.includes('"assistant"')) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      const m = o.message;
      if (o.type !== 'assistant' || !m) continue;
      const t = Date.parse(o.timestamp);
      const u = m.usage;
      if (u && m.model !== '<synthetic>') {
        const key = `${m.id}:${o.requestId || ''}`;
        if (!seen.has(key)) {
          seen.add(key);
          const e = { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0 };
          e.usd = priceOf(m.model, e).usd;
          const wasFirst = !firstUsageSeen;
          firstUsageSeen = true;
          if (t >= since) {
            const p = projectOf(o, fallback);
            if (!project || p === project) {
              if (wasFirst) {
                const ovTokens = e.input + e.cacheWrite;
                overhead.push({ tile: mergedKey, label: meta?.description || shortLabel(sessionId, p), project: p, tokens: ovTokens, at: t, big: ovTokens > 20000 });
              }
              bump(perProject, p, p, e);
              bump(perTile, mergedKey, meta?.description || shortLabel(mergedKey, p), e);
              bumpCost(mergedKey, m.model, e);
              const total = e.input + e.output + e.cacheWrite + e.cacheRead;
              turns.push({ tokens: total, tile: (perTile.get(mergedKey) || {}).label || mergedKey, project: p, time: t, cause: lastTool });
            }
          }
        }
      }
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type !== 'tool_use') continue;
          const arg = toolArg(b.input);
          lastTool = `${b.name}${arg ? `(${arg})` : ''}`;
          if (b.name === 'Read' && b.input && b.input.file_path && t >= since) {
            const p = projectOf(o, fallback);
            if (!project || p === project) {
              let fm = fileReads.get(mergedKey);
              if (!fm) fileReads.set(mergedKey, fm = new Map());
              const fp = shortPath(b.input.file_path);
              fm.set(fp, (fm.get(fp) || 0) + 1);
            }
          }
        }
      }
    }
  }

  // OpenCode's database events: exact per message; reasoning tokens count as output.
  for (const o of opencode) {
    if (o.at < since) continue;
    const p = o.directory ? path.basename(o.directory) || o.directory : 'opencode';
    if (project && p !== project) continue;
    const e = { input: o.input, output: o.output + (o.reasoning || 0), cacheWrite: o.cacheWrite, cacheRead: o.cacheRead };
    e.usd = priceOf(o.model, e, o.cost).usd;
    e.free = isFreeModel(o.model);
    bump(perProject, p, p, e);
    bump(perTile, o.rootSessionId, `${p} · oc ${String(o.rootSessionId).slice(-6)}`, e);
    bumpCost(o.rootSessionId, o.model, e);
  }

  turns.sort((a, b) => b.tokens - a.tokens);
  const repeatedReads = [];
  for (const [tile, fm] of fileReads) {
    const label = (perTile.get(tile) || {}).label || tile;
    for (const [file, count] of fm) if (count > 3) repeatedReads.push({ tile, label, file, count });
  }
  repeatedReads.sort((a, b) => b.count - a.count);
  overhead.sort((a, b) => b.tokens - a.tokens);

  // usd is null (unknown) when any event in the row has no price; usdKnown is the sum of the priced ones.
  const finish = map => [...map.values()].map(r => {
    const all = r.input + r.output + r.cacheWrite + r.cacheRead;
    const inTotal = r.input + r.cacheRead + r.cacheWrite;
    return { ...r, usd: r.unpriced ? null : r.usdKnown, cacheHitRate: inTotal ? r.cacheRead / inTotal : 0, tokens: all, accuracy: 'exact' };
  }).sort((a, b) => b.tokens - a.tokens);
  const total = finish(new Map([['all', [...perModel.values()].reduce((a, r) => {
    for (const k of ['input', 'output', 'cacheWrite', 'cacheRead', 'free', 'paid', 'usdKnown', 'unpriced']) a[k] += r[k];
    return a;
  }, { key: 'all', label: 'All', input: 0, output: 0, cacheWrite: 0, cacheRead: 0, free: 0, paid: 0, usdKnown: 0, unpriced: 0 })]]))[0];

  return {
    since, days,
    projects: finish(perProject).sort((a, b) => (b.paid + b.free) - (a.paid + a.free)),
    tiles: finish(perTile).sort((a, b) => (b.paid + b.free) - (a.paid + a.free)),
    models: finish(perModel), tiers: finish(perTier), tasks: finish(perTask),
    total, cacheHitRate: total.cacheHitRate, pricing: pricingInfo,
    biggestTurns: turns.slice(0, 10),
    repeatedReads: repeatedReads.slice(0, 20),
    overhead: overhead.slice(0, 15),
  };
}

// A model's context window: 1M for Claude Fable and Mythos, and Opus/Sonnet 4.6 and later; 200K for
// Haiku and older models unless Claude Code runs them as [1m]. A context already past 200K is 1M.
function contextMax(model, tokens) {
  return tokens > 200000 || /\[1m\]|fable|mythos|(opus|sonnet)-(4-[6-9]|[5-9])/i.test(model || '') ? 1000000 : 200000;
}

module.exports = { createUsage, contextMax };
