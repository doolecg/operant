// Tests for roles.js: the six role presets, their plugin agent files, and the task -> role mapping.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { ROLES, NAMES, roleForTask, roleText } = require('../roles.js');

const dir = path.join(__dirname, '..', 'agent-plugin', 'agents');
const split = text => { const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text); return m && { meta: yaml.load(m[1]), body: text.slice(m[0].length) }; };

test('the six roles and their tiers', () => {
  assert.deepEqual(NAMES, ['implement', 'fix', 'explore', 'review', 'docs', 'design']);
  assert.deepEqual(Object.fromEntries(NAMES.map(n => [n, ROLES[n].tier])),
    { implement: 'small', fix: 'small', explore: 'xsmall', review: 'small', docs: 'xsmall', design: 'high' });
});

test('a task maps to a role from its kind', () => {
  const cases = [
    ['Fix the crash when the tile closes', 'fix'], ['The settings page is broken', 'fix'],
    ['Add unit tests for board.js', 'implement'], ['Refactor the updater', 'implement'], ['Add a dark mode toggle', 'implement'],
    ['Update the README with the new flags', 'docs'], ['Where is the tile title set?', 'explore'], ['Explain how routing works', 'explore'],
    ['Do the thing', 'implement'], ['Design the plugin API', 'design'], ['Plan the migration to the new store', 'design'],
    ['Architecture for the sync feature', 'design'], ['Fix the design of the button', 'fix'],
    ['Implement step 3 of the plan', 'implement'], ['Add the new button design to settings', 'implement'],
  ];
  for (const [text, role] of cases) assert.equal(roleForTask(text), role, text);
  assert.equal(roleForTask(''), 'implement');
  assert.equal(roleForTask(null), 'implement');
});

for (const name of NAMES) {
  test(`${name}.md has valid frontmatter that matches ROLES`, () => {
    const file = path.join(dir, `${name}.md`);
    assert.ok(fs.statSync(file).isFile());
    const p = split(fs.readFileSync(file, 'utf8'));
    assert.ok(p, 'frontmatter opens on line 1 and closes with ---');
    assert.equal(p.meta.name, name);
    assert.ok(typeof p.meta.description === 'string' && p.meta.description.trim());
    assert.equal(p.meta.model, ROLES[name].claudeModel);
    assert.equal(p.meta.effort, ROLES[name].effort);
    const tools = String(p.meta.tools || '');
    if (ROLES[name].readOnly) assert.ok(tools && !/\b(Edit|Write|NotebookEdit)\b/.test(tools), 'read-only roles list their tools and give no edit tool');
    assert.ok(p.body.trim().split('\n').length <= 35, 'body stays short');
    assert.match(p.body, /Status: DONE \| DONE_WITH_CONCERNS \| BLOCKED \| NEEDS_CONTEXT/);
    assert.match(p.body, /operant task done <id> --status done\|blocked\|failed/);
  });
}

test('only the six role files are in agents/', () => {
  assert.deepEqual(fs.readdirSync(dir).sort(), NAMES.map(n => `${n}.md`).sort());
});

test('roleText is the body without frontmatter, cached, empty for an unknown role', () => {
  for (const name of NAMES) {
    const t = roleText(name);
    assert.ok(t.length > 100);
    assert.doesNotMatch(t, /^---|^name:|^model:/m);
    assert.equal(roleText(name), t);
    assert.equal(t, split(fs.readFileSync(path.join(dir, `${name}.md`), 'utf8').replace(/\r\n/g, '\n')).body.trim());
  }
  assert.equal(roleText('nope'), '');
});

test('the design role has no code-edit tools and decides rather than surveys', () => {
  assert.match(roleText('design'), /decision/);
  assert.doesNotMatch(roleText('design'), /2 or 3 approaches/);
});
