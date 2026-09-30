// Item 95: the setup card's logic (local-setup.js, pure) and the worker (local-model.js) against a fake Ollama and a fake winget,
// once for every state a part can reach and once for every failure.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const setup = require('../local-setup');
const lm = require('../local-model');
const { CHECKS } = require('../health');

const GB = 1e9;
const PULL = [
  'pulling manifest\n',
  'pulling aa11: 10% |#   | 0.3 GB/3.0 GB  30 MB/s  1m30s\r',
  'pulling aa11: 50% |##  | 1.5 GB/3.0 GB  40 MB/s  40s\r',
  'pulling bb22: 100% |####| 1.0 KB/1.0 KB\r',
  'verifying sha256 digest\nwriting manifest\nsuccess\n',
];

// ---- pure module
test('sizes, speed and time left read like a person would say them', () => {
  assert.equal(setup.parseSize('1.2 GB'), 1.2e9);
  assert.equal(setup.parseSize('45 MB'), 45e6);
  assert.equal(setup.parseSize('nonsense'), null);
  assert.equal(setup.fmtBytes(5 * GB), '5.0 GB');
  assert.equal(setup.fmtBytes(300e6), '300 MB');
  assert.equal(setup.fmtEta(40), '40 s left');
  assert.equal(setup.fmtEta(150), '3 min left');
  assert.equal(setup.fmtSpeed(40e6), '40 MB/s');
});

test('the pull tracker adds the layers up: percent, bytes, speed, time left', () => {
  let t = 0;
  const tr = setup.createPullTracker({ now: () => t });
  tr.feed('\x1b[?25lpulling manifest\r');
  t = 1000; tr.feed('pulling aa11: 10% |#    | 0.3 GB/3.0 GB  30 MB/s  1m30s\r');
  t = 2000; const s = tr.feed('pulling aa11: 20% |##   | 0.6 GB/3.0 GB  30 MB/s  1m20s\r');
  assert.equal(s.pct, 20);
  assert.equal(s.done, 0.6 * GB);
  assert.equal(s.total, 3 * GB);
  assert.equal(Math.round(s.speed / 1e6), 300);     // measured: 0.3 GB in a second
  assert.equal(Math.round(s.etaSec), 8);            // 2.4 GB left at 300 MB/s
  tr.feed('pulling bb22: 50% |#| 0.5 KB/1.0 KB\r');
  assert.equal(tr.snapshot().total, 3 * GB + 1000);
  assert.equal(tr.feed('success\n').pct, 100);
  assert.match(setup.progressDetail(s), /20% · 600 MB of 3\.0 GB · 300 MB\/s · 8 s left/);
});

test('a bare percentage (no sizes) still moves the bar; verifying is a phase, not a number', () => {
  const tr = setup.createPullTracker();
  assert.equal(tr.feed('pulling 3f: 60% \r').pct, 60);
  assert.equal(tr.feed('verifying sha256 digest').phase, 'verifying');
});

test('preflight: what downloads, disk, memory, and the smaller model when e4b will not run', () => {
  const ok = setup.preflight({ model: 'gemma4:e4b', ollamaInstalled: false, modelInstalled: false, freeDisk: 100 * GB, totalMem: 16 * 1024 ** 3 });
  assert.deepEqual(ok.downloads.map(d => d.what), ['Ollama', 'gemma4:e4b']);
  assert.equal(ok.totalBytes, setup.OLLAMA_BYTES + setup.MODEL_INFO['gemma4:e4b'].bytes);
  assert.equal(ok.disk.ok, true);
  assert.equal(ok.memory.ok, true);
  assert.equal(ok.suggest, null);
  assert.equal(ok.blocked, false);

  const small = setup.preflight({ model: 'gemma4:e4b', ollamaInstalled: true, modelInstalled: false, freeDisk: 100 * GB, totalMem: 6 * 1024 ** 3 });
  assert.deepEqual(small.downloads.map(d => d.what), ['gemma4:e4b']);
  assert.equal(small.memory.ok, false);
  assert.equal(small.suggest, 'gemma4:e2b');

  const tiny = setup.preflight({ model: 'gemma4:e4b', ollamaInstalled: true, modelInstalled: false, totalMem: 2 * 1024 ** 3 });
  assert.equal(tiny.suggest, null);
  assert.ok(tiny.notes.some(n => /little memory/.test(n)));

  const full = setup.preflight({ model: 'gemma4:e4b', ollamaInstalled: true, modelInstalled: false, freeDisk: 2 * GB, totalMem: 16 * 1024 ** 3 });
  assert.equal(full.blocked, true);
  assert.match(full.notes[0], /Not enough free disk space/);

  const linux = setup.preflight({ model: 'gemma4:e4b', platform: 'linux', ollamaInstalled: false, modelInstalled: false });
  assert.deepEqual(linux.downloads.map(d => d.what), ['gemma4:e4b']);
  assert.ok(linux.notes.some(n => /download page/.test(n)));
  assert.equal(setup.preflight({ model: 'gemma4:e4b', ollamaInstalled: true, modelInstalled: true }).nothingToDownload, true);
});

