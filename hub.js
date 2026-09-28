// The hub: Operant's own copy of the user's skills and rules, so every agent reads one source.
//   <hub>/skills/<name>/SKILL.md   one copy of each skill; ~/.claude/skills/<name> is a junction to it
//   <hub>/rules.md                 the personal rules; ~/.claude/CLAUDE.md shrinks to one @import line
//   <hub>/backups/<timestamp>/     everything an apply touched, so "undo" restores it exactly
// Everything takes explicit paths (claudeDir, hubDir) so it can be tested against a copy of ~/.claude.
// audit() is read-only; apply() only performs the fixes it is given ids for. Plugin folders are report-only.
const fs = require('fs');
const os = require('os');
const path = require('path');
const memory = require('./memory');

const MAX_SKILL_BYTES = 20 * 1024;
const MAX_RULES_BYTES = 8 * 1024;
const LINK_NAME = 'operant-hub'; // ~/.claude/operant-hub -> <hub>: the space-free path CLAUDE.md imports through
const SKIP_SKILLS = new Set(['synced']); // managed by Claude Code

const hubSkills = hubDir => path.join(hubDir, 'skills');
const hubRules = hubDir => path.join(hubDir, 'rules.md');
const claudeSkills = claudeDir => path.join(claudeDir, 'skills');

function lstat(p) { try { return fs.lstatSync(p); } catch { return null; } }
function isLink(p) { const s = lstat(p); return !!s && s.isSymbolicLink(); }
// A junction reports as a link; "broken" when its target is gone.
function linkTarget(p) { try { return fs.readlinkSync(p); } catch { return null; } }
function linkBroken(p) { try { fs.statSync(p); return false; } catch { return true; } }
function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function sameDir(a, b) { return path.resolve(a).replace(/[\\/]+$/, '').toLowerCase() === path.resolve(b).replace(/[\\/]+$/, '').toLowerCase(); }
function dirSize(p) {
  let n = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const f = path.join(p, e.name);
    n += e.isDirectory() ? dirSize(f) : e.isFile() ? fs.statSync(f).size : 0;
  }
  return n;
}
function rmAny(p) {
  const s = lstat(p);
  if (!s) return;
  if (s.isSymbolicLink()) { try { fs.unlinkSync(p); } catch { fs.rmdirSync(p); } } else fs.rmSync(p, { recursive: true, force: true });
}

// The line CLAUDE.md is reduced to. Claude Code imports don't take paths with spaces, so it goes
// through the operant-hub junction inside claudeDir (~ form when that is the real ~/.claude).
function importLine(claudeDir) {
  const p = path.join(claudeDir, LINK_NAME, 'rules.md').replace(/\\/g, '/');
  const home = os.homedir().replace(/\\/g, '/');
  return '@' + (p.toLowerCase().startsWith(home.toLowerCase() + '/') ? '~' + p.slice(home.length) : p);
}

function frontmatterName(file) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readText(file) || '');
  const n = m && /^name:\s*["']?(.+?)["']?\s*$/m.exec(m[1]);
  return n ? n[1].trim() : null;
}
function findSkillFiles(root, depth = 6) {
  const out = [];
  (function walk(dir, d) {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isFile() && e.name === 'SKILL.md') out.push(p);
      else if (e.isDirectory() && d < depth && e.name !== 'node_modules' && e.name !== '.git') walk(p, d + 1);
    }
  })(root, 0);
  return out;
}

