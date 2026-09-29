// Item 45: shared memory across agents. One memory per project, at `.operant/memory/`, that every
// agent in that project reads and adds to; user-wide facts (--type user / --global) live in
// Operant's own userData `memory/` instead. Each fact is a small Markdown file with frontmatter
// (name, description, type, optional about) plus a one-line entry in an index, `MEMORY.md`. The
// main agent's own memory (Claude Code: ~/.claude/projects/<mangled cwd>/memory/) is folded into
// recall read-only, so other agents see what it already knows.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const TYPES = ['user', 'feedback', 'project', 'reference'];
const CONFIDENCE = ['verified', 'observed', 'inferred', 'stale'];
const RECALL_LOG_MAX = 2 * 1024 * 1024;

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

// The project a fact belongs to: the nearest folder at or above cwd that is a git repo or already has
// a `.operant/` folder, or null (the home folder, a drive root, or no project found). Project facts are
// only ever written inside a project.
function memoryProjectDir(cwd, { homeDir = os.homedir() } = {}) {
  if (!cwd) return null;
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  let dir = path.resolve(String(cwd));
  for (;;) {
    if (homeDir && same(dir, homeDir)) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // drive root
    if (['.git', '.operant'].some(n => fs.existsSync(path.join(dir, n)))) return dir;
    dir = parent;
  }
}
// Where recall reads project facts: the project's memory, or (outside a project) an existing
// `<cwd>/.operant/memory` that already holds facts, so older facts saved there stay readable.
function readableProjectMemoryDir(cwd, homeDir) {
  if (!cwd) return null;
  const root = memoryProjectDir(cwd, { homeDir });
  if (root) return projectMemoryDir(root);
  const legacy = projectMemoryDir(cwd);
  return listFacts(legacy).length ? legacy : null;
}
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
  const int = v => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : 0; };
  return {
    file, dir, path: path.join(dir, file), meta,
    id: file.replace(/\.md$/i, ''),
    name: meta.name || file.replace(/\.md$/, ''),
    description: meta.description || '',
    type: meta.type || 'project',
    about: Array.isArray(meta.about) ? meta.about : (meta.about ? [meta.about] : []),
    aboutSig: Array.isArray(meta.aboutSig) ? meta.aboutSig : (meta.aboutSig ? [meta.aboutSig] : []),
    confidence: CONFIDENCE.includes(meta.confidence) ? meta.confidence : 'observed',
    created: meta.created || '', updated: meta.updated || '', lastUsed: meta.lastUsed || '',
    recalls: int(meta.recalls), uses: int(meta.uses), rejects: int(meta.rejects),
    supersedes: meta.supersedes || '',
    body: body.trim(),
  };
}

// Rewrites one fact's frontmatter with a patch (counters, confidence), keeping its body and any keys we don't know.
function patchFact(f, patch) {
  const meta = { ...f.meta, ...patch };
  try { fs.writeFileSync(f.path, toFrontmatter(meta) + '\n' + f.body + '\n'); } catch { /* best effort */ }
}

