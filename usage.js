// Token usage: reads the per-message usage Claude Code writes into its transcripts
// (~/.claude/projects/<project>/<session>.jsonl, and each subagent's under <session>/subagents)
// and keeps the last month of it for the top bar's pill and its graph.

const path = require('path');
const fs = require('fs');

const KEEP_MS = 31 * 86400e3;
const CHUNK = 4 << 20;
// range -> [span, bucket] in ms. Hour and day buckets start on local hours and midnights.
const RANGES = { '5h': [5 * 3600e3, 10 * 60e3], '24h': [24 * 3600e3, 30 * 60e3], '7d': [7 * 86400e3, 4 * 3600e3], '30d': [30 * 86400e3, 86400e3] };

function createUsage({ projectsDir, send }) {
  const files = new Map(); // path -> { offset, partial, size }
  const seen = new Set();  // message id + request id: each content block repeats its message's usage
  let events = [];         // [time, input, output, cacheWrite, cacheRead, project]
  let timer = null, busy = false, scanned = false, lastSig = '';

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

  function take(line, fallbackProject) {
    if (!line.includes('"usage"') || !line.includes('"assistant"')) return;
    let o;
    try { o = JSON.parse(line); } catch { return; }
    const m = o.message, u = m?.usage;
    if (o.type !== 'assistant' || !u || m.model === '<synthetic>') return;
    const key = `${m.id}:${o.requestId || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    const t = Date.parse(o.timestamp);
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
    const fallback = path.relative(projectsDir, file).split(path.sep)[0];
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
        for (const l of lines) take(l, fallback);
      }
    } finally { await fh.close(); }
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

  return { start, stop, summary, series, refresh: scan };
}

module.exports = { createUsage };
