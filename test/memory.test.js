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
function tmpProj() {
  const dir = tmpDir('proj');
  fs.mkdirSync(path.join(dir, '.git'));
  return dir;
}
test.after(() => { for (const d of madeDirs) fs.rmSync(d, { recursive: true, force: true }); });

test('remember saves a fact with frontmatter, and rebuilds the index', () => {
  const cwd = tmpProj();
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
  const cwd = tmpProj();
  const userDataDir = tmpDir('user');
  memory.remember({ cwd, userDataDir, text: 'Prefers plain commit messages, no AI attribution', type: 'user' });
  assert.equal(memory.listFacts(memory.projectMemoryDir(cwd)).length, 0);
  assert.equal(memory.listFacts(memory.globalMemoryDir(userDataDir)).length, 1);

  memory.remember({ cwd, userDataDir, text: 'Another global fact', global: true });
  assert.equal(memory.listFacts(memory.globalMemoryDir(userDataDir)).length, 2);
});

test('remember dedupes: a matching name or description updates instead of duplicating', () => {
  const cwd = tmpProj();
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
  const cwd = tmpProj();
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
  const cwd = tmpProj();
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
  const cwd = tmpProj(); // no .codegraph/ here, so about entries are kept as-is
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
  const cwd = tmpProj();
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
  const cwd = tmpProj();
  const userDataDir = tmpDir('user');
  const f = memory.remember({ cwd, userDataDir, text: 'Temporary fact to delete' });
  const dir = memory.projectMemoryDir(cwd);
  assert.equal(memory.listFacts(dir).length, 1);

  memory.deleteFact({ dir, file: f.file });
  assert.equal(memory.listFacts(dir).length, 0);
  const index = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8');
  assert.equal(index.trim(), '');
});

// Item 58: confidence, staleness, ranking, supersedes, feedback.
const facts = (cwd, u) => memory.listFacts(memory.projectMemoryDir(cwd), u);
function patch(cwd, id, edit) {
  const f = path.join(memory.projectMemoryDir(cwd), `${id}.md`);
  fs.writeFileSync(f, edit(fs.readFileSync(f, 'utf8')));
}

test('a fact written before item 58 (no new fields) is still recalled', () => {
  const cwd = tmpProj(), userDataDir = tmpDir('user');
  const dir = memory.projectMemoryDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'old.md'), '---\nname: "Old fact"\ndescription: "the deploy uses rsync"\ntype: "project"\n---\n\nthe deploy uses rsync\n');
  const r = memory.recall({ cwd, userDataDir, query: 'rsync' });
  assert.equal(r.total, 1);
  assert.match(r.text, /the deploy uses rsync/);
  assert.match(r.text, /id: old/);
});

test('remember writes confidence, dates, counters and aboutSig', () => {
  const cwd = tmpProj(), userDataDir = tmpDir('user');
  fs.writeFileSync(path.join(cwd, 'a.js'), 'one');
  memory.remember({ cwd, userDataDir, text: 'a.js does one thing', about: ['a.js'], confidence: 'verified' });
  const [f] = facts(cwd, userDataDir);
  assert.equal(f.confidence, 'verified');
  assert.ok(f.created && f.updated);
  assert.equal(f.aboutSig.length, 1);
  assert.match(f.aboutSig[0], /^[0-9a-f]{40}$/);
});

test('BM25 ranks the relevant fact first', () => {
  const cwd = tmpProj(), userDataDir = tmpDir('user');
  memory.remember({ cwd, userDataDir, text: 'The build server caches nothing' });
  memory.remember({ cwd, userDataDir, text: 'Database migrations run through flyway migrations only, flyway is required' });
  memory.remember({ cwd, userDataDir, text: 'Logs rotate daily' });
  const r = memory.recall({ cwd, userDataDir, query: 'flyway migrations' });
  assert.match(r.text.split('\n')[0], /Database migrations/);
});

