const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { redactValues } = require('../redact');
const dataStore = require('../store');
const outcomes = require('../outcomes');
const memory = require('../memory');
const agentBrief = require('../agent-brief');
const { formatPrime } = require('../bin/operant-prime');
const backup = require('../backup');
const sb = require('../state-backup');

const SECRETS = ['sk-abcdefghijklmnopqrstuvwx1234', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'abcdefghijklmnopqrstuvwxyz012345'];
const LEAKY = `keys ${SECRETS[0]} and ${SECRETS[1]} and Bearer ${SECRETS[2]} end`;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'operant-sec-'));
const done = d => fs.rmSync(d, { recursive: true, force: true });
const noSecrets = (text, what) => { for (const s of SECRETS) assert.ok(!String(text).includes(s), `${what} leaks ${s}`); };
const allText = dir => {
  let out = '';
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    out += e.isDirectory() ? allText(p) : fs.readFileSync(p, 'utf8');
  }
  return out;
};

test('redactValues redacts secret-looking values and leaves keys and other values alone', () => {
  const src = { token: LEAKY, list: [LEAKY, 5, null], nested: { a: 'plain', b: LEAKY } };
  const out = redactValues(src);
  noSecrets(JSON.stringify(out), 'redactValues');
  assert.deepStrictEqual(Object.keys(out), ['token', 'list', 'nested']);
  assert.strictEqual(out.nested.a, 'plain');
  assert.strictEqual(out.list[1], 5);
  assert.ok(src.token.includes(SECRETS[0]), 'the input is not changed');
});

test('store append writes redacted rows', () => {
  const d = tmp();
  try {
    const s = dataStore.openStore(d);
    s.append('failures', { kind: 'x', evidence: LEAKY });
    noSecrets(allText(d), 'store file');
  } finally { done(d); }
});

test('appendOutcome writes redacted entries', () => {
  const d = tmp();
  try {
    const f = path.join(d, 'outcomes.jsonl');
    outcomes.appendOutcome(f, { t: Date.now(), reason: LEAKY });
    noSecrets(fs.readFileSync(f, 'utf8'), 'outcomes file');
  } finally { done(d); }
});

test('memory.remember writes redacted facts', () => {
  const d = tmp();
  try {
    memory.remember({ cwd: d, userDataDir: d, text: `Deploy with ${LEAKY}`, global: true, homeDir: d });
    noSecrets(allText(d), 'memory file');
  } finally { done(d); }
});

test('formatPrime output is redacted', () => {
  const text = formatPrime({ v: '1', role: 'lead', tile: { id: 1, kind: 'ai', title: 'Claude', project: 'p', agent: 'claude' }, team: null, tiles: [], ports: [],
    memory: { text: `- [k](k.md) - ${LEAKY}`, total: 1, shown: 1, more: 0 } }, { progress: LEAKY });
  noSecrets(text, 'prime');
});

test('contextSection and mainRulesText are redacted', () => {
  const sec = agentBrief.contextSection('task', [{ kind: 'note', source: 'memory', text: LEAKY }]);
  noSecrets(sec, 'contextSection');
  const d = tmp();
  try {
    fs.writeFileSync(path.join(d, 'rules.md'), `# rules\n${LEAKY}\n`);
    agentBrief.setHubDir(d);
    const t = agentBrief.mainRulesText('claude', 'opencode');
    assert.ok(t.includes('# rules'));
    noSecrets(t, 'mainRulesText');
  } finally { agentBrief.setHubDir(null); done(d); }
});

test('backup copyTree and stage write redacted text files and copy others as they are', () => {
  const d = tmp();
  try {
    const src = path.join(d, 'src'), dest = path.join(d, 'dest');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'SKILL.md'), LEAKY);
    fs.writeFileSync(path.join(src, 'a.bin'), Buffer.from([1, 2, 3]));
    backup.copyTree(src, dest);
    noSecrets(allText(dest), 'copyTree');
    assert.deepStrictEqual([...fs.readFileSync(path.join(dest, 'a.bin'))], [1, 2, 3]);

    const claude = path.join(d, 'claude'), repo = path.join(d, 'repo');
    fs.mkdirSync(path.join(claude, 'skills', 's1'), { recursive: true });
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(claude, 'skills', 's1', 'SKILL.md'), LEAKY);
    fs.writeFileSync(path.join(claude, 'CLAUDE.md'), LEAKY);
    backup.stage(repo, null, claude);
    noSecrets(allText(repo), 'stage');
    assert.ok(fs.existsSync(path.join(repo, 'rules.md')));
  } finally { done(d); }
});

test('createBackup output is redacted', () => {
  const d = tmp();
  try {
    fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ note: LEAKY }));
    fs.writeFileSync(path.join(d, 'outcomes.jsonl'), LEAKY + '\n');
    const b = sb.createBackup({ userDataDir: d, reason: 'manual' });
    noSecrets(allText(b.folder), 'state backup');
  } finally { done(d); }
});

test('store clearAll empties the folder and the store reopens empty', () => {
  const d = tmp();
  try {
    const dir = path.join(d, 'store');
    const s = dataStore.openStore(dir);
    s.append('failures', { kind: 'x' });
    assert.ok(dataStore.clearAll(dir) >= 1);
    assert.deepStrictEqual(fs.readdirSync(dir), []);
    assert.strictEqual(dataStore.openStore(dir).count('failures'), 0);
    assert.strictEqual(dataStore.clearAll(path.join(d, 'missing')), 0);
  } finally { done(d); }
});
