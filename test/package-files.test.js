// Every local module the app loads must be in package.json build.files, or the installed app
// crashes on launch with "Cannot find module" (as 1.15.0 did with backup.js). Follows relative
// require() calls from the entry points and checks each file against the packaged patterns.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = require('../package.json');

const packaged = (rel) => pkg.build.files.some((p) =>
  p.endsWith('/**') ? rel.startsWith(p.slice(0, -2)) : rel === p);

function resolveLocal(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const c of [base, base + '.js', base + '.json', path.join(base, 'index.js')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

test('every locally required file is packaged', () => {
  const entries = [pkg.main, 'preload.js'].map((f) => path.join(root, f));
  const seen = new Set();
  const missing = [];
  const queue = [...entries];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (!packaged(rel)) missing.push(rel);
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      const target = resolveLocal(file, m[1]);
      if (!target) missing.push(`${rel} -> ${m[1]} (not found)`);
      else queue.push(target);
    }
  }
  assert.deepEqual(missing, [], 'add these to "build.files" in package.json');
});

// macOS and Linux run these directly, so git must keep them executable: a Windows checkout can't tell,
// and the packaged app keeps the mode git gave them.
test('POSIX wrappers are executable in git', () => {
  const wrappers = ['bin/operant', 'hooks/long-commands.sh'];
  const out = require('node:child_process').execFileSync('git', ['ls-files', '-s', ...wrappers], { cwd: root, encoding: 'utf8' });
  for (const f of wrappers) assert.match(out, new RegExp(`^100755 \\S+ \\d\\t${f}$`, 'm'), `run: git update-index --chmod=+x ${f}`);
});

// The CLI and hooks run under a plain node outside Electron, which cannot read app.asar: everything
// they require (transitively) must be in asarUnpack, or `operant` dies with "Cannot find module '../redact'".
test('every module the CLI and hooks require is unpacked from the asar', () => {
  const unpacked = (rel) => pkg.build.asarUnpack.some((p) => p.endsWith('/**') ? rel.startsWith(p.slice(0, -2)) : rel === p);
  const seen = new Set(), missing = [];
  const queue = ['bin/operant-cli.js', 'bin/operant-prime.js', 'bin/operant-hook.js', 'hooks/long-commands.js'].map((f) => path.join(root, f));
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (!unpacked(rel)) missing.push(rel);
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      const target = resolveLocal(file, m[1]);
      if (target) queue.push(target);
    }
  }
  assert.deepEqual(missing, [], 'add these to "build.asarUnpack" in package.json');
});
