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
};
// Positionals that should swallow the *rest* of the args as one space-joined string.
const JOIN_REST = { run: 'command', agent: 'prompt', notify: 'text', title: 'text', send: 'text', type: 'text' };

function usage() {
  console.log(`operant <cmd> [args] [--flag value] [--json]

  tiles                          list this window's tiles
  status                         info about the calling tile
  view <path> [--focus]          open a viewer tile
  edit <path>                    open an editor tile
  diff [dir]                     open a changes tile
  run <command...> [--title t] [--cwd c] [--focus]   run a command in a new tile
  agent <prompt...> [--agent id] [--cwd c] [--title t]  start an agent tile
  usage                          your tile's context size and the plan limits
  compact                        queue a progress note + compact for your tile's next idle moment
  read <id> [--lines n] [--new] [--errors] [--grep p]  read a tile's terminal output
  send <id> <text...> [--enter]  type into a tile
  wait <id> [--idle s] [--timeout s] [--new] [--errors] [--grep p]   wait for a tile to go quiet
  stop <id>                      stop a tile's running agent/command
  notify <text...> [--title t]   Windows notification
  title <text...>                retitle the calling tile
  focus <id>                     focus a tile
  close <id> [--force]           close a tile
  ask <question...> [--options "A|B|C"] [--detail d]  ask the user
  open <target>                  open a file/folder/URL
  ws [n] [--name n]              switch/name workspace
  browse <url> [--id n] [--focus]   open (or navigate) a browser tile
  shot <id> [--out file.png] [--full]   screenshot a browser tile's page
  console <id> [--errors] [--new] [--lines n]   a browser tile's console output
  text <id> [selector]           a browser tile's visible page text
  click <id> <selector>          click an element in a browser tile
  type <id> <selector> <text...> [--enter]   type into an element in a browser tile
  url <id>                       a browser tile's current url/title
  ports                          list dev-server URLs found in this window's tiles
  watch <id> --errors [--grep p]  notify on a new matching line in a tile (--off to stop, no id to list)

  --json prints the raw JSON result instead of formatted text.
  read/wait: --new only output since your last read, --errors only error/warning lines with context, --grep <pattern> only matching lines.`);
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
  return args;
}

function fmtTile(t) {
  const flags = [t.busy && 'busy', t.focused && 'focused', t.self && 'self'].filter(Boolean).map(f => `[${f}]`);
  if (t.runaway) flags.push(`[⚠ ${t.runaway}]`);
  return [t.id, t.kind, t.title, t.cwd, flags.join(' ')].filter(x => x !== undefined && x !== '').join('  ');
}

function footer(result) {
  const { total, shown } = result || {};
  if (typeof total !== 'number' || typeof shown !== 'number' || shown >= total) return '';
  return `\n(showing ${shown} of ${total} lines)`;
}

function formatResult(cmd, result) {
  switch (cmd) {
    case 'tiles': return (result || []).map(fmtTile).join('\n');
    case 'status': return `${result.id}  ${result.kind}  ${result.title}  ${result.cwd}  ws=${result.ws}${result.branch ? '  ' + result.branch : ''}`;
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
  if (!argv.length || argv[0] === 'help' || argv[0] === '--help') { usage(); return; }

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
