// A local model for the lowest team tier, through Ollama. Big Pickle (opencode/big-pickle) stays the first
// choice; when it is busy or its free use has run out (a failover, below) and the local model is installed and
// ready, that one tier runs `ollama/<model>` until Big Pickle has had time to recover. Everything here is pure or
// takes its process spawner, so it is tested without Ollama; main.js owns the one instance and the IPC.
const { spawn: nodeSpawn } = require('child_process');

const MODELS = ['gemma4:e4b', 'gemma4:e2b', 'gemma4:12b'];
const DEFAULT_MODEL = 'gemma4:e4b';
const BASE_URL = 'http://localhost:11434/v1';
const FREE_MODEL = 'opencode/big-pickle';
const FREE_TIER = 'xsmall';
const COOLDOWN_MS = 10 * 60 * 1000;
const WINGET_ARGS = ['install', '--id', 'Ollama.Ollama', '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements'];
const DOWNLOAD_URL = 'https://ollama.com/download';

// The `provider` entry that makes `opencode -m ollama/<model>` work. `user` is the ollama provider the user's own
// OpenCode config already has, if any: their baseURL is kept and OpenCode merges the model into their list.
function providerConfig(model, user) {
  const entry = { npm: '@ai-sdk/openai-compatible', name: 'Ollama', models: { [model]: { name: model } } };
  if (!user?.options?.baseURL) entry.options = { baseURL: BASE_URL };
  return { ollama: entry };
}

// OPENCODE_CONFIG_CONTENT (a JSON string, or empty) with the ollama provider folded in; everything else is kept.
function withProvider(content, model, user) {
  let obj = {};
  try { obj = content ? JSON.parse(content) || {} : {}; } catch { obj = {}; }
  const provider = { ...(obj.provider || {}) };
  const ours = providerConfig(model, user).ollama;
  const cur = provider.ollama || {};
  provider.ollama = { ...ours, ...cur, models: { ...ours.models, ...(cur.models || {}) }, options: { ...(ours.options || {}), ...(cur.options || {}) } };
  return JSON.stringify({ ...obj, provider });
}

// Error text that means Big Pickle can't take the work right now: rate limited, overloaded, timed out, or its free use is used up.
const FREE_FAILURE = /\b(429|502|503|504|529)\b|rate.?limit|too many requests|overload|capacity|timed? ?out|timeout|quota|usage limit|limit (reached|exceeded)|exceeded|insufficient|free (usage|tier|use)|unavailable|busy/i;
const isFreeFailure = text => FREE_FAILURE.test(String(text || ''));
const isFreeModelId = id => id === FREE_MODEL || id === 'big-pickle';

// Remembers that Big Pickle failed, so the tier runs the local model for a while, then tries Big Pickle again.
function createFailover({ now = Date.now, cooldownMs = COOLDOWN_MS } = {}) {
  let down = null;
  return {
    fail(reason) { down = { reason: String(reason || 'unavailable').replace(/\s+/g, ' ').slice(0, 120), until: now() + cooldownMs }; return down; },
    clear() { down = null; },
    active() { if (down && now() >= down.until) down = null; return down; },
  };
}

// The tiers with the lowest one swapped for the local model while Big Pickle is down and the local model is ready.
// The tier says which one is active (`active`) and, on the local one, why (`fallback`, which Settings already shows).
function overlay(tiers, { ready, model, down }) {
  const t = tiers && tiers[FREE_TIER];
  if (!t || t.model !== FREE_MODEL) return tiers;
  const active = ready && down ? { ...t, model: `ollama/${model}`, fallback: `Big Pickle: ${down.reason}`, active: `local (${model})` } : { ...t, active: 'Big Pickle' };
  return { ...tiers, [FREE_TIER]: active };
}
// The same for a { claude, opencode } map of per-mode results ({ tiers, removed, empty }).
function overlayModes(modes, o) {
  const out = {};
  for (const [k, m] of Object.entries(modes || {})) out[k] = m && m.tiers ? { ...m, tiers: overlay(m.tiers, o) } : m;
  return out;
}

// "pulling 3f1c...  45% ▕███▏ 1.2 GB/2.6 GB" -> 45 (the last percentage in the text), or null.
function parsePercent(text) {
  const all = String(text || '').match(/(\d{1,3})%/g);
  if (!all) return null;
  const n = parseInt(all[all.length - 1], 10);
  return n >= 0 && n <= 100 ? n : null;
}

