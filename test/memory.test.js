// Tests for memory.js (plan item 45): save, dedupe/update, recall by query and --about, index
// format, and the read-only fold-in of the main agent's own (Claude Code) memory folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const memory = require('../memory.js');

const madeDirs = [];
function tmpDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `operant-memtest-${name}-`));
  madeDirs.push(dir);
  return dir;
}
test.after(() => { for (const d of madeDirs) fs.rmSync(d, { recursive: true, force: true }); });

test('remember saves a fact with frontmatter, and rebuilds the index', () => {
  const cwd = tmpDir('proj');
  const userDataDir = tmpDir('user');
  const r = memory.remember({ cwd, userDataDir, text: 'Ship on dev-<version>, fast-forward main at release', type: 'project' });
  assert.equal(r.updated, false);
  assert.equal(r.type, 'project');

  const dir = memory.projectMemoryDir(cwd);
  const facts = memory.listFacts(dir);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].description, 'Ship on dev-<version>, fast-forward main at release');
  assert.equal(facts[0].type, 'project');

  const index = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8');
  assert.match(index, /^- \*\*.+\*\* \[project\] — Ship on dev-<version>/m);
});

test('remember with --type user / --global saves to Operant userData, not the project', () => {
  const cwd = tmpDir('proj');
  const userDataDir = tmpDir('user');
  memory.remember({ cwd, userDataDir, text: 'Prefers plain commit messages, no AI attribution', type: 'user' });
  assert.equal(memory.listFacts(memory.projectMemoryDir(cwd)).length, 0);
  assert.equal(memory.listFacts(memory.globalMemoryDir(userDataDir)).length, 1);

  memory.remember({ cwd, userDataDir, text: 'Another global fact', global: true });
  assert.equal(memory.listFacts(memory.globalMemoryDir(userDataDir)).length, 2);
});

test('remember dedupes: a matching name or description updates instead of duplicating', () => {
  const cwd = tmpDir('proj');
  const userDataDir = tmpDir('user');
  const dir = memory.projectMemoryDir(cwd);

  const first = memory.remember({ cwd, userDataDir, text: 'Runs on Node 22 in CI' });
  assert.equal(first.updated, false);
  assert.equal(memory.listFacts(dir).length, 1);

  // Exact same text again: same file, marked updated.
  const second = memory.remember({ cwd, userDataDir, text: 'Runs on Node 22 in CI' });
  assert.equal(second.updated, true);
  assert.equal(second.file, first.file);
  assert.equal(memory.listFacts(dir).length, 1);

  // A genuinely different fact adds a second entry.
  memory.remember({ cwd, userDataDir, text: 'Deploys are manual, triggered from the release skill' });
  assert.equal(memory.listFacts(dir).length, 2);
});

test('recall with no query returns the index; a query returns full matching facts', () => {
  const cwd = tmpDir('proj');
  const userDataDir = tmpDir('user');
  memory.remember({ cwd, userDataDir, text: 'The build lives in build/ and is gitignored' });
  memory.remember({ cwd, userDataDir, text: 'Release notes go at the top of RELEASE_NOTES.md' });

  const idx = memory.recall({ cwd, userDataDir });
  assert.match(idx.text, /Project memory/);
  assert.match(idx.text, /build\/ and is gitignored/);
  assert.match(idx.text, /RELEASE_NOTES\.md/);

  const q = memory.recall({ cwd, userDataDir, query: 'release notes' });
  assert.equal(q.total, 1);
  assert.match(q.text, /Release notes go at the top/);
  assert.doesNotMatch(q.text, /gitignored/);

  const none = memory.recall({ cwd, userDataDir, query: 'nonexistent xyz' });
  assert.equal(none.total, 0);
});

test('recall caps output and reports how many more matched', () => {
  const cwd = tmpDir('proj');
  const userDataDir = tmpDir('user');
  for (let i = 0; i < 40; i++) {
    memory.remember({ cwd, userDataDir, text: `Fact number ${i} about the widget subsystem and its quirks and history` });
  }
  const r = memory.recall({ cwd, userDataDir, query: 'widget', tokenCap: 200 }); // ~800 chars
  assert.equal(r.total, 40);
  assert.ok(r.shown < r.total);
  assert.equal(r.more, r.total - r.shown);
  assert.ok(r.text.length <= 200 * 4 + 200); // generous slack for the last accepted chunk
});

test('remember --about links a fact to files/symbols, and recall --about finds it', () => {
  const cwd = tmpDir('proj'); // no .codegraph/ here, so about entries are kept as-is
  const userDataDir = tmpDir('user');
  memory.remember({ cwd, userDataDir, text: 'recall() caps output around 2k tokens', about: ['memory.js', 'recall'] });
  memory.remember({ cwd, userDataDir, text: 'unrelated fact with no links' });

  const byFile = memory.recall({ cwd, userDataDir, about: 'memory.js' });
  assert.equal(byFile.total, 1);
  assert.match(byFile.text, /caps output around 2k tokens/);

  const bySymbol = memory.recall({ cwd, userDataDir, about: 'recall' });
  assert.equal(bySymbol.total, 1);

  const none = memory.recall({ cwd, userDataDir, about: 'no-such-symbol' });
  assert.equal(none.total, 0);
});

test("recall folds in the main agent's own memory, read-only", () => {
  // A fake home directory, never the user's real ~/.claude.
  const homeDir = tmpDir('home');
  const cwd = tmpDir('proj');
  const userDataDir = tmpDir('user');
  const claudeDir = memory.claudeMemoryDir(cwd, homeDir);
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'MEMORY.md'), '- [Some note](some-note.md) — a thing the main agent learned\n');
  fs.writeFileSync(path.join(claudeDir, 'some-note.md'), '---\nname: "Some note"\n---\nThe main agent learned this durable fact about tokens.\n');

  const idx = memory.recall({ cwd, userDataDir, homeDir });
  assert.match(idx.text, /read-only/);
  assert.match(idx.text, /a thing the main agent learned/);

  const q = memory.recall({ cwd, userDataDir, homeDir, query: 'durable fact about tokens' });
  assert.equal(q.total, 1);
  assert.match(q.text, /main agent, read-only/);
});

test('deleteFact removes the file and rebuilds the index', () => {
  const cwd = tmpDir('proj');
  const userDataDir = tmpDir('user');
  const f = memory.remember({ cwd, userDataDir, text: 'Temporary fact to delete' });
  const dir = memory.projectMemoryDir(cwd);
  assert.equal(memory.listFacts(dir).length, 1);

  memory.deleteFact({ dir, file: f.file });
  assert.equal(memory.listFacts(dir).length, 0);
  const index = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8');
  assert.equal(index.trim(), '');
});
