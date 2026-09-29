// Tests for what agent-setup.js does to deliver the `operant` skill per session: the clean-up of the copies
// older versions wrote into the agents' own folders, the launch args, env and config each agent gets
// instead, and the probes that say whether an installed CLI takes them. Everything runs on temp folders:
// nothing here reads or writes the real ~/.claude or ~/.config/opencode.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const setup = require('../agent-setup.js');
const brief = require('../agent-brief.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'operant-setuptest-'));
test.after(() => { fs.rmSync(root, { recursive: true, force: true }); });

const write = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const SKILL = '---\nname: operant\ndescription: Use when running inside Operant.\n---\n# Operant control\n';
const claudeSkill = home => path.join(home, '.claude', 'skills', 'operant');
const opencodeSkill = home => path.join(home, '.config', 'opencode', 'skills', 'operant');
let n = 0;
const dir = name => path.join(root, `${name}-${++n}`);

// ---------------------------------------------------------------- the old copies
test('isOperantSkillFile means a SKILL.md whose frontmatter name is operant', () => {
  assert.ok(setup.isOperantSkillFile(SKILL));
  assert.ok(setup.isOperantSkillFile(SKILL.replace(/\n/g, '\r\n')), 'a file checked out with CRLF');
  assert.ok(!setup.isOperantSkillFile('---\nname: operant-notes\n---\nx'));
  assert.ok(!setup.isOperantSkillFile('---\ndescription: name: operant\n---\nx'));
  assert.ok(!setup.isOperantSkillFile('# Operant\nname: operant\n'), 'no frontmatter');
  assert.ok(!setup.isOperantSkillFile('') && !setup.isOperantSkillFile(null));
});

test('removeLegacySkillCopies removes Operant\'s copies and the folders they leave empty', () => {
  const home = dir('home');
  write(path.join(claudeSkill(home), 'SKILL.md'), SKILL);
  write(path.join(opencodeSkill(home), 'SKILL.md'), SKILL);
  write(path.join(home, '.claude', 'skills', 'other', 'SKILL.md'), '---\nname: other\n---\nkeep');
  assert.deepEqual(setup.removeLegacySkillCopies({ homeDir: home }), [claudeSkill(home), opencodeSkill(home)]);
  assert.ok(!fs.existsSync(claudeSkill(home)) && !fs.existsSync(opencodeSkill(home)));
  assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', 'other', 'SKILL.md')), 'the skills folder and its other skills stay');
  assert.ok(fs.existsSync(path.join(home, '.config', 'opencode', 'skills')));
  assert.deepEqual(setup.removeLegacySkillCopies({ homeDir: home }), [], 'nothing left to do the second time');
});

test('removeLegacySkillCopies leaves a skill someone else called operant', () => {
  const home = dir('home');
  const theirs = '---\nname: operant-tools\ndescription: mine\n---\nmy own\n';
  write(path.join(claudeSkill(home), 'SKILL.md'), theirs);
  write(path.join(opencodeSkill(home), 'SKILL.md'), '# no frontmatter at all\n');
  assert.deepEqual(setup.removeLegacySkillCopies({ homeDir: home }), []);
  assert.equal(fs.readFileSync(path.join(claudeSkill(home), 'SKILL.md'), 'utf8'), theirs);
  assert.ok(fs.existsSync(path.join(opencodeSkill(home), 'SKILL.md')));
});

test('removeLegacySkillCopies removes only the SKILL.md when the folder holds other files', () => {
  const home = dir('home');
  write(path.join(claudeSkill(home), 'SKILL.md'), SKILL);
  write(path.join(claudeSkill(home), 'notes.txt'), 'mine');
  assert.deepEqual(setup.removeLegacySkillCopies({ homeDir: home }), [claudeSkill(home)]);
  assert.deepEqual(fs.readdirSync(claudeSkill(home)), ['notes.txt']);
});

// The hub (Tidy agents) links ~/.claude/skills/<name> to a folder of its own, and the old sync wrote
// through that link. Only the link may go: what it points at is the hub's.
test('removeLegacySkillCopies removes a link without touching what it points to', () => {
  const home = dir('home'), target = dir('hub-skill');
  write(path.join(target, 'SKILL.md'), SKILL);
  write(path.join(target, 'ref', 'extra.md'), 'kept');
  fs.mkdirSync(path.dirname(claudeSkill(home)), { recursive: true });
  fs.symlinkSync(target, claudeSkill(home), 'junction');
  assert.deepEqual(setup.removeLegacySkillCopies({ homeDir: home }), [claudeSkill(home)]);
  assert.throws(() => fs.lstatSync(claudeSkill(home)), { code: 'ENOENT' }, 'the link is gone');
  assert.equal(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), SKILL);
  assert.equal(fs.readFileSync(path.join(target, 'ref', 'extra.md'), 'utf8'), 'kept');
});

