// OpenCode plugin mirroring Claude Code's UserPromptSubmit -> CodeGraph hook, so OpenCode tiles
// get the same context CodeGraph gives Claude. Operant only adds this to a tile's `plugin` list
// (via OPENCODE_CONFIG_CONTENT, agent-setup.js) when the main agent's own ~/.claude/settings.json
// actually configures that hook, and runs the exact same command it configures.
//
// OpenCode's closest equivalent to a "before prompt" hook is `chat.message`, which runs just
// before the user's message is sent and can add extra text parts to it.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const COMMAND = process.env.OPERANT_CODEGRAPH_HOOK_COMMAND || (process.platform === 'win32' ? 'codegraph.cmd prompt-hook' : 'codegraph prompt-hook');

function runHook(promptText, cwd) {
  return new Promise(resolve => {
    const [cmd, ...args] = COMMAND.split(/\s+/);
    let child;
    try {
      child = execFile(cmd, args, { cwd, shell: true, timeout: 15000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        resolve(err ? '' : String(stdout || '').trim());
      });
    } catch { return resolve(''); }
    try {
      child.stdin.write(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: promptText, cwd }));
      child.stdin.end();
    } catch {}
  });
}

// Claude Code hooks can print plain text (used as-is) or JSON with
// hookSpecificOutput.additionalContext; support both.
function extractContext(raw) {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    const ctx = parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.additionalContext;
    if (typeof ctx === 'string') return ctx;
  } catch {}
  return raw;
}

// OpenCode saves the parts exactly as the hook leaves them and fails the whole prompt if one has
// no id/sessionID/messageID. Its part ids sort in creation order: "prt_" + 12 hex (time * 4096 +
// a counter, low 48 bits) + 14 random base62 chars. Mint one just past the highest already on the
// message so the context lands after the user's own text.
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const MASK48 = 0xffffffffffffn;
function nextPartId(parts) {
  let t = (BigInt(Date.now()) * 4096n + 1n) & MASK48;
  for (const p of parts) {
    const m = /^prt_([0-9a-f]{12})/.exec(p.id || '');
    if (m && BigInt('0x' + m[1]) >= t) t = BigInt('0x' + m[1]) + 1n;
  }
  let tail = '';
  for (const b of randomBytes(14)) tail += BASE62[b % 62];
  return 'prt_' + (t & MASK48).toString(16).padStart(12, '0') + tail;
}

export const CodegraphPromptPlugin = async ({ directory }) => ({
  'chat.message': async (input, output) => {
    const promptText = (output.parts || []).filter(p => p.type === 'text').map(p => p.text).join('\n').trim();
    if (!promptText) return;
    // The context is optional but a part without these ids breaks the prompt, so skip it if they're missing.
    const sessionID = (output.message && output.message.sessionID) || input.sessionID;
    const messageID = (output.message && output.message.id) || input.messageID;
    if (!sessionID || !messageID) return;
    const context = extractContext(await runHook(promptText, directory || process.cwd()));
    if (!context) return;
    // synthetic = not typed by the user: the TUI keeps it out of the message bubble and out of undo/copy/fork.
    output.parts.push({
      id: nextPartId(output.parts), sessionID, messageID, type: 'text', synthetic: true,
      text: `\n<codegraph-context>\n${context}\n</codegraph-context>\n`,
    });
  },
});
