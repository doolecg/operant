// The context section of a worker's launch brief, built from what the task is about (plan 2.4 part 1): the
// files its text names, the project profile, memories that match it and the git changes, ranked, deduplicated
// and budgeted by context-engine.js through agent-brief.contextSection. One line (no newlines, no double
// quotes), because the brief travels as one quoted shell argument.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_FILES = 3;
const FILE_CHARS = 1500;
const FILE_RE = /[\w.\/\\-]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|py|java|kt|go|rs|cs|rb|php|c|cpp|h|md|css|html)\b/g;

// Files the task text names that exist under cwd (relative paths only), most-named first, at most MAX_FILES.
function mentionedFiles(text, cwd, { exists = fs.existsSync } = {}) {
  const out = [];
  for (const m of String(text || '').matchAll(FILE_RE)) {
    const rel = m[0].replace(/\\/g, '/').replace(/^\.\//, '');
    if (rel.startsWith('/') || rel.includes('..') || /^[a-z]:/i.test(rel) || out.includes(rel)) continue;
    if (exists(path.join(cwd, rel))) out.push(rel);
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

const hashOf = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

// -> pieces for buildContext. deps: { readFile, exists, getProfile, getGit, recall, record(provider) }; all optional.
function gatherPieces({ cwd, task, userDataDir, homeDir }, deps = {}) {
  const readFile = deps.readFile || (f => fs.readFileSync(f, 'utf8'));
  const pieces = [];
  const now = Date.now();
  for (const rel of mentionedFiles(task, cwd, { exists: deps.exists })) {
    try {
      const raw = readFile(path.join(cwd, rel));
      const h = hashOf(raw);
      pieces.push({ kind: 'file', source: rel, text: raw.slice(0, FILE_CHARS), hash: h, currentHash: h, at: now });
    } catch { /* unreadable: skipped */ }
  }
  try {
    const p = (deps.getProfile || require('./project-profile').getProfile)(cwd);
    const bits = [
      p.languages && p.languages.length ? p.languages.join(', ') : '',
      p.packageManager || '',
      p.commands && p.commands.length ? `commands: ${p.commands.slice(0, 6).join(' | ')}` : '',
      p.failing && p.failing.length ? `known failing: ${p.failing.slice(0, 5).join(', ')}` : '',
    ].filter(Boolean);
    if (bits.length) pieces.push({ kind: 'file', source: 'project profile', text: bits.join('; '), at: now });
  } catch { /* no profile */ }
  try {
    const rec = (deps.recall || require('./memory').recall)({ cwd, userDataDir, homeDir, query: task, tokenCap: 400 });
    if (rec && rec.shown && rec.text) pieces.push({ kind: 'memory', source: 'project memory', text: rec.text, at: now });
  } catch { /* no memory */ }
  try {
    const g = (deps.getGit || require('./project-profile').getGit)(cwd);
    if (g) {
      if (deps.record) deps.record('git', 'called');
      const files = (g.changed || []).slice(0, 8).join(', ');
      const text = [`branch ${g.branch}; ${g.changedTotal ? `changed: ${files}${g.changedTotal > 8 ? ` (+${g.changedTotal - 8} more)` : ''}` : 'clean'}`,
        ...(g.commits && g.commits.length ? [`recent commits: ${g.commits.slice(0, 5).join(' | ')}`] : [])].join('; ');
      pieces.push({ kind: 'git', source: 'git', text, at: now });
    }
  } catch { /* no git */ }
  return pieces;
}

// -> { text, sources } where text is '' or ' — <heading and pieces>' ready to append to the prompt.
function workerContext(opts, deps = {}) {
  const { contextSection } = require('./agent-brief');
  deps = { record: (provider, field) => require('./context-providers').recordFor(opts.cwd, provider, field), ...deps };
  const pieces = gatherPieces(opts, deps);
  const section = contextSection(opts.task, pieces, { maxBytes: opts.maxBytes });
  if (!section) return { text: '', sources: [] };
  const sources = pieces.filter(p => section.includes(`[${p.kind} ${p.source}`)).map(p => p.kind);
  if (deps.record && sources.includes('git')) deps.record('git', 'used');
  const flat = require('./codegraph-first').flatten(section, 1400);
  return { text: ` — ${flat}`, sources };
}

module.exports = { workerContext, gatherPieces, mentionedFiles };
