// Pure logic for the guided local-model setup card (Settings > Agents > Local model): the five parts and their
// states, the pull-progress parser (percent, bytes, speed, time left), the checks made before anything is
// downloaded (size, disk, memory), the failure text, and the health row. No I/O, so it is tested without Ollama.

const GB = 1e9;
const GIB = 1024 ** 3;

const PARTS = [
  { id: 'ollama', label: 'Ollama' },
  { id: 'running', label: 'Ollama running' },
  { id: 'model', label: 'Model' },
  { id: 'ready', label: 'Ready to use' },
  { id: 'connected', label: 'Connected to OpenCode' },
];
const PART_STATES = ['idle', 'checking', 'downloading', 'installing', 'starting', 'ready', 'failed'];
const partLabel = id => (PARTS.find(p => p.id === id) || { label: id }).label;

const OLLAMA_BYTES = 1 * GB;
// Approximate download size (e4b as measured with `ollama list`, the others estimated) and the memory the model wants;
// the real size is read back from Ollama afterwards.
const MODEL_INFO = {
  'gemma4:e4b': { bytes: 9.6 * GB, ramGB: 8 },
  'gemma4:e2b': { bytes: 7.2 * GB, ramGB: 4 },
  'gemma4:12b': { bytes: 8 * GB, ramGB: 16 },
};
const TEST_PROMPT = 'Reply with the single word: ok';

const UNITS = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };
const parseSize = s => {
  const m = /^\s*([\d.]+)\s*([KMGT]?B)\s*$/i.exec(String(s || ''));
  return m ? Math.round(parseFloat(m[1]) * UNITS[m[2].toUpperCase()]) : null;
};
const fmtBytes = n => {
  if (n == null || !isFinite(n)) return '?';
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)} TB`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.max(0, Math.round(n / 1e3))} KB`;
};
const fmtSpeed = bps => (bps > 0 ? `${fmtBytes(bps)}/s` : '');
const fmtEta = sec => {
  if (sec == null || !isFinite(sec) || sec < 0) return '';
  if (sec < 60) return `${Math.max(1, Math.round(sec))} s left`;
  if (sec < 3600) return `${Math.round(sec / 60)} min left`;
  return `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min left`;
};

const stripAnsi = t => String(t || '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');

// Ollama's `pull` prints one progress line per layer:
//   pulling 3f1c8a: 45% ▕████████        ▏ 1.2 GB/2.6 GB  45 MB/s  30s
// Feed it the raw output; it adds the layers up. snapshot() -> { pct, done, total, speed, etaSec, phase }.
const PULL_LINE = /pulling\s+([0-9a-z]+):\s+(\d{1,3})%.*?([\d.]+\s*[KMGT]?B)\s*\/\s*([\d.]+\s*[KMGT]?B)(?:\s+([\d.]+\s*[KMGT]?B)\/s)?/i;
function createPullTracker({ now = Date.now, windowMs = 6000 } = {}) {
  const layers = new Map();
  let phase = 'starting', reported = null, samples = [], barePct = null;
  const sum = () => { let done = 0, total = 0; for (const l of layers.values()) { done += l.done; total += l.total; } return { done, total }; };
  function feed(text) {
    for (const line of stripAnsi(text).split(/[\r\n]+/)) {
      const m = PULL_LINE.exec(line);
      if (m) {
        const done = parseSize(m[3]), total = parseSize(m[4]);
        if (done == null || total == null) continue;
        layers.set(m[1], { done, total });
        if (m[5]) reported = parseSize(m[5]);
        phase = 'downloading';
        const { done: d } = sum();
        samples.push([now(), d]);
        const cut = now() - windowMs;
        samples = samples.filter(s => s[0] >= cut);
      } else if (/pulling\s+\S+:\s+(\d{1,3})%/i.test(line)) {
        barePct = Math.min(100, parseInt(/(\d{1,3})%/.exec(line)[1], 10)); phase = 'downloading';
      } else if (/verifying/i.test(line)) phase = 'verifying';
      else if (/writing manifest/i.test(line)) phase = 'finishing';
      else if (/^\s*success/i.test(line)) phase = 'done';
    }
    return snapshot();
  }
  function snapshot() {
    const { done, total } = sum();
    let speed = null;
    if (samples.length >= 2) {
      const [t0, b0] = samples[0], [t1, b1] = samples[samples.length - 1];
      if (t1 > t0 && b1 >= b0) speed = ((b1 - b0) / (t1 - t0)) * 1000;
    }
    if (!(speed > 0) && reported) speed = reported;
    const etaSec = speed > 0 && total > done ? (total - done) / speed : null;
    const pct = phase === 'done' ? 100 : total ? Math.min(99, Math.floor((done / total) * 100)) : barePct != null ? Math.min(99, barePct) : 0;
    return { pct, done, total, speed, etaSec, phase };
  }
  return { feed, snapshot };
}

const progressDetail = s => {
  if (s.phase === 'verifying') return 'Verifying the download…';
  if (s.phase === 'finishing') return 'Finishing…';
  if (!s.total) return 'Starting the download…';
  return [`${s.pct}%`, `${fmtBytes(s.done)} of ${fmtBytes(s.total)}`, fmtSpeed(s.speed), fmtEta(s.etaSec)].filter(Boolean).join(' · ');
};

