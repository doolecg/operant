// Skills backup: copies every skill (hub + ~/.claude/skills) and the rules into a private git repo's
// working folder, commits the change and pushes it. Everything takes explicit paths so it can be
// tested against temp dirs and a local bare "remote". Only ever touches the configured repo folder,
// only the current branch, and never forces a push, creates or removes a remote.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const hub = require('./hub');

const SKIP_SKILLS = new Set(['synced', hub.LINK_NAME]);
const SKIP_DIRS = new Set(['__pycache__', '.git', 'node_modules', '.venv', '.mypy_cache', '.pytest_cache']);
const isSecret = n => /^\.env(\..*)?$/i.test(n) || /\.(key|pem)$/i.test(n) || /^credentials/i.test(n);
const isJunk = n => n === '.DS_Store' || n === 'Thumbs.db' || /\.pyc$/i.test(n);

function git(dir, args, opts = {}) {
  return new Promise(resolve => {
    execFile('git', ['-C', dir, ...args], { timeout: 120000, windowsHide: true, maxBuffer: 16 << 20,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }, ...opts }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout || '').trim(), err: String(stderr || (err && err.message) || '').trim() });
    });
  });
}
const realPath = p => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
const norm = p => realPath(p).replace(/[\\/]+$/, '').toLowerCase();
const same = (a, b) => norm(a) === norm(b);
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// Copies src into dest following junctions/symlinks, skipping junk and secrets. `seen` holds the real
// paths on the current branch of the walk so a link back to a parent can't loop.
function copyTree(src, dest, seen = new Set()) {
  const real = fs.realpathSync(src);
  if (seen.has(real)) return;
  seen.add(real);
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src)) {
    if (isSecret(e) || isJunk(e)) continue;
    const s = path.join(src, e), d = path.join(dest, e);
    let st; try { st = fs.statSync(s); } catch { continue; } // broken link
    if (st.isDirectory()) { if (!SKIP_DIRS.has(e)) copyTree(s, d, seen); }
    else if (st.isFile()) fs.copyFileSync(s, d);
  }
  seen.delete(real);
}

// name -> real folder, hub first (a ~/.claude/skills entry with the same name is the link back to it).
function collectSkills(hubDir, claudeDir) {
  const skills = new Map();
  for (const root of [hubDir ? hub.hubSkills(hubDir) : '', path.join(claudeDir || '', 'skills')]) {
    let names = []; try { names = fs.readdirSync(root); } catch {}
    for (const n of names) {
      if (SKIP_SKILLS.has(n) || skills.has(n)) continue;
      const p = path.join(root, n);
      if (isDir(p) && fs.existsSync(path.join(p, 'SKILL.md'))) skills.set(n, p);
    }
  }
  return skills;
}

function rulesSource(hubDir, claudeDir) {
  for (const p of [hubDir && hub.hubRules(hubDir), claudeDir && path.join(claudeDir, 'CLAUDE.md')]) if (p && fs.existsSync(p)) return p;
  return null;
}

// Refreshes <repo>/skills and <repo>/rules.md to match the sources.
function stage(repoDir, hubDir, claudeDir) {
  const out = path.join(repoDir, 'skills');
  fs.rmSync(out, { recursive: true, force: true });
  for (const [name, dir] of collectSkills(hubDir, claudeDir)) copyTree(dir, path.join(out, name));
  const rules = rulesSource(hubDir, claudeDir);
  if (rules) fs.copyFileSync(rules, path.join(repoDir, 'rules.md'));
}

// The repo folder must be the root of a git repository with a remote, on a branch.
async function checkRepo(repoDir) {
  if (!repoDir || !isDir(repoDir)) return { error: 'Folder not found' };
  const top = await git(repoDir, ['rev-parse', '--show-toplevel']);
  if (top.code) return { error: 'Not a git repository' };
  if (!same(top.out, repoDir)) return { error: 'Not the root of a git repository' };
  const remotes = (await git(repoDir, ['remote'])).out.split(/\s+/).filter(Boolean);
  if (!remotes.length) return { error: 'The repository has no remote' };
  const branch = await git(repoDir, ['symbolic-ref', '--short', 'HEAD']);
  if (branch.code || !branch.out) return { error: 'Not on a branch (detached HEAD)' };
  return { remotes };
}

// -> { path, status: 'pushed' | 'nothing' | 'error', message }
async function backupRepo({ repoDir, hubDir, claudeDir, message = 'Back up skills' }) {
  const res = (status, msg) => ({ path: repoDir, status, message: msg });
  const chk = await checkRepo(repoDir);
  if (chk.error) return res('error', chk.error);
  const { remotes } = chk;
  try { stage(repoDir, hubDir, claudeDir); } catch (e) { return res('error', 'Copy failed: ' + e.message); }

  const add = await git(repoDir, ['add', '-A']);
  if (add.code) return res('error', 'git add failed: ' + add.err);
  const changed = (await git(repoDir, ['diff', '--cached', '--quiet'])).code === 1;
  if (changed) {
    const c = await git(repoDir, ['commit', '-m', message]);
    if (c.code) return res('error', 'git commit failed: ' + (c.err || c.out));
  }
  const upstream = (await git(repoDir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).code === 0;
  if (upstream && !changed) {
    const ahead = await git(repoDir, ['rev-list', '--count', '@{u}..HEAD']);
    if (ahead.out === '0') return res('nothing', 'Nothing to back up');
  } else if (!upstream && !changed && (await git(repoDir, ['rev-parse', '--verify', 'HEAD'])).code) {
    return res('nothing', 'Nothing to back up');
  }
  const p = await git(repoDir, upstream ? ['push'] : ['push', '-u', remotes[0], 'HEAD']);
  if (p.code) return res('error', 'git push failed: ' + (p.err.split('\n').filter(Boolean).pop() || 'unknown error'));
  return res('pushed', 'Pushed');
}

// repos: [{ path }] -> [result per repo]
async function backupAll({ repos, hubDir, claudeDir }) {
  const results = [];
  for (const r of repos || []) results.push(await backupRepo({ repoDir: r && r.path, hubDir, claudeDir }));
  return results;
}

module.exports = { backupRepo, checkRepo, backupAll, collectSkills, copyTree };