// Usage telemetry (recalls, uses, rejects, lastUsed) lives in userData memory-stats.json, keyed by the
// fact file's absolute path, so recalling never edits fact files that a project keeps in git.
const statsKey = p => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
function loadStats(userDataDir) {
  if (!userDataDir) return {};
  try {
    const o = JSON.parse(fs.readFileSync(path.join(userDataDir, 'memory-stats.json'), 'utf8'));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch { return {}; }
}
function updateStats(userDataDir, edits) { // edits: [[fact, patch]]
  if (!userDataDir) return;
  const all = loadStats(userDataDir);
  for (const [f, patch] of edits) {
    const k = statsKey(f.path);
    all[k] = { recalls: f.recalls, uses: f.uses, rejects: f.rejects, lastUsed: f.lastUsed, ...all[k], ...patch };
  }
  try { fs.mkdirSync(userDataDir, { recursive: true }); fs.writeFileSync(path.join(userDataDir, 'memory-stats.json'), JSON.stringify(all)); } catch { /* best effort */ }
}

// Every fact file in a memory dir (not its MEMORY.md index). With userDataDir, usage stats are overlaid
// on whatever counters an older fact file still carries in its frontmatter.
function listFacts(dir, userDataDir) {
  let files;
  try { files = fs.readdirSync(dir); } catch { return []; }
  const stats = userDataDir ? loadStats(userDataDir) : {};
  return files.filter(f => f.toLowerCase().endsWith('.md') && f.toUpperCase() !== 'MEMORY.MD')
    .map(f => readFact(dir, f)).filter(Boolean)
    .map(f => {
      const st = stats[statsKey(f.path)];
      return st ? Object.assign(f, { recalls: Number(st.recalls) || 0, uses: Number(st.uses) || 0, rejects: Number(st.rejects) || 0, lastUsed: st.lastUsed || f.lastUsed }) : f;
    });
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

// The file an `about` entry points at ("<name>@<file>:<line>", "<file>:<line>" or a plain path), or null
// when it isn't a file (a bare symbol name CodeGraph couldn't resolve).
function aboutRel(entry) {
  const s = String(entry);
  return (s.includes('@') ? s.slice(s.indexOf('@') + 1) : s).replace(/:\d+$/, '');
}
// sha1 of the whole file: CodeGraph gives a symbol's start line but no end line, so a symbol link is
// hashed by its file too. "-" = nothing to check.
function hashAbout(cwd, entry) {
  if (!cwd) return '-';
  try {
    const abs = path.resolve(cwd, aboutRel(entry));
    if (!fs.statSync(abs).isFile()) return '-';
    return crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex');
  } catch { return '-'; }
}
// The first `about` file that changed or vanished since the fact was saved, or null.
function staleAbout(cwd, fact) {
  if (!cwd) return null;
  for (let i = 0; i < fact.about.length; i++) {
    const sig = fact.aboutSig[i];
    if (!sig || sig === '-') continue;
    const now = hashAbout(cwd, fact.about[i]);
    if (now === '-' || now !== sig) return aboutRel(fact.about[i]);
  }
  return null;
}

function targetDir(cwd, userDataDir, type, global, homeDir) {
  const root = (global || type === 'user') ? null : memoryProjectDir(cwd, { homeDir });
  return root ? projectMemoryDir(root) : globalMemoryDir(userDataDir);
}

// Saves one fact, updating an existing one instead of adding a duplicate when its name or
// description (normalized) matches a fact already in the same memory dir.
function remember({ cwd, userDataDir, text, type = 'project', global = false, about = [], confidence, supersedes, homeDir }) {
  const fact = String(text || '').trim();
  if (!fact) throw new Error('text required');
  const kind = TYPES.includes(type) ? type : 'project';
  const dir = targetDir(cwd, userDataDir, kind, global, homeDir);
  const fellBack = !global && kind !== 'user' && dir === globalMemoryDir(userDataDir);
  fs.mkdirSync(dir, { recursive: true });

  const aboutList = [...new Set([].concat(about).map(a => String(a).trim()).filter(Boolean)
    .map(a => resolveAbout(cwd, a)).filter(Boolean))];

  const name = shortName(fact);
  const slug = slugify(name);
  const existing = listFacts(dir, userDataDir).find(f => slugify(f.name) === slug || norm(f.description) === norm(fact));
  const file = existing ? existing.file : (() => {
    let n = `${slug}.md`, i = 2;
    while (fs.existsSync(path.join(dir, n))) n = `${slug}-${i++}.md`;
    return n;
  })();

  const now = new Date().toISOString();
  let supId = '';
  if (supersedes) {
    const want = String(supersedes).trim().replace(/\.md$/i, '');
    const target = [dir, readableProjectMemoryDir(cwd, homeDir), globalMemoryDir(userDataDir)].filter(Boolean).flatMap(d => listFacts(d))
      .find(f => f.id === want || slugify(f.name) === slugify(want));
    if (!target) throw new Error(`no fact "${want}" to supersede`);
    supId = target.id;
  }
  const conf = CONFIDENCE.includes(confidence) ? confidence : (existing ? existing.confidence : 'observed');
  const meta = {
    name, description: fact, type: kind, about: aboutList, aboutSig: aboutList.map(a => hashAbout(cwd, a)),
    confidence: conf, created: (existing && existing.created) || now, updated: now,
    supersedes: supId || (existing ? existing.supersedes : ''),
  };
  fs.writeFileSync(path.join(dir, file), toFrontmatter(meta) + '\n' + fact + '\n');
  // An older fact's frontmatter counters move to the sidecar, since remember no longer writes them.
  if (existing && (existing.recalls || existing.uses || existing.rejects || existing.lastUsed)) updateStats(userDataDir, [[existing, {}]]);
  rebuildIndex(dir);
  return { name, id: file.replace(/\.md$/i, ''), type: kind, file, dir, updated: !!existing,
    ...(fellBack ? { note: `saved to your personal memory (${cwd} isn't a project)` } : {}) };
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

function formatFact(f, sourceLabel, stale) {
  const about = f.about.length ? `\nabout: ${f.about.join(', ')}` : '';
  const tags = (f.confidence !== 'observed' ? ` [${f.confidence}]` : '') + (stale ? ` [stale: ${stale} changed]` : '');
  const where = [`id: ${f.id}`, sourceLabel].filter(Boolean).join(', ');
  return `## ${f.name} [${f.type}]${tags} (${where})${about}\n${f.body || f.description}`;
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
    { dir: readableProjectMemoryDir(cwd, homeDir), label: null, readOnly: false },
    { dir: globalMemoryDir(userDataDir), label: 'global', readOnly: false },
  ].filter(s => s.dir);
  if (cwd) sources.push({ dir: claudeMemoryDir(cwd, homeDir), label: 'main agent, read-only', readOnly: true });
  return sources;
}

function readOnlyIndexText(dir) {
  try { return fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8').trim(); } catch { return ''; }
}

// No query/about: the index (this project's facts, then global, then the main agent's own memory).
function recallIndex({ cwd, userDataDir, tokenCap, homeDir, all }) {
  const sections = [];
  for (const { dir, label, readOnly } of allSources(cwd, userDataDir, homeDir)) {
    if (readOnly) {
      const text = readOnlyIndexText(dir);
      if (text) sections.push(`### Main agent's memory (read-only)\n${text}`);
      continue;
    }
    const every = rebuildIndex(dir);
    const hide = all ? new Set() : supersededIds(every);
    const facts = every.filter(f => !isSuperseded(f, hide));
    if (facts.length) sections.push(`### ${label ? label[0].toUpperCase() + label.slice(1) : 'Project'} memory\n${facts.map(indexLine).join('\n')}`);
  }
  if (!sections.length) return { text: '(no memory yet)', shown: 0, total: 0, more: 0 };
  const { text, shown, total, more } = capOutput(sections, tokenCap);
  return { text, shown, total, more };
}

// Facts another fact names in `supersedes` are replaced: hidden from recall unless `all`.
function supersededIds(facts) {
  const ids = new Set();
  for (const f of facts) if (f.supersedes) { ids.add(String(f.supersedes)); ids.add(slugify(f.supersedes)); }
  return ids;
}
const isSuperseded = (f, ids) => ids.has(f.id) || ids.has(slugify(f.name));

function tokens(text) { return String(text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean); }

// BM25 (k1 1.2, b 0.75) of each doc (a token array) against the query tokens.
function bm25(docs, qTokens, k1 = 1.2, b = 0.75) {
  const N = docs.length;
  const avg = docs.reduce((n, d) => n + d.length, 0) / (N || 1) || 1;
  const terms = [...new Set(qTokens)];
  const df = new Map(terms.map(t => [t, docs.filter(d => d.includes(t)).length]));
  return docs.map(d => {
    let score = 0;
    for (const t of terms) {
      const n = df.get(t);
      const tf = d.filter(x => x === t).length;
      if (!n || !tf) continue;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * tf * (k1 + 1) / (tf + k1 * (1 - b + b * d.length / avg));
    }
    return score;
  });
}

// How much a fact has earned its place: feedback ratio, and a 14-day half-life since it was last
// used or updated (floor 0.2). Facts with no dates (written before item 58) don't decay.
function weight(f, now = Date.now()) {
  const useful = Math.max(0.05, (f.uses - f.rejects + 1) / (f.recalls + 2));
  const t = Date.parse(f.lastUsed || f.updated || f.created || '');
  const decay = Number.isFinite(t) ? Math.max(0.2, Math.pow(0.5, Math.max(0, now - t) / 86400000 / 14)) : 1;
  return useful * decay;
}

// Appends to userData memory-recalls.jsonl, trimming the oldest lines past ~2 MB.
function logRecall(userDataDir, rec) {
  if (!userDataDir) return;
  const file = path.join(userDataDir, 'memory-recalls.jsonl');
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), ...rec }) + '\n');
    if (fs.statSync(file).size > RECALL_LOG_MAX) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      fs.writeFileSync(file, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n');
    }
  } catch { /* best effort */ }
}

