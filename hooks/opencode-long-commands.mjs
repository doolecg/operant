// Item 37 follow-up: the same long-command reroute as hooks/long-commands.js (Claude Code's
// PreToolUse hook), but as an OpenCode plugin using tool.execute.before, which can rewrite a tool
// call's args before it runs. Reuses classify/rewriteCommand from long-commands.js rather than
// duplicating the regexes.
//
// Loaded only for OpenCode processes Operant itself starts, and only when Settings > Agents >
// "Reroute long commands" is on: main.js adds this file's path to the `plugin` array in the
// per-process OPENCODE_CONFIG_CONTENT env var (merged with the user's own opencode.json/opencode.jsonc,
// never written to it). The OPERANT=1 check below is what keeps it a no-op if this file is ever
// loaded any other way (e.g. a user's own opencode.json referencing it directly).
//
// .mjs, not .js: OpenCode's plugin loader (Bun) requires the imported module's export to be a bare
// function, and a CommonJS file re-exported through dynamic import() here comes through as
// `{ default: fn }` rather than `fn` itself, which the loader rejects with "Plugin export is not a
// function". A real ES module with a default export doesn't have that problem.

import { rewriteCommand } from './long-commands.js';

export default async () => ({
  'tool.execute.before': async (input, output) => {
    if (process.env.OPERANT !== '1') return;
    if (!input || input.tool !== 'bash') return;
    const command = output && output.args && output.args.command;
    if (typeof command !== 'string') return;
    const updated = rewriteCommand(command);
    if (updated) output.args.command = updated;
  },
});