// The install/remove worker. deps: { spawn, which(cmd) -> Promise<path|null>, env() -> Promise<env>, platform, onChange(state) }.
function createLocalModel({ spawn = nodeSpawn, which, env = async () => process.env, platform = process.platform, onChange = () => {}, wait = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  let st = { status: 'none', pct: 0, message: '', model: DEFAULT_MODEL, link: '' };
  let busy = false;
  const set = patch => { st = { ...st, ...patch }; onChange(st); };

  // Runs a command to the end, feeding each chunk of its output to onText. -> exit code (-1: could not start).
  const exec = (cmd, args, onText) => new Promise(async resolve => {
    let child;
    try { child = spawn(cmd, args, { env: await env(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { return resolve(-1); }
    let out = '';
    const feed = d => { out += d.toString('utf8'); onText && onText(d.toString('utf8')); };
    child.stdout && child.stdout.on('data', feed);
    child.stderr && child.stderr.on('data', feed);
    child.on('error', () => resolve(-1));
    child.on('close', code => resolve(code == null ? -1 : code));
  });
  const execOut = (cmd, args) => new Promise(async resolve => {
    let out = '', child;
    try { child = spawn(cmd, args, { env: await env(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch { return resolve({ code: -1, out: '' }); }
    child.stdout && child.stdout.on('data', d => { out += d.toString('utf8'); });
    child.on('error', () => resolve({ code: -1, out }));
    child.on('close', code => resolve({ code: code == null ? -1 : code, out }));
  });

  const find = async () => (await which('ollama')) || null;

  // Is the model there? -> true/false; null when Ollama isn't installed or its server isn't answering.
  async function has(model) {
    const exe = await find();
    if (!exe) return null;
    const r = await execOut(exe, ['list']);
    if (r.code !== 0) return null;
    const want = model.includes(':') ? model : model + ':latest';
    return r.out.split(/\r?\n/).some(l => l.trim().split(/\s+/)[0] === want);
  }

  async function refresh(model = st.model) {
    if (busy) return st;
    const exe = await find();
    if (!exe) { set({ status: 'none', model, message: '', pct: 0 }); return st; }
    const r = await has(model);
    set({ status: r ? 'ready' : 'none', model, pct: 0, message: r === null ? 'Ollama is installed but not running' : '' });
    return st;
  }

  // Ollama installed and its server answering; starts `ollama serve` (detached) when it isn't.
  async function serve(exe) {
    if ((await execOut(exe, ['list'])).code === 0) return true;
    try { const c = spawn(exe, ['serve'], { env: await env(), windowsHide: true, detached: true, stdio: 'ignore' }); c.unref && c.unref(); } catch { return false; }
    for (let i = 0; i < 20; i++) { await wait(500); if ((await execOut(exe, ['list'])).code === 0) return true; }
    return false;
  }

  // Install Ollama when missing (Windows: winget; elsewhere the official installer is linked, never piped into a shell), then pull the model.
  async function install(model = st.model) {
    if (busy) return st;
    busy = true;
    set({ status: 'installing', model, pct: 0, message: 'Checking for Ollama…', link: '' });
    try {
      let exe = await find();
      if (!exe) {
        if (platform !== 'win32') { set({ status: 'error', message: `Install Ollama from ${DOWNLOAD_URL}, then press Install again`, link: DOWNLOAD_URL }); return st; }
        set({ message: 'Installing Ollama (winget)…' });
        const code = await exec('winget', WINGET_ARGS, t => { const p = parsePercent(t); if (p != null) set({ pct: Math.min(p, 99) }); });
        exe = await find();
        if (!exe) { set({ status: 'error', message: code === -1 ? `winget is not available. Install Ollama from ${DOWNLOAD_URL}` : `The Ollama install did not finish (exit ${code}). Install it from ${DOWNLOAD_URL}`, link: DOWNLOAD_URL }); return st; }
      }
      set({ message: 'Starting Ollama…', pct: 0 });
      if (!await serve(exe)) { set({ status: 'error', message: 'Ollama did not start. Open the Ollama app and try again' }); return st; }
      set({ message: `Downloading ${model}…` });
      let tail = '';
      const code = await exec(exe, ['pull', model], t => {
        tail = (tail + t).slice(-400);
        const p = parsePercent(t);
        if (p != null) set({ pct: p });
      });
      if (code !== 0) { set({ status: 'error', message: `Could not download ${model}: ${tail.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').trim().split(/[\r\n]+/).pop() || 'exit ' + code}` }); return st; }
      set({ status: 'ready', pct: 100, message: '' });
      return st;
    } finally { busy = false; }
  }

  // Removes the model (Ollama itself stays).
  async function remove(model = st.model) {
    if (busy) return st;
    busy = true;
    try {
      const exe = await find();
      if (exe) await exec(exe, ['rm', model]);
      set({ status: 'none', pct: 0, message: '', model });
    } finally { busy = false; }
    return st;
  }

  return { install, remove, refresh, state: () => st, setModel: m => { if (!busy && m !== st.model) { st = { ...st, model: m }; } }, busy: () => busy };
}

module.exports = { MODELS, DEFAULT_MODEL, BASE_URL, FREE_MODEL, FREE_TIER, COOLDOWN_MS, WINGET_ARGS, providerConfig, withProvider, isFreeFailure, isFreeModelId, createFailover, overlay, overlayModes, parsePercent, createLocalModel };