test('removeLegacySkillCopies leaves a link to someone else\'s skill', () => {
  const home = dir('home'), target = dir('their-skill');
  write(path.join(target, 'SKILL.md'), '---\nname: operant-tools\n---\nmine');
  fs.mkdirSync(path.dirname(claudeSkill(home)), { recursive: true });
  fs.symlinkSync(target, claudeSkill(home), 'junction');
  assert.deepEqual(setup.removeLegacySkillCopies({ homeDir: home }), []);
  assert.ok(fs.lstatSync(claudeSkill(home)).isSymbolicLink());
});

test('removeLegacySkillCopies never throws', () => {
  assert.deepEqual(setup.removeLegacySkillCopies({ homeDir: path.join(root, 'no', 'such', 'home') }), []);
  const home = dir('home');
  write(claudeSkill(home), 'a file where the folder should be');
  assert.deepEqual(setup.removeLegacySkillCopies({ homeDir: home }), []);
});

// ---------------------------------------------------------------- CLAUDE_CODE_PLUGIN_DIRS
const PLUGIN = path.join(os.tmpdir(), 'Operant', 'resources', 'agent-plugin');
const A = path.join(os.tmpdir(), 'my-plugins', 'a'), B = path.join(os.tmpdir(), 'my-plugins', 'b');
const join = (...p) => p.join(path.delimiter);

test('pluginDirsEnv adds our folder after the ones the tile inherited, once', () => {
  assert.equal(setup.pluginDirsEnv(undefined, PLUGIN, true), PLUGIN);
  assert.equal(setup.pluginDirsEnv('', PLUGIN, true), PLUGIN);
  assert.equal(setup.pluginDirsEnv(join(A, B), PLUGIN, true), join(A, B, PLUGIN));
  assert.equal(setup.pluginDirsEnv(join(A, PLUGIN, B, PLUGIN), PLUGIN, true), join(A, B, PLUGIN));
  assert.equal(setup.pluginDirsEnv(join(A, '', B), PLUGIN, true), join(A, B, PLUGIN), 'empty entries go');
});

test('pluginDirsEnv takes our folder out, and gives null when nothing is left', () => {
  assert.equal(setup.pluginDirsEnv(join(A, PLUGIN, B), PLUGIN, false), join(A, B));
  assert.equal(setup.pluginDirsEnv(join(PLUGIN, PLUGIN), PLUGIN, false), null);
  assert.equal(setup.pluginDirsEnv(undefined, PLUGIN, false), null);
  assert.equal(setup.pluginDirsEnv(join(A, B), PLUGIN, false), join(A, B), 'someone else\'s folders are theirs');
});

test('pluginDirsEnv knows our folder under another spelling', () => {
  assert.equal(setup.pluginDirsEnv(PLUGIN + path.sep, PLUGIN, false), null, 'a trailing separator');
  assert.equal(setup.pluginDirsEnv(join(A, PLUGIN + path.sep), PLUGIN, true), join(A, PLUGIN));
});

test('pluginDirsEnv ignores case on Windows', { skip: process.platform !== 'win32' }, () => {
  assert.equal(setup.pluginDirsEnv(PLUGIN.toUpperCase(), PLUGIN, false), null);
  assert.equal(setup.pluginDirsEnv(join(A, PLUGIN.toLowerCase()), PLUGIN, true), join(A, PLUGIN));
});

