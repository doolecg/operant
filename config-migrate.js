// Config versions: config.json stores only what the user changed, plus configVersion. When a release renames
// or reshapes a saved key, add a migration here ({ to: N, run(user) }) and raise CURRENT by matching it.
// A migration edits the copy it is given, and must be idempotent: a crash before the migrated file is saved
// means it runs again on the next start.
const MIGRATIONS = [
  // Template: version 1 only establishes the version number, it changes nothing. A later one looks like
  //   { to: 2, run(user) { if ('oldKey' in user) { user.newKey ??= user.oldKey; delete user.oldKey; } } },
  { to: 1, run() {} },
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

// Defaults under what the user changed; keybinds and team are nested, so a partial override keeps the rest.
function mergeUser(defaults, user, keybinds) {
  return {
    ...defaults, ...user,
    keybinds: { ...keybinds, ...(user.keybinds || {}) },
    team: { ...defaults.team, ...(user.team || {}), tiers: { ...defaults.team.tiers, ...(user.team?.tiers || {}) }, budgets: { ...defaults.team.budgets, ...(user.team?.budgets || {}) } },
  };
}

module.exports = { CURRENT, MIGRATIONS, migrate, applyPatch, mergeUser };
