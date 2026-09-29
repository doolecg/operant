// Item 37: a Claude Code PreToolUse hook that reroutes long-running shell commands
// (test/build/install runners) through `operant test`/`operant build`/`operant run`+`wait` instead
// of the agent's own Bash tool, so the raw output never floods the agent's context. On by default
// (Settings > Agents > "Reroute long commands"). It only rewrites the command and never approves it,
// so the rewritten command still goes through the user's normal permission prompts; ending a command
// with `# raw` opts out. Only rewrites when it's actually running inside an Operant tile (env
// OPERANT=1) — Operant passes this script via --settings, so it also runs for Claude sessions started
// outside Operant, and this env check is what keeps it a no-op there.
//
// Wired up from main.js, which writes a small settings.json fragment (just the `hooks` block, never
// touching the user's own ~/.claude/settings.json) pointing Claude Code's --settings flag at
// long-commands.cmd, which runs this file through the packaged Electron exe with
// ELECTRON_RUN_AS_NODE=1 (see bin/operant.cmd for the same pattern).

'use strict';

// Anything with these has too much going on for a single-command rewrite to stay correct
// (piping into something else, redirecting output, chaining with && / ; , a background job, or a
// command substitution) — left alone, same as any command that already calls `operant` itself.
const UNSAFE = /[|&;<>]|\$\(|`/;
// Quotes too: bash and PowerShell escape them differently, so the rewrite can't re-quote the
// command correctly for both.
const QUOTED = /["']/;
const ALREADY_OPERANT = /\boperant\b/i;
// The agent's way out: a command ending in "# raw" runs exactly as written.
const RAW = /#\s*raw$/i;

// Order matters only where a tool has both a test and build subcommand with the same prefix.
const RULES = [
  { re: /^(npm|pnpm|yarn)\s+ci\b/i, kind: 'install' },
  { re: /^(npm|pnpm|yarn)\s+install\b/i, kind: 'install' },
  { re: /^(npm|pnpm|yarn)\s+(run\s+)?test\b/i, kind: 'test' },
  { re: /^(npm|pnpm|yarn)\s+(run\s+)?build\b/i, kind: 'build' },
  { re: /^npx\s+(vitest|jest)\b/i, kind: 'test' },
  { re: /^pytest\b/i, kind: 'test' },
  { re: /^cargo\s+test\b/i, kind: 'test' },
  { re: /^cargo\s+build\b/i, kind: 'build' },
  { re: /^go\s+test\b/i, kind: 'test' },
  { re: /^go\s+build\b/i, kind: 'build' },
  { re: /^\.?\/?gradlew?(\.bat)?\s+test\b/i, kind: 'test' },
  { re: /^\.?\/?gradlew?(\.bat)?\s+build\b/i, kind: 'build' },
  { re: /^mvn\s+test\b/i, kind: 'test' },
  { re: /^mvn\s+package\b/i, kind: 'build' },
  { re: /^mvn\s+install\b/i, kind: 'install' },
  { re: /^dotnet\s+test\b/i, kind: 'test' },
  { re: /^dotnet\s+build\b/i, kind: 'build' },
];

// Which long-running kind a command is, or null if it's not one of ours to touch.
function classify(command) {
  const cmd = String(command || '').trim();
  if (!cmd || UNSAFE.test(cmd) || QUOTED.test(cmd) || ALREADY_OPERANT.test(cmd) || RAW.test(cmd)) return null;
  for (const rule of RULES) if (rule.re.test(cmd)) return rule.kind;
  return null;
}

// A short, shell-safe title for the tile: the first two words, e.g. "npm-install".
function titleFor(command) {
  const words = String(command).trim().split(/\s+/).slice(0, 2).join('-');
  return (words.replace(/[^a-zA-Z0-9._-]/g, '') || 'run').slice(0, 40);
}

function dq(s) { return `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`; }
// PowerShell's double quotes still expand $variables and escape with ` rather than \, so it gets
// single quotes, where only ' itself is special (doubled).
function sq(s) { return `'${String(s).replace(/'/g, "''")}'`; }

// The rewritten command, or null if `command` isn't a long-running kind we know about (or is
// already unsafe/already-operant, via classify). `shell` is 'bash' (default) or 'powershell' —
// Claude Code's Windows tool is named "PowerShell", not "Bash", and the install rewrite below
// pipes through a tiny script that only parses as one or the other.
function rewriteCommand(command, shell = 'bash') {
  const kind = classify(command);
  if (!kind) return null;
  const cmd = String(command).trim();
  const q = shell === 'powershell' ? sq : dq;
  if (kind === 'test') return `operant test ${q(cmd)}`;
  if (kind === 'build') return `operant build ${q(cmd)}`;
  // Installs: start it in its own tile, then wait for it with just the errors.
  const title = titleFor(cmd);
  if (shell === 'powershell') {
    return `$id = (operant run ${q(cmd)} --title ${q(title)}) -split ' ' | Select-Object -Last 1; operant wait $id --errors`;
  }
  return `id=$(operant run ${q(cmd)} --title ${q(title)} | awk '{print $2}'); operant wait "$id" --errors`;
}

// The hook's JSON reply for one PreToolUse event (the parsed stdin), or null to leave the call alone.
// No permissionDecision on purpose: an "allow" would approve the rewritten command unseen, while
// leaving it out keeps Claude Code's normal permission flow in place (updatedInput still applies).
// updatedInput replaces the whole tool input, so the other fields (description, run_in_background...)
// are carried over, and the timeout is raised because operant test/build wait up to 600 s themselves.
function hookOutput(input, env = {}) {
  // Off outside an Operant tile — this is the switch that makes the hook a no-op when Claude
  // Code is run any other way, even though --settings wires the hook up unconditionally.
  if (!input || env.OPERANT !== '1') return null;
  // Claude Code's shell tool is "Bash" on macOS/Linux and "PowerShell" on Windows.
  const shell = input.tool_name === 'PowerShell' ? 'powershell' : input.tool_name === 'Bash' ? 'bash' : null;
  if (input.hook_event_name !== 'PreToolUse' || !shell) return null;
  const toolInput = input.tool_input;
  const command = toolInput && toolInput.command;
  const updated = typeof command === 'string' ? rewriteCommand(command, shell) : null;
  if (!updated) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: { ...toolInput, command: updated, timeout: Math.max(Number(toolInput.timeout) || 0, 600000) },
      additionalContext: `Operant rerouted \`${command.trim()}\` to \`${updated}\`: it runs in its own tile and returns only the summary and failures. `
        + 'Full output: `operant read <tile id>` (`operant tiles` lists them). To run a command unchanged, end it with `# raw`.',
    },
  };
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => { raw += c; });
  process.stdin.on('end', () => {
    let out = null;
    try { out = hookOutput(JSON.parse(raw || '{}'), process.env); } catch {} // never block the tool call over a hook bug
    if (out) process.stdout.write(JSON.stringify(out), () => process.exit(0));
    else process.exit(0);
  });
}

if (require.main === module) main();

module.exports = { classify, rewriteCommand, titleFor, hookOutput };