// ---------------------------------------------------------------- OpenCode: config and skill paths
// A project with a .git folder, so the walk up for opencode.json stops there and a stray file above it is never read.
function project(name) {
  const home = dir(`${name}-home`), repo = dir(`${name}-repo`);
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true });
  return { home, repo, cwd: path.join(repo, 'src', 'deep') };
}
const OURS = path.join(os.tmpdir(), 'Operant', 'resources', 'agent-plugin', 'skills');

test('opencodeSkillPaths is just ours when the user has none', () => {
  const p = project('none');
  assert.deepEqual(setup.opencodeSkillPaths(p.cwd, OURS, { homeDir: p.home }), [OURS]);
});

// OpenCode replaces skills.paths from one config to the next, so these have to be carried along or
// the user's own skill folders stop loading in Operant's tiles.
test('opencodeSkillPaths keeps the user\'s own paths, global first, project next, ours last', () => {
  const p = project('user');
  // jsonc with comments and trailing commas, which OpenCode accepts
  write(path.join(p.home, '.config', 'opencode', 'opencode.jsonc'),
    '{\n  // skills of mine\n  "skills": { "paths": ["~/my-skills", "/shared/skills", /* inline */ ], },\n}\n');
  write(path.join(p.repo, 'opencode.json'), JSON.stringify({ skills: { paths: ['./project-skills'] } }));
  write(path.join(p.repo, '.opencode', 'opencode.json'), JSON.stringify({ skills: { paths: ['./dot-skills', '/shared/skills'] } }));
  assert.deepEqual(setup.opencodeSkillPaths(p.cwd, OURS, { homeDir: p.home }),
    ['~/my-skills', '/shared/skills', './project-skills', './dot-skills', OURS]);
});

test('opencodeSkillPaths lists ours once, and last, even when the user already has it', () => {
  const p = project('dupe');
  write(path.join(p.repo, 'opencode.json'), JSON.stringify({ skills: { paths: [OURS + path.sep, 'mine'] } }));
  assert.deepEqual(setup.opencodeSkillPaths(p.cwd, OURS, { homeDir: p.home }), ['mine', OURS]);
  assert.deepEqual(setup.opencodeSkillPaths(p.repo, OURS, { homeDir: p.home }), ['mine', OURS]);
});

test('opencodeSkillPaths does not go past the project\'s git root, and skips what it cannot read', () => {
  const p = project('bounds');
  write(path.join(path.dirname(p.repo), 'opencode.json'), JSON.stringify({ skills: { paths: ['above-the-repo'] } }));
  write(path.join(p.repo, 'opencode.jsonc'), '{ "skills": { "paths": [ }');
  write(path.join(p.repo, 'src', 'opencode.json'), JSON.stringify({ skills: { paths: [42, null, '', 'in-src'] } }));
  assert.deepEqual(setup.opencodeSkillPaths(p.cwd, OURS, { homeDir: p.home }), ['in-src', OURS]);
});

test('opencodeConfigContent carries the plugin and skill paths only when there are any', () => {
  assert.equal(brief.opencodeConfigContent(null), '{}');
  assert.equal(brief.opencodeConfigContent(null, { skillPaths: [] }), '{}');
  assert.deepEqual(JSON.parse(brief.opencodeConfigContent('brief.md', { plugins: ['a.mjs'], skillPaths: ['x', 'y'] })),
    { instructions: ['brief.md'], plugin: ['a.mjs'], skills: { paths: ['x', 'y'] } });
  assert.deepEqual(JSON.parse(brief.opencodeConfigContent(null, { skillPaths: ['x'] })), { skills: { paths: ['x'] } });
});

// With the main agent's setup shared, main.js runs buildOpencodeConfigContent over that same JSON:
// it may add MCP servers and a plugin, but must not drop what is already in it.
test('buildOpencodeConfigContent keeps the skill paths and the plugins it is given', () => {
  const base = brief.opencodeConfigContent('brief.md', { plugins: ['reroute.mjs'], skillPaths: ['mine', OURS] });
  const config = { shareSetup: true, defaultAgent: 'opencode', agents: [{ id: 'opencode', command: 'opencode' }] };
  const merged = JSON.parse(setup.buildOpencodeConfigContent({ base, cwd: root, userDataDir: root, config }));
  assert.deepEqual(merged, { instructions: ['brief.md'], plugin: ['reroute.mjs'], skills: { paths: ['mine', OURS] } });
});

