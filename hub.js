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
const MANAGED_SKILLS = new Set(['operant']); // rewritten by Operant on every start, so never tidied
const TIDY_MIN_BYTES = 32;             // below this, stray whitespace isn't worth a finding
const OPTIMISE_RULES_BYTES = 4 * 1024; // rules/skills past these sizes get an "optimise with an agent" offer
const OPTIMISE_SKILL_BYTES = 12 * 1024;
const MAX_DESCRIPTION = 1024;          // Claude Code's cap on a skill description
const MAX_INDEX_LINES = 200;           // Claude Code only loads this many lines of MEMORY.md

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

// ---- Markdown: the files every agent reads, checked for waste and structure.
const optimisedPath = hubDir => path.join(hubDir, 'optimised.json');
function readOptimised(hubDir) { try { return JSON.parse(fs.readFileSync(optimisedPath(hubDir), 'utf8')); } catch { return {}; } }

// Every Markdown file Tidy agents looks after: the rules, the user's own skills (not plugins) and memory.
function mdTargets({ claudeDir, hubDir, memoryDirs }, localSkills) {
  const out = [];
  const md = path.join(claudeDir, 'CLAUDE.md'), text = readText(md);
  const rules = text != null && text.trim() === importLine(claudeDir) ? hubRules(hubDir) : md;
  if (fs.existsSync(rules)) out.push({ file: rules, role: 'rules', writable: true });
  for (const [name, dir] of localSkills) {
    if (MANAGED_SKILLS.has(name)) continue;
    (function walk(d, depth) {
      let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isFile() && /\.md$/i.test(e.name)) out.push({ file: p, role: e.name === 'SKILL.md' && d === dir ? 'skill' : 'skill-ref', skill: name, writable: true });
        else if (e.isDirectory() && depth < 3 && e.name !== 'node_modules' && e.name !== '.git') walk(p, depth + 1);
      }
    })(dir, 0);
  }
  for (const { dir, writable } of memoryDirs) {
    let files = []; try { files = fs.readdirSync(dir); } catch {}
    for (const f of files) if (/\.md$/i.test(f)) out.push({ file: path.join(dir, f), role: f.toUpperCase() === 'MEMORY.MD' ? 'memory-index' : 'memory', writable });
  }
  return out;
}

// Lines of a Markdown file tagged raw when they sit in frontmatter or a code fence, which are never rewritten.
function mdLines(text) {
  const lines = text.split(/\r?\n/);
  let fence = null, front = lines[0] === '---';
  return lines.map((line, i) => {
    let raw = front || !!fence;
    if (front && i > 0 && line === '---') front = false;
    else if (!front) {
      const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (m && !fence) { fence = m[1]; raw = true; }
      else if (m && fence && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
    }
    return { line, raw };
  }).concat(fence ? [{ unclosed: true }] : []);
}

// Mechanical tidy: BOM, trailing spaces, runs of blank lines, repeated paragraphs. Code and frontmatter stay as they are.
function tidyMd(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const tagged = mdLines(text.replace(/^﻿/, '')).filter(l => !l.unclosed);
  const out = [], seen = new Set();
  let dupes = 0, para = [];
  const flush = () => {
    const key = para.map(l => l.trim()).join(' ').replace(/\s+/g, ' ');
    if (key.length >= 40 && !key.startsWith('#')) {
      if (seen.has(key)) { dupes++; para = []; if (out[out.length - 1] === '') out.pop(); return; }
      seen.add(key);
    }
    out.push(...para); para = [];
  };
  for (const l of tagged) {
    if (l.raw) { flush(); out.push(l.line); continue; }
    const line = l.line.replace(/[ \t]+$/, '');
    if (line === '') { flush(); if (out.length && out[out.length - 1] !== '') out.push(''); continue; }
    para.push(line);
  }
  flush();
  while (out.length && out[0] === '') out.shift();
  while (out.length && out[out.length - 1] === '') out.pop();
  const result = out.join(eol) + (out.length ? eol : '');
  return { text: result, saved: Buffer.byteLength(text) - Buffer.byteLength(result), dupes };
}

// Structure problems an agent (or the user) should sort out: they make a file slower to read and search.
function mdStructure(text, { needHeadings = true } = {}) {
  const issues = [], headings = new Set();
  let last = 0, lastHeading = null, sinceHeading = 0;
  for (const l of mdLines(text)) {
    if (l.unclosed) { issues.push('a code block is never closed'); continue; }
    if (l.raw) { sinceHeading++; continue; }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l.line);
    if (!h) {
      if (l.line.trim()) sinceHeading++;
      if (l.line.length > 600) issues.push('a line over 600 characters (split it into bullets)');
      continue;
    }
    const level = h[1].length, key = level + h[2].toLowerCase();
    if (last && level > last + 1) issues.push(`heading "${h[2]}" jumps from level ${last} to ${level}`);
    if (lastHeading && !sinceHeading && level <= lastHeading.level) issues.push(`section "${lastHeading.text}" is empty`);
    if (headings.has(key)) issues.push(`heading "${h[2]}" appears twice (merge the sections)`);
    headings.add(key);
    last = level; lastHeading = { level, text: h[2] }; sinceHeading = 0;
  }
  if (needHeadings && !headings.size && Buffer.byteLength(text) > 3 * 1024) issues.push('over 3 KB with no headings');
  return [...new Set(issues)];
}

