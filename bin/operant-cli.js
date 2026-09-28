#!/usr/bin/env node
// Operant control CLI: lets an agent running in an Operant tile drive the app
// (open viewers, run commands in new tiles, read their output, ask the user, etc).
// Node built-ins only, no deps, must start fast.

const POSITIONAL = {
  view: ['path'], edit: ['path'], open: ['target'], diff: ['dir'], usage: [], compact: [],
  run: ['command'], agent: ['prompt'], notify: ['text'], title: ['text'],
  ask: ['question'], ws: ['index'],
  read: ['id'], focus: ['id'], close: ['id'], wait: ['id'], stop: ['id'],
  send: ['id', 'text'],
  browse: ['url'], shot: ['id'], console: ['id'], url: ['id'],
  text: ['id', 'selector'], click: ['id', 'selector'], type: ['id', 'selector', 'text'],
  ports: [], watch: ['id'],
  plan: ['path'], board: [],
};
// Positionals that should swallow the *rest* of the args as one space-joined string.
const JOIN_REST = { run: 'command', agent: 'prompt', notify: 'text', title: 'text', send: 'text', type: 'text' };

// Single source of truth for command help: group (for the grouped list) plus
// usage/description/examples (for `operant help <cmd>`). Keeps the two in sync.
const GROUP_ORDER = ['tiles', 'terminals', 'files', 'browser', 'agents & tasks', 'context', 'misc'];
const COMMANDS = {
  tiles: { group: 'tiles', usage: 'operant tiles', desc: "list this window's tiles", examples: ['operant tiles'] },
  status: { group: 'tiles', usage: 'operant status', desc: 'info about the calling tile', examples: ['operant status'] },
  focus: { group: 'tiles', usage: 'operant focus <id>', desc: 'focus a tile', examples: ['operant focus 7'] },
  close: { group: 'tiles', usage: 'operant close <id> [--force]', desc: 'close a tile', examples: ['operant close 7'] },
  ws: { group: 'tiles', usage: 'operant ws [n] [--name n]', desc: 'switch/name workspace', examples: ['operant ws 2'] },
  title: { group: 'tiles', usage: 'operant title <text...>', desc: 'retitle the calling tile', examples: ['operant title "worker1"'] },

  view: { group: 'files', usage: 'operant view <path> [--focus]', desc: 'open a viewer tile (Markdown/code/images)', examples: ['operant view plan.md'] },
  edit: { group: 'files', usage: 'operant edit <path>', desc: 'open an editor tile', examples: ['operant edit foo.js'] },
  diff: { group: 'files', usage: 'operant diff [dir]', desc: 'open a changes tile', examples: ['operant diff'] },
  open: { group: 'files', usage: 'operant open <target>', desc: 'open a file/folder/URL', examples: ['operant open report.pdf'] },

  run: { group: 'terminals', usage: 'operant run <command...> [--title t] [--cwd c] [--focus]', desc: 'run a command in a new tile, stays open', examples: ['operant run "npm run dev" --title dev'] },
  read: { group: 'terminals', usage: 'operant read <id> [--lines n] [--new] [--errors] [--grep p]', desc: "a tile's terminal output", examples: ['operant read 7 --errors', 'operant read 7 --new'] },
  send: { group: 'terminals', usage: 'operant send <id> <text...> [--enter]', desc: 'type into a tile', examples: ['operant send 7 "y" --enter'] },
  wait: { group: 'terminals', usage: 'operant wait <id> [--idle s] [--timeout s] [--new] [--errors] [--grep p]', desc: 'block until a tile goes quiet or exits, then read (same read filters)', examples: ['operant wait 7 --idle 5', 'operant wait 7 --errors'] },
  stop: { group: 'terminals', usage: 'operant stop <id>', desc: "stop a tile's running agent/command", examples: ['operant stop 7'] },

  browse: { group: 'browser', usage: 'operant browse <url> [--id n] [--focus]', desc: 'open (or navigate) a browser tile', examples: ['operant browse localhost:3000'] },
  shot: { group: 'browser', usage: 'operant shot <id> [--out file.png] [--full]', desc: "screenshot a browser tile's page", examples: ['operant shot 5'] },
  console: { group: 'browser', usage: 'operant console <id> [--errors] [--new] [--lines n]', desc: "a browser tile's console output", examples: ['operant console 5 --errors'] },
  text: { group: 'browser', usage: 'operant text <id> [selector]', desc: "a browser tile's visible page text (cheap, no image)", examples: ['operant text 5'] },
  click: { group: 'browser', usage: 'operant click <id> <selector>', desc: 'click an element in a browser tile', examples: ['operant click 5 "#btn"'] },
  type: { group: 'browser', usage: 'operant type <id> <selector> <text...> [--enter]', desc: 'type into an element in a browser tile', examples: ['operant type 5 "#q" hi --enter'] },
  url: { group: 'browser', usage: 'operant url <id>', desc: "a browser tile's current url/title", examples: ['operant url 5'] },

  agent: { group: 'agents & tasks', usage: 'operant agent <prompt...> [--agent id] [--cwd c] [--title t]', desc: 'start a new agent tile with a prompt', examples: ['operant agent "task..." --title worker'] },
  ask: { group: 'agents & tasks', usage: 'operant ask <question...> [--options "A|B|C"] [--detail d]', desc: 'blocking dialog, returns the choice', examples: ['operant ask "Delete old migrations?" --options "Delete|Keep"'] },
  notify: { group: 'agents & tasks', usage: 'operant notify <text...> [--title t]', desc: 'Windows notification', examples: ['operant notify "Tests pass, ready for review"'] },
  plan: { group: 'agents & tasks', usage: 'operant plan <file.md>', desc: 'show a plan, block until Approve or Change (returns the note)', examples: ['operant plan plan.md'] },
  task: { group: 'agents & tasks', usage: 'operant task add "<text>" [--for id] | claim <id> | done <id> [--note n] | note <id> "<text>"', desc: 'add/claim/finish/note a board task', examples: ['operant task add "fix the login bug"', 'operant task claim 3', 'operant task done 3 --note "fixed in login.js"'] },
  board: { group: 'agents & tasks', usage: 'operant board', desc: 'list every task: id, status, owner, text, last note', examples: ['operant board'] },

  usage: { group: 'context', usage: 'operant usage', desc: "your tile's context size and the plan limits", examples: ['operant usage'] },
  compact: { group: 'context', usage: 'operant compact', desc: "queue a progress note + compact for your tile's next idle moment", examples: ['operant compact'] },

  ports: { group: 'misc', usage: 'operant ports', desc: "list dev-server URLs found in this window's tiles", examples: ['operant ports'] },
  watch: { group: 'misc', usage: 'operant watch <id> --errors [--grep p]', desc: 'notify (and tell the agent on its next call) on a new matching line in a tile (--off to stop, no id to list)', examples: ['operant watch 7 --errors', 'operant watch 7 --off'] },
};

