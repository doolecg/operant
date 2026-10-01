#!/usr/bin/env node
// Regenerates help.json (the stub's `operant help` text) by running the real CLI once per command,
// so the stub says what the real one says. Re-run it against a worktree to snapshot a redesigned CLI:
//   node make-help.mjs [--repo <path>]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const i = process.argv.indexOf('--repo');
const repo = (i > 0 && process.argv[i + 1]) || process.env.OPERANT_EVAL_REPO || path.resolve(here, '..', '..');
const cli = path.join(repo, 'bin', 'operant-cli.js');

// Help never talks to the app, but strip OPERANT_* anyway so this can't reach one by accident.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^OPERANT/i.test(k)));
const run = (...args) => execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\r\n/g, '\n').trimEnd();

// An unknown command prints the full command list on stderr, which is the one list that can't drift
// from the CLI's own table.
let names;
try { run('help', '__list__'); } catch (e) {
  const m = /^Commands: (.+)$/m.exec(String(e.stderr));
  if (!m) throw new Error(`could not read the command list from ${cli}`);
  names = m[1].split(', ');
}

const out = { generatedFrom: repo, list: run('help'), commands: {} };
for (const n of names) out.commands[n] = run('help', n);
fs.writeFileSync(path.join(here, 'help.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`wrote help.json: ${names.length} commands from ${cli}`);
