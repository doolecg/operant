// OpenCode plugin mirroring Claude Code's UserPromptSubmit -> CodeGraph hook, so OpenCode tiles
// get the same context CodeGraph gives Claude. Operant only adds this to a tile's `plugin` list
// (via OPENCODE_CONFIG_CONTENT, agent-setup.js) when the main agent's own ~/.claude/settings.json
// actually configures that hook, and runs the exact same command it configures.
//
// OpenCode's closest equivalent to a "before prompt" hook is `chat.message`, which runs just
// before the user's message is sent and can add extra text parts to it.
import { execFile } from 'node:child_process';

const COMMAND = process.env.OPERANT_CODEGRAPH_HOOK_COMMAND || 'codegraph.cmd prompt-hook';

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

export const CodegraphPromptPlugin = async ({ directory }) => ({
  'chat.message': async (_input, output) => {
    const promptText = (output.parts || []).filter(p => p.type === 'text').map(p => p.text).join('\n').trim();
    if (!promptText) return;
    const context = extractContext(await runHook(promptText, directory || process.cwd()));
    if (!context) return;
    output.parts.push({ type: 'text', text: `\n<codegraph-context>\n${context}\n</codegraph-context>\n` });
  },
});
