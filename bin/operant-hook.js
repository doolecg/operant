// `operant hook <event>`: what Operant's Claude Code hooks run. SessionStart and SubagentStart come
// from the agent plugin (agent-plugin/hooks/hooks.json), Stop and PostToolUse from a tile's --settings
// file (main.js). Reads the hook's JSON on stdin and prints the hook's JSON answer. It must never get in
// the agent's way: outside a tile, with Operant closed or slow, or on any error it prints nothing
// and exits 0.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const prime = require('./operant-prime');
const cgFirst = require('../codegraph-first');

const API_TIMEOUT = 3000;

function readStdin(ms = 2000) {
  if (process.stdin.isTTY) return Promise.resolve({});
  return new Promise(resolve => {
    let raw = '';
    const done = () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } };
    const timer = setTimeout(done, ms);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { raw += c; });
    process.stdin.on('end', () => { clearTimeout(timer); done(); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve({}); });
  });
}

async function call(cmd, args) {
  const api = process.env.OPERANT_API;
  if (!api || process.env.OPERANT !== '1') return null;
  const res = await fetch(`${api}/v1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPERANT_TOKEN || process.env.OPERANT_AUTH || ''}` },
    body: JSON.stringify({ cmd, args, tile: process.env.OPERANT_TILE }),
    signal: AbortSignal.timeout(API_TIMEOUT),
  });
  const body = await res.json().catch(() => null);
  return body && body.ok ? body.result : null;
}

// CodeGraph-first gate state: one tiny file per agent (session, plus the subagent's id when Claude Code gives one).
const GATE_DIR = path.join(os.tmpdir(), 'operant-cg');
const GATE_TTL = 24 * 3600 * 1000;
const gateFile = input => path.join(GATE_DIR, crypto.createHash('sha1').update(`${input.session_id || ''}|${input.agent_id || ''}`).digest('hex').slice(0, 20) + '.json');
function readGate(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; } }
function writeGate(file) {
  try {
    fs.mkdirSync(GATE_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ cg: true }));
    const old = Date.now() - GATE_TTL;
    for (const f of fs.readdirSync(GATE_DIR)) {
      const p = path.join(GATE_DIR, f);
      try { if (fs.statSync(p).mtimeMs < old) fs.unlinkSync(p); } catch {}
    }
  } catch {}
}

const HANDLERS = {
  // Every start, resume, /clear, compact and fork: the context from before a compact is summarised
  // away, so it's injected again each time rather than once.
  async 'session-start'(input) {
    const data = await call('prime', { hook: 'session-start' });
    if (!data || data.off) return null;
    const local = prime.readLocal(data.tile?.project || input.cwd || process.cwd());
    return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: prime.formatPrime(data, local) } };
  },
  async 'subagent-start'(input) {
    const r = await call('hook', { event: 'subagent-start' });
    if (!r || r.off) return null;
    return { hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: prime.subagentBrief(prime.readLocal(input.cwd || process.cwd(), { withGit: false })) } };
  },
  // Before the turn ends: agent messages waiting for this tile keep it going, and a worker with its
  // board task open is asked once for the report. The app decides which; stop_hook_active tells it
  // Claude is already continuing because of a Stop hook (a worker is never asked twice, messages drain).
  async stop(input) {
    const r = await call('hook', { event: 'stop', active: !!input.stop_hook_active, output: typeof input.last_assistant_message === 'string' ? input.last_assistant_message.slice(0, 200000) : undefined });
    return r && r.block ? { decision: 'block', reason: r.block } : null;
  },
  // Messaging on: agent messages waiting for this tile, handed over after each tool call.
  async 'post-tool-use'() {
    const r = await call('hook', { event: 'post-tool-use' });
    return r && r.context ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: r.context } } : null;
  },
  // CodeGraph first: a code search by grep is denied until this agent has made a CodeGraph call. Needs no Operant API,
  // so it also holds for subagents and with the app slow or closed. OPERANT_CODEGRAPH_GATE=0 switches it off.
  async 'pre-tool-use'(input) {
    if (process.env.OPERANT_CODEGRAPH_GATE === '0' || !input || typeof input.tool_name !== 'string') return null;
    if (!cgFirst.findIndexRoot(input.cwd || process.cwd(), fs.existsSync)) return null;
    const file = gateFile(input);
    const d = cgFirst.gateDecision({ tool: input.tool_name, input: input.tool_input, state: readGate(file), hasIndex: true });
    if (d.record) { writeGate(file); return null; }
    return d.allow ? null : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: d.reason } };
  },
};

async function run(event) {
  try {
    const handler = HANDLERS[event];
    if (!handler) return;
    const out = await handler(await readStdin());
    if (out) process.stdout.write(JSON.stringify(out));
  } catch {}
}

module.exports = { run, HANDLERS };