function helpList() {
  const lines = [`operant <cmd> [args] [--flag value] [--json]`, ''];
  for (const group of GROUP_ORDER) {
    const names = Object.keys(COMMANDS).filter(n => COMMANDS[n].group === group);
    if (names.length) lines.push(`  ${group}: ${names.join(', ')}`);
  }
  lines.push('', '  operant help <cmd> for flags and examples.');
  lines.push('  --json prints the raw JSON result instead of formatted text.');
  lines.push('  read/wait: --new only output since your last read, --errors only error/warning lines with context, --grep <pattern> only matching lines.');
  console.log(lines.join('\n'));
}

function helpFor(cmd) {
  const c = COMMANDS[cmd];
  if (!c) {
    console.error(`operant: unknown command "${cmd}"`);
    console.error(`Commands: ${Object.keys(COMMANDS).join(', ')}`);
    process.exit(1);
  }
  const lines = [c.usage, '', `  ${c.desc}`];
  if (c.examples.length) {
    lines.push('', 'Examples:');
    for (const ex of c.examples) lines.push(`  ${ex}`);
  }
  console.log(lines.join('\n'));
}

function parseArgs(argv) {
  const cmd = argv[0];
  const rest = argv.slice(1);
  const flags = {};
  const positionals = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[name] = next; i++; }
      else flags[name] = true;
    } else {
      positionals.push(a);
    }
  }
  return { cmd, positionals, flags };
}

