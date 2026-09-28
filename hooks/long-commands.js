// Item 37: an optional Claude Code PreToolUse hook that reroutes long-running shell commands
// (test/build/install runners) through `operant test`/`operant build`/`operant run`+`wait` instead
// of the agent's own Bash tool, so the raw output never floods the agent's context. Off by default
// (Settings > Agents > "Reroute long commands"); only rewrites when it's actually running inside an
// Operant tile (env OPERANT=1) — Operant passes this script via --settings, so it also runs for
// Claude sessions started outside Operant, and this env check is what keeps it a no-op there.
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
const ALREADY_OPERANT = /\boperant\b/i;

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
  if (!cmd || UNSAFE.test(cmd) || ALREADY_OPERANT.test(cmd)) return null;
  for (const rule of RULES) if (rule.re.test(cmd)) return rule.kind;
  return null;
}

// A short, shell-safe title for the tile: the first two words, e.g. "npm-install".
function titleFor(command) {
  const words = String(command).trim().split(/\s+/).slice(0, 2).join('-');
  return (words.replace(/[^a-zA-Z0-9._-]/g, '') || 'run').slice(0, 40);
}

function dq(s) { return `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`; }

// The rewritten command, or null if `command` isn't a long-running kind we know about (or is
// already unsafe/already-operant, via classify). `shell` is 'bash' (default) or 'powershell' —
// Claude Code's Windows tool is named "PowerShell", not "Bash", and the install rewrite below
// pipes through a tiny script that only parses as one or the other.
function rewriteCommand(command, shell = 'bash') {
  const kind = classify(command);
  if (!kind) return null;
  const cmd = String(command).trim();
  if (kind === 'test') return `operant test ${dq(cmd)}`;
  if (kind === 'build') return `operant build ${dq(cmd)}`;
  // Installs: start it in its own tile, then wait for it with just the errors.
  const title = titleFor(cmd);
  if (shell === 'powershell') {
    return `$id = (operant run ${dq(cmd)} --title ${dq(title)}) -split ' ' | Select-Object -Last 1; operant wait $id --errors`;
  }
  return `id=$(operant run ${dq(cmd)} --title ${dq(title)} | awk '{print $2}'); operant wait "$id" --errors`;
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => { raw += c; });
  process.stdin.on('end', () => {
    try {
      // Off outside an Operant tile — this is the switch that makes the hook a no-op when Claude
      // Code is run any other way, even though --settings wires the hook up unconditionally.
      if (process.env.OPERANT !== '1') return process.exit(0);
      const input = JSON.parse(raw || '{}');
      // Claude Code's shell tool is "Bash" on macOS/Linux and "PowerShell" on Windows.
      const shell = input.tool_name === 'PowerShell' ? 'powershell' : input.tool_name === 'Bash' ? 'bash' : null;
      if (input.hook_event_name !== 'PreToolUse' || !shell) return process.exit(0);
      const command = input.tool_input && input.tool_input.command;
      const updated = typeof command === 'string' ? rewriteCommand(command, shell) : null;
      if (!updated) return process.exit(0);
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { command: updated },
        },
      }));
      process.exit(0);
    } catch (e) {
      process.exit(0); // never block the tool call over a hook bug
    }
  });
}

if (require.main === module) main();

module.exports = { classify, rewriteCommand, titleFor };