// Relative links and @imports that point at nothing.
function mdBrokenLinks(file, text) {
  const dir = path.dirname(file), bad = new Set();
  for (const l of mdLines(text)) {
    if (l.raw || l.unclosed) continue;
    for (const m of l.line.matchAll(/\[[^\]]*\]\(<?([^)\s>]+)>?(?:\s[^)]*)?\)/g)) {
      const t = m[1].split('#')[0];
      if (!t || /^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('//')) continue;
      let target; try { target = decodeURIComponent(t); } catch { target = t; }
      if (!fs.existsSync(path.resolve(dir, target))) bad.add(t);
    }
    const imp = /^@(\S+)$/.exec(l.line.trim());
    if (imp && /[\\/.]/.test(imp[1]) && !fs.existsSync(path.resolve(dir, imp[1].replace(/^~(?=[\\/])/, os.homedir())))) bad.add(imp[1]);
  }
  return [...bad];
}

const kb = n => n >= 1024 ? `${Math.round(n / 102.4) / 10} KB` : `${n} bytes`;

function mdAudit(args, localSkills, add) {
  const { claudeDir, hubDir } = args;
  const bases = [[hubDir, 'hub'], [claudeDir, '~/.claude'], [os.homedir(), '~']].map(([b, as]) => [path.resolve(b), as]);
  const show = p => {
    const r = path.resolve(p);
    const hit = bases.find(([b]) => r.toLowerCase().startsWith(b.toLowerCase() + path.sep));
    return (hit ? hit[1] + r.slice(hit[0].length) : r).replace(/\\/g, '/');
  };
  const optimised = readOptimised(hubDir);
  const toOptimise = [], stats = { files: 0, bytes: 0 };
  for (const t of mdTargets(args, localSkills)) {
    const text = readText(t.file);
    if (text == null) continue;
    const size = Buffer.byteLength(text), name = show(t.file);
    stats.files++; stats.bytes += size;

    const tidy = tidyMd(text);
    if (tidy.saved >= TIDY_MIN_BYTES || tidy.dupes) {
      const what = [tidy.saved ? `${kb(tidy.saved)} of padding` : '', tidy.dupes ? `${tidy.dupes} repeated paragraph${tidy.dupes === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
      add({ id: `tidy-md:${t.file}`, kind: 'messy', message: `${name}: ${what}; tidy it (code blocks and frontmatter untouched)`, fix: t.writable ? { type: 'tidy-md', file: t.file } : undefined });
    }
    const issues = t.role === 'memory-index' ? [] : mdStructure(text, { needHeadings: t.role !== 'memory' });
    // Problems only an agent can sort out: offered as an "agent-fix" that hands it the file and the problem.
    const agentFix = (id, kind, message) => add({ id, kind, message, fix: t.writable ? { type: 'agent-fix', file: t.file, problem: message } : undefined });
    if (issues.length) agentFix(`structure:${t.file}`, 'structure', `${name}: ${issues.slice(0, 3).join('; ')}${issues.length > 3 ? ` (+${issues.length - 3} more)` : ''}`);
    const broken = mdBrokenLinks(t.file, text);
    if (broken.length) agentFix(`md-links:${t.file}`, 'broken-link', `${name} links to ${broken.length === 1 ? 'a missing file' : broken.length + ' missing files'}: ${broken.slice(0, 3).join(', ')}`);

    if (t.role === 'skill') {
      const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
      const desc = m && /^description:\s*(.*)$/m.exec(m[1]);
      if (!m || !/^name:/m.test(m[1]) || !desc || !desc[1].trim().replace(/^["']|["']$/g, '')) agentFix(`skill-meta:${t.skill}`, 'index', `Skill "${t.skill}" has no name or description in its frontmatter, so agents can't tell when to load it`);
      else if (desc[1].length > MAX_DESCRIPTION) agentFix(`skill-desc:${t.skill}`, 'index', `Skill "${t.skill}" description is ${desc[1].length} characters; Claude Code cuts it at ${MAX_DESCRIPTION}`);
    }
    if (t.role === 'memory' && !/^---[\s\S]*?^description:[ \t]*\S/m.test(text)) agentFix(`memory-meta:${t.file}`, 'index', `${name} has no description, so its index line says nothing useful`);
    if (t.role === 'memory-index') {
      const lines = text.split(/\r?\n/).filter(Boolean);
      if (lines.length > MAX_INDEX_LINES) agentFix(`index-long:${t.file}`, 'index', `${name} has ${lines.length} lines; only the first ${MAX_INDEX_LINES} are loaded`);
      const wide = lines.filter(l => l.length > 200).length;
      if (wide) agentFix(`index-wide:${t.file}`, 'index', `${name}: ${wide} index line${wide === 1 ? ' is' : 's are'} over 200 characters; keep each to a one-line hook`);
    }

    const big = (t.role === 'rules' && size > OPTIMISE_RULES_BYTES) || (t.role === 'skill' && size > OPTIMISE_SKILL_BYTES);
    const prev = optimised[t.file];
    if (t.writable && (big || issues.length >= 2) && !(prev && size <= prev.size * 1.2)) toOptimise.push({ file: t.file, name, size, issues: issues.length });
  }
  for (const o of toOptimise) {
    add({ id: `optimise:${o.file}`, kind: 'optimise', message: `${o.name} (${kb(o.size)}${o.issues ? `, ${o.issues} structure issue${o.issues === 1 ? '' : 's'}` : ''}): an agent restructures it into short sections, merges repeats and cuts its token cost, keeping every rule`, fix: { type: 'agent-optimise', file: o.file, size: o.size } });
  }
  return stats;
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

  const mdStats = mdAudit({ claudeDir, hubDir, memoryDirs }, local, add);

  // Agent rewrites cost tokens, so they are offered but never counted toward the badge.
  const fixable = findings.filter(f => f.fix && !f.fix.type.startsWith('agent-')).length;
  return { findings, fixable, drift: fixable > 0, md: mdStats };
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
    case 'tidy-md': {
      const text = fs.readFileSync(fix.file, 'utf8');
      bk.save(fix.file);
      fs.writeFileSync(fix.file, tidyMd(text).text);
      return;
    }
    case 'agent-optimise': {
      // Backed up here and rewritten by the agent tile the renderer starts, so undo puts the original back.
      bk.save(fix.file);
      const done = readOptimised(hubDir);
      done[fix.file] = { size: fix.size, at: new Date().toISOString() };
      fs.mkdirSync(hubDir, { recursive: true });
      fs.writeFileSync(optimisedPath(hubDir), JSON.stringify(done, null, 1));
      return { agent: { file: fix.file, task: 'optimise' } };
    }
    case 'agent-fix': {
      bk.save(fix.file);
      return { agent: { file: fix.file, task: 'fix', problem: fix.problem } };
    }
    default: throw new Error(`unknown fix ${fix.type}`);
  }
}

// ids: the finding ids the user ticked. Re-audits first so it never applies a stale plan.
function apply({ claudeDir, hubDir, memoryDirs = [], ids }) {
  const want = new Set(ids);
  const fixes = audit({ claudeDir, hubDir, memoryDirs }).findings.filter(f => f.fix && want.has(f.id));
  if (!fixes.length) return { backup: null, done: [], errors: [], agent: [] };
  const bk = newBackup(hubDir);
  const done = [], errors = [], agent = [];
  // rules first, so a skills failure never leaves CLAUDE.md pointing nowhere
  fixes.sort((a, b) => (b.fix.type === 'adopt-rules') - (a.fix.type === 'adopt-rules'));
  for (const f of fixes) {
    try { const r = runFix(f.fix, { claudeDir, hubDir }, bk); done.push(f.id); if (r?.agent) agent.push(r.agent); }
    catch (e) { errors.push({ id: f.id, error: String(e.message || e) }); }
  }
  bk.manifest.applied = done;
  bk.flush();
  return { backup: path.basename(bk.dir), done, errors, agent };
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

module.exports = { audit, apply, tidyMd, mdStructure, undo, lastBackup, importLine, hubRules, hubSkills, LINK_NAME };