// Turn parsed positionals/flags into the named args object the server expects.
function buildArgs(cmd, positionals, flags) {
  const args = {};
  const names = POSITIONAL[cmd] || [];
  const joinField = JOIN_REST[cmd];
  if (joinField) {
    // First positional(s) before the joined field are consumed normally, the rest is joined.
    const joinIdx = names.indexOf(joinField);
    for (let i = 0; i < joinIdx; i++) {
      const v = positionals[i];
      args[names[i]] = !isNaN(v) && v.trim() !== '' ? Number(v) : v;
    }
    const restWords = positionals.slice(joinIdx);
    if (restWords.length) args[joinField] = restWords.join(' ');
  } else {
    names.forEach((n, i) => {
      if (positionals[i] === undefined) return;
      const v = positionals[i];
      args[n] = !isNaN(v) && v.trim() !== '' ? Number(v) : v;
    });
  }
  for (const [k, v] of Object.entries(flags)) {
    if (k === 'json') continue;
    let val = v;
    if (val === true || val === false) args[k] = val;
    else if (k === 'options') args[k] = String(val).split('|');
    else if (!isNaN(val) && val.trim() !== '') args[k] = Number(val);
    else args[k] = val;
  }
  // ask/ws's first positional is a question/index, not covered by JOIN_REST.
  if (cmd === 'ask' && positionals.length) args.question = positionals.join(' ');
  if (cmd === 'ws' && positionals.length) args.index = Number(positionals[0]);
  // task <sub> <id|text...>: the sub-command decides how the rest of the positionals are read.
  if (cmd === 'task') {
    args.sub = positionals[0];
    if (args.sub === 'add') args.text = positionals.slice(1).join(' ');
    else if (args.sub === 'note') { args.id = Number(positionals[1]); args.text = positionals.slice(2).join(' '); }
    else args.id = Number(positionals[1]);
  }
  // Relative paths mean the shell's current folder, not the folder the tile started in.
  const path = require('path');
  for (const k of ['path', 'dir']) if (typeof args[k] === 'string' && args[k]) args[k] = path.resolve(args[k]);
  if (cmd === 'open' && typeof args.target === 'string' && require('fs').existsSync(args.target)) args.target = path.resolve(args.target);
  return args;
}

function fmtTile(t) {
  const flags = [t.busy && 'busy', t.focused && 'focused', t.self && 'self'].filter(Boolean).map(f => `[${f}]`);
  if (t.runaway) flags.push(`[⚠ ${t.runaway}]`);
  return [t.id, t.kind, t.title, t.cwd, t.tokens, flags.join(' ')].filter(x => x !== undefined && x !== '').join('  ');
}

function footer(result) {
  const { total, shown } = result || {};
  if (typeof total !== 'number' || typeof shown !== 'number' || shown >= total) return '';
  return `\n(showing ${shown} of ${total} lines)`;
}