// memoryDirs: [{ dir, writable }]. Only writable ones (Operant's own) get fixes.
function audit({ claudeDir, hubDir, memoryDirs = [] }) {
  const findings = [];
  const add = f => findings.push(f);
  const skillsDir = claudeSkills(claudeDir);
  let entries = [];
  try { entries = fs.readdirSync(skillsDir, { withFileTypes: true }); } catch {}
  const local = new Map(); // name -> claude/skills entry path

  for (const e of entries) {
    if (SKIP_SKILLS.has(e.name)) continue;
    const p = path.join(skillsDir, e.name);
    const inHub = fs.existsSync(path.join(hubSkills(hubDir), e.name, 'SKILL.md'));
    if (isLink(p)) {
      if (linkBroken(p)) {
        add(inHub
          ? { id: `relink-skill:${e.name}`, kind: 'broken-link', message: `"${e.name}" is a broken junction; the hub has a copy`, fix: { type: 'relink-skill', name: e.name } }
          : { id: `remove-broken:${e.name}`, kind: 'broken-link', message: `"${e.name}" is a broken junction (target ${linkTarget(p)} is gone)`, fix: { type: 'remove-broken', name: e.name } });
      } else {
        local.set(e.name, p);
        const t = linkTarget(p);
        if (!(t && sameDir(t, path.join(hubSkills(hubDir), e.name)))) {
          add({ id: `linked-elsewhere:${e.name}`, kind: 'info', message: `"${e.name}" is a link to ${t}, not the hub; left alone` });
        }
      }
      continue;
    }
    if (!e.isDirectory() || !fs.existsSync(path.join(p, 'SKILL.md'))) continue;
    local.set(e.name, p);
    if (inHub) {
      add({ id: `conflict-skill:${e.name}`, kind: 'conflict', message: `"${e.name}" exists both in ~/.claude/skills and in the hub as separate copies; resolve by hand` });
    } else {
      add({ id: `adopt-skill:${e.name}`, kind: 'not-in-hub', message: `"${e.name}" is not in the hub; move it there and link it back`, fix: { type: 'adopt-skill', name: e.name } });
    }
  }
  // hub skills whose link is missing entirely
  let hubEntries = [];
  try { hubEntries = fs.readdirSync(hubSkills(hubDir), { withFileTypes: true }); } catch {}
  for (const e of hubEntries) {
    if (e.isDirectory() && !lstat(path.join(skillsDir, e.name))) {
      add({ id: `relink-skill:${e.name}`, kind: 'broken-link', message: `Hub skill "${e.name}" has no link in ~/.claude/skills`, fix: { type: 'relink-skill', name: e.name } });
    }
  }

  // Same skill name in ~/.claude/skills and in plugins (report only)
  const pluginNames = new Map(); // name -> [paths]
  for (const sub of ['marketplaces', 'cache']) {
    for (const f of findSkillFiles(path.join(claudeDir, 'plugins', sub))) {
      const name = frontmatterName(f) || path.basename(path.dirname(f));
      if (!pluginNames.has(name)) pluginNames.set(name, []);
      pluginNames.get(name).push(f);
    }
  }
  for (const name of local.keys()) {
    const hits = pluginNames.get(name);
    if (hits) add({ id: `dup-plugin:${name}`, kind: 'duplicate', message: `"${name}" is in ~/.claude/skills and also in a plugin (${path.relative(path.join(claudeDir, 'plugins'), hits[0]).split(path.sep).slice(0, 2).join('/')}); plugin folders are report-only` });
  }

  // Oversized skills and rules (report only)
  for (const name of local.keys()) {
    const f = path.join(skillsDir, name, 'SKILL.md');
    try {
      const size = fs.statSync(f).size;
      if (size > MAX_SKILL_BYTES) add({ id: `big-skill:${name}`, kind: 'oversized', message: `"${name}" SKILL.md is ${Math.round(size / 1024)} KB; every load costs tokens, consider splitting it` });
    } catch {}
  }
  const claudeMd = path.join(claudeDir, 'CLAUDE.md');
  const md = readText(claudeMd);
  const rulesText = readText(hubRules(hubDir));
  const isImport = md != null && md.trim() === importLine(claudeDir);
  if (md != null && !isImport) {
    if (rulesText == null || rulesText === md) {
      add({ id: 'adopt-rules', kind: 'not-in-hub', message: `CLAUDE.md (${Math.round(md.length / 1024 * 10) / 10} KB) is not in the hub; move it to hub/rules.md and leave a one-line import`, fix: { type: 'adopt-rules' } });
    } else {
      add({ id: 'conflict-rules', kind: 'conflict', message: 'CLAUDE.md and hub/rules.md both exist and differ; resolve by hand' });
    }
  } else if (isImport && (rulesText == null || linkBroken(path.join(claudeDir, LINK_NAME)))) {
    add({ id: 'broken-rules', kind: 'broken-link', message: 'CLAUDE.md imports the hub rules, but hub/rules.md or the operant-hub link is missing' });
  }
  const rulesSize = Math.max(rulesText ? Buffer.byteLength(rulesText) : 0, md && !isImport ? Buffer.byteLength(md) : 0);
  if (rulesSize > MAX_RULES_BYTES) add({ id: 'big-rules', kind: 'oversized', message: `The rules file is ${Math.round(rulesSize / 1024)} KB and is sent with every session; consider trimming it` });

  // Memory: duplicate facts, and (Operant's own) index drift
  for (const { dir, writable } of memoryDirs) {
    const facts = memory.listFacts(dir);
    const seen = new Map();
    const drop = [];
    for (const f of facts.sort((a, b) => a.file.localeCompare(b.file))) {
      const key = (f.description || f.body).toLowerCase().replace(/\s+/g, ' ').trim();
      if (!key) continue;
      if (seen.has(key)) drop.push({ file: f.file, dup: seen.get(key) }); else seen.set(key, f.file);
    }
    for (const d of drop) {
      const where = path.basename(path.dirname(dir)) === '.operant' ? '.operant/memory' : dir;
      add({ id: `dup-memory:${dir}:${d.file}`, kind: 'duplicate', message: `Memory fact ${d.file} duplicates ${d.dup} (${where})`, fix: writable ? { type: 'drop-memory', dir, file: d.file } : undefined });
    }
    if (writable && facts.length) {
      const index = readText(path.join(dir, 'MEMORY.md')) || '';
      const missing = facts.filter(f => !index.includes(`**${f.name}**`));
      if (missing.length) add({ id: `index-memory:${dir}`, kind: 'stale', message: `Memory index in ${dir} is missing ${missing.length} fact(s); rebuild it`, fix: { type: 'index-memory', dir } });
    }
  }

  const fixable = findings.filter(f => f.fix).length;
  return { findings, fixable, drift: fixable > 0 };
}