const freshParts = () => Object.fromEntries(PARTS.map(p => [p.id, { state: 'idle', detail: 'Not started' }]));
function setPart(parts, id, state, detail, extra = {}) {
  if (!PART_STATES.includes(state)) throw new Error(`unknown part state ${state}`);
  return { ...parts, [id]: { state, detail: detail == null ? parts[id].detail : detail, ...extra } };
}

// What will happen and whether the machine can take it. `have`: { ollama, model } installed already.
// -> { model, downloads: [{ what, bytes }], totalBytes, disk: { free, need, ok }, memory: { total, need, ok }, suggest, blocked, notes }
function preflight({ model, platform = 'win32', ollamaInstalled, modelInstalled, freeDisk = null, totalMem = null }) {
  const info = MODEL_INFO[model] || null;
  const downloads = [];
  const notes = [];
  if (!ollamaInstalled) {
    if (platform === 'win32') downloads.push({ what: 'Ollama', bytes: OLLAMA_BYTES });
    else notes.push('Ollama is not installed. Get it from the Ollama download page, then come back here.');
  }
  if (!modelInstalled) downloads.push({ what: model, bytes: info ? info.bytes : null });
  const totalBytes = downloads.reduce((n, d) => n + (d.bytes || 0), 0);
  const need = Math.round(totalBytes * 1.2);
  const disk = { free: freeDisk, need, ok: freeDisk == null ? null : freeDisk >= need };
  const needMem = info ? info.ramGB * GIB * 0.9 : null;
  const memory = { total: totalMem, needGB: info ? info.ramGB : null, ok: totalMem == null || needMem == null ? null : totalMem >= needMem };
  let suggest = null;
  if (memory.ok === false) {
    suggest = Object.entries(MODEL_INFO)
      .filter(([m, i]) => i.ramGB < info.ramGB && totalMem >= i.ramGB * GIB * 0.9)
      .sort((a, b) => b[1].ramGB - a[1].ramGB)[0]?.[0] || null;
    if (!suggest) notes.push('This computer has little memory; the model may be very slow.');
  }
  if (disk.ok === false) notes.push(`Not enough free disk space: ${fmtBytes(need)} needed, ${fmtBytes(freeDisk)} free.`);
  return { model, downloads, totalBytes, disk, memory, suggest, blocked: disk.ok === false, notes, nothingToDownload: !downloads.length };
}

// The failure record shown on the card: the part, what happened, whether anything was left half-installed.
const LEFTOVER = {
  ollama: 'Ollama may be partly installed. Retrying runs the installer again.',
  running: 'Ollama is installed and nothing is half-installed.',
  model: 'What was already downloaded is kept, so retrying continues from there.',
  ready: 'The model is fully downloaded and kept. Nothing is half-installed.',
  connected: 'The model is installed and works. Nothing is half-installed.',
};
function failure(part, what, { leftover, link } = {}) {
  return { part, label: partLabel(part), what: String(what || 'it did not finish'), leftover: leftover || LEFTOVER[part] || '', link: link || '', retry: `Retry ${partLabel(part).toLowerCase()}` };
}

// `ollama list` -> { has(model), sizeOf(model), total } (sizes in bytes; null when unlisted).
function parseList(out, model) {
  const want = model && (model.includes(':') ? model : model + ':latest');
  let size = null, total = 0, has = false;
  for (const l of String(out || '').split(/\r?\n/).slice(1)) {
    const name = l.trim().split(/\s+/)[0];
    if (!name) continue;
    const m = /([\d.]+\s*[KMGT]?B)\b/i.exec(l.slice(name.length));
    const bytes = m ? parseSize(m[1]) : null;
    if (bytes) total += bytes;
    if (name === want) { has = true; size = bytes; }
  }
  return { has, size, total };
}

// The health row (health.js) for the whole card. -> { state, detail }
function healthOf(s) {
  if (!s) return { state: 'unknown', detail: 'Not checked yet' };
  const parts = s.parts || {};
  const failed = s.failed || Object.values(parts).find(p => p.state === 'failed');
  if (s.status === 'installing') return { state: 'available', detail: `Setting up ${s.model}: ${s.message || 'working'}` };
  if (s.status === 'confirm' || s.status === 'paused') return { state: 'available', detail: s.status === 'paused' ? `Setup of ${s.model} is paused` : `${s.model} is not installed yet` };
  if (s.status === 'error' || failed) return { state: 'degraded', detail: `${failed && failed.label ? failed.label + ' failed: ' : ''}${(failed && failed.what) || s.message || 'setup failed'}` };
  if (s.status === 'ready') {
    if (parts.running && parts.running.state !== 'ready') return { state: 'degraded', detail: `${s.model} is installed but Ollama is not running` };
    if (parts.connected && parts.connected.state === 'failed') return { state: 'degraded', detail: `${s.model} is installed but not connected to OpenCode` };
    return { state: 'healthy', detail: `${s.model} is installed and Ollama is running${parts.ready && parts.ready.state === 'ready' ? ', test prompt answered' : ''}` };
  }
  if (s.everReady) return { state: 'degraded', detail: `${s.model} was ready and now is not (${s.message || 'Ollama is not answering'})` };
  return { state: 'not-configured', detail: s.message || 'No local model installed' };
}

module.exports = {
  PARTS, PART_STATES, MODEL_INFO, OLLAMA_BYTES, TEST_PROMPT,
  partLabel, parseSize, fmtBytes, fmtSpeed, fmtEta, stripAnsi, createPullTracker, progressDetail,
  freshParts, setPart, preflight, failure, parseList, healthOf,
};
