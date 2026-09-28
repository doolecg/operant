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