// items: [{ text, fact? }]. Caps by tokens, then counts a recall on the facts that fit (project/global
// only) and logs their ids. Recall's only writes are the stats sidecar and the log.
function finish(items, tokenCap, userDataDir, query) {
  if (!items.length) return null;
  const capped = capOutput(items.map(i => i.text), tokenCap);
  const shown = items.slice(0, capped.shown).map(i => i.fact).filter(Boolean);
  const now = new Date().toISOString();
  updateStats(userDataDir, shown.map(f => [f, { recalls: f.recalls + 1, lastUsed: now }]));
  if (shown.length) logRecall(userDataDir, { query: query || '', ids: shown.map(f => f.id) });
  return { ...capped, total: items.length };
}

// query: BM25 over name/description/body, weighted by usefulness and recency, stale facts halved.
// Anything the old plain substring match found (about text included) still counts, ranked last.
function recallQuery({ cwd, userDataDir, query, tokenCap, homeDir, all }) {
  const q = norm(query);
  const cands = [];
  const writable = [];
  for (const { dir, label, readOnly } of allSources(cwd, userDataDir, homeDir)) {
    if (readOnly) {
      let files = [];
      try { files = fs.readdirSync(dir); } catch {}
      for (const f of files.filter(f => f.toLowerCase().endsWith('.md') && f.toUpperCase() !== 'MEMORY.MD')) {
        let raw = ''; try { raw = fs.readFileSync(path.join(dir, f), 'utf8'); } catch {}
        const { meta, body } = parseFrontmatter(raw);
        cands.push({ hay: raw.toLowerCase(), toks: tokens(`${meta.name || ''} ${meta.description || ''} ${body}`), text: `## ${f.replace(/\.md$/, '')} (main agent, read-only)\n${raw.trim()}` });
      }
      continue;
    }
    for (const fact of listFacts(dir, userDataDir)) {
      writable.push(fact);
      cands.push({ fact, label, hay: `${fact.name} ${fact.description} ${fact.body} ${fact.about.join(' ')}`.toLowerCase(), toks: tokens(`${fact.name} ${fact.description} ${fact.body}`) });
    }
  }
  const hidden = all ? new Set() : supersededIds(writable);
  const scores = bm25(cands.map(c => c.toks), tokens(query));
  const now = Date.now();
  const ranked = [];
  cands.forEach((c, i) => {
    if (c.fact && isSuperseded(c.fact, hidden)) return;
    if (!(scores[i] > 0) && !c.hay.includes(q)) return;
    let stale = null, w = 1;
    if (c.fact) {
      stale = staleAbout(cwd, c.fact);
      w = weight(c.fact, now) * (stale || c.fact.confidence === 'stale' ? 0.5 : 1);
    }
    ranked.push({ score: (scores[i] > 0 ? scores[i] : 0.01) * w, fact: c.fact, text: c.text || formatFact(c.fact, c.label, stale) });
  });
  ranked.sort((a, b) => b.score - a.score);
  return finish(ranked, tokenCap, userDataDir, query) || { text: '(no facts match)', shown: 0, total: 0, more: 0 };
}

