// `operant hook <event>`: what Operant's Claude Code hooks run. SessionStart and SubagentStart come
// from the agent plugin (agent-plugin/hooks/hooks.json), Stop and PostToolUse from a tile's --settings
// file (main.js). Reads the hook's JSON on stdin and prints the hook's JSON answer. It must never get in
// the agent's way: outside a tile, with Operant closed or slow, or on any error it prints nothing
// and exits 0.
'use strict';

const prime = require('./operant-prime');

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
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPERANT_TOKEN || ''}` },
    body: JSON.stringify({ cmd, args, tile: process.env.OPERANT_TILE }),
    signal: AbortSignal.timeout(API_TIMEOUT),
  });
  const body = await res.json().catch(() => null);
  return body && body.ok ? body.result : null;
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
    return { hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: prime.subagentBrief(prime.readLocal(input.cwd || process.cwd())) } };
  },
  // Before the turn ends: agent messages waiting for this tile keep it going, and a worker with its
  // board task open is asked once for the report. The app decides which; stop_hook_active tells it
  // Claude is already continuing because of a Stop hook (a worker is never asked twice, messages drain).
  async stop(input) {
    const r = await call('hook', { event: 'stop', active: !!input.stop_hook_active });
    return r && r.block ? { decision: 'block', reason: r.block } : null;
  },
  // Messaging on: agent messages waiting for this tile, handed over after each tool call.
  async 'post-tool-use'() {
    const r = await call('hook', { event: 'post-tool-use' });
    return r && r.context ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: r.context } } : null;
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