// ---------------------------------------------------------------- the probes
// A stand-in for the agent CLI, run the way a tile runs it (a command line through the shell), that
// answers from what it is asked and given: `--help`, or `debug config` with the OpenCode config env.
const fake = path.join(root, 'fake-agent.js');
write(fake, `
if (process.env.FAKE_FAIL) process.exit(3);
const args = process.argv.slice(2).join(' ');
if (args === '--help') console.log(process.env.FAKE_HELP || '');
else if (!(args === 'debug config' && process.env.OPENCODE_CONFIG_CONTENT === '{"skills":{"paths":[]}}')) process.exit(1);
`);
const FAKE = `"${process.execPath}" "${fake}"`;
const env = extra => ({ ...process.env, ...extra });

test('probeClaudePluginDir is true when --plugin-dir is in the help', async () => {
  assert.equal(await setup.probeClaudePluginDir(FAKE, { env: env({ FAKE_HELP: 'Options:\n  --plugin-dir <path>  Load a plugin from a directory' }) }), true);
});

test('probeClaudePluginDir is false without the flag, on an error, and for a command that is not there', async () => {
  assert.equal(await setup.probeClaudePluginDir(FAKE, { env: env({ FAKE_HELP: 'Options:\n  --settings <file>' }) }), false);
  assert.equal(await setup.probeClaudePluginDir(FAKE, { env: env({ FAKE_HELP: '--plugin-dir', FAKE_FAIL: '1' }) }), false);
  assert.equal(await setup.probeClaudePluginDir('operant-no-such-agent'), false);
  assert.equal(await setup.probeClaudePluginDir(''), false);
});

test('probeOpencodeSkillPaths runs `debug config` with an empty skills.paths, and is true on exit 0', async () => {
  assert.equal(await setup.probeOpencodeSkillPaths(FAKE, { env: env() }), true);
  assert.equal(await setup.probeOpencodeSkillPaths(FAKE, { env: env({ OPENCODE_CONFIG_CONTENT: '{"other":1}' }) }), true, 'the probe sets the config itself');
});

test('probeOpencodeSkillPaths is false when the CLI rejects it, and for a command that is not there', async () => {
  assert.equal(await setup.probeOpencodeSkillPaths(FAKE, { env: env({ FAKE_FAIL: '1' }) }), false);
  assert.equal(await setup.probeOpencodeSkillPaths('operant-no-such-agent'), false);
});

test('hookSettingsContent: the reroute, a worker Stop hook, both, or nothing', () => {
  const opts = { rerouteCmd: 'C:\app\hooks\long-commands.cmd', operantCmd: 'C:\app\bin\operant.cmd' };
  assert.equal(setup.hookSettingsContent({ ...opts, reroute: false, worker: false }), null);
  const r = setup.hookSettingsContent({ ...opts, reroute: true, worker: false });
  assert.deepEqual(Object.keys(r.hooks), ['PreToolUse']);
  assert.equal(r.hooks.PreToolUse[0].matcher, 'Bash|PowerShell');
  const w = setup.hookSettingsContent({ ...opts, reroute: false, worker: true });
  assert.deepEqual(Object.keys(w.hooks), ['Stop']);
  assert.equal(w.hooks.Stop[0].hooks[0].command, '"C:\app\bin\operant.cmd" hook stop');
  assert.deepEqual(Object.keys(setup.hookSettingsContent({ ...opts, reroute: true, worker: true }).hooks), ['PreToolUse', 'Stop']);
  const m = setup.hookSettingsContent({ ...opts, reroute: false, worker: false, messaging: true });
  assert.deepEqual(Object.keys(m.hooks), ['PostToolUse', 'Stop'], 'messaging adds both hooks for everyone');
  assert.equal(m.hooks.PostToolUse[0].matcher, undefined);
  assert.equal(m.hooks.PostToolUse[0].hooks[0].command, `"${opts.operantCmd}" hook post-tool-use`);
  assert.equal(m.hooks.PostToolUse[0].hooks[0].timeout, 5);
  assert.deepEqual(Object.keys(setup.hookSettingsContent({ ...opts, reroute: true, worker: true, messaging: true }).hooks), ['PreToolUse', 'PostToolUse', 'Stop']);
});
