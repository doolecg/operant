(function () {
// Settings > Agents in plain words (item 94). Pure: the text of every team setting (label, what it does for you,
// when it applies, its developer term), the plain-language summary, the three presets with their preview and
// custom detection, and the inline warnings. settings.js only draws what this returns.
const TIERS = ['free', 'xsmall', 'small', 'medium', 'high', 'max'];
const TIER_NAME = { free: 'Free', xsmall: 'XSmall', small: 'Small', medium: 'Medium', high: 'High', max: 'Max' };
const MIN_INSIDE = 20000; // "keep saving inside the limit" refuses limits below this

const kTok = n => n >= 1e6 ? `${+(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(n);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const get = (o, path) => path.split('.').reduce((v, k) => (v == null ? undefined : v[k]), o);
function put(team, path, value) {
  const out = { ...team, budgets: { ...(team.budgets || {}) } };
  const [a, b] = path.split('.');
  if (b) out[a] = { ...(out[a] || {}), [b]: value }; else out[a] = value;
  return out;
}

// What a preset sets. Balanced is the shipped default. Presets never touch which agent or model a tier runs, or
// whether team mode is on: those are your choices.
const PRESETS = {
  cheapest: { name: 'Cheapest', blurb: 'Small limits, few workers, only the cheap tiers, a daily cap.', values: {
    maxTier: 'xsmall', maxWorkers: 2, dailyCap: 2000000, verifyBeforeReview: true, savingProgress: 'over',
    'budgets.free': 60000, 'budgets.xsmall': 100000, 'budgets.small': 200000, 'budgets.medium': 400000, 'budgets.high': 800000, 'budgets.max': 1200000 } },
  balanced: { name: 'Balanced', blurb: 'The default: up to the small tier, 4 workers, sensible limits, no daily cap.', values: {
    maxTier: 'small', maxWorkers: 4, dailyCap: 0, verifyBeforeReview: true, savingProgress: 'over',
    'budgets.free': 100000, 'budgets.xsmall': 150000, 'budgets.small': 300000, 'budgets.medium': 600000, 'budgets.high': 1200000, 'budgets.max': 2000000 } },
  best: { name: 'Best quality', blurb: 'Every tier open, 6 workers, roomy limits, no daily cap.', values: {
    maxTier: 'max', maxWorkers: 6, dailyCap: 0, verifyBeforeReview: true, savingProgress: 'over',
    'budgets.free': 150000, 'budgets.xsmall': 250000, 'budgets.small': 500000, 'budgets.medium': 1000000, 'budgets.high': 2000000, 'budgets.max': 3000000 } },
};
const PRESET_ORDER = ['cheapest', 'balanced', 'best'];
const FIELDS = Object.keys(PRESETS.balanced.values);

// The settings a person sees, in the five groups. `id` is the row's data-sid; `path` is under cfg.team.
const GROUPS = ['Who does the work', 'How much they may spend', 'When they get stuck', 'What they use', 'Local model'];
const budgetMeta = t => ({ id: 'budget.' + t, path: 'budgets.' + t, group: GROUPS[1], label: `${TIER_NAME[t]} token limit`,
  does: `Stops a ${t} worker at this many tokens so one task cannot run away (you are told at 80%, it saves at 90%). 0 = no limit.`,
  when: 'Workers started after the change; a running worker keeps its limit', dev: `team.budgets.${t}` });
const minutesMeta = t => ({ id: 'minutes.' + t, path: 'minutes.' + t, group: GROUPS[1], label: `${TIER_NAME[t]} time limit (minutes)`,
  does: `Stops a ${t} worker after this many minutes on a task (you are told at 90%, and earlier when its pace says it will be passed). It asks you first; it never moves up by itself. 0 = no limit.`,
  when: 'Workers started after the change; a running worker keeps its limit', dev: `team.minutes.${t}` });
const callsMeta = t => ({ id: 'calls.' + t, path: 'calls.' + t, group: GROUPS[1], label: `${TIER_NAME[t]} tool-call limit`,
  does: `Stops a ${t} worker after this many tool calls on a task (you are told at 90%, and earlier when its pace says it will be passed). It asks you first; it never moves up by itself. 0 = no limit.`,
  when: 'Workers started after the change; a running worker keeps its limit', dev: `team.calls.${t}` });
const tierMeta = t => ({ id: 'tier.' + t, group: GROUPS[0], adv: true, label: `${TIER_NAME[t]} tier: agent, model, effort`,
  does: `Which agent and model runs ${t} jobs, and what the lead is told this tier is for.`,
  when: 'The next worker the lead starts', dev: `team.tiers.${t}.agent, .model, .effort, .use` });
const META = [
  { id: 'enabled', path: 'enabled', group: GROUPS[0], label: 'Team mode', does: 'A lead agent hands small jobs to cheaper workers, each in its own tile.',
    when: 'The next thing the lead starts', dev: 'team.enabled' },
  { id: 'maxWorkers', path: 'maxWorkers', group: GROUPS[0], label: 'Workers at once', does: 'How many workers may run side by side.',
    when: 'The next worker the lead starts', dev: 'team.maxWorkers' },
  { id: 'maxTier', path: 'maxTier', group: GROUPS[0], label: 'Highest tier workers may use', does: 'Workers cannot be started above this tier, however hard the job.',
    when: 'The next worker the lead starts', dev: 'team.maxTier' },
  { id: 'refineTo', group: GROUPS[0], label: 'Refined prompts go to', does: 'Where "send it" goes after a refine: a Claude tile that plans it itself, or team work (one master runs numbered parts on their tiers). You can still pick each time.',
    when: 'The next refine', dev: 'refineTo' },
  { id: 'routing', group: GROUPS[0], label: 'Where each tier runs', does: 'The routes a tier tries in order, the fallbacks in use, and how this week went.',
    when: 'Live', dev: 'team.tiers.<tier>.fallbacks' },
  ...TIERS.map(tierMeta),
  ...TIERS.map(budgetMeta),
  ...TIERS.map(minutesMeta),
  ...TIERS.map(callsMeta),
  { id: 'suggest', group: GROUPS[1], label: 'Suggested limits', does: 'Limits worked out from your past tasks; nothing changes until you press Apply.',
    when: 'On the click', dev: 'team.budgets (90th percentile + 25%)' },
  { id: 'savingProgress', path: 'savingProgress', group: GROUPS[1], label: 'Saving progress at a limit', does: 'Whether the tokens a worker needs to save its notes come on top of its limit or out of it.',
    when: 'Workers started after the change', dev: 'team.savingProgress' },
  { id: 'dailyCap', path: 'dailyCap', group: GROUPS[1], label: 'Daily cap per project', does: 'Once a project has used this many tokens today, Operant asks you before the next worker starts. 0 = off.',
    when: 'The next worker the lead starts', dev: 'team.dailyCap' },
  { id: 'askBeforeMoveUp', group: GROUPS[2], label: 'Ask before moving up a tier', does: 'A stuck worker, a second failure or a spent limit pauses the task and asks you: move up, retry with a hint, take over, or stop.',
    when: 'Always on in this release', dev: 'TierGuard.ASK_BEFORE_MOVE_UP' },
  { id: 'verifyBeforeReview', path: 'verifyBeforeReview', group: GROUPS[3], label: 'Run checks before review', does: 'When a worker finishes a code task, Operant runs your test or build and attaches the result; a failing check sends it back once.',
    when: 'The next finished worker', dev: 'team.verifyBeforeReview' },
  { id: 'verifyTypesLint', path: 'verifyTypesLint', group: GROUPS[3], label: 'Run type check and lint too', does: 'After the tests or build pass, Operant also runs the type check and lint the project has (from package.json, tsconfig, Cargo.toml and so on). A failure sends the task back once.',
    when: 'The next finished worker', dev: 'team.verifyTypesLint' },
  { id: 'messaging', group: GROUPS[3], label: 'Let agents message each other', does: 'Adds operant msg and operant inbox so agents can pass each other short notes. Off by default.',
    when: 'New tiles; a Claude Code tile already open only gets notes when idle', dev: 'messaging' },
  { id: 'localModel', group: GROUPS[4], label: 'Local model', does: 'A model on your computer the free tier falls back to when Big Pickle is busy or out of free use.',
    when: 'The next free-tier worker', dev: 'localModel.model' },
];
const byId = Object.fromEntries(META.map(m => [m.id, m]));

const tierName = t => TIER_NAME[t] || t;
const teamOf = cfg => cfg.team || {};
const topTier = team => team.maxTier || Object.keys(team.tiers || {}).pop() || 'small';

// Effective value of a setting, as a short phrase.
function effective(cfg, id) {
  const t = teamOf(cfg), m = byId[id];
  switch (id) {
    case 'enabled': return t.enabled ? 'On' : 'Off';
    case 'maxWorkers': return `${t.maxWorkers ?? 4} at once`;
    case 'maxTier': return tierName(topTier(t)) + ' and below';
    case 'savingProgress': return t.savingProgress === 'inside' ? 'Inside the limit' : 'On top of the limit';
    case 'dailyCap': return t.dailyCap ? `${kTok(t.dailyCap)} tokens a day` : 'No cap';
    case 'verifyBeforeReview': return t.verifyBeforeReview === false ? 'Off' : 'On';
    case 'verifyTypesLint': return t.verifyTypesLint === false ? 'Off' : 'On';
    case 'messaging': return cfg.messaging ? 'On' : 'Off';
    case 'refineTo': return cfg.refineTo === 'team' ? 'Team work' + (t.enabled ? '' : ' (team mode is off, so a send is refused)') : 'A Claude tile';
    case 'askBeforeMoveUp': return 'On';
    default:
      if (m && m.path && m.path.startsWith('budgets.')) { const n = get(t, m.path) || 0; return n ? `${kTok(n)} tokens per task` : 'No limit'; }
      if (m && m.path && m.path.startsWith('minutes.')) { const n = get(t, m.path) || 0; return n ? `${n} minutes per task` : 'No limit'; }
      if (m && m.path && m.path.startsWith('calls.')) { const n = get(t, m.path) || 0; return n ? `${n} tool calls per task` : 'No limit'; }
      if (id.startsWith('tier.')) { const x = (t.tiers || {})[id.slice(5)] || {}; return [x.agent, x.model, x.effort].filter(Boolean).join(' · ') || 'Not set'; }
      return '';
  }
}

// Presets: what applying one would change, without changing it.
const valueOf = (team, path) => { const v = get(team, path); return v === undefined ? (typeof PRESETS.balanced.values[path] === 'number' ? 0 : v) : v; };
const fieldText = (path, v) => path === 'maxTier' ? tierName(v) : path === 'savingProgress' ? (v === 'inside' ? 'inside the limit' : 'on top of the limit')
  : typeof v === 'boolean' ? (v ? 'on' : 'off') : path === 'dailyCap' ? (v ? kTok(v) : 'no cap') : typeof v === 'number' ? (v ? kTok(v) : 'no limit') : String(v);
const fieldLabel = path => path.startsWith('budgets.') ? `${tierName(path.slice(8))} token limit`
  : (META.find(m => m.path === path) || {}).label || path;
function presetDiff(team, id) {
  const p = PRESETS[id];
  if (!p) return [];
  return FIELDS.filter(f => !same(valueOf(team, f), p.values[f])).map(f => ({ path: f, label: fieldLabel(f), from: valueOf(team, f), to: p.values[f],
    text: `${fieldLabel(f)}: ${fieldText(f, valueOf(team, f))} -> ${fieldText(f, p.values[f])}` }));
}
function applyPreset(team, id) {
  let out = { ...team, budgets: { ...(team.budgets || {}) } };
  for (const [path, v] of Object.entries((PRESETS[id] || { values: {} }).values)) out = put(out, path, v);
  return out;
}
// The preset the team settings match exactly, else 'custom'; `nearest` says which one it is closest to and by how much.
function detectPreset(team) {
  const counts = PRESET_ORDER.map(id => [id, presetDiff(team, id).length]);
  const exact = counts.find(([, n]) => n === 0);
  if (exact) return { id: exact[0], name: PRESETS[exact[0]].name, custom: false, changes: 0 };
  const [id, n] = counts.reduce((a, b) => (b[1] < a[1] ? b : a));
  return { id: 'custom', name: 'Custom', custom: true, nearest: id, changes: n };
}

// Inline warnings, keyed by the row (data-sid) they belong to. ctx: { agentIds, localStatus, missingAgents }.
function warnings(cfg, ctx = {}) {
  const t = teamOf(cfg), w = {};
  const add = (id, msg) => { (w[id] = w[id] || []).push(msg); };
  const ids = ctx.agentIds || (cfg.agents || []).map(a => a.id);
  const top = TIERS.indexOf(topTier(t));
  TIERS.forEach((tier, i) => {
    const b = get(t, 'budgets.' + tier) || 0;
    if (b > 0 && b < MIN_INSIDE) add('budget.' + tier, `${kTok(b)} is very small: a worker will usually stop before it finishes${t.savingProgress === 'inside' ? ', and "inside the limit" needs 20k or more' : ''}.`);
    else if (b === 0 && t.enabled && i <= top) add('budget.' + tier, 'No limit: one task on this tier can use as many tokens as it likes.');
    const lower = TIERS.slice(0, i).map(l => get(t, 'budgets.' + l) || 0).filter(Boolean);
    if (b > 0 && lower.length && b < Math.max(...lower)) add('budget.' + tier, `Smaller than a lower tier's limit (${kTok(Math.max(...lower))}), so the harder tier gets less room.`);
    const x = (t.tiers || {})[tier];
    if (x && x.agent && !ids.includes(x.agent)) add('tier.' + tier, `This tier uses "${x.agent}", which is not in your agent list, so it cannot start.`);
    if (x && (ctx.missingAgents || []).includes(x.agent)) add('tier.' + tier, `This tier needs ${x.agent}, which is not installed.`);
  });
  if ((t.maxWorkers || 4) > 8) add('maxWorkers', 'Many workers at once burn tokens quickly and are hard to follow.');
  if (topTier(t) === 'max') add('maxTier', 'Workers may use the most expensive tier.');
  const smallest = Math.min(...TIERS.map(x => get(t, 'budgets.' + x) || 0).filter(Boolean), Infinity);
  if (t.dailyCap && smallest !== Infinity && t.dailyCap < smallest) add('dailyCap', `Below one worker's limit (${kTok(smallest)}): the first worker could pass it.`);
  if (t.savingProgress === 'inside' && TIERS.some(x => { const b = get(t, 'budgets.' + x); return b && b < MIN_INSIDE; })) add('savingProgress', 'Some limits are under 20k, which "inside the limit" refuses.');
  if (ctx.localStatus === 'error') add('localModel', 'The local model failed to install; the free tier will fall back to the next route instead.');
  return w;
}