test('usefulness and decay change the order', () => {
  const cwd = tmpProj(), userDataDir = tmpDir('user');
  const a = memory.remember({ cwd, userDataDir, text: 'Cache layer uses redis alpha' });
  const b = memory.remember({ cwd, userDataDir, text: 'Cache layer uses redis beta' });
  const first = () => memory.recall({ cwd, userDataDir, query: 'cache redis' }).text.split('\n')[0];
  const setMeta = (id, kv) => patch(cwd, id, raw => raw.replace(/^---\n/, '---\n' + Object.entries(kv).map(([k, v]) => `${k}: "${v}"\n`).join('')));
  // b has proven useful; a has been rejected.
  setMeta(b.id, { uses: 5 }); setMeta(a.id, { rejects: 3 });
  assert.match(first(), /beta/);
  // Now b is old and unused for a long time while a is fresh: decay flips it back only once weights cross.
  const old = new Date(Date.now() - 60 * 86400000).toISOString();
  const fa = facts(cwd, userDataDir).find(f => f.id === a.id), fb = facts(cwd, userDataDir).find(f => f.id === b.id);
  assert.ok(memory.weight({ ...fb, lastUsed: old }) < memory.weight(fb));
  assert.equal(memory.weight({ ...fb, lastUsed: old, uses: 0, recalls: 0 }), 0.5 * 0.2);
  assert.ok(memory.weight({ ...fa, rejects: 0, lastUsed: new Date().toISOString() }) > memory.weight({ ...fb, uses: 0, lastUsed: old }));
});

test('an about file that changed or vanished shows a stale marker and ranks lower', () => {
  const cwd = tmpProj(), userDataDir = tmpDir('user');
  fs.writeFileSync(path.join(cwd, 'a.js'), 'one');
  memory.remember({ cwd, userDataDir, text: 'Widget rendering goes through a.js', about: ['a.js'] });
  memory.remember({ cwd, userDataDir, text: 'Widget rendering is cached elsewhere' });
  assert.doesNotMatch(memory.recall({ cwd, userDataDir, query: 'widget rendering' }).text, /stale/);
  fs.writeFileSync(path.join(cwd, 'a.js'), 'two');
  const r = memory.recall({ cwd, userDataDir, query: 'widget rendering' });
  assert.match(r.text, /\[stale: a\.js changed\]/);
  assert.match(r.text.split('\n')[0], /cached elsewhere/);
  fs.rmSync(path.join(cwd, 'a.js'));
  assert.match(memory.recall({ cwd, userDataDir, query: 'widget rendering' }).text, /\[stale: a\.js changed\]/);
  assert.equal(facts(cwd, userDataDir).length, 2); // never deleted
});

test('a superseded fact is hidden unless --all', () => {
  const cwd = tmpProj(), userDataDir = tmpDir('user');
  const old = memory.remember({ cwd, userDataDir, text: 'Deploys go out through ftp' });
  memory.remember({ cwd, userDataDir, text: 'Deploys go out through rsync', supersedes: old.id });
  const r = memory.recall({ cwd, userDataDir, query: 'deploys' });
  assert.equal(r.total, 1);
  assert.match(r.text, /rsync/);
  assert.equal(memory.recall({ cwd, userDataDir, query: 'deploys', all: true }).total, 2);
  assert.throws(() => memory.remember({ cwd, userDataDir, text: 'x y z', supersedes: 'nope' }), /no fact/);
});

test('used and wrong update counters; repeated wrong marks the fact stale', () => {
  const cwd = tmpProj(), userDataDir = tmpDir('user');
  const { id } = memory.remember({ cwd, userDataDir, text: 'Tabs are four wide' });
  memory.recall({ cwd, userDataDir, query: 'tabs', feedback: 'used', id });
  assert.equal(facts(cwd, userDataDir)[0].uses, 1);
  memory.recall({ cwd, userDataDir, feedback: 'wrong', id, note: 'it is two' });
  assert.equal(facts(cwd, userDataDir)[0].rejects, 1);
  assert.equal(facts(cwd, userDataDir)[0].confidence, 'observed');
  memory.recall({ cwd, userDataDir, feedback: 'wrong', id });
  assert.equal(facts(cwd, userDataDir)[0].confidence, 'stale');
  assert.throws(() => memory.recall({ cwd, userDataDir, feedback: 'used', id: 'nope' }), /no fact/);
});