test('part states are limited to the seven and a failure names its part', () => {
  const p = setup.freshParts();
  assert.deepEqual(Object.keys(p), ['ollama', 'running', 'model', 'ready', 'connected']);
  for (const st of setup.PART_STATES) assert.equal(setup.setPart(p, 'model', st, 'x').model.state, st);
  assert.throws(() => setup.setPart(p, 'model', 'sleeping', 'x'));
  const f = setup.failure('model', 'no network');
  assert.equal(f.label, 'Model');
  assert.equal(f.retry, 'Retry model');
  assert.match(f.leftover, /kept/);
});

test('ollama list: the model, its size and the total', () => {
  const out = 'NAME ID SIZE MODIFIED\ngemma4:e4b abc 5.0 GB 2 days ago\nother:1b def 1.3 GB 1 week ago\n';
  assert.deepEqual(setup.parseList(out, 'gemma4:e4b'), { has: true, size: 5 * GB, total: 6.3 * GB });
  assert.equal(setup.parseList(out, 'gemma4:e2b').has, false);
});

test('health: not configured, available while setting up, degraded on failure, healthy when ready', () => {
  const h = s => setup.healthOf(s).state;
  assert.equal(h({ status: 'none', model: 'm', parts: setup.freshParts() }), 'not-configured');
  assert.equal(h({ status: 'installing', model: 'm', message: 'x', parts: {} }), 'available');
  assert.equal(h({ status: 'confirm', model: 'm', parts: {} }), 'available');
  assert.equal(h({ status: 'error', model: 'm', failed: { label: 'Model', what: 'no network' }, parts: {} }), 'degraded');
  assert.equal(h({ status: 'ready', model: 'm', parts: { running: { state: 'ready' }, connected: { state: 'ready' } } }), 'healthy');
  assert.equal(h({ status: 'ready', model: 'm', parts: { running: { state: 'idle' } } }), 'degraded');
  assert.equal(h({ status: 'none', model: 'm', everReady: true, parts: {} }), 'degraded');
  assert.equal(h(null), 'unknown');
  const row = CHECKS.localmodel({ status: 'ready', model: 'gemma4:e4b', parts: { running: { state: 'ready' }, connected: { state: 'ready' } } })[0];
  assert.equal(row.state, 'healthy');
  assert.equal(row.action, 'settings:Agents');
  assert.equal(CHECKS.localmodel(null)[0].state, 'unknown');
});

// ---- the worker against a fake Ollama and a fake winget
function world(o = {}) {
  const w = { platform: 'win32', installed: false, running: false, models: [], wingetCode: 0, wingetInstalls: true, serveStarts: true,
    pullCode: 0, pullChunks: PULL, pullHangs: false, pullAddsModel: true, runCode: 0, runOut: 'ok', freeDisk: 100 * GB, mem: 16 * 1024 ** 3, connected: true, ...o };
  w.calls = []; w.states = [];
  const spawn = (cmd, args) => {
    w.calls.push([cmd, ...args].join(' '));
    const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.unref = () => {};
    const finish = (code, out, chunks = []) => setImmediate(() => { for (const ch of chunks) c.stdout.emit('data', Buffer.from(ch)); if (out) c.stdout.emit('data', Buffer.from(out)); c.emit('close', code); });
    const verb = cmd === 'winget' ? 'winget' : args[0];
    if (verb === 'winget') { if (w.wingetInstalls && w.wingetCode === 0) w.installed = true; finish(w.wingetCode, '', ['Downloading 30%\r', 'Installing 90%\r']); }
    else if (verb === 'list') finish(w.running ? 0 : 1, 'NAME ID SIZE MODIFIED\n' + w.models.map(m => `${m} abc 5.0 GB now`).join('\n') + '\n');
    else if (verb === 'serve') { if (w.serveStarts) w.running = true; finish(0); }
    else if (verb === 'pull') {
      if (w.pullHangs) { c.kill = () => { w.killed = true; c.emit('close', null); }; setImmediate(() => c.stdout.emit('data', Buffer.from(PULL[1]))); }
      else { if (w.pullCode === 0 && w.pullAddsModel) w.models.push(args[1]); finish(w.pullCode, w.pullCode ? 'Error: pull failed: connection reset' : '', w.pullCode ? [] : w.pullChunks); }
    }
    else if (verb === 'run') finish(w.runCode, w.runCode === 0 ? w.runOut : 'Error: model failed to load');
    else if (verb === 'rm') { w.models = w.models.filter(m => m !== args[1]); finish(0); }
    else finish(0);
    return c;
  };
  w.m = lm.createLocalModel({ spawn, platform: w.platform, which: async () => (w.installed ? 'C:/ollama.exe' : null), onChange: s => w.states.push(s), wait: async () => {},
    probe: async () => w.running, freeDisk: () => w.freeDisk, totalMem: () => w.mem, connected: () => w.connected });
  w.seen = id => new Set(w.states.map(s => s.parts[id].state));
  return w;
}

