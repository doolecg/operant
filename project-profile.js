// Per-project profile for `operant prime`: languages, package manager, build/test commands and known
// failing checks (cached in <root>/.operant/profile.json, rebuilt when a key file's mtime changes),
// plus live git awareness (branch, changed files, recent commits, all capped).
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { writeFileAtomic } = require('./atomic-write');

const KEY_FILES = ['package.json', 'Cargo.toml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'pom.xml',
  'pyproject.toml', 'requirements.txt', 'go.mod', 'Makefile', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'bun.lockb', 'bun.lock', 'Gemfile', 'composer.json', 'tsconfig.json'];
const EXT_LANG = { '.js': 'JavaScript', '.mjs': 'JavaScript', '.ts': 'TypeScript', '.tsx': 'TypeScript', '.py': 'Python',
  '.rs': 'Rust', '.go': 'Go', '.java': 'Java', '.kt': 'Kotlin', '.cs': 'C#', '.rb': 'Ruby', '.php': 'PHP', '.cpp': 'C++', '.c': 'C' };
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.gradle', '.operant', 'out', 'venv', '.venv']);
const MAX_CMDS = 8, MAX_FILES = 8, MAX_COMMITS = 5, MAX_FAIL = 5;

const stat = p => { try { return fs.statSync(p); } catch { return null; } };
const read = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

function stamps(dir) {
  const o = {};
  for (const n of KEY_FILES) { const s = stat(path.join(dir, n)); if (s) o[n] = Math.round(s.mtimeMs); }
  return o;
}

function countExt(dir, langs, depth = 0, seen = { n: 0 }) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (seen.n > 2000) return;
    if (e.isDirectory()) { if (depth < 3 && !SKIP.has(e.name) && !e.name.startsWith('.')) countExt(path.join(dir, e.name), langs, depth + 1, seen); continue; }
    seen.n++;
    const l = EXT_LANG[path.extname(e.name).toLowerCase()];
    if (l) langs[l] = (langs[l] || 0) + 1;
  }
}

function detect(dir) {
  const has = n => !!stat(path.join(dir, n));
  const langs = new Set(), cmds = [];
  let pm = null;
  const add = c => { if (c && !cmds.includes(c)) cmds.push(c); };
  const pkg = read(path.join(dir, 'package.json'));
  if (pkg != null) {
    pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : (has('bun.lockb') || has('bun.lock')) ? 'bun' : 'npm';
    let j = {}; try { j = JSON.parse(pkg) || {}; } catch {}
    const run = s => pm === 'npm' ? (s === 'test' ? 'npm test' : `npm run ${s}`) : `${pm} ${s}`;
    for (const s of ['build', 'test', 'lint', 'typecheck', 'dev', 'start']) if (j.scripts && typeof j.scripts[s] === 'string') add(run(s));
    langs.add(has('tsconfig.json') ? 'TypeScript' : 'JavaScript');
  }
  if (has('Cargo.toml')) { langs.add('Rust'); pm = pm || 'cargo'; add('cargo build'); add('cargo test'); }
  if (has('build.gradle') || has('build.gradle.kts') || has('settings.gradle')) {
    langs.add('Java/Kotlin'); pm = pm || 'gradle';
    const g = has('gradlew') || has('gradlew.bat') ? './gradlew' : 'gradle';
    add(`${g} build`); add(`${g} test`);
  }
  if (has('pom.xml')) { langs.add('Java'); pm = pm || 'maven'; add('mvn package'); add('mvn test'); }
  if (has('pyproject.toml') || has('requirements.txt')) {
    langs.add('Python');
    const t = read(path.join(dir, 'pyproject.toml')) || '';
    pm = pm || (/\[tool\.poetry\]/.test(t) ? 'poetry' : /\[tool\.uv\]/.test(t) || has('uv.lock') ? 'uv' : 'pip');
    if (/pytest/.test(t) || has('pytest.ini') || has('tests')) add('pytest');
  }
  if (has('go.mod')) { langs.add('Go'); pm = pm || 'go'; add('go build ./...'); add('go test ./...'); }
  if (has('Gemfile')) { langs.add('Ruby'); pm = pm || 'bundler'; }
  if (has('composer.json')) { langs.add('PHP'); pm = pm || 'composer'; }
  if (has('Makefile')) add('make');
  const ext = {}; countExt(dir, ext);
  for (const [l] of Object.entries(ext).sort((a, b) => b[1] - a[1]).slice(0, 3)) if (![...langs].some(x => x.includes(l))) langs.add(l);
  return { languages: [...langs].slice(0, 5), packageManager: pm, commands: cmds.slice(0, MAX_CMDS) };
}

const cachePath = dir => path.join(dir, '.operant', 'profile.json');
const same = (a, b) => JSON.stringify(a || {}) === JSON.stringify(b || {});

// `failing` (optional): names of checks known to fail, set by callers; kept across refreshes when omitted.
function getProfile(dir, { failing } = {}) {
  dir = path.resolve(dir);
  const st = stamps(dir);
  let cached = null;
  try { cached = JSON.parse(read(cachePath(dir))); } catch {}
  let prof = cached && same(cached.stamps, st) ? cached : null;
  let dirty = false;
  if (!prof) { prof = { ...detect(dir), failing: (cached && cached.failing) || [], stamps: st }; dirty = true; }
  if (Array.isArray(failing) && !same(failing, prof.failing)) { prof.failing = failing.map(String).slice(0, MAX_FAIL); dirty = true; }
  if (dirty) { try { if (stat(path.join(dir, '.operant')) || stat(path.join(dir, '.git'))) writeFileAtomic(cachePath(dir), JSON.stringify(prof)); } catch {} }
  return prof;
}

function git(dir, args) {
  try { return execFileSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
}

function getGit(dir, run = git) {
  const b = run(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (b == null) return null;
  const st = (run(dir, ['status', '--porcelain']) || '').split('\n').filter(l => l.trim());
  const log = (run(dir, ['log', '-n5', '--oneline']) || '').split('\n').filter(l => l.trim());
  return { branch: b.trim(), changed: st.slice(0, MAX_FILES).map(l => l.trim()), changedTotal: st.length,
    conflicts: st.filter(l => /^(UU|AA|DD|AU|UA|DU|UD)/.test(l)).length, commits: log.slice(0, MAX_COMMITS) };
}

module.exports = { getProfile, getGit, detect, stamps, MAX_FILES, MAX_COMMITS, MAX_FAIL };