// ---- backup: save(p) records what p is right now, so undo can put it back exactly.
function newBackup(hubDir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let dir = path.join(hubDir, 'backups', stamp), n = 1;
  while (fs.existsSync(dir)) dir = path.join(hubDir, 'backups', `${stamp}-${n++}`);
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
  const manifest = { created: new Date().toISOString(), entries: [], undone: false };
  const seen = new Set();
  const flush = () => fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 1));
  return {
    dir,
    save(p) {
      if (seen.has(p)) return;
      seen.add(p);
      const s = lstat(p);
      const entry = { path: p, kind: 'absent' };
      if (s && s.isSymbolicLink()) { entry.kind = 'link'; entry.target = linkTarget(p); }
      else if (s) {
        entry.kind = s.isDirectory() ? 'dir' : 'file';
        entry.copy = String(manifest.entries.length);
        fs.cpSync(p, path.join(dir, 'files', entry.copy), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
      }
      manifest.entries.push(entry);
      flush(); // written before the change, so a crash mid-apply is still undoable
    },
    flush,
    manifest,
  };
}

const LINK_KIND = process.platform === 'win32' ? 'junction' : 'dir';
function makeLink(target, at) { fs.mkdirSync(path.dirname(at), { recursive: true }); fs.symlinkSync(target, at, LINK_KIND); }

