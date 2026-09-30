// Config versions: config.json stores only what the user changed, plus configVersion. When a release renames
// or reshapes a saved key, add a migration here ({ to: N, run(user) }) and raise CURRENT by matching it.
// A migration edits the copy it is given, and must be idempotent: a crash before the migrated file is saved
// means it runs again on the next start.
const MIGRATIONS = [
  // Template: version 1 only establishes the version number, it changes nothing. A later one looks like
  //   { to: 2, run(user) { if ('oldKey' in user) { user.newKey ??= user.oldKey; delete user.oldKey; } } },
  { to: 1, run() {} },
  // The Operant Terminal is gone: drop its settings, and a default agent of 'operant' goes back to the first agent.
  { to: 2, run(user) {
    delete user.terminal;
    if (user.defaultAgent === 'operant') delete user.defaultAgent;
    for (const d of Object.values(user.projectDefaults || {})) if (d && d.agent === 'operant') delete d.agent;
  } },
  // Gemma 3 can't call tools in Ollama, so it can't run a tier: a saved gemma3 local model goes back to the default.
  { to: 3, run(user) { if (/^gemma3(:|$)/.test(user.localModel?.model || '')) delete user.localModel.model; } },
  // Big Pickle (free) is used first (item 96): an xsmall tier saved on a paid model is only OFFERED "Use Big Pickle"
  // (Settings > Agents > Team, one click); nothing is switched here. The new free tier comes from the defaults.
  { to: 4, run(user) {
    const x = user.team?.tiers?.xsmall;
    if (isPlain(x) && x.model && !/(^|\/)big-pickle$|-free$|^ollama\//i.test(x.model)) user.tierOffers = [...new Set([...(Array.isArray(user.tierOffers) ? user.tierOffers : []), 'use-big-pickle'])];
  } },
];
const CURRENT = MIGRATIONS[MIGRATIONS.length - 1].to;

const isPlain = v => v && typeof v === 'object' && !Array.isArray(v);

// -> { user, from, to, changed, future?, error? }. A config with no configVersion is version 0. One written by a
// newer Operant (higher version) and one whose migration throws come back untouched.
function migrate(user) {
  if (!isPlain(user)) return { user, from: 0, to: 0, changed: false };
  const from = Number.isInteger(user.configVersion) && user.configVersion > 0 ? user.configVersion : 0;
  if (from > CURRENT) return { user, from, to: from, changed: false, future: true };
  let next;
  try {
    next = JSON.parse(JSON.stringify(user));
    for (const m of MIGRATIONS) if (m.to > from) m.run(next);
  } catch (error) { return { user, from, to: from, changed: false, error }; }
  next.configVersion = CURRENT;
  return { user: next, from, to: CURRENT, changed: from !== CURRENT || user.configVersion !== CURRENT };
}

// The config:set patch on the stored user config: only known keys, null resets a key to its default.
function applyPatch(user, patch, defaults) {
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in defaults)) continue;
    if (v === null) delete user[k]; else user[k] = v;
  }
  return user;
}

// ---------------------------------------------------------------- validation (config:set)