// --about <file|symbol>: facts linked to it, or to any symbol CodeGraph resolved into that file.
function recallAbout({ cwd, userDataDir, about, tokenCap, homeDir, all }) {
  const target = String(about).trim();
  const resolved = resolveAbout(cwd, target);
  const resolvedFile = resolved && resolved.includes('@') ? resolved.split('@')[1].split(':')[0] : null;
  const srcs = allSources(cwd, userDataDir, homeDir).filter(s => !s.readOnly);
  const hidden = all ? new Set() : supersededIds(srcs.flatMap(s => listFacts(s.dir, userDataDir)));
  const items = [];
  for (const { dir, label } of srcs) {
    for (const fact of listFacts(dir, userDataDir)) {
      if (isSuperseded(fact, hidden)) continue;
      if (fact.about.length && aboutMatches(fact, target, resolvedFile || target)) items.push({ fact, text: formatFact(fact, label, staleAbout(cwd, fact)) });
    }
  }
  return finish(items, tokenCap, userDataDir, `about:${target}`) || { text: '(no facts linked to that)', shown: 0, total: 0, more: 0 };
}

// `operant memory used|wrong <id>`: an agent's verdict on a fact it was handed. Two rejects that
// outnumber the uses mark it stale (never deleted).
function feedback({ cwd, userDataDir, id, kind, note, homeDir }) {
  const want = String(id || '').trim().replace(/\.md$/i, '');
  if (!want) throw new Error('id required');
  const fact = [readableProjectMemoryDir(cwd, homeDir), globalMemoryDir(userDataDir)].filter(Boolean).flatMap(d => listFacts(d, userDataDir)).find(f => f.id === want);
  if (!fact) throw new Error(`no fact "${want}"`);
  if (kind === 'used') updateStats(userDataDir, [[fact, { uses: fact.uses + 1 }]]);
  else if (kind === 'wrong') {
    const rejects = fact.rejects + 1;
    updateStats(userDataDir, [[fact, { rejects }]]);
    if (rejects >= 2 && rejects > fact.uses) patchFact(fact, { confidence: 'stale' });
  } else throw new Error('feedback is "used" or "wrong"');
  logRecall(userDataDir, { id: fact.id, [kind]: true, ...(note ? { note: String(note) } : {}) });
  return { text: `${fact.id}: ${kind}`, shown: 0, total: 0, more: 0 };
}

function recall(args) {
  const { cwd, userDataDir, query, about, tokenCap = 2000, homeDir, all } = args;
  if (args.feedback) return feedback({ cwd, userDataDir, id: args.id, kind: args.feedback, note: args.note, homeDir });
  if (about) return recallAbout({ cwd, userDataDir, about, tokenCap, homeDir, all });
  if (query) return recallQuery({ cwd, userDataDir, query, tokenCap, homeDir, all });
  return recallIndex({ cwd, userDataDir, tokenCap, homeDir, all });
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
  projectMemoryDir, memoryProjectDir, globalMemoryDir, claudeMemoryDir,
  // exported for tests
  slugify, shortName, weight, bm25, parseFrontmatter, toFrontmatter, listFacts, rebuildIndex, resolveAbout,
};
