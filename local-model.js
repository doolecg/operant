// A local model for the free team tier, through Ollama. Big Pickle (opencode/big-pickle) stays the first
// choice; when it is busy or its free use has run out (a fallback route, tier-routes.js) and the local model is
// installed and ready, that tier runs `ollama/<model>` until Big Pickle has had time to recover. Everything here is pure or
// takes its process spawner, so it is tested without Ollama; main.js owns the one instance and the IPC.
const { spawn: nodeSpawn } = require('child_process');
const setup = require('./local-setup');

const MODELS = ['gemma4:e4b', 'gemma4:e2b', 'gemma4:12b'];
const DEFAULT_MODEL = 'gemma4:e4b';
const BASE_URL = 'http://localhost:11434/v1';
const FREE_MODEL = 'opencode/big-pickle';
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

// "pulling 3f1c...  45% ▕███▏ 1.2 GB/2.6 GB" -> 45 (the last percentage in the text), or null.
function parsePercent(text) {
  const all = String(text || '').match(/(\d{1,3})%/g);
  if (!all) return null;
  const n = parseInt(all[all.length - 1], 10);
  return n >= 0 && n <= 100 ? n : null;
}

// The setup worker behind the Settings card. deps: { spawn, which(cmd) -> Promise<path|null>, env() -> Promise<env>, platform,
// onChange(state), probe() -> Promise<bool> (is the server answering on localhost:11434), freeDisk() -> bytes|null,
// totalMem() -> bytes|null, connected(model) -> bool (the OpenCode provider entry is in place) }.
// State: { status: none|confirm|installing|paused|ready|error, pct, message, link, model, parts, failed, plan, info, everReady }.
function createLocalModel({ spawn = nodeSpawn, which, env = async () => process.env, platform = process.platform, onChange = () => {}, wait = ms => new Promise(r => setTimeout(r, ms)),
  probe = null, freeDisk = () => null, totalMem = () => null, connected = () => true, now = Date.now, testTimeoutMs = 180000 } = {}) {
  let st = { status: 'none', pct: 0, message: '', model: DEFAULT_MODEL, link: '', parts: setup.freshParts(), failed: null, plan: null, info: null, everReady: false };
  let busy = false, current = null, cancelled = false;
  const set = patch => { st = { ...st, ...patch }; onChange(st); };
  const part = (id, state, detail, extra) => set({ parts: setup.setPart(st.parts, id, state, detail, extra) });

  // Runs a command to the end, feeding each chunk of its output to onText. -> exit code (-1: could not start).
  const exec = (cmd, args, onText, { timeoutMs = 0 } = {}) => new Promise(async resolve => {
    let child;
    try { child = spawn(cmd, args, { env: await env(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { return resolve(-1); }
    current = child;
    let timer = null;
    if (timeoutMs) timer = setTimeout(() => { try { child.kill && child.kill(); } catch {} }, timeoutMs);
    const feed = d => { onText && onText(d.toString('utf8')); };
    child.stdout && child.stdout.on('data', feed);
    child.stderr && child.stderr.on('data', feed);
    const end = code => { clearTimeout(timer); if (current === child) current = null; resolve(code); };
    child.on('error', () => end(-1));
    child.on('close', code => end(code == null ? -1 : code));
  });
  const execOut = (cmd, args) => new Promise(async resolve => {
    let out = '', child;
    try { child = spawn(cmd, args, { env: await env(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch { return resolve({ code: -1, out: '' }); }
    child.stdout && child.stdout.on('data', d => { out += d.toString('utf8'); });
    child.on('error', () => resolve({ code: -1, out }));
    child.on('close', code => resolve({ code: code == null ? -1 : code, out }));
  });

  const find = async () => (await which('ollama')) || null;
  const listed = async (exe, model) => {
    const r = await execOut(exe, ['list']);
    return r.code === 0 ? setup.parseList(r.out, model) : null;
  };
  // Is the model there? -> true/false; null when Ollama isn't installed or its server isn't answering.
  async function has(model) {
    const exe = await find();
    if (!exe) return null;
    const l = await listed(exe, model);
    return l ? l.has : null;
  }
  const answering = async exe => probe ? !!(await probe()) : (await execOut(exe, ['list'])).code === 0;

  // Sets the parts and info from what is on the machine, without downloading or running the model.
  async function look(model) {
    const exe = await find();
    let parts = setup.freshParts();
    const mk = (id, state, detail) => { parts = setup.setPart(parts, id, state, detail); };
    if (!exe) { set({ status: 'none', model, pct: 0, message: '', parts, info: null }); return; }
    mk('ollama', 'ready', 'Found');
    if (!(await answering(exe))) {
      mk('running', 'idle', 'Not running');
      set({ status: 'none', model, pct: 0, message: 'Ollama is installed but not running', parts, info: null });
      return;
    }
    mk('running', 'ready', 'Answering on localhost:11434');
    const l = await listed(exe, model);
    if (!l || !l.has) {
      mk('model', 'idle', 'Not downloaded');
      set({ status: 'none', model, pct: 0, message: '', parts, info: null });
      return;
    }
    mk('model', 'ready', l.size ? `${setup.fmtBytes(l.size)} on disk` : 'Downloaded');
    const tested = st.model === model && st.parts.ready.state === 'ready';
    mk('ready', tested ? 'ready' : 'idle', tested ? st.parts.ready.detail : 'Not tested yet, press Test it');
    const ok = !!connected(model);
    mk('connected', ok ? 'ready' : 'failed', ok ? 'Provider entry in place' : 'No ollama provider for OpenCode');
    set({ status: 'ready', model, pct: 100, message: '', parts, failed: null, everReady: true, info: { model, bytes: l.size, diskUsed: l.total } });
  }

  async function refresh(model = st.model) {
    if (busy) return st;
    await look(model);
    return st;
  }

  // What would be downloaded, and whether the machine can take it. Nothing is changed.
  async function plan(model = st.model) {
    const exe = await find();
    const running = exe ? await answering(exe) : false;
    const l = exe && running ? await listed(exe, model) : null;
    const p = setup.preflight({ model, platform, ollamaInstalled: !!exe, modelInstalled: !!(l && l.has), freeDisk: freeDisk(), totalMem: totalMem() });
    return { ...p, other: p.suggest ? { model: p.suggest, bytes: (setup.MODEL_INFO[p.suggest] || {}).bytes } : null };
  }

  // Ollama installed and its server answering; starts `ollama serve` (detached) when it isn't.
  async function serve(exe) {
    if (await answering(exe)) return true;
    try { const c = spawn(exe, ['serve'], { env: await env(), windowsHide: true, detached: true, stdio: 'ignore' }); c.unref && c.unref(); } catch { return false; }
    for (let i = 0; i < 20; i++) { await wait(500); if (await answering(exe)) return true; }
    return false;
  }

  const clean = t => setup.stripAnsi(t).trim().split(/[\r\n]+/).filter(Boolean).pop() || '';
  const fail = (partId, what, opts) => {
    const f = setup.failure(partId, what, opts);
    set({ status: 'error', message: what, link: f.link, failed: f, parts: setup.setPart(st.parts, partId, 'failed', what) });
    return st;
  };
  const pause = (partId, what) => {
    set({ status: 'paused', message: what, failed: null, parts: setup.setPart(st.parts, partId, 'idle', what, { paused: true }) });
    return st;
  };

  // The tiny test prompt: the model has to answer. -> { ok, code, text }
  async function tryPrompt(exe, model) {
    let text = '';
    const code = await exec(exe, ['run', model, setup.TEST_PROMPT], t => { text += t; }, { timeoutMs: testTimeoutMs });
    const answer = clean(text);
    return { ok: code === 0 && !!answer && !cancelled, code, text: answer };
  }
  const promptFailure = t => t.code === 0 ? 'The model did not answer the test prompt'
    : `The test prompt failed (${t.code === -1 ? 'timed out or could not start' : 'exit ' + t.code})${t.text ? ': ' + t.text : ''}`;

  // Install Ollama when missing (Windows: winget; elsewhere the official installer is linked, never piped into a shell), start it,
  // pull the model, try it, check the OpenCode entry. `ask`: look first and wait for the user's go-ahead (status 'confirm').
  // Parts already in place are skipped, so this is also the retry for a failed part and the resume after Cancel.
  async function install(model = st.model, { ask = false } = {}) {
    if (busy) return st;
    if (ask) {
      const p = await plan(model);
      if (!p.nothingToDownload || p.notes.length) { set({ status: 'confirm', model, plan: p, message: '', failed: null }); return st; }
    }
    busy = true; cancelled = false;
    set({ status: 'installing', model, pct: 0, message: 'Checking for Ollama…', link: '', failed: null, plan: null, parts: setup.freshParts() });
    try {
      // 1. Ollama
      part('ollama', 'checking', 'Looking for Ollama…');
      let exe = await find();
      if (!exe) {
        if (platform !== 'win32') return fail('ollama', `Install Ollama from ${DOWNLOAD_URL}, then press Install again`, { link: DOWNLOAD_URL, leftover: 'Nothing was installed.' });
        set({ message: 'Installing Ollama (winget)…' });
        part('ollama', 'installing', 'Installing with winget…');
        const code = await exec('winget', WINGET_ARGS, t => { const p = parsePercent(t); if (p != null) { set({ pct: Math.min(p, 99) }); part('ollama', 'installing', `Installing with winget… ${Math.min(p, 99)}%`); } });
        if (cancelled) return pause('ollama', 'Ollama install cancelled. Resume runs the installer again');
        exe = await find();
        if (!exe) return fail('ollama', code === -1 ? `winget is not available. Install Ollama from ${DOWNLOAD_URL}` : `The Ollama install did not finish (exit ${code}). Install it from ${DOWNLOAD_URL}`, { link: DOWNLOAD_URL });
      }
      part('ollama', 'ready', 'Found');
      // 2. Ollama running
      set({ message: 'Starting Ollama…', pct: 0 });
      part('running', 'checking', 'Checking localhost:11434…');
      if (!await answering(exe)) part('running', 'starting', 'Starting Ollama…');
      if (!await serve(exe)) return fail('running', 'Ollama did not start. Open the Ollama app and try again');
      part('running', 'ready', 'Answering on localhost:11434');
      // 3. the model
      part('model', 'checking', 'Checking for the model…');
      const before = await listed(exe, model);
      if (!before || !before.has) {
        set({ message: `Downloading ${model}…` });
        const tracker = setup.createPullTracker({ now });
        part('model', 'downloading', 'Starting the download…');
        let tail = '';
        const code = await exec(exe, ['pull', model], t => {
          tail = (tail + t).slice(-400);
          const snap = tracker.feed(t);
          if (snap.total || snap.phase !== 'starting') { set({ pct: snap.pct }); part('model', 'downloading', setup.progressDetail(snap), { pct: snap.pct, done: snap.done, total: snap.total, speed: snap.speed, etaSec: snap.etaSec }); }
        });
        if (cancelled) { const s = tracker.snapshot(); return pause('model', `Paused${s.total ? ` at ${s.pct}% (${setup.fmtBytes(s.done)} of ${setup.fmtBytes(s.total)})` : ''}. Resume continues from there`); }
        if (code !== 0) return fail('model', `Could not download ${model}: ${clean(tail) || 'exit ' + code}`);
      }
      const l = await listed(exe, model);
      part('model', 'ready', l && l.size ? `${setup.fmtBytes(l.size)} on disk` : 'Downloaded');
      // 4. does it answer
      set({ message: 'Trying the model…', pct: 100 });
      part('ready', 'checking', 'Sending a tiny test prompt…');
      const t = await tryPrompt(exe, model);
      if (cancelled) return pause('ready', 'Cancelled before the test prompt finished');
      if (!t.ok) return fail('ready', promptFailure(t));
      part('ready', 'ready', `Answered: "${t.text.slice(0, 40)}"`);
      // 5. OpenCode
      part('connected', 'checking', 'Checking the OpenCode provider entry…');
      if (!connected(model)) return fail('connected', 'The OpenCode provider entry for the model is missing');
      part('connected', 'ready', 'Provider entry in place');
      set({ status: 'ready', pct: 100, message: '', failed: null, everReady: true, info: { model, bytes: l && l.size, diskUsed: l && l.total } });
      return st;
    } finally { busy = false; current = null; }
  }

  // Stops what is running; the model download keeps its partial files, so install() resumes it.
  function cancel() {
    if (!busy) return st;
    cancelled = true;
    set({ message: 'Cancelling…' });
    try { current && current.kill && current.kill(); } catch {}
    return st;
  }

  // The Test it button: only the test prompt, on a model that is already there.
  async function test(model = st.model) {
    if (busy) return st;
    busy = true; cancelled = false;
    try {
      const exe = await find();
      if (!exe || !(await answering(exe))) return fail('running', 'Ollama is not running');
      part('ready', 'checking', 'Sending a tiny test prompt…');
      const t = await tryPrompt(exe, model);
      if (!t.ok) return fail('ready', promptFailure(t));
      part('ready', 'ready', `Answered: "${t.text.slice(0, 40)}"`);
      set({ status: 'ready', failed: null, message: '' });
      return st;
    } finally { busy = false; current = null; }
  }

  // Removes the model (Ollama itself stays).
  async function remove(model = st.model) {
    if (busy) return st;
    busy = true;
    try {
      const exe = await find();
      if (exe) await exec(exe, ['rm', model]);
      const kept = st.parts.ollama.state === 'ready';
      set({ status: 'none', pct: 0, message: '', model, failed: null, plan: null, info: null, everReady: false,
        parts: kept ? { ...st.parts, model: { state: 'idle', detail: 'Not downloaded' }, ready: { state: 'idle', detail: 'Not started' }, connected: { state: 'idle', detail: 'Not started' } } : setup.freshParts() });
    } finally { busy = false; }
    return st;
  }

  // Drops the go-ahead question or a failure and goes back to what is on the machine.
  async function dismiss() { if (busy) return st; set({ plan: null, failed: null }); return refresh(); }

  return { install, remove, refresh, plan, cancel, test, dismiss, state: () => st, setModel: m => { if (!busy && m !== st.model) { st = { ...st, model: m, plan: null, failed: null }; } }, busy: () => busy };
}

// Cheap classification helpers for the local model: never a prompt refiner. Pure; `run(prompt) -> Promise<string>` is injected.
const taskTypeLib = require('./task-type');
const { redactText: redactForModel } = require('./redact');
const outputCompress = require('./output-compress');
const withTimeout = (p, ms) => new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('timeout')), ms); Promise.resolve(p).then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); }); });
const HELPER_TIMEOUT_MS = 20000;

async function classifyTask(text, { run, ready, fallback = taskTypeLib.classifyTask, timeoutMs = HELPER_TIMEOUT_MS } = {}) {
  const fb = () => fallback(text);
  try {
    if (typeof run !== 'function' || typeof ready !== 'function' || !ready()) return fb();
    const types = taskTypeLib.TYPES;
    const prompt = `Classify this coding task. Answer with exactly one word from: ${types.join(', ')}.

Task:
${redactForModel(String(text || '')).slice(0, 2000)}

Answer:`;
    const word = String(await withTimeout(run(prompt), timeoutMs)).toLowerCase().match(/[a-z]+/);
    return word && types.includes(word[0]) ? word[0] : fb();
  } catch { return fb(); }
}

function clipHeadTail(text, maxChars) {
  return text.length <= maxChars ? text : `${text.slice(0, Math.floor(maxChars * 0.4))}
... ${text.length - maxChars} chars omitted ...
${text.slice(-Math.floor(maxChars * 0.6))}`;
}

async function summariseOutput(text, { run, ready, maxChars = 1500, timeoutMs = HELPER_TIMEOUT_MS } = {}) {
  const s = String(text == null ? '' : text);
  if (s.length < 1500) return s;
  const fb = () => clipHeadTail(outputCompress.compress(s, { minChars: 0, minLines: 0 }), maxChars);
  try {
    if (typeof run !== 'function' || typeof ready !== 'function' || !ready()) return fb();
    const prompt = `Summarise this tool output in under ${Math.floor(maxChars / 6)} words. Keep errors, file paths and exit codes. Do not add advice.

${clipHeadTail(redactForModel(s), 6000)}`;
    const out = redactForModel(String(await withTimeout(run(prompt), timeoutMs)).trim());
    return out ? clipHeadTail(out, maxChars) : fb();
  } catch { return fb(); }
}

// Builds `run` from `ollama run <model> <prompt>`. deps: { model(), which, spawn, env, ready() }.
function createHelper({ model, which, spawn = nodeSpawn, env = async () => process.env, ready = () => false, timeoutMs = HELPER_TIMEOUT_MS } = {}) {
  const run = async prompt => {
    const exe = await which('ollama');
    if (!exe) throw new Error('ollama not found');
    return new Promise(async (resolve, reject) => {
      let out = '', child;
      try { child = spawn(exe, ['run', typeof model === 'function' ? model() : model, prompt], { env: await env(), windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return reject(e); }
      const t = setTimeout(() => { try { child.kill(); } catch {} reject(new Error('timeout')); }, timeoutMs);
      child.stdout && child.stdout.on('data', d => { out += d.toString('utf8'); });
      child.on('error', e => { clearTimeout(t); reject(e); });
      child.on('close', code => { clearTimeout(t); code === 0 ? resolve(out) : reject(new Error(`exit ${code}`)); });
    });
  };
  return {
    run,
    classify: (text, fallback) => classifyTask(text, { run, ready, fallback, timeoutMs }),
    summarise: (text, o) => summariseOutput(text, { run, ready, timeoutMs, ...o }),
  };
}

module.exports = { classifyTask, summariseOutput, createHelper, MODELS, DEFAULT_MODEL, BASE_URL, FREE_MODEL, WINGET_ARGS, providerConfig, withProvider, isFreeFailure, isFreeModelId, parsePercent, createLocalModel };