// Numeric limits per setting. The Settings controls' min/max and these must agree (test/settings-contract.test.js).
// int: whole numbers only; unit: how the message names it.
const RANGES = {
  borderAnimationSeconds: { min: 2, max: 20, int: true, unit: 'seconds' },
  opacity: { min: 0.4, max: 1 },
  blur: { min: 0, max: 40, int: true, unit: 'px' },
  rounding: { min: 0, max: 24, int: true, unit: 'px' },
  borderSize: { min: 1, max: 6, int: true, unit: 'px' },
  gapsIn: { min: 0, max: 24, int: true, unit: 'px' },
  gapsOut: { min: 0, max: 48, int: true, unit: 'px' },
  fontSize: { min: 9, max: 24, int: true, unit: 'px' },
  lineHeight: { min: 1, max: 1.6 },
  scrollback: { min: 1000, max: 200000, int: true, unit: 'lines' },
  masterRatio: { min: 0.2, max: 0.85 },
  maxTilesPerWorkspace: { min: 1, max: 16, int: true, unit: 'tiles' },
  autoCompact: { min: 0, max: 100, int: true, unit: 'percent' },
  cacheTtlMinutes: { min: 1, max: 120, int: true, unit: 'minutes' },
  notifyWhenIdleSeconds: { min: 0, max: 600, int: true, unit: 'seconds' },
  autoCloseDoneAgentsSeconds: { min: 0, max: 86400, int: true, unit: 'seconds' },
  idleCloseTerminalMinutes: { min: 0, max: 1440, int: true, unit: 'minutes' },
  agentLookbackSeconds: { min: 0, max: 3600, int: true, unit: 'seconds' },
  stuckTurns: { min: 0, max: 200, int: true, unit: 'tool calls' },
  runawayLoopRepeats: { min: 3, max: 50, int: true, unit: 'repeats' },
  runawayMinutes: { min: 0, max: 600, int: true, unit: 'minutes' },
  runawaySubagents: { min: 0, max: 100, int: true },
  sidebarWidth: { min: 160, max: 600, int: true, unit: 'px' },
  codegraphChangedFiles: { min: 1, max: 100000, int: true, unit: 'files' },
  updateCheckHours: { min: 0, max: 24, int: true, unit: 'hours' },
  backgroundAfterSeconds: { min: 0, max: 600, int: true, unit: 'seconds' },
  // Token counts have no control min/max (typed as 2M or 500k), so only a sane ceiling.
  tokenBudget: { min: 0, max: 1e12, int: true, unit: 'tokens' },
  runawayTokens: { min: 0, max: 1e12, int: true, unit: 'tokens' },
};
const ENUMS = {
  wallpaper: ['glow-dots', 'glow', 'plain'],
  borderAnimation: ['active', 'focused', 'off'],
  animations: ['normal', 'fast', 'off'],
  cursorStyle: ['block', 'bar', 'underline'],
  defaultLayout: ['master', 'dwindle'],
  restoreSession: ['update', 'always', 'never'],
  runawayGuard: ['warn', 'stop', 'off'],
  ide: ['code', 'cursor', 'windsurf', 'zed', 'idea', 'rider', 'subl', 'custom'],
  fileOpens: ['view', 'edit', 'system'],
  editor: ['auto', 'vim', 'nvim', 'micro', 'nano', 'edit', 'custom'],
  configOpensIn: ['system', 'editor'],
  clockFormat: ['auto', '24', '12'],
  mediaSize: ['compact', 'full'],
  codegraphOnStartup: ['changed', 'all', 'off'],
  updateChannel: ['stable', 'beta'],
  explorerOpensIn: ['tile', 'window'],
};
const USAGE_SERIES = ['input', 'output', 'cacheWrite', 'cacheRead'];

const kindOf = v => Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
const A_KIND = { boolean: 'true or false', number: 'a number', string: 'text', array: 'a list', object: 'an object' };
const shown = v => { const t = typeof v === 'string' ? `"${v}"` : JSON.stringify(v); return t === undefined ? 'nothing' : t.length > 60 ? t.slice(0, 57) + '...' : t; };
const rangeText = r => `${r.int ? 'a whole number ' : 'a number '}${r.min}-${r.max}${r.unit ? ' ' + r.unit : ''}`;
function isDirDefault(p) { try { return require('fs').statSync(p).isDirectory(); } catch { return false; } }