function formatResult(cmd, result) {
  switch (cmd) {
    case 'tiles': return (result || []).map(fmtTile).join('\n');
    case 'status': return `${result.id}  ${result.kind}  ${result.title}  ${result.cwd}  ws=${result.ws}${result.branch ? '  ' + result.branch : ''}${result.tokens ? '  ' + result.tokens + ' tokens' : ''}`;
    case 'view': case 'edit': case 'diff': case 'run': case 'agent': return `tile ${result.id}`;
    case 'read': return (result.text || '') + footer(result);
    case 'wait': return (result.exited ? '[exited]\n' : '') + (result.text || '') + footer(result);
    case 'stop': return `stopped tile ${result.id} (${result.how})`;
    case 'ask': return result.answer === null ? '(closed)' : String(result.answer);
    case 'ws': return `workspace ${result.current}`;
    case 'browse': return `tile ${result.id}`;
    case 'console': case 'text': return (result.text || '') + footer(result);
    case 'click': case 'type': return result.ok ? 'ok' : JSON.stringify(result);
    case 'url': return [result.id, result.url, result.title, result.loading ? '[loading]' : ''].filter(x => x !== undefined && x !== '').join('  ');
    case 'ports': return (result.ports || []).length ? result.ports.map(p => `${p.id}  ${p.title}  ${p.url}`).join('\n') : '(no dev servers found)';
    case 'watch':
      if (result.watches) return result.watches.length
        ? result.watches.map(w => `${w.id}${w.errors ? '  errors' : ''}${w.grep ? `  grep:"${w.grep}"` : ''}`).join('\n')
        : '(no watches)';
      return result.off ? `stopped watching tile ${result.id}` : `watching tile ${result.id}`;
    case 'plan': return result.approved ? 'approved' : `change: ${result.note || ''}`;
    case 'task': return result.sub === 'add' ? String(result.id) : `${result.id}  ${result.status}${result.note ? `  ${result.note}` : ''}`;
    case 'board': {
      const owner = o => o ? `${o.id} ${o.title}` : '-';
      return (result.tasks || []).length ? result.tasks.map(t => `${t.id}  ${t.status}  ${owner(t.owner)}  ${t.text}${t.note ? `  · ${t.note}` : ''}`).join('\n') : '(no tasks)';
    }
    case 'usage': {
      const lines = [result.max
        ? `context: ${result.tokens.toLocaleString()} / ${result.max.toLocaleString()} tokens (${result.pct}%)`
        : 'context: not available for this tile yet'];
      const l = result.limits;
      const pct = x => x && typeof x.used === 'number' ? `${Math.round(x.used)}%${x.resets ? ` (resets ${new Date(x.resets).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })})` : ''}` : null;
      if (!l) lines.push('plan limits: off (Settings › Usage)');
      else if (l.error) lines.push(l.error);
      else {
        if (pct(l.session)) lines.push(`session (5h): ${pct(l.session)}`);
        if (pct(l.week)) lines.push(`week: ${pct(l.week)}`);
      }
      return lines.join('\n');
    }
    default: return result === undefined || result === null || result === '' || Object.keys(result || {}).length === 0
      ? 'ok' : JSON.stringify(result);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') { helpList(); return; }
  if (argv[0] === 'help') { if (argv[1]) helpFor(argv[1]); else helpList(); return; }

  const api = process.env.OPERANT_API;
  if (!api) {
    console.error('operant: not inside an Operant tile (OPERANT_API is not set)');
    process.exit(2);
  }

  const { cmd, positionals, flags } = parseArgs(argv);
  const args = buildArgs(cmd, positionals, flags);
  const asJson = !!flags.json;

  let res;
  try {
    res = await fetch(`${api}/v1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPERANT_TOKEN || ''}` },
      body: JSON.stringify({ cmd, args, tile: process.env.OPERANT_TILE }),
    });
  } catch (err) {
    if (err && (err.cause?.code === 'ECONNREFUSED' || err.code === 'ECONNREFUSED')) {
      console.error('operant: could not reach Operant (is it still running?)');
    } else {
      console.error(`operant: request failed: ${err.message}`);
    }
    process.exit(1);
  }

  let body;
  try { body = await res.json(); } catch { body = null; }

  if (body && body.warn) console.error(body.warn);

  if (!res.ok || !body || body.ok === false) {
    console.error(`operant: ${body && body.error ? body.error : `request failed (${res.status})`}`);
    process.exit(1);
  }

  if (cmd === 'shot') {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { id, png } = body.result;
    let out = flags.out;
    if (!out) {
      const dir = path.join(os.tmpdir(), 'operant-shots');
      fs.mkdirSync(dir, { recursive: true });
      out = path.join(dir, `tile${id}-${Date.now()}.png`);
    }
    fs.writeFileSync(out, Buffer.from(png, 'base64'));
    if (asJson) console.log(JSON.stringify({ id, path: out }));
    else console.log(out);
    return;
  }

  if (asJson) console.log(JSON.stringify(body.result));
  else {
    const text = formatResult(cmd, body.result);
    if (text) console.log(text);
  }
}

main();
