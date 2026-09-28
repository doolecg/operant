// Token usage for agent CLIs besides Claude Code and OpenCode, read from their own session files.
// Neither CLI takes an explicit --session-id from Operant, so a session file is matched to the
// tile that started it by its cwd (main.js keeps a small FIFO of tiles waiting to be claimed).
//
// UNTESTED against a real Codex or Gemini CLI session -- neither is installed on this machine.
// The formats below were read from each project's own source as of September 2026, not guessed:
//   Codex:  codex-rs/protocol/src/protocol.rs (TokenUsage, TokenUsageInfo, TokenCountEvent,
//           SessionMeta) and codex-rs/history/src/lib.rs (RolloutLine) in openai/codex.
//   Gemini: packages/core/src/services/chatRecording{Types,Service}.ts (TokensSummary,
//           MessageRecord, the metadata record) in google-gemini/gemini-cli.
// If either project changes its format, a line that no longer matches is just skipped -- this
// never throws, so a bad or unexpected file degrades to "no token data" for that tile, not a crash.

const path = require('path');
const fs = require('fs');
const os = require('os');

const numField = (o, names) => { for (const n of names) if (o && typeof o[n] === 'number') return o[n]; return 0; };

// A small generic tailer: watches `root` (up to maxDepth subfolders) for files matching `test`,
// and calls onLine(file, line) for each newly-appended line. Shared by Codex and Gemini below.
function createTailer(root, maxDepth, test, onLine) {
  const files = new Map(); // path -> { offset, partial, size }
  async function list(dir, depth, out) {
    let ents;
    try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return out; }
    for (const d of ents) {
      const p = path.join(dir, d.name);
      if (d.isDirectory() && depth < maxDepth) await list(p, depth + 1, out);
      else if (d.isFile() && test(d.name)) out.push(p);
    }
    return out;
  }
  async function readFile(file, st) {
    let f = files.get(file);
    if (!f) files.set(file, f = { offset: 0, partial: '', size: -1 });
    if (st.size === f.size) return;
    if (st.size < f.offset) { f.offset = 0; f.partial = ''; }
    f.size = st.size;
    const fh = await fs.promises.open(file, 'r');
    try {
      while (f.offset < st.size) {
        const len = Math.min(4 << 20, st.size - f.offset);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, f.offset);
        if (!bytesRead) break;
        f.offset += bytesRead;
        const lines = (f.partial + buf.toString('utf8', 0, bytesRead)).split('\n');
        f.partial = lines.pop();
        for (const l of lines) if (l) { try { onLine(file, l); } catch {} }
      }
    } finally { await fh.close(); }
  }
  let timer = null, busy = false;
  async function scan() {
    if (busy) return;
    busy = true;
    try {
      for (const file of await list(root, 0, [])) {
        let st;
        try { st = await fs.promises.stat(file); } catch { continue; }
        try { await readFile(file, st); } catch {}
      }
    } finally { busy = false; }
  }
  return {
    start() { if (!timer) { scan(); timer = setInterval(scan, 5000); } },
    stop() { clearInterval(timer); timer = null; },
  };
}

// ---------------------------------------------------------------- Codex

const CODEX_ROOT = path.join(os.homedir(), '.codex', 'sessions');

// Each line is a RolloutLine: {timestamp, ordinal?, type, payload} (type/payload flattened in from
// the RolloutItem enum). We only care about "session_meta" (has payload.cwd) and "event_msg" whose
// payload.type is "token_count" (payload.info.{total_token_usage,last_token_usage}, each a
// TokenUsage: input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens,
// reasoning_output_tokens, total_tokens).
function parseCodexLine(line) {
  if (!line.includes('"type":"session_meta"') && !line.includes('"type":"event_msg"')) return null;
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  if (o.type === 'session_meta' && o.payload && typeof o.payload.cwd === 'string') return { cwd: o.payload.cwd };
  if (o.type === 'event_msg' && o.payload?.type === 'token_count') {
    const info = o.payload.info;
    if (!info) return null;
    const last = info.last_token_usage, total = info.total_token_usage;
    const t = Date.parse(o.timestamp) || Date.now();
    return {
      t,
      ctxTokens: total ? numField(total, ['total_tokens']) : 0,
      ctxMax: typeof info.model_context_window === 'number' ? info.model_context_window : null,
      last: last ? {
        input: numField(last, ['input_tokens']),
        output: numField(last, ['output_tokens']) + numField(last, ['reasoning_output_tokens']),
        cacheRead: numField(last, ['cached_input_tokens']),
        cacheWrite: numField(last, ['cache_write_input_tokens']),
      } : null,
    };
  }
  return null;
}

// onSession(file, cwd): a rollout file's cwd became known. onUsage(file, event): a token_count line.
function createCodex({ onSession, onUsage }) {
  const cwds = new Map(); // file -> cwd already reported
  return createTailer(CODEX_ROOT, 3, n => /^rollout-.*\.jsonl$/.test(n), (file, line) => {
    const e = parseCodexLine(line);
    if (!e) return;
    if (e.cwd) { if (cwds.get(file) !== e.cwd) { cwds.set(file, e.cwd); onSession(file, e.cwd); } return; }
    if (e.last) onUsage(file, e);
  });
}

// ---------------------------------------------------------------- Gemini CLI

const GEMINI_ROOT = path.join(os.homedir(), '.gemini', 'tmp');

// The first line of a session-*.jsonl is a metadata record {sessionId, projectHash, directories,
// ...}; each later line is a MessageRecord, and an assistant ('gemini') one may carry
// .tokens (TokensSummary: input, output, cached, thoughts?, tool?, total) and .model.
function parseGeminiLine(line) {
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  if (typeof o.sessionId === 'string' && typeof o.projectHash === 'string') {
    const cwd = Array.isArray(o.directories) && typeof o.directories[0] === 'string' ? o.directories[0] : null;
    return cwd ? { cwd } : null;
  }
  if (o.type === 'gemini' && o.tokens) {
    const tk = o.tokens;
    const t = Date.parse(o.timestamp) || Date.now();
    return {
      t,
      model: typeof o.model === 'string' ? o.model : null,
      // No cumulative context total is recorded; this turn's own input+cached is close enough
      // for a rough context size (same approximation used for OpenCode's badge).
      ctxTokens: numField(tk, ['input']) + numField(tk, ['cached']),
      ctxMax: null,
      last: {
        input: numField(tk, ['input']),
        output: numField(tk, ['output']) + numField(tk, ['thoughts']),
        cacheRead: numField(tk, ['cached']),
        cacheWrite: 0,
      },
    };
  }
  return null;
}

function createGemini({ onSession, onUsage }) {
  const cwds = new Map();
  return createTailer(GEMINI_ROOT, 3, n => /^session-.*\.jsonl$/.test(n), (file, line) => {
    const e = parseGeminiLine(line);
    if (!e) return;
    if (e.cwd) { if (cwds.get(file) !== e.cwd) { cwds.set(file, e.cwd); onSession(file, e.cwd); } return; }
    onUsage(file, e);
  });
}

module.exports = { createCodex, createGemini, parseCodexLine, parseGeminiLine };