function runFix(fix, { claudeDir, hubDir }, bk) {
  const skillsDir = claudeSkills(claudeDir);
  switch (fix.type) {
    case 'adopt-skill': {
      const src = path.join(skillsDir, fix.name), dst = path.join(hubSkills(hubDir), fix.name);
      bk.save(src); bk.save(dst);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.cpSync(src, dst, { recursive: true, preserveTimestamps: true });
      if (!fs.existsSync(path.join(dst, 'SKILL.md'))) throw new Error('copy to the hub failed');
      fs.rmSync(src, { recursive: true, force: true });
      makeLink(dst, src);
      return;
    }
    case 'relink-skill': {
      const at = path.join(skillsDir, fix.name);
      bk.save(at);
      rmAny(at);
      makeLink(path.join(hubSkills(hubDir), fix.name), at);
      return;
    }
    case 'remove-broken': {
      const at = path.join(skillsDir, fix.name);
      bk.save(at);
      rmAny(at);
      return;
    }
    case 'adopt-rules': {
      const md = path.join(claudeDir, 'CLAUDE.md'), dst = hubRules(hubDir), link = path.join(claudeDir, LINK_NAME);
      bk.save(md); bk.save(dst); bk.save(link);
      fs.mkdirSync(hubDir, { recursive: true });
      fs.copyFileSync(md, dst);
      rmAny(link);
      makeLink(hubDir, link);
      if (fs.readFileSync(path.join(link, 'rules.md'), 'utf8') !== fs.readFileSync(md, 'utf8')) throw new Error('the rules link does not resolve');
      fs.writeFileSync(md, importLine(claudeDir) + '\n');
      return;
    }
    case 'drop-memory': {
      bk.save(path.join(fix.dir, fix.file)); bk.save(path.join(fix.dir, 'MEMORY.md'));
      fs.unlinkSync(path.join(fix.dir, fix.file));
      memory.rebuildIndex(fix.dir);
      return;
    }
    case 'index-memory': {
      bk.save(path.join(fix.dir, 'MEMORY.md'));
      memory.rebuildIndex(fix.dir);
      return;
    }
    default: throw new Error(`unknown fix ${fix.type}`);
  }
}

// ids: the finding ids the user ticked. Re-audits first so it never applies a stale plan.
function apply({ claudeDir, hubDir, memoryDirs = [], ids }) {
  const want = new Set(ids);
  const fixes = audit({ claudeDir, hubDir, memoryDirs }).findings.filter(f => f.fix && want.has(f.id));
  if (!fixes.length) return { backup: null, done: [], errors: [] };
  const bk = newBackup(hubDir);
  const done = [], errors = [];
  // rules first, so a skills failure never leaves CLAUDE.md pointing nowhere
  fixes.sort((a, b) => (b.fix.type === 'adopt-rules') - (a.fix.type === 'adopt-rules'));
  for (const f of fixes) {
    try { runFix(f.fix, { claudeDir, hubDir }, bk); done.push(f.id); }
    catch (e) { errors.push({ id: f.id, error: String(e.message || e) }); }
  }
  bk.manifest.applied = done;
  bk.flush();
  return { backup: path.basename(bk.dir), done, errors };
}

function lastBackup(hubDir) {
  let names = [];
  try { names = fs.readdirSync(path.join(hubDir, 'backups')).sort(); } catch {}
  for (const n of names.reverse()) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(hubDir, 'backups', n, 'manifest.json'), 'utf8'));
      if (!m.undone) return { name: n, manifest: m, dir: path.join(hubDir, 'backups', n) };
    } catch {}
  }
  return null;
}

function undo({ hubDir }) {
  const b = lastBackup(hubDir);
  if (!b) return { restored: 0, backup: null };
  for (const e of b.manifest.entries.slice().reverse()) {
    rmAny(e.path);
    if (e.kind === 'absent') continue;
    fs.mkdirSync(path.dirname(e.path), { recursive: true });
    if (e.kind === 'link') fs.symlinkSync(e.target, e.path, LINK_KIND);
    else fs.cpSync(path.join(b.dir, 'files', e.copy), e.path, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  }
  b.manifest.undone = true;
  fs.writeFileSync(path.join(b.dir, 'manifest.json'), JSON.stringify(b.manifest, null, 1));
  return { restored: b.manifest.entries.length, backup: b.name };
}

module.exports = { audit, apply, undo, lastBackup, importLine, hubRules, hubSkills, LINK_NAME };