test('recall increments recalls and lastUsed, and logs the injected ids', () => {
  const cwd = tmpProj(), userDataDir = tmpDir('user');
  const { id } = memory.remember({ cwd, userDataDir, text: 'Ports start at 4100' });
  memory.recall({ cwd, userDataDir, query: 'ports' });
  memory.recall({ cwd, userDataDir, query: 'ports' });
  const f = facts(cwd, userDataDir)[0];
  assert.equal(f.recalls, 2);
  assert.ok(f.lastUsed);
  assert.equal(f.body, 'Ports start at 4100');
  const lines = fs.readFileSync(path.join(userDataDir, 'memory-recalls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines[0].ids, [id]);
  assert.equal(lines[0].query, 'ports');
  // The index does not count as a recall.
  memory.recall({ cwd, userDataDir });
  assert.equal(facts(cwd, userDataDir)[0].recalls, 2);
});

test('recall and used leave fact files byte-identical; counters live in the sidecar', () => {
  const cwd = tmpProj(), userDataDir = tmpDir('user');
  const { id, file, dir } = memory.remember({ cwd, userDataDir, text: 'Lint runs before tests' });
  const before = fs.readFileSync(path.join(dir, file));
  memory.recall({ cwd, userDataDir, query: 'lint' });
  memory.recall({ cwd, userDataDir, feedback: 'used', id });
  memory.recall({ cwd, userDataDir, feedback: 'wrong', id });
  assert.ok(before.equals(fs.readFileSync(path.join(dir, file))));
  const f = facts(cwd, userDataDir)[0];
  assert.deepEqual([f.recalls, f.uses, f.rejects], [1, 1, 1]);
  // A corrupt sidecar is tolerated.
  fs.writeFileSync(path.join(userDataDir, 'memory-stats.json'), '{nope');
  assert.equal(memory.recall({ cwd, userDataDir, query: 'lint' }).total, 1);
});

test('memoryProjectDir: only a git repo or a .operant folder is a project', () => {
  const homeDir = tmpDir('home');
  assert.equal(memory.memoryProjectDir(homeDir, { homeDir }), null);
  const plain = path.join(homeDir, 'notes');
  fs.mkdirSync(plain);
  assert.equal(memory.memoryProjectDir(plain, { homeDir }), null);
  const repo = path.join(homeDir, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true });
  assert.equal(memory.memoryProjectDir(path.join(repo, 'src', 'deep'), { homeDir }), repo);
  const op = path.join(homeDir, 'op');
  fs.mkdirSync(path.join(op, '.operant'), { recursive: true });
  assert.equal(memory.memoryProjectDir(op, { homeDir }), op);
  assert.equal(memory.memoryProjectDir(path.parse(homeDir).root, { homeDir }), null);
});

test('remember outside a project saves to global memory and says so; recall still reads old home facts', () => {
  const homeDir = tmpDir('home'), userDataDir = tmpDir('user');
  const r = memory.remember({ cwd: homeDir, homeDir, userDataDir, text: 'A fact said from the home folder' });
  assert.equal(r.dir, memory.globalMemoryDir(userDataDir));
  assert.match(r.note, /saved to your personal memory \(.* isn't a project\)/);
  assert.equal(fs.existsSync(path.join(homeDir, '.operant')), false);
  const old = memory.projectMemoryDir(homeDir);
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'legacy.md'), ['---', 'name: legacy', 'description: Legacy home fact', 'type: project', '---', 'Legacy home fact', ''].join(String.fromCharCode(10)));
  const idx = memory.recall({ cwd: homeDir, homeDir, userDataDir });
  assert.match(idx.text, /Legacy home fact/);
  assert.match(idx.text, /home folder/);
});

test('a new fact that contradicts an older one about the same subject keeps both and records the conflict', () => {
  const cwd = tmpProj();
  const userDataDir = tmpDir('user');
  const a = memory.remember({ cwd, userDataDir, text: 'Release tags use the v prefix, like v1.2.1', confidence: 'observed' });
  const b = memory.remember({ cwd, userDataDir, text: 'Release tags never use the v prefix, plain 1.2.1', confidence: 'verified' });
  assert.equal(b.conflicts.length, 1);
  assert.equal(b.conflicts[0].id, a.id);
  assert.equal(b.conflicts[0].preferred, b.id, 'the verified one is preferred');
  const facts = memory.listFacts(memory.projectMemoryDir(cwd));
  assert.equal(facts.length, 2);
  for (const f of facts) assert.equal(f.conflictsWith.length, 1);
  const r = memory.recall({ cwd, userDataDir, query: 'release tags prefix' });
  assert.match(r.text, /conflicts with/);
  assert.ok(r.text.indexOf(b.name) < r.text.indexOf(a.name), 'the preferred fact ranks first');
});

test('unrelated or agreeing facts are not flagged; a newer fact wins at equal confidence', () => {
  const cwd = tmpProj();
  const userDataDir = tmpDir('user');
  memory.remember({ cwd, userDataDir, text: 'The dev server listens on port 3000 in this project' });
  const c = memory.remember({ cwd, userDataDir, text: 'Commit messages are plain, no attribution lines' });
  assert.equal(c.conflicts, undefined);
  const older = memory.listFacts(memory.projectMemoryDir(cwd)).find(f => /port 3000/.test(f.description));
  const d = memory.remember({ cwd, userDataDir, text: 'The dev server listens on port 4000 in this project' });
  assert.equal(d.conflicts[0].id, older.id);
  assert.equal(d.conflicts[0].preferred, d.id);
});

test('source and commits are recorded, and repeat saves keep the union', () => {
  const cwd = tmpProj();
  const userDataDir = tmpDir('user');
  memory.remember({ cwd, userDataDir, text: 'The parser trims headers first', source: 'agent:tile-4', commits: ['abc1234'], about: ['parser.js'] });
  const r = memory.remember({ cwd, userDataDir, text: 'The parser trims headers first', commits: 'def5678,abc1234', about: ['parser.js'] });
  const f = memory.listFacts(memory.projectMemoryDir(cwd)).find(x => x.id === r.id);
  assert.equal(f.source, 'agent:tile-4');
  assert.deepEqual(f.commits.sort(), ['abc1234', 'def5678']);
  assert.deepEqual(f.about, ['parser.js']);
});

test('facts not recalled in 90 days are archived, not deleted, and leave the index', () => {
  const cwd = tmpProj();
  const userDataDir = tmpDir('user');
  const old = memory.remember({ cwd, userDataDir, text: 'Old fact about the exporter pipeline' });
  const fresh = memory.remember({ cwd, userDataDir, text: 'Fresh fact about the importer stage' });
  const oldPath = path.join(old.dir, old.file);
  const raw = fs.readFileSync(oldPath, 'utf8').replace(/updated: "[^"]+"/, 'updated: "2020-01-01T00:00:00.000Z"').replace(/created: "[^"]+"/, 'created: "2020-01-01T00:00:00.000Z"');
  fs.writeFileSync(oldPath, raw);
  const moved = memory.archiveStale({ cwd, userDataDir });
  assert.deepEqual(moved, [old.id]);
  assert.ok(fs.existsSync(path.join(old.dir, 'archive', old.file)), 'kept in archive/');
  assert.ok(!fs.existsSync(oldPath));
  assert.ok(fs.existsSync(path.join(fresh.dir, fresh.file)));
  assert.doesNotMatch(fs.readFileSync(path.join(old.dir, 'MEMORY.md'), 'utf8'), /exporter/);
  assert.deepEqual(memory.archiveStale({ cwd, userDataDir }), []);
});

test('a recent recall keeps an old fact from being archived', () => {
  const cwd = tmpProj();
  const userDataDir = tmpDir('user');
  const old = memory.remember({ cwd, userDataDir, text: 'Exporter pipeline batches rows by fifty' });
  const p = path.join(old.dir, old.file);
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/updated: "[^"]+"/, 'updated: "2020-01-01T00:00:00.000Z"').replace(/created: "[^"]+"/, 'created: "2020-01-01T00:00:00.000Z"'));
  memory.recall({ cwd, userDataDir, query: 'exporter pipeline' });
  assert.deepEqual(memory.archiveStale({ cwd, userDataDir }), []);
});