test('from nothing: every part goes through its states and ends ready', async () => {
  const w = world();
  const r = await w.m.install('gemma4:e4b');
  assert.equal(r.status, 'ready');
  for (const id of ['ollama', 'running', 'model', 'ready', 'connected']) assert.equal(r.parts[id].state, 'ready', id);
  assert.ok(w.seen('ollama').has('installing') && w.seen('ollama').has('checking'));
  assert.ok(w.seen('running').has('starting'));
  assert.ok(w.seen('model').has('downloading') && w.seen('model').has('checking'));
  assert.ok(w.seen('ready').has('checking'));
  assert.ok(w.calls.includes('C:/ollama.exe serve'), 'started for you');
  assert.match(w.calls[0], /^winget install --id Ollama\.Ollama/);
  const dl = w.states.filter(s => s.parts.model.state === 'downloading' && s.parts.model.total).at(-1);
  assert.match(dl.parts.model.detail, /GB/);
  assert.match(r.parts.ready.detail, /ok/);
  assert.equal(r.info.model, 'gemma4:e4b');
  assert.equal(r.info.bytes, 5 * GB);
  assert.equal(r.everReady, true);
});

test('Ollama already there and running: those parts are found and nothing is installed or started', async () => {
  const w = world({ installed: true, running: true });
  const r = await w.m.install('gemma4:e4b');
  assert.equal(r.status, 'ready');
  assert.ok(!w.calls.some(c => c.startsWith('winget') || c.includes('serve')));
  assert.equal(w.seen('ollama').has('installing'), false);
});

test('asks first: the plan is shown and nothing runs until the go-ahead', async () => {
  const w = world({ mem: 6 * 1024 ** 3 });
  const r = await w.m.install('gemma4:e4b', { ask: true });
  assert.equal(r.status, 'confirm');
  assert.equal(r.plan.suggest, 'gemma4:e2b');
  assert.equal(r.plan.other.model, 'gemma4:e2b');
  assert.deepEqual(w.calls, [], 'no winget, no pull');
  const dismissed = await w.m.dismiss();
  assert.equal(dismissed.plan, null);
  assert.equal(dismissed.status, 'none');
  const go = await w.m.install('gemma4:e2b');
  assert.equal(go.status, 'ready');
  assert.ok(w.calls.includes('C:/ollama.exe pull gemma4:e2b'));
});

test('nothing to ask about when everything is in place', async () => {
  const w = world({ installed: true, running: true, models: ['gemma4:e4b'] });
  assert.equal((await w.m.install('gemma4:e4b', { ask: true })).status, 'ready');
});

test('failure, Ollama: winget fails, names the part, may be half-installed, retry runs again', async () => {
  const w = world({ wingetCode: 1, wingetInstalls: false });
  const r = await w.m.install('gemma4:e4b');
  assert.equal(r.status, 'error');
  assert.equal(r.failed.part, 'ollama');
  assert.match(r.failed.what, /did not finish \(exit 1\)/);
  assert.match(r.failed.leftover, /partly installed/);
  assert.equal(r.parts.ollama.state, 'failed');
  assert.equal(r.failed.retry, 'Retry ollama');
  w.wingetCode = 0; w.wingetInstalls = true;
  assert.equal((await w.m.install('gemma4:e4b')).status, 'ready');
});

test('failure, Ollama on macOS or Linux: the download page is linked and nothing was installed', async () => {
  const w = world({ platform: 'linux' });
  const r = await w.m.install('gemma4:e4b');
  assert.equal(r.failed.part, 'ollama');
  assert.equal(r.link, 'https://ollama.com/download');
  assert.equal(r.failed.link, 'https://ollama.com/download');
  assert.match(r.failed.leftover, /Nothing was installed/);
  assert.deepEqual(w.calls, []);
});

test('failure, Ollama running: the server never answers', async () => {
  const w = world({ installed: true, serveStarts: false });
  const r = await w.m.install('gemma4:e4b');
  assert.equal(r.failed.part, 'running');
  assert.equal(r.parts.running.state, 'failed');
  assert.match(r.failed.leftover, /nothing is half-installed/);
  assert.equal(r.parts.model.state, 'idle');
});

