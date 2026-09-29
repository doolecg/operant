// Operant's health view: one row per part of the app, each with a state, a one-line detail and the time it was
// checked. The checks are pure functions of what the probes report, so main.js injects the probes (which read what
// Operant already knows: no new slow processes on each refresh) and the tests inject fakes.
//
// States: healthy | available (something to act on, nothing wrong) | degraded | unavailable | not-configured | unknown.
// Nothing is healthy without having been checked: a part with no probe result is unknown.

const STATES = ['healthy', 'available', 'degraded', 'unavailable', 'not-configured', 'unknown'];
// Worst first. available counts as fine; not-configured and unknown are grey, and rank above healthy so a part that
// was never checked is not hidden behind green ones.
const RANK = { unavailable: 5, degraded: 4, unknown: 3, 'not-configured': 2, available: 1, healthy: 0 };
const DEFAULT_TTL_MS = 5 * 60 * 1000;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
function ago(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
const row = (id, name, state, detail, extra = {}) => ({ id, name, state, detail, ...extra });
const unknownRow = (id, name, detail = 'Not checked yet', extra = {}) => row(id, name, 'unknown', detail, extra);

// ---- the checks: (raw probe result, now) -> rows. `action` names what the UI offers for the row.

function checkApp(raw) {
  if (!raw || !raw.version) return [unknownRow('app', 'Operant')];
  const inst = raw.installState;
  const name = 'Operant';
  if (inst && typeof inst === 'object') {
    const st = String(inst.state || inst.status || '');
    if (inst.ok === false || /fail|damage|broken|degrad|error/i.test(st)) {
      return [row('app', name, 'degraded', `Version ${raw.version}: ${inst.message || inst.error || st || 'the install has a problem'}`)];
    }
    if (inst.pending || /pending|check|install/i.test(st)) return [row('app', name, 'unknown', `Version ${raw.version}: still checking the install`)];
  }
  return [row('app', name, 'healthy', `Version ${raw.version}${raw.installState ? ' · install ok' : ''}`)];
}

function checkUpdates(raw, now) {
  const name = 'Updates';
  if (!raw) return [unknownRow('updates', name, 'Not checked yet', { action: 'check-updates' })];
  const s = raw.status || null, hist = Array.isArray(raw.history) ? raw.history : [];
  const last = hist[hist.length - 1];
  const failedStart = last && last.result === 'failed-to-start' ? `The last update (${last.to}) did not start properly. ` : '';
  const act = { action: 'check-updates' };
  if (s && s.state === 'error') return [row('updates', name, 'degraded', `${failedStart}${s.message || 'The last check failed'}`, act)];
  if (s && (s.state === 'ready' || s.state === 'downloading')) return [row('updates', name, 'available', `${failedStart}Version ${s.version} ${s.state === 'ready' ? 'is ready to install' : 'is downloading'}`, act)];
  if (last && last.result === 'failed-to-start') return [row('updates', name, 'degraded', `The last update (${last.to}) did not start properly`, act)];
  if (!s || !s.checkedAt) return [unknownRow('updates', name, 'No update check yet', act)];
  if (s.state === 'checking') return [unknownRow('updates', name, 'Checking now', act)];
  const lastResult = last ? ` · last update ${last.to}: ${last.result || 'unknown'}` : '';
  return [row('updates', name, 'healthy', `Up to date, checked ${ago(now - s.checkedAt)}${lastResult}`, act)];
}

function checkBackups(raw, now) {
  const name = 'Backups';
  if (!raw) return [unknownRow('backups', name)];
  const { enabled, everyHours = 24, last, validated } = raw;
  if (!enabled) return [row('backups', name, 'not-configured', last ? `Automatic backups are off (last one ${ago(now - Date.parse(last.at))})` : 'Automatic backups are off', { action: 'settings:Backups' })];
  const act = { action: 'backup-now' };
  if (!last) return [row('backups', name, 'degraded', 'No backup has been taken yet', act)];
  const age = now - Date.parse(last.at);
  if (!Number.isFinite(age)) return [row('backups', name, 'degraded', 'The newest backup has no readable date', act)];
  if (validated && validated.ok === false) return [row('backups', name, 'degraded', `The last restore test failed${validated.error ? `: ${validated.error}` : ''}`, act)];
  if (age > everyHours * 2 * 3600e3) return [row('backups', name, 'degraded', `Last backup ${ago(age)}, due every ${plural(everyHours, 'hour', 'hours')}`, act)];
  const test = validated ? `restore test ${validated.ok ? 'passed' : 'failed'} ${ago(now - Date.parse(validated.at))}` : 'not restore-tested yet';
  return [row('backups', name, 'healthy', `Last backup ${ago(age)} · ${test}`, act)];
}

function checkConfig(raw) {
  const name = 'Settings file';
  if (!raw) return [unknownRow('config', name)];
  if (raw.broken) return [row('config', name, 'degraded', 'config.json did not parse: a copy was kept as config.broken.json and defaults are in use', { action: 'open-config' })];
  if (raw.error) return [row('config', name, 'degraded', `The settings migration failed, the file was left as is: ${raw.error}`, { action: 'open-config' })];
  if (raw.future) return [row('config', name, 'degraded', `config.json is from a newer Operant (version ${raw.from}), used as is`)];
  if (raw.migrated) return [row('config', name, 'healthy', `Read and migrated from version ${raw.from}`)];
  if (raw.missing) return [row('config', name, 'healthy', 'No config file yet, using the defaults')];
  return [row('config', name, 'healthy', 'Read and parsed')];
}

function checkAgents(raw) {
  const list = raw && Array.isArray(raw.agents) ? raw.agents : null;
  if (!list) return [unknownRow('agents', 'Agents')];
  if (!list.length) return [row('agents', 'Agents', 'not-configured', 'No agent CLIs are configured', { action: 'settings:Agents' })];
  return list.map(a => {
    const id = `agent:${a.id}`, name = a.name || a.id, exe = String(a.command || '').trim().split(/\s+/)[0];
    const installed = raw.installed ? raw.installed[a.id] : undefined;
    if (!exe) return row(id, name, 'not-configured', 'No command set', { action: 'settings:Agents' });
    if (installed === true) return row(id, name, 'healthy', `Installed (${exe})${raw.versions && raw.versions[a.id] ? ` · ${raw.versions[a.id]}` : ''}`);
    if (installed === false) return row(id, name, 'unavailable', `'${exe}' is not installed or not on PATH`, { action: 'settings:Agents' });
    return unknownRow(id, name, `Looking for '${exe}'`);
  });
}

function checkModels(raw) {
  const tiers = raw && Array.isArray(raw.tiers) ? raw.tiers : null;
  if (!tiers) return [unknownRow('models', 'Models')];
  if (!tiers.length) return [row('models', 'Models', 'not-configured', 'No team tiers are set up', { action: 'settings:Agents' })];
  return tiers.map(t => {
    const id = `model:${t.name}`, name = `Model · ${t.name}`, what = [t.agent, t.model].filter(Boolean).join(' · ');
    const act = { action: 'settings:Agents' };
    if (!t.active) return row(id, name, 'unavailable', `${what || 'This tier'} cannot run and nothing can stand in for it`, act);
    if (t.active.fallback) return row(id, name, 'degraded', `Fell back to ${[t.active.agent, t.active.model].filter(Boolean).join(' · ')}: ${t.active.fallback}`, act);
    if (t.installed !== true) return unknownRow(id, name, `${what}: the CLI has not been looked for yet`);
    if (t.oc && !raw.modelsRead) return unknownRow(id, name, `${what}: OpenCode's model list has not been read yet`);
    // Installed and listed, but no call has proven it works yet: available, not healthy.
    return row(id, name, 'available', `${what} is installed and listed (not yet proven by a run)`);
  });
}

function checkMemory(raw) {
  if (!raw) return [unknownRow('memory', 'Memory')];
  const one = (id, name, m, empty, action) => {
    if (!m) return row(id, name, 'not-configured', empty, action ? { action } : {});
    if (m.error) return row(id, name, 'degraded', `${m.dir} is not readable: ${m.error}`);
    if (m.missing) return row(id, name, 'not-configured', empty);
    const stale = m.stale ? ` · ${plural(m.stale, 'fact looks', 'facts look')} stale` : '';
    return row(id, name, m.stale ? 'degraded' : 'healthy', `${plural(m.count, 'fact', 'facts')}${stale}`);
  };
  return [
    one('memory:project', 'Memory · project', raw.project, raw.cwd ? 'No memory for this project yet' : 'No project selected'),
    one('memory:personal', 'Memory · personal', raw.personal, 'No personal memory yet'),
  ];
}

function checkCodegraph(raw) {
  const name = 'CodeGraph';
  if (!raw) return [unknownRow('codegraph', name)];
  const cli = raw.cli; // version string, null (looked, not found), undefined (not looked yet)
  if (cli === undefined) return [unknownRow('codegraph', name, 'Looking for the CodeGraph CLI')];
  if (cli === null) return [row('codegraph', name, raw.indexed ? 'degraded' : 'unavailable', raw.indexed ? 'The index exists but the CodeGraph CLI was not found' : 'The CodeGraph CLI was not found', { action: 'settings:CodeGraph' })];
  if (!raw.cwd) return [row('codegraph', name, 'not-configured', `CLI ${cli} found, no project selected`)];
  if (!raw.indexed) return [row('codegraph', name, 'not-configured', `CLI ${cli} found, this project is not indexed`, { action: 'index-project' })];
  return [row('codegraph', name, 'healthy', `CLI ${cli} · this project is indexed`, { action: 'index-project', actionLabel: 'Sync index' })];
}

function checkMcp(raw) {
  const name = 'MCP servers';
  if (!raw) return [unknownRow('mcp', name)];
  const names = Array.isArray(raw.servers) ? raw.servers : [];
  if (!names.length) return [row('mcp', name, 'not-configured', 'No servers configured for agent tiles')];
  const shown = names.slice(0, 4).join(', ') + (names.length > 4 ? ` +${names.length - 4}` : '');
  return [row('mcp', name, 'available', `${plural(names.length, 'server', 'servers')} configured (not connected to): ${shown}`)];
}

const kb = n => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
function checkAnalytics(raw) {
  const name = 'Usage and outcomes';
  if (!raw) return [unknownRow('analytics', name)];
  const parts = [], bad = [];
  for (const [label, f] of [['usage', raw.usage], ['outcomes', raw.outcomes]]) {
    if (!f) continue;
    if (f.error) bad.push(`${label} not readable: ${f.error}`);
    else if (f.missing) parts.push(`${label}: none yet`);
    else parts.push(`${label} ${kb(f.bytes || 0)}`);
  }
  if (bad.length) return [row('analytics', name, 'degraded', bad.join(' · '))];
  if (!parts.length) return [unknownRow('analytics', name)];
  if (parts.every(p => /none yet$/.test(p))) return [row('analytics', name, 'not-configured', parts.join(' · '))];
  return [row('analytics', name, 'healthy', parts.join(' · '))];
}

const COMPONENTS = [
  ['app', checkApp], ['updates', checkUpdates], ['backups', checkBackups], ['config', checkConfig],
  ['agents', checkAgents], ['models', checkModels], ['memory', checkMemory], ['codegraph', checkCodegraph],
  ['mcp', checkMcp], ['analytics', checkAnalytics],
];
const CHECKS = Object.fromEntries(COMPONENTS);

// The worst state of a list of rows (healthy for none: callers only ask about a list they have).
function worst(rows) {
  let w = 'healthy';
  for (const r of rows) if ((RANK[r.state] ?? 3) > RANK[w]) w = r.state;
  return w;
}

// createHealth({ probes, now, ttlMs, slowTtlMs, onChange })
//   probes: { app, updates, backups, config, agents, models, memory, codegraph, mcp, analytics }, each (ctx) => raw
//   (sync or async, may throw); ctx = { cwd }. A missing probe or one that throws leaves its rows unknown/degraded.
//   probes listed in `slow` are remembered for slowTtlMs (default 5 min) whatever `force` says.
function createHealth({ probes = {}, now = Date.now, ttlMs = DEFAULT_TTL_MS, slowTtlMs = DEFAULT_TTL_MS, slow = ['codegraph'], onChange } = {}) {
  let snap = null; // { at, cwd, rows }
  let inflight = null;
  const slowMemo = new Map(); // `${id}|${cwd}` -> { at, raw }

  const placeholder = () => COMPONENTS.flatMap(([id, fn]) => fn(null, now()).map(r => ({ ...r, checkedAt: null })));

  async function probe(id, ctx) {
    const fn = probes[id];
    if (typeof fn !== 'function') return { none: true };
    const key = `${id}|${ctx.cwd || ''}`;
    if (slow.includes(id)) {
      const m = slowMemo.get(key);
      if (m && now() - m.at < slowTtlMs) return m.result;
    }
    let result;
    try { result = { raw: await fn(ctx) }; } catch (e) { result = { error: String((e && e.message) || e) }; }
    if (slow.includes(id) && !result.error) slowMemo.set(key, { at: now(), result });
    return result;
  }

  async function refresh(ctx) {
    const t = now();
    const rows = [];
    await Promise.all(COMPONENTS.map(async ([id, fn], i) => {
      const r = await probe(id, ctx);
      let out;
      if (r.none) out = fn(null, t).map(x => ({ ...x, checkedAt: null }));
      else if (r.error) out = [row(id, id, 'degraded', `The check failed: ${r.error}`, { checkedAt: t })];
      else { try { out = fn(r.raw, t).map(x => ({ ...x, checkedAt: x.state === 'unknown' && r.raw == null ? null : t })); } catch (e) { out = [row(id, id, 'degraded', `The check failed: ${(e && e.message) || e}`, { checkedAt: t })]; } }
      rows[i] = out;
    }));
    const flat = rows.flat();
    const prev = snap;
    snap = { at: t, cwd: ctx.cwd || '', rows: flat };
    const summary = build();
    if (prev && onChange && changed(prev.rows, flat)) { try { onChange(summary); } catch {} }
    return summary;
  }

  const changed = (a, b) => {
    if (a.length !== b.length) return true;
    const m = new Map(a.map(r => [r.id, r.state]));
    return b.some(r => m.get(r.id) !== r.state);
  };

  function build() {
    const rows = snap ? snap.rows : placeholder();
    return { at: snap ? snap.at : null, overall: snap ? worst(rows) : 'unknown', components: rows };
  }

  // What is known right now, without checking anything: every row unknown until the first refresh.
  const peek = () => build();

  // Cached for ttlMs and per project; force checks again.
  function get({ force = false, cwd = '' } = {}) {
    const ctx = { cwd: cwd || '' };
    if (!force && snap && snap.cwd === ctx.cwd && now() - snap.at < ttlMs) return Promise.resolve(build());
    if (!inflight) inflight = refresh(ctx).finally(() => { inflight = null; });
    return inflight;
  }

  return { get, peek };
}

module.exports = { createHealth, worst, STATES, RANK, CHECKS, DEFAULT_TTL_MS, ago };
