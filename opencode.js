// OpenCode: its subagents as tiles. OpenCode keeps a subagent as a session with a parent, which
// its terminal UI mostly hides. Each OpenCode tile runs with its own --port, and this listens to that
// server's event stream: a new child session becomes a subagent tile beside the tile, its text and
// tool calls stream into it, and it's done when the session goes idle. OpenCode windows started
// outside Operant are read from its database instead (Settings › Tiles & subagents › other sessions).

const path = require('path');
const os = require('os');
const net = require('net');

const DB_PATH = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A free local port for the next OpenCode tile.
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

function createOpenCode({ sendTo, primary, config, onToolUse, onTokens, onSubagentCount }) {
  const tiles = new Map();   // pty id -> { port, owner, alive, abort, roots: Set, subs: Map, ctx }
  const external = new Map(); // child session id -> sub read from the database
  const ownedRoots = new Set(); // root sessions of Operant's own OpenCode tiles
  const startTime = Date.now();
  // A message's tokens {input, output, cache:{read, write}} -> the runaway guard's per-turn total,
  // the same shape Claude's usage entries are summed as.
  const tokenSum = tk => !tk ? 0 : (tk.input || 0) + (tk.output || 0) + (tk.cache?.read || 0) + (tk.cache?.write || 0);
  const tokenBreakdown = tk => ({ input: tk?.input || 0, output: tk?.output || 0, cacheWrite: tk?.cache?.write || 0, cacheRead: tk?.cache?.read || 0 });
  // Free Zen models: the id ends in "-free", or the always-free opencode/big-pickle.
  const isFreeModel = id => !id ? false : id === 'opencode/big-pickle' || /-free$/i.test(id);
  const liveSubs = t => { let n = 0; for (const s of t.subs.values()) if (!s.done) n++; return n; };

  // One subagent: which window it's in, the roles of its messages, and what has been sent already.
  const newSub = (info, owner, key) => ({
    id: info.id, owner, key, roles: new Map(), sent: new Set(), done: false,
  });
  const cap = s => String(s || '').replace(/^./, c => c.toUpperCase());

  function announce(sub, info) {
    sendTo(sub.owner, 'agent:new', {
      agentId: info.id, sessionId: sub.key, project: info.directory || '',
      agentType: info.agent || 'subagent', description: String(info.title || info.id).replace(/\s*\(@[\w-]+ subagent\)\s*$/, ''),
      spawnDepth: 1,
    });
  }

  // An OpenCode message part -> transcript entries in the shape the subagent tiles draw (see main's slimEntry).
  function partEntries(sub, part) {
    const role = sub.roles.get(part.messageID) || 'assistant', out = [];
    const once = (k, e) => { if (!sub.sent.has(k)) { sub.sent.add(k); out.push(e); } };
    if (part.type === 'text' && part.text && (role === 'user' || part.time?.end)) {
      once(part.id + ':text', { role, stop: null, blocks: [{ type: 'text', text: part.text }] });
    } else if (part.type === 'reasoning' && part.text && part.time?.end) {
      once(part.id + ':think', { role: 'assistant', stop: null, blocks: [{ type: 'thinking', text: part.text }] });
    } else if (part.type === 'tool') {
      const st = part.state || {};
      const use = { role: 'assistant', stop: null, blocks: [{ type: 'tool_use', id: part.callID, name: cap(part.tool), input: st.input || {} }] };
      if (st.status === 'running' || st.status === 'completed' || st.status === 'error') once(part.id + ':use', use);
      if (st.status === 'completed' || st.status === 'error') {
        const text = st.status === 'error' ? String(st.error || 'failed') : String(st.output || '');
        once(part.id + ':res', { role: 'user', stop: null, blocks: [{ type: 'tool_result', id: part.callID, text: text.slice(0, 4000), isError: st.status === 'error' }] });
      }
    } else if (part.type === 'step-finish' && part.reason === 'stop') finish(sub, out);
    return out;
  }
  function finish(sub, out) {
    if (sub.done) return;
    sub.done = true;
    out.push({ role: 'assistant', stop: 'end_turn', blocks: [] });
  }
  const send = (sub, entries) => { if (entries.length) sendTo(sub.owner, 'agent:entries', { agentId: sub.id, entries }); };

  // The tile's root session filling its context window: input + both cache kinds.
  function sendContext(t, ptyId, tokens, modelID, free) {
    if (!config.contextBadge || !tokens) return;
    const ctx = (tokens.input || 0) + (tokens.cache?.read || 0) + (tokens.cache?.write || 0);
    if (!ctx || (ctx === t.ctx && modelID === t.ctxModel)) return;
    t.ctx = ctx; t.ctxModel = modelID;
    sendTo(t.owner, 'context', { sessionId: `oc:${ptyId}`, tokens: ctx, max: ctx > 200000 ? 1000000 : 200000, model: modelID, free });
  }

  // ---------------------------------------------------------------- tiles started in Operant

  function handle(t, ptyId, e) {
    const p = e.properties || {};
    const key = `oc:${ptyId}`;
    if (e.type === 'session.created' || e.type === 'session.updated') {
      const info = p.info || {};
      if (!info.parentID) { t.roots.add(info.id); ownedRoots.add(info.id); if (info.directory) t.directory = info.directory; return; }
      if (!t.subs.has(info.id) && e.type === 'session.created') {
        const sub = newSub(info, t.owner, key);
        t.subs.set(info.id, sub);
        announce(sub, info);
        onSubagentCount?.(key, t.owner, liveSubs(t));
      }
      return;
    }
    if (e.type === 'session.status' && t.roots.has(p.sessionID)) {
      sendTo(t.owner, 'opencode:busy', { ptyId, busy: p.status?.type === 'busy' });
      return;
    }
    // A permission prompt on the tile's own session (plan item 44); subagent prompts aren't surfaced.
    if (e.type === 'permission.asked' && t.roots.has(p.sessionID)) {
      sendTo(t.owner, 'oc-permission', { ptyId, id: p.id, permission: p.permission, patterns: p.patterns, always: p.always, metadata: p.metadata });
      return;
    }
    if (e.type === 'permission.replied' && t.roots.has(p.sessionID)) {
      sendTo(t.owner, 'oc-permission-cleared', { ptyId, id: p.requestID });
      return;
    }
    if (e.type === 'message.updated' && t.roots.has(p.sessionID)) {
      if (p.info?.role === 'assistant') {
        const free = isFreeModel(p.info.modelID) || isFreeModel(p.info.providerID && `${p.info.providerID}/${p.info.modelID}`);
        sendContext(t, ptyId, p.info.tokens, p.info.modelID, free);
        onTokens?.(key, t.owner, tokenSum(p.info.tokens), tokenBreakdown(p.info.tokens), free, t.directory && path.basename(t.directory));
        // Auto compact's /session/{id}/summarize needs the model the tile is actually using.
        if (p.info.providerID) t.providerID = p.info.providerID;
        if (p.info.modelID) t.modelID = p.info.modelID;
      }
      return;
    }
    if (e.type === 'message.part.updated' && t.roots.has(p.sessionID)) {
      if (p.part?.type === 'tool' && p.part.state?.status === 'running') onToolUse?.(key, t.owner, p.part.tool, p.part.state.input, null);
      return;
    }
    const sub = t.subs.get(p.sessionID);
    if (!sub) return;
    if (e.type === 'message.updated' && p.info) {
      sub.roles.set(p.info.id, p.info.role);
      if (p.info.role === 'assistant') {
        const free = isFreeModel(p.info.modelID) || isFreeModel(p.info.providerID && `${p.info.providerID}/${p.info.modelID}`);
        onTokens?.(sub.key, t.owner, tokenSum(p.info.tokens), tokenBreakdown(p.info.tokens), free, t.directory && path.basename(t.directory));
      }
    } else if (e.type === 'message.part.updated' && p.part) {
      if (p.part.type === 'tool' && p.part.state?.status === 'running') onToolUse?.(sub.key, t.owner, p.part.tool, p.part.state.input, null);
      send(sub, partEntries(sub, p.part));
    } else if (e.type === 'session.idle') { const out = []; finish(sub, out); send(sub, out); }
  }

  // The event stream, reconnected until the tile closes (the server takes a moment to start).
  async function listen(t, ptyId) {
    const dec = new TextDecoder();
    while (t.alive) {
      try {
        const r = await fetch(`http://127.0.0.1:${t.port}/event`, { signal: t.abort.signal });
        const reader = r.body.getReader();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line.startsWith('data:')) continue;
            try { handle(t, ptyId, JSON.parse(line.slice(5))); } catch {}
          }
        }
      } catch {}
      if (t.alive) await sleep(1000);
    }
  }

  function watch(ptyId, port, owner) {
    const t = { port, owner, alive: true, abort: new AbortController(), roots: new Set(), subs: new Map(), ctx: 0 };
    tiles.set(ptyId, t);
    listen(t, ptyId);
  }
  function unwatch(ptyId) {
    const t = tiles.get(ptyId);
    if (!t) return;
    t.alive = false;
    try { t.abort.abort(); } catch {}
    tiles.delete(ptyId);
  }

  // The runaway guard's stop for an OpenCode tile: aborts the root session and any running
  // subagent sessions on that tile's server. Never throws.
  async function abort(ptyId) {
    const t = tiles.get(ptyId);
    if (!t) return;
    const ids = [...t.roots, ...[...t.subs.values()].filter(s => !s.done).map(s => s.id)];
    await Promise.all(ids.map(id => fetch(`http://127.0.0.1:${t.port}/session/${id}/abort`, { method: 'POST' }).catch(() => {})));
  }

  // Auto compact (main.js): summarize the tile's root session in place, using the provider/model
  // its own assistant messages report. Never throws; { ok: false } tells the caller to fall back
  // to typing /compact instead.
  async function summarize(ptyId) {
    const t = tiles.get(ptyId);
    if (!t) return { ok: false, error: 'no tile' };
    const root = [...t.roots][0];
    if (!root || !t.providerID || !t.modelID) return { ok: false, error: 'no session/model yet' };
    try {
      const r = await fetch(`http://127.0.0.1:${t.port}/session/${root}/summarize`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerID: t.providerID, modelID: t.modelID }),
      });
      return { ok: r.ok };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // ---------------------------------------------------------------- OpenCode started elsewhere

  let db = null, pollT = null, lastPart = 0;
  function openDb() {
    if (db) return db;
    try { const { DatabaseSync } = require('node:sqlite'); db = new DatabaseSync(DB_PATH, { readOnly: true }); } catch { db = null; }
    return db;
  }
  function poll() {
    if (!config.showExternalAgents || !openDb()) return;
    try {
      const since = startTime - config.agentLookbackSeconds * 1000;
      // Children of sessions no Operant tile owns, a couple of seconds old (a tile's own arrive through its stream first).
      for (const s of db.prepare('select id, parent_id, directory, title, agent from session where parent_id is not null and time_created > ? and time_created < ?')
        .all(since, Date.now() - 2000)) {
        if (external.has(s.id) || ownedRoots.has(s.parent_id) || [...tiles.values()].some(t => t.subs.has(s.id))) continue;
        const sub = newSub({ id: s.id }, primary(), `oc-ext:${s.parent_id}`);
        external.set(s.id, sub);
        announce(sub, { id: s.id, directory: s.directory, title: s.title, agent: s.agent });
      }
      const live = [...external.values()].filter(x => !x.done);
      if (!live.length) return;
      const ids = live.map(x => x.id), marks = ids.map(() => '?').join(',');
      for (const m of db.prepare(`select id, session_id, data from message where session_id in (${marks})`).all(...ids)) {
        try { external.get(m.session_id).roles.set(m.id, JSON.parse(m.data).role); } catch {}
      }
      const parts = db.prepare(`select id, message_id, session_id, data, time_updated from part where session_id in (${marks}) and time_updated >= ? order by time_updated`)
        .all(...ids, lastPart);
      for (const row of parts) {
        lastPart = Math.max(lastPart, row.time_updated);
        const sub = external.get(row.session_id);
        let part;
        try { part = { ...JSON.parse(row.data), id: row.id, messageID: row.message_id }; } catch { continue; }
        send(sub, partEntries(sub, part));
      }
    } catch (e) { console.error('opencode poll failed', e.message); }
  }
  function start() { if (!pollT) pollT = setInterval(poll, 2000); }

  return { freePort, watch, unwatch, start, abort, summarize };
}

// The OpenCode CLI, however its command is written.
const isOpenCode = agent => /(^|[\\/])opencode(\.(exe|cmd|ps1))?$/i.test(String(agent?.command || '').trim().split(/\s+/)[0]);

module.exports = { createOpenCode, isOpenCode };
