// The skill's frontmatter is all Claude Code and OpenCode read to list and trigger it, and a YAML error
// there drops every field without a word: 1.18.0 shipped one and the skill showed up as just "Operant
// control". js-yaml comes along with electron-builder, so it isn't a dependency of ours.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

// Where the skill lives: where the skill lives.
const SKILL_FILE = path.join(__dirname, '..', 'agent-plugin', 'skills', 'operant', 'SKILL.md');
// The fields the Agent Skills format defines; a reader may drop or reject any other.
const FIELDS = ['name', 'description', 'license', 'compatibility', 'metadata'];

// Splits SKILL.md into its parsed frontmatter and its body. Throws when the frontmatter is missing or
// isn't valid YAML.
function parseSkill(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) throw new Error('the file must start with --- on line 1 and close its frontmatter with ---');
  const meta = yaml.load(m[1]);
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('the frontmatter must be a YAML mapping');
  return { meta, body: text.slice(m[0].length) };
}

const text = fs.readFileSync(SKILL_FILE, 'utf8');
let skill = null;
let parseError = null;
try { skill = parseSkill(text); } catch (e) { parseError = e; }
// Without a parse there's nothing else to check, and the first test already says why.
const parsed = { skip: parseError ? 'the frontmatter does not parse' : false };

test('the frontmatter opens on line 1 and is valid YAML', () => {
  assert.match(text, /^---\r?\n/, 'SKILL.md must start with --- on line 1');
  assert.ifError(parseError);
});

test('the frontmatter has only fields the Agent Skills format defines', parsed, () => {
  const other = Object.keys(skill.meta).filter(k => !FIELDS.includes(k));
  assert.deepEqual(other, [], `fields outside ${FIELDS.join(', ')}`);
});

test('the name is the folder name, in lowercase with single hyphens', parsed, () => {
  const { name } = skill.meta;
  assert.equal(name, 'operant');
  assert.equal(name, path.basename(path.dirname(SKILL_FILE)));
  assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
});

test('the description says when to use the skill and when not to, in at most 1024 characters', parsed, () => {
  const { description } = skill.meta;
  assert.equal(typeof description, 'string');
  assert.ok(description.length >= 1 && description.length <= 1024, `the description is ${description.length} characters`);
  assert.match(description, /Use when/);
  assert.match(description, /Not for/);
});

test('the compatibility note, when there is one, is at most 500 characters', parsed, () => {
  const { compatibility } = skill.meta;
  if (compatibility === undefined) return;
  assert.equal(typeof compatibility, 'string');
  assert.ok(compatibility.length <= 500, `the compatibility note is ${compatibility.length} characters`);
});

// OpenCode would show these literally instead of running them.
test('the body has no Claude-only syntax and stays short', parsed, () => {
  for (const claudeOnly of ['!`', '$ARGUMENTS', '${CLAUDE_']) {
    assert.ok(!skill.body.includes(claudeOnly), `the body contains ${claudeOnly}`);
  }
  const lines = skill.body.trim().split(/\r?\n/).length;
  assert.ok(lines <= 130, `the body is ${lines} lines`);
});

// The 1.18.0 frontmatter: the ": " in "Also: get plans" is invalid inside an unquoted description, so
// every field was dropped. This has to keep failing, or the checks above could pass on a broken file.
const OLD_SKILL = [
  '---',
  'name: operant',
  'description: Use when running inside the Operant terminal app (env OPERANT=1, or `operant` on PATH). Run long commands (tests, builds, installs, dev servers) in a tile via operant run/wait instead of your shell, reading back only errors/new/matching lines to save context tokens. Also: get plans approved, split work across agent tiles with a task board, check context and compact, find dev servers, watch for errors, ask, notify.',
  '---',
  '',
  '# Operant control',
  '',
];

test('the 1.18.0 frontmatter, with ": " in an unquoted description, does not parse', () => {
  for (const eol of ['\n', '\r\n']) {
    assert.throws(() => parseSkill(OLD_SKILL.join(eol)), { name: 'YAMLException' });
  }
});

// Team mode is a skill. The Team section is the whole workflow, gated on `operant team`.
test('the Team mode section carries the whole workflow and only acts when team mode is on', parsed, () => {
  const i = skill.body.indexOf('## Team mode');
  assert.ok(i >= 0, 'no "## Team mode" section');
  const next = skill.body.indexOf('\n## ', i + 5);
  const team = skill.body.slice(i, next < 0 ? undefined : next);
  assert.match(team, /only when `operant team`/);
  for (const need of ['When to delegate', 'do it yourself', 'operant agent --tier', 'operant task done', '--status done|blocked|failed', 'operant read', 'operant test',
    'operant task approve', 'operant task reject']) assert.ok(team.includes(need), `the Team mode section lacks "${need}"`);
  assert.match(team, /Approve only after `operant test` passes/);
  assert.match(team, /only after it has reported back, and then straight away/);
  assert.match(team, /never leave a reported one open/);
  assert.match(team, /A team runs on one CLI/);
  assert.doesNotMatch(team, /master worker|\bother CLI/);
  // Each CLI's own way to hand a part to a tier.
  assert.match(team, /Claude Code: a subagent through the Agent tool, `model` set to the tier's alias \(haiku, sonnet or opus\)/);
  assert.match(team, /OpenCode: the `tier-<name>` subagent/);
  assert.match(team, /Codex, Gemini CLI \(no subagent tool\): you are the team's one master; number the parts/);
  assert.match(team, /--title "<n>\/<total> <3-5 words>"/);
  assert.match(team, /Each tier's use \(in your context\) says what to hand it/);
});

test('the skill has no Terminal, prompt-box or refiner assumptions', parsed, () => {
  assert.doesNotMatch(text, /Operant Terminal|prompt box|refiner/i);
});

test('the skill makes a CodeGraph query the first code action when an index exists', parsed, () => {
  assert.match(skill.body, /\.codegraph.*first code action is a CodeGraph query/s);
});