// Checks a config:set patch before it is applied. -> [{ key, message, expected }], empty when every key is fine.
// null always passes (it resets the key). Keys not in defaults are ignored, as applyPatch ignores them.
// opts.current is the effective config (what the message says was kept, and what cross-checks fall back on);
// opts.isDir(path) replaces the folder check (tests).
function validatePatch(patch, defaults, opts = {}) {
  if (!isPlain(patch)) return [{ key: '', message: 'Settings must be sent as an object; nothing was changed', expected: 'an object' }];
  const errors = [];
  const current = opts.current || defaults;
  const isDir = opts.isDir || isDirDefault;
  const bad = (key, expected, sub) => errors.push({ key, expected, message: `Must be ${expected}; kept ${shown(current[key])}${sub ? ' (' + sub + ')' : ''}` });
  const agents = Array.isArray(patch.agents) ? patch.agents : current.agents;
  const agentIds = new Set((Array.isArray(agents) ? agents : []).filter(a => a && typeof a.id === 'string').map(a => a.id));

  for (const [key, v] of Object.entries(patch)) {
    if (!(key in defaults) || v === null) continue;
    const want = kindOf(defaults[key]);
    if (kindOf(v) !== want) { bad(key, A_KIND[want] || want); continue; }
    if (want === 'number' && !Number.isFinite(v)) { bad(key, 'a finite number'); continue; }
    const r = RANGES[key];
    if (r && (v < r.min || v > r.max || (r.int && !Number.isInteger(v)))) { bad(key, rangeText(r)); continue; }
    const en = ENUMS[key];
    if (en && !en.includes(v)) { bad(key, 'one of ' + en.join(', ')); continue; }
    if (key === 'defaultCwd' && !isDir(v)) { bad(key, 'a folder that exists'); continue; }
    if (key === 'accent' && v !== '' && !/^#[0-9a-f]{6}$/i.test(v)) { bad(key, 'empty or a color like #d97757'); continue; }
    if (key === 'usageSeries' && (!v.length || v.some(s => !USAGE_SERIES.includes(s)))) { bad(key, 'at least one of ' + USAGE_SERIES.join(', ')); continue; }
    if (key === 'projects' && v.some(p => typeof p !== 'string')) { bad(key, 'a list of folder paths'); continue; }
    if (key === 'agents') {
      if (!v.length) { bad(key, 'at least one agent'); continue; }
      if (v.some(a => !isPlain(a) || typeof a.id !== 'string' || !a.id || typeof a.name !== 'string' || typeof a.command !== 'string' || (a.args !== undefined && !Array.isArray(a.args)))) { bad(key, 'agents with an id, name, command and argument list'); continue; }
      if (new Set(v.map(a => a.id)).size !== v.length) { bad(key, 'agents with different ids'); continue; }
    }
    if (key === 'localModel' && !(isPlain(v) && (v.model === undefined || (typeof v.model === 'string' && /^[A-Za-z0-9._\/-]+(:[A-Za-z0-9._-]+)?$/.test(v.model))))) { bad(key, 'an Ollama model name like gemma4:e4b'); continue; }
    if (key === 'tierOffers' && v.some(o => typeof o !== 'string')) { bad(key, 'a list of offer names'); continue; }
    if (key === 'team') teamErrors(v, current.team || {}, agentIds, (expected, sub) => bad('team', expected, sub));
    if (key === 'projectDefaults') {
      for (const [p, d] of Object.entries(v)) {
        if (!isPlain(d)) { bad(key, 'per-project settings as objects'); break; }
        if (d.agent && d.agent !== current.projectDefaults?.[p]?.agent && !agentIds.has(d.agent)) { bad(key, 'an agent that exists', `"${d.agent}" is not one`); break; }
        if (d.agents !== undefined && !['both', 'claude', 'opencode'].includes(d.agents)) { bad(key, 'agents as both, claude or opencode'); break; }
      }
    }
  }
  // Conflict: the default agent has to be one of the agents in this patch or already saved.
  const dAgent = typeof patch.defaultAgent === 'string' ? patch.defaultAgent : 'agents' in patch ? current.defaultAgent : null;
  if (typeof dAgent === 'string' && agentIds.size && !agentIds.has(dAgent) && !errors.some(e => e.key === 'defaultAgent' || e.key === 'agents')) {
    bad('defaultAgent', 'one of the agents: ' + [...agentIds].join(', '), 'the agents in this change do not include it');
  }
  return errors;
}

function teamErrors(team, cur, agentIds, bad) {
  if (!isPlain(team)) return bad('an object');
  if (team.enabled !== undefined && typeof team.enabled !== 'boolean') return bad('team mode true or false');
  if (team.maxWorkers !== undefined && !(Number.isInteger(team.maxWorkers) && team.maxWorkers >= 1 && team.maxWorkers <= 16)) return bad('max workers a whole number 1-16');
  if (team.tiers !== undefined && !isPlain(team.tiers)) return bad('tiers as an object');
  for (const [name, t] of Object.entries(team.tiers || {})) {
    if (!isPlain(t)) return bad('each tier an object', name);
    if (t.agent && t.agent !== cur.tiers?.[name]?.agent && !agentIds.has(t.agent)) return bad('a tier agent that exists', `${name}: "${t.agent}" is not an agent`);
    if (t.fallbacks !== undefined) {
      if (!Array.isArray(t.fallbacks) || t.fallbacks.some(r => !isPlain(r) || !(r.local === true || (typeof r.model === 'string' && r.model)))) return bad('fallbacks as a list of routes with a model, or local', name);
      const badAgent = t.fallbacks.find(r => r.agent && !agentIds.has(r.agent));
      if (badAgent) return bad('a fallback agent that exists', `${name}: "${badAgent.agent}" is not an agent`);
    }
  }
  for (const [name, n] of Object.entries(team.budgets || {})) if (!Number.isInteger(n) || n < 0) return bad('budgets as whole numbers of 0 or more', name);
  for (const key of ['minutes', 'calls']) for (const [name, n] of Object.entries(team[key] || {})) if (!Number.isInteger(n) || n < 0) return bad(key + ' as whole numbers of 0 or more', name);
  const tiers = team.tiers === undefined ? cur.tiers : team.tiers;
  if (team.maxTier !== undefined && isPlain(tiers) && !(team.maxTier in tiers)) return bad('a top tier that exists: ' + Object.keys(tiers).join(', '));
}

// Defaults under what the user changed; keybinds, team and backups are nested, so a partial override keeps the rest.
function mergeUser(defaults, user, keybinds) {
  return {
    ...defaults, ...user,
    keybinds: { ...keybinds, ...(user.keybinds || {}) },
    backups: { ...defaults.backups, ...(user.backups || {}) },
    localModel: { ...defaults.localModel, ...(user.localModel || {}) },
    team: { ...defaults.team, ...(user.team || {}), tiers: { ...defaults.team.tiers, ...(user.team?.tiers || {}) }, budgets: { ...defaults.team.budgets, ...(user.team?.budgets || {}) },
      minutes: { ...defaults.team.minutes, ...(user.team?.minutes || {}) }, calls: { ...defaults.team.calls, ...(user.team?.calls || {}) } },
  };
}

module.exports = { CURRENT, MIGRATIONS, migrate, applyPatch, mergeUser, validatePatch, RANGES, ENUMS };