// The plain summary on top: one sentence per line, each pointing at the row that changes it.
// ctx: { labelOf(modelId), localStatus, localModel }
function summary(cfg, ctx = {}) {
  const t = teamOf(cfg), tiers = t.tiers || {};
  const label = ctx.labelOf || (x => x);
  const agentName = id => ((cfg.agents || []).find(a => a.id === id) || {}).name || id || 'an agent';
  const lines = [];
  const line = (target, text) => lines.push({ target, text });
  const top = topTier(t), topIdx = Math.max(0, TIERS.indexOf(top));
  const on = !!t.enabled;
  line('enabled', on ? 'Team mode is on: a lead agent hands small jobs to cheaper workers in their own tiles.' : 'Team mode is off: agents do the work themselves. Turn it on to hand small jobs to cheaper workers.');
  if (on) {
    const free = tiers.free || tiers.xsmall, hard = tiers[top];
    line('maxWorkers', `Up to ${t.maxWorkers ?? 4} workers run at once.`);
    if (free) line(tiers.free ? 'tier.free' : 'tier.xsmall', `Easy jobs go to ${label(free.model || '')} first${free.fallbacks && free.fallbacks.length ? ', with a backup if it is busy' : ''}.`);
    if (hard) line('maxTier', `The hardest job a worker takes is ${tierName(top)}, which runs ${agentName(hard.agent)} ${label(hard.model || '')}.`);
    const lim = TIERS.slice(0, topIdx + 1).filter(x => tiers[x]).map(x => `${x} ${(get(t, 'budgets.' + x) || 0) ? kTok(t.budgets[x]) : 'no limit'}`);
    line('budget.' + TIERS[topIdx], `Each worker stops at its token limit (${lim.join(', ')}) and ${t.savingProgress === 'inside' ? 'saves its notes inside that limit' : 'gets a little extra to save its notes'}.`);
    line('dailyCap', t.dailyCap ? `A project may use ${kTok(t.dailyCap)} tokens a day; past that, Operant asks you before another worker starts.` : 'There is no daily cap on tokens.');
    line('askBeforeMoveUp', 'A stuck worker, a second failure or a spent limit pauses the task and asks you before it moves up a tier.');
    line('verifyBeforeReview', t.verifyBeforeReview === false ? 'Finished code tasks go to review without being tested first.' : 'Finished code tasks are tested before you review them.');
  }
  line('localModel', ctx.localStatus === 'ready' ? `The local model (${ctx.localModel || 'installed'}) is ready as a free backup.`
    : ctx.localStatus === 'installing' ? 'The local model is installing.' : 'No local model is installed, so the free tier has no on-computer backup.');
  const p = detectPreset(t);
  return { lines, preset: p, presetText: p.custom ? `Custom: ${p.changes} setting${p.changes === 1 ? '' : 's'} differ${p.changes === 1 ? 's' : ''} from ${PRESETS[p.nearest].name}.` : `Preset: ${p.name}.` };
}