test('failure, Model: the download breaks, what was fetched is kept, retry continues', async () => {
  const w = world({ installed: true, running: true, pullCode: 1 });
  const r = await w.m.install('gemma4:e4b');
  assert.equal(r.failed.part, 'model');
  assert.match(r.failed.what, /connection reset/);
  assert.match(r.failed.leftover, /continues from there/);
  w.pullCode = 0;
  assert.equal((await w.m.install('gemma4:e4b')).status, 'ready');
});

test('failure, Ready to use: the model does not answer (empty) or crashes; it stays downloaded', async () => {
  const w = world({ installed: true, running: true, runOut: '' });
  const r = await w.m.install('gemma4:e4b');
  assert.equal(r.failed.part, 'ready');
  assert.match(r.failed.what, /did not answer/);
  assert.match(r.failed.leftover, /fully downloaded/);
  assert.equal(r.parts.model.state, 'ready');
  w.runCode = 1;
  const pulls = () => w.calls.filter(c => c.includes(' pull ')).length;
  const before = pulls();
  const again = await w.m.install('gemma4:e4b');
  assert.match(again.failed.what, /test prompt failed \(exit 1\)/);
  assert.equal(pulls(), before, 'not downloaded twice');
});

test('failure, Connected to OpenCode: the provider entry is missing', async () => {
  const w = world({ installed: true, running: true, connected: false });
  const r = await w.m.install('gemma4:e4b');
  assert.equal(r.failed.part, 'connected');
  assert.equal(r.status, 'error');
  assert.equal(r.parts.ready.state, 'ready');
});

test('Cancel stops the download and Resume picks it up; the pill state is paused in between', async () => {
  const w = world({ installed: true, running: true, pullHangs: true });
  const p = w.m.install('gemma4:e4b');
  for (let i = 0; i < 40 && !w.m.state().parts.model.total; i++) await new Promise(r => setImmediate(r));
  assert.equal(w.m.state().parts.model.state, 'downloading');
  w.m.cancel();
  const r = await p;
  assert.ok(w.killed);
  assert.equal(r.status, 'paused');
  assert.match(r.message, /Paused at 10%.*Resume continues/);
  assert.equal(r.failed, null);
  w.pullHangs = false;
  const done = await w.m.install('gemma4:e4b');
  assert.equal(done.status, 'ready');
});

test('refresh reads what is on the machine without downloading or prompting', async () => {
  const w = world({ installed: true, running: true, models: ['gemma4:e4b'] });
  const r = await w.m.refresh('gemma4:e4b');
  assert.equal(r.status, 'ready');
  assert.equal(r.parts.ready.state, 'idle');
  assert.match(r.parts.ready.detail, /Test it/);
  assert.equal(r.parts.connected.state, 'ready');
  assert.ok(!w.calls.some(c => / (run|pull) /.test(c)));

  const stopped = world({ installed: true, running: false });
  const s = await stopped.m.refresh('gemma4:e4b');
  assert.equal(s.status, 'none');
  assert.equal(s.parts.running.state, 'idle');
  assert.equal(setup.healthOf(s).state, 'not-configured');

  const none = await world().m.refresh('gemma4:e4b');
  assert.equal(none.parts.ollama.state, 'idle');
});

test('after: Test it, the health status, Remove the model, and changing the model reuses the card', async () => {
  const w = world({ installed: true, running: true, models: ['gemma4:e4b'] });
  await w.m.refresh('gemma4:e4b');
  assert.equal(setup.healthOf(w.m.state()).state, 'healthy');
  const t = await w.m.test();
  assert.equal(t.status, 'ready');
  assert.equal(t.parts.ready.state, 'ready');
  assert.equal((await w.m.refresh('gemma4:e4b')).parts.ready.state, 'ready', 'a passed test is remembered');
  w.runOut = '';
  assert.equal((await w.m.test()).failed.part, 'ready');
  w.runOut = 'ok';
  w.m.setModel('gemma4:e2b');
  const other = await w.m.refresh('gemma4:e2b');
  assert.equal(other.status, 'none');
  assert.equal(other.model, 'gemma4:e2b');
  assert.equal(other.parts.ollama.state, 'ready');
  await w.m.refresh('gemma4:e4b');
  const gone = await w.m.remove('gemma4:e4b');
  assert.equal(gone.status, 'none');
  assert.equal(gone.parts.model.state, 'idle');
  assert.equal(gone.parts.ollama.state, 'ready');
  assert.equal(setup.healthOf(gone).state, 'not-configured');
});