test('recall delete <id> removes a fact (active or archived) and clears it from conflict records', () => {
  const cwd = tmpProj();
  const userDataDir = tmpDir('user');
  const a = memory.remember({ cwd, userDataDir, text: 'Release tags use the v prefix, like v1.2.1' });
  const b = memory.remember({ cwd, userDataDir, text: 'Release tags never use the v prefix, plain 1.2.1' });
  const r = memory.recall({ cwd, userDataDir, feedback: 'delete', id: a.id });
  assert.match(r.text, /deleted/);
  assert.ok(!fs.existsSync(path.join(a.dir, a.file)));
  const left = memory.listFacts(memory.projectMemoryDir(cwd)).find(f => f.id === b.id);
  assert.deepEqual(left.conflictsWith, []);
  assert.throws(() => memory.recall({ cwd, userDataDir, feedback: 'delete', id: 'nope' }), /no fact/);
});

test('recalls and uses are counted for the memory provider in .operant', () => {
  const cwd = tmpProj();
  const userDataDir = tmpDir('user');
  const r = memory.remember({ cwd, userDataDir, text: 'Exporter pipeline batches rows by fifty' });
  memory.recall({ cwd, userDataDir, query: 'exporter' });
  memory.recall({ cwd, userDataDir, feedback: 'used', id: r.id });
  const s = require('../context-providers.js').readStats(cwd);
  assert.deepEqual([s.memory.called, s.memory.used], [1, 1]);
});