// Search: does a setting's label, description, developer term or group contain every word?
function matches(m, q) {
  const hay = `${m.label || ''} ${m.does || ''} ${m.dev || ''} ${m.group || ''} ${m.when || ''} ${m.adv ? 'advanced' : ''}`.toLowerCase();
  return String(q || '').toLowerCase().split(/\s+/).filter(Boolean).every(w => hay.includes(w));
}

// Team settings that differ from the defaults (defaults: cfg.team of the shipped config), as paths.
function changedFrom(team, defaults) {
  const out = [];
  for (const f of ['enabled', 'maxWorkers', 'maxTier', 'savingProgress', 'dailyCap', 'verifyBeforeReview', 'verifyTypesLint', ...TIERS.map(x => 'budgets.' + x), ...TIERS.map(x => 'minutes.' + x), ...TIERS.map(x => 'calls.' + x)]) {
    if (!same(get(team, f), get(defaults, f))) out.push(f);
  }
  return out;
}

const api = { TIERS, TIER_NAME, GROUPS, META, PRESETS, PRESET_ORDER, FIELDS, byId, kTok, get, put, effective, presetDiff, applyPreset, detectPreset, warnings, summary, matches, changedFrom };
if (typeof module !== 'undefined') module.exports = api; else globalThis.AgentSettings = api;
})();
