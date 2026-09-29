// Smoke test for a built Operant: starts it on a throwaway profile, opens a shell tile and runs the
// `operant` CLI in it (the pty, the shell, PATH, the CLI wrapper and the control API all have to work),
// then opens an agent tile for an agent that isn't installed and checks it says so. Fails on any
// uncaught error in the main process or the window. CI runs it on each OS's packaged app:
//   node test/smoke.mjs <app executable> [app args]
// From a checkout: node test/smoke.mjs node_modules/electron/dist/electron.exe .
// SMOKE_SHELL=<path> sets the tiles' shell (e.g. Git's bash.exe, to run the macOS/Linux sh launches on Windows).
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [exe, ...extra] = process.argv.slice(2);
if (!exe) { console.error('usage: node test/smoke.mjs <app executable> [app args]'); process.exit(2); }
const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const port = 9400 + Math.floor(Math.random() * 500);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'operant-smoke-'));
const out = path.join(profile, 'cli-out.txt'), agentOut = path.join(profile, 'agent-out.txt');
// The second agent is node writing a file: its arguments carry quotes and parentheses, which have to
// reach it intact through the shell's quoting. The path has forward slashes: Git Bash on Windows
// (SMOKE_SHELL) re-reads its command line and turns \\ into \.
const writer = `require('fs').writeFileSync(${JSON.stringify(agentOut.replace(/\\/g, '/'))}, "agent ok (it's quoted)")`;
fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
  autoUpdate: false, showExternalAgents: false, masterOnStartup: false, onboarded: true, agentChosen: true,
  restoreSession: 'never', gpuTerminals: false, notifications: false, tokenUsage: false, planLimits: false,
  mediaControls: false, codegraphOnStartup: 'off', confirmClose: false, autoCloseDoneAgentsSeconds: 0, idleCloseTerminalMinutes: 0,
  agents: [{ id: 'smoke', name: 'Smoke', command: 'operant-smoke-missing', args: [] },
    { id: 'writer', name: 'Writer', command: 'node', args: ['-e', writer] }],
  defaultAgent: 'smoke',
  ...(process.env.SMOKE_SHELL ? { shell: process.env.SMOKE_SHELL } : {}),
}));

