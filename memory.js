// Item 45: shared memory across agents. One memory per project, at `.operant/memory/`, that every
// agent in that project reads and adds to; user-wide facts (--type user / --global) live in
// Operant's own userData `memory/` instead. Each fact is a small Markdown file with frontmatter
// (name, description, type, optional about) plus a one-line entry in an index, `MEMORY.md`. The
// main agent's own memory (Claude Code: ~/.claude/projects/<mangled cwd>/memory/) is folded into
// recall read-only, so other agents see what it already knows.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const TYPES = ['user', 'feedback', 'project', 'reference'];

function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'fact';
}
function shortName(text) {
  return String(text).trim().split(/\s+/).slice(0, 8).join(' ').slice(0, 60);
}
function norm(text) {
  return String(text).toLowerCase().trim().replace(/\s+/g, ' ');
}

// Claude Code's own project-memory folder: the cwd with every non-alphanumeric character (each
// one, not collapsed) turned into "-", e.g. F:\PROGRAMMING\REPOS\Operant -> F--PROGRAMMING-REPOS-Operant.
function claudeMemoryDir(cwd, homeDir = os.homedir()) {
  const mangled = String(cwd).replace(/[^A-Za-z0-9]/g, '-');
  return path.join(homeDir, '.claude', 'projects', mangled, 'memory');
}
function projectMemoryDir(cwd) { return path.join(cwd, '.operant', 'memory'); }
function globalMemoryDir(userDataDir) { return path.join(userDataDir, 'memory'); }

function parseFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!mm) continue;
    let v = mm[2].trim();
    if (v.startsWith('[') && v.endsWith(']')) {
      meta[mm[1]] = v === '[]' ? [] : v.slice(1, -1).split(',').map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
    } else meta[mm[1]] = v.replace(/^"|"$/g, '');
  }
  return { meta, body: m[2] };
}
function toFrontmatter(meta) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(meta)) {
    if (v == null || v === '') continue;
    if (Array.isArray(v)) { if (v.length) lines.push(`${k}: [${v.map(x => JSON.stringify(String(x))).join(', ')}]`); }
    else lines.push(`${k}: ${JSON.stringify(String(v))}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

function readFact(dir, file) {
  let raw;
  try { raw = fs.readFileSync(path.join(dir, file), 'utf8'); } catch { return null; }
  const { meta, body } = parseFrontmatter(raw);
  return {
    file, dir, path: path.join(dir, file),
    name: meta.name || file.replace(/\.md$/, ''),
    description: meta.description || '',
    type: meta.type || 'project',
    about: Array.isArray(meta.about) ? meta.about : (meta.about ? [meta.about] : []),
    body: body.trim(),
  };
}

// Every fact file in a memory dir (not its MEMORY.md index).
function listFacts(dir) {
  let files;
  try { files = fs.readdirSync(dir); } catch { return []; }
  return files.filter(f => f.toLowerCase().endsWith('.md') && f.toUpperCase() !== 'MEMORY.MD')
    .map(f => readFact(dir, f)).filter(Boolean);
}

function indexLine(f) {
  const about = f.about.length ? ` (about: ${f.about.join(', ')})` : '';
  return `- **${f.name}** [${f.type}]${about} — ${f.description}`;
}
function rebuildIndex(dir) {
  const facts = listFacts(dir).sort((a, b) => a.name.localeCompare(b.name));
  const body = facts.map(indexLine).join('\n');
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'MEMORY.md'), body + (body ? '\n' : '')); } catch (e) { /* best effort */ }
  return facts;
}

function codegraphExists(cwd) {
  try { return fs.statSync(path.join(cwd, '.codegraph')).isDirectory(); } catch { return false; }
}

// Resolves one --about item through `codegraph query <name>` (fast, single call) so the link
// survives renames as "<name>@<file>:<line>" instead of a bare name. Falls back to the raw text
// (a plain path also works fine unresolved) when CodeGraph isn't indexed or doesn't answer.
function resolveAbout(cwd, item) {
  const raw = String(item).trim();
  if (!raw) return null;
  if (!cwd || !codegraphExists(cwd)) return raw;
  try {
    const out = execFileSync('codegraph', ['query', raw], { cwd, timeout: 4000, encoding: 'utf8', windowsHide: true });
    const m = /([^\s:()"]+\.[A-Za-z0-9]+):(\d+)/.exec(out);
    if (m) {
      let file = m[1].replace(/\\/g, '/');
      if (path.isAbsolute(file)) file = path.relative(cwd, file).replace(/\\/g, '/');
      return `${raw}@${file}:${m[2]}`;
    }
  } catch { /* codegraph missing, not indexed, or query failed: keep the raw text */ }
  return raw;
}

function targetDir(cwd, userDataDir, type, global) {
  return (global || type === 'user') ? globalMemoryDir(userDataDir) : projectMemoryDir(cwd);
}

// Saves one fact, updating an existing one instead of adding a duplicate when its name or
// description (normalized) matches a fact already in the same memory dir.
function remember({ cwd, userDataDir, text, type = 'project', global = false, about = [] }) {
  const fact = String(text || '').trim();
  if (!fact) throw new Error('text required');
  const kind = TYPES.includes(type) ? type : 'project';
  const dir = targetDir(cwd, userDataDir, kind, global);
  fs.mkdirSync(dir, { recursive: true });

  const aboutList = [...new Set([].concat(about).map(a => String(a).trim()).filter(Boolean)
    .map(a => resolveAbout(cwd, a)).filter(Boolean))];

  const name = shortName(fact);
  const slug = slugify(name);
  const existing = listFacts(dir).find(f => slugify(f.name) === slug || norm(f.description) === norm(fact));
  const file = existing ? existing.file : (() => {
    let n = `${slug}.md`, i = 2;
    while (fs.existsSync(path.join(dir, n))) n = `${slug}-${i++}.md`;
    return n;
  })();

  const meta = { name, description: fact, type: kind, about: aboutList };
  fs.writeFileSync(path.join(dir, file), toFrontmatter(meta) + '\n' + fact + '\n');
  rebuildIndex(dir);
  return { name, type: kind, file, dir, updated: !!existing };
}

// Rough token cap (~4 chars/token). Cuts at a whole entry boundary and reports how many were left out.
function capOutput(entries, tokenCap = 2000) {
  const limit = Math.max(200, tokenCap) * 4;
  let out = '', shown = 0;
  for (const e of entries) {
    const chunk = (out ? '\n\n' : '') + e;
    if (out && out.length + chunk.length > limit) break;
    out += chunk; shown++;
  }
  const more = entries.length - shown;
  return { text: out, shown, total: entries.length, more };
}

function formatFact(f, sourceLabel) {
  const about = f.about.length ? `\nabout: ${f.about.join(', ')}` : '';
  return `## ${f.name} [${f.type}]${sourceLabel ? ` (${sourceLabel})` : ''}${about}\n${f.body || f.description}`;
}

function aboutMatches(fact, target, resolvedTargetFile) {
  const t = target.toLowerCase();
  const rf = resolvedTargetFile ? resolvedTargetFile.toLowerCase() : null;
  return fact.about.some(a => {
    const al = String(a).toLowerCase();
    return al === t || al.includes(t) || (rf && al.includes(rf));
  });
}

// Every fact in scope for a project: its own `.operant/memory/`, Operant's global `memory/`, and
// (read-only) the main agent's own memory folder for this project.
function allSources(cwd, userDataDir, homeDir) {
  const sources = [
    { dir: projectMemoryDir(cwd), label: null, readOnly: false },
    { dir: globalMemoryDir(userDataDir), label: 'global', readOnly: false },
  ];
  if (cwd) sources.push({ dir: claudeMemoryDir(cwd, homeDir), label: 'main agent, read-only', readOnly: true });
  return sources;
}

function readOnlyIndexText(dir) {
  try { return fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8').trim(); } catch { return ''; }
}

// No query/about: the index (this project's facts, then global, then the main agent's own memory).
function recallIndex({ cwd, userDataDir, tokenCap, homeDir }) {
  const sections = [];
  for (const { dir, label, readOnly } of allSources(cwd, userDataDir, homeDir)) {
    if (readOnly) {
      const text = readOnlyIndexText(dir);
      if (text) sections.push(`### Main agent's memory (read-only)\n${text}`);
      continue;
    }
    const facts = rebuildIndex(dir);
    if (facts.length) sections.push(`### ${label ? label[0].toUpperCase() + label.slice(1) : 'Project'} memory\n${facts.map(indexLine).join('\n')}`);
  }
  if (!sections.length) return { text: '(no memory yet)', shown: 0, total: 0, more: 0 };
  const { text, shown, total, more } = capOutput(sections, tokenCap);
  return { text, shown, total, more };
}

// query: substring match (case-insensitive) over name/description/body/about, across every source.
function recallQuery({ cwd, userDataDir, query, tokenCap, homeDir }) {
  const q = norm(query);
  const entries = [];
  for (const { dir, label, readOnly } of allSources(cwd, userDataDir, homeDir)) {
    if (readOnly) {
      let files = [];
      try { files = fs.readdirSync(dir); } catch {}
      for (const f of files.filter(f => f.toLowerCase().endsWith('.md') && f.toUpperCase() !== 'MEMORY.MD')) {
        let raw = ''; try { raw = fs.readFileSync(path.join(dir, f), 'utf8'); } catch {}
        if (raw.toLowerCase().includes(q)) entries.push(`## ${f.replace(/\.md$/, '')} (main agent, read-only)\n${raw.trim()}`);
      }
      continue;
    }
    for (const fact of listFacts(dir)) {
      const hay = `${fact.name} ${fact.description} ${fact.body} ${fact.about.join(' ')}`.toLowerCase();
      if (hay.includes(q)) entries.push(formatFact(fact, label));
    }
  }
  if (!entries.length) return { text: '(no facts match)', shown: 0, total: 0, more: 0 };
  return { ...capOutput(entries, tokenCap), total: entries.length };
}

// --about <file|symbol>: facts linked to it, or to any symbol CodeGraph resolved into that file.
function recallAbout({ cwd, userDataDir, about, tokenCap, homeDir }) {
  const target = String(about).trim();
  const resolved = resolveAbout(cwd, target);
  const resolvedFile = resolved && resolved.includes('@') ? resolved.split('@')[1].split(':')[0] : null;
  const entries = [];
  for (const { dir, label } of allSources(cwd, userDataDir, homeDir).filter(s => !s.readOnly)) {
    for (const fact of listFacts(dir)) {
      if (fact.about.length && aboutMatches(fact, target, resolvedFile || target)) entries.push(formatFact(fact, label));
    }
  }
  if (!entries.length) return { text: '(no facts linked to that)', shown: 0, total: 0, more: 0 };
  return { ...capOutput(entries, tokenCap), total: entries.length };
}

function recall({ cwd, userDataDir, query, about, tokenCap = 2000, homeDir }) {
  if (about) return recallAbout({ cwd, userDataDir, about, tokenCap, homeDir });
  if (query) return recallQuery({ cwd, userDataDir, query, tokenCap, homeDir });
  return recallIndex({ cwd, userDataDir, tokenCap, homeDir });
}

function listAll({ cwd, userDataDir }) {
  const project = listFacts(projectMemoryDir(cwd)).map(f => ({ ...f, scope: 'project' }));
  const global = listFacts(globalMemoryDir(userDataDir)).map(f => ({ ...f, scope: 'global' }));
  return [...project, ...global];
}

function deleteFact({ dir, file }) {
  fs.unlinkSync(path.join(dir, file));
  rebuildIndex(dir);
}

module.exports = {
  TYPES, remember, recall, listAll, deleteFact,
  projectMemoryDir, globalMemoryDir, claudeMemoryDir,
  // exported for tests
  slugify, shortName, parseFrontmatter, toFrontmatter, listFacts, rebuildIndex, resolveAbout,
};
