// OpenCode side of Operant's live context. Claude Code tiles get it from the SessionStart and
// SubagentStart hooks (bin/operant-hook.js); OpenCode has no such hooks, so this plugin puts the
// same `operant prime` text into the system prompt of each session in an Operant tile, and the short
// subagent brief into subagent sessions (the ones with a parent). Worked out once per session and
// again after a compaction, so the system prompt stays the same between turns and the prompt cache
// stays warm.
//
// Loaded like the other Operant plugins: main.js lists it in the per-process OPENCODE_CONFIG_CONTENT
// `plugin` array, never the user's opencode.json. A no-op outside an Operant tile. .mjs for the
// reason given in opencode-long-commands.mjs.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const prime = require('../bin/operant-prime.js');

async function call(cmd, args) {
  const res = await fetch(`${process.env.OPERANT_API}/v1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPERANT_TOKEN || ''}` },
    body: JSON.stringify({ cmd, args, tile: process.env.OPERANT_TILE }),
    signal: AbortSignal.timeout(3000),
  });
  const body = await res.json().catch(() => null);
  return body && body.ok ? body.result : null;
}

export default async ({ directory }) => {
  if (process.env.OPERANT !== '1' || !process.env.OPERANT_API) return {};
  const subagents = new Set();
  const replies = new Map(); // sessionID -> { id, parts: Map(partID -> text) } of the latest assistant reply
  const texts = new Map(); // sessionID -> the text to add ('' for nothing)

  async function textFor(sessionID) {
    if (subagents.has(sessionID)) {
      const r = await call('hook', { event: 'subagent-start' });
      return r && !r.off ? prime.subagentBrief(prime.readLocal(directory)) : '';
    }
    const data = await call('prime', { hook: 'session-start' });
    if (!data || data.off) return '';
    return prime.formatPrime(data, prime.readLocal(data.tile?.project || directory));
  }

  return {
    event: async ({ event }) => {
      const info = event?.properties?.info;
      if (event?.type === 'session.created' && info?.parentID) subagents.add(info.id);
      const part = event?.type === 'message.part.updated' ? event.properties?.part : null;
      if (part && part.type === 'text' && typeof part.text === 'string' && part.sessionID && !part.synthetic) {
        let r = replies.get(part.sessionID);
        if (!r || r.id !== part.messageID) replies.set(part.sessionID, r = { id: part.messageID, parts: new Map() });
        r.parts.set(part.id, part.text);
      }
      if (event?.type === 'session.idle' && !subagents.has(event.properties?.sessionID)) {
        const r = replies.get(event.properties?.sessionID);
        const output = r ? [...r.parts.values()].join('\n\n').slice(0, 200000) : '';
        if (output.trim()) await call('hook', { event: 'output', output }).catch(() => {});
      }
      if (event?.type === 'session.compacted') texts.delete(event.properties?.sessionID);
    },
    // Title and summary calls come without a session; they don't need Operant's context.
    'experimental.chat.system.transform': async (input, output) => {
      const id = input?.sessionID;
      if (!id) return;
      if (!texts.has(id)) texts.set(id, await textFor(id).catch(() => ''));
      const text = texts.get(id);
      if (text) output.system.push(text);
    },
  };
};