const env = { ...process.env, OPERANT_USER_DATA: profile, OPERANT_BACKGROUND: '1' };
for (const k of ['ELECTRON_RUN_AS_NODE', 'OPERANT_API', 'OPERANT_TOKEN', 'OPERANT_TILE', 'OPERANT_EXE']) delete env[k];
// zsh with no startup files at all opens its first-run menu, which would eat what the test types.
if (/zsh$/.test(process.env.SMOKE_SHELL || '') && !env.ZDOTDIR) { env.ZDOTDIR = profile; fs.writeFileSync(path.join(profile, '.zshrc'), ''); }
// The window opens behind everything else; these keep it drawing there.
const keepDrawing = ['--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion'];
const app = spawn(exe, [...extra, `--remote-debugging-port=${port}`, ...keepDrawing], { env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
let appLog = '';
app.stdout.on('data', d => { appLog += d; });
app.stderr.on('data', d => { appLog += d; });
app.on('exit', code => { appLog += `\n[app exited with ${code}]`; });

function stop() {
  if (process.platform === 'win32') { try { execFileSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
  else { try { process.kill(-app.pid, 'SIGKILL'); } catch {} }
}
async function until(what, fn, ms = 30000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) { const v = await fn(); if (v) return v; }
  throw new Error(`timed out: ${what}`);
}

const errors = [];
let cdp, lastText = '';
try {
  const wsUrl = await until('the Operant window', async () => {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      return list.find(t => t.type === 'page' && /renderer[\\/]index\.html/.test(t.url))?.webSocketDebuggerUrl;
    } catch { return null; }
  }, 60000);
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = m => {
    const d = JSON.parse(m.data);
    if (d.id) { pending.get(d.id)?.(d); pending.delete(d.id); }
    else if (d.method === 'Runtime.exceptionThrown') errors.push(`window: ${d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text}`);
  };
  cdp = (method, params = {}) => new Promise(res => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expr => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  await cdp('Runtime.enable');

  const MODS = { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 };
  const press = async combo => {
    const parts = combo.split('+'), key = parts.pop(), shift = parts.includes('Shift');
    const k = key.length === 1 ? { key: shift ? key : key.toLowerCase(), code: 'Key' + key, windowsVirtualKeyCode: key.charCodeAt(0) }
      : { key, code: key, windowsVirtualKeyCode: 13, text: '\r' };
    const modifiers = parts.reduce((m, p) => m | MODS[p], 0);
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', modifiers, ...k });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...k });
  };
  const terms = () => evaluate(`document.querySelectorAll('.xterm').length`);
  const lastTerm = () => evaluate(`[...document.querySelectorAll('.xterm')].at(-1)?.querySelector('.xterm-rows')?.textContent || ''`);
  const newTile = async combo => {
    const before = await terms();
    await press(combo);
    await until(`a tile from ${combo}`, async () => (await terms()) > before);
  };

  await until('the window to load', () => evaluate(`!!document.querySelector('#bar') && document.readyState === 'complete'`));
  await sleep(1500);

  // A shell tile, and the CLI inside it.
  await newTile('Alt+Shift+T');
  await until('the shell prompt', async () => (lastText = await lastTerm()).trim());
  await sleep(1500);
  await evaluate(`[...document.querySelectorAll('.xterm-helper-textarea')].at(-1).focus()`);
  await cdp('Input.insertText', { text: `operant version > "${out}"` });
  await press('Enter');
  const said = await until('operant version in the shell tile', async () => {
    lastText = await lastTerm();
    try { const b = fs.readFileSync(out); const s = b.toString(b[0] === 0xff && b[1] === 0xfe ? 'utf16le' : 'utf8'); return s.includes(version) && s; } catch { return null; }
  });
  console.log(`shell tile: operant version -> ${said.replace(/\0/g, '').trim()}`);

  // operant run: a new tile runs the command, then stays open as a shell.
  let before = await terms();
  await cdp('Input.insertText', { text: 'operant run "echo run-ok"' });
  await press('Enter');
  await until('the operant run tile', async () => (await terms()) > before);
  await until('its output', async () => (lastText = await lastTerm()).includes('run-ok'));
  await sleep(2500);
  lastText = await lastTerm();
  if ((await terms()) <= before || /not found|No such file|cannot execute|not recognized/i.test(lastText)) throw new Error("the operant run tile didn't stay open as a shell");
  console.log('run tile: ran the command and stayed open');

  // An agent tile whose agent isn't installed explains it and waits.
  await newTile('Alt+Enter');
  await until('the missing-agent message', async () => (lastText = await lastTerm()).includes("isn't installed"));
  console.log('agent tile: explains a missing agent');

  // An agent from the picker (Alt+N, 2) gets its arguments intact.
  before = await terms();
  await press('Alt+N');
  await sleep(500);
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: '2', code: 'Digit2', windowsVirtualKeyCode: 50 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: '2', code: 'Digit2', windowsVirtualKeyCode: 50 });
  const wrote = await until("the second agent's file", () => { try { return fs.readFileSync(agentOut, 'utf8'); } catch { return null; } });
  if (wrote !== "agent ok (it's quoted)") throw new Error(`the agent got its arguments mangled: ${wrote}`);
  console.log('agent tile: arguments reach the agent intact');

  const logFile = path.join(profile, 'operant.log');
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  for (const l of log.split('\n')) if (/uncaughtException/.test(l)) errors.push(`main: ${l}`);
  for (const l of log.split('\n')) if (/unhandledRejection/.test(l)) console.log(`warning: ${l}`);
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('smoke test passed');
} catch (e) {
  console.error(`smoke test failed: ${e.message}`);
  if (lastText) console.error(`last tile text:\n${lastText}`);
  if (errors.length) console.error(errors.join('\n'));
  console.error(`app output:\n${appLog.slice(-4000)}`);
  process.exitCode = 1;
} finally {
  stop();
  await sleep(1000);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit();
}
