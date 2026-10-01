// The refine skill: valid frontmatter, and the steps the plan asks for are in its text.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const file = path.join(__dirname, '..', 'agent-plugin', 'skills', 'refine', 'SKILL.md');
const text = fs.readFileSync(file, 'utf8');
const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
const meta = m ? yaml.load(m[1]) : null;
const body = m ? text.slice(m[0].length) : text;

test('the frontmatter is valid, named after its folder, and says when to use it and when not', () => {
  assert.ok(meta && typeof meta === 'object');
  assert.deepEqual(Object.keys(meta).sort(), ['compatibility', 'description', 'name']);
  assert.equal(meta.name, 'refine');
  assert.ok(meta.description.length <= 1024);
  assert.match(meta.description, /Use when/);
  assert.match(meta.description, /Not for/);
  for (const phrase of ['refine this', 'tighten this prompt', 'send this to Claude']) assert.ok(meta.description.includes(phrase), phrase);
  assert.ok(body.trim().split(/\r?\n/).length <= 130);
  for (const claudeOnly of ['!`', '$ARGUMENTS', '${CLAUDE_']) assert.ok(!body.includes(claudeOnly), claudeOnly);
});

test('the brief has a goal, files from CodeGraph first, constraints, a check, what to hand back and a report line', () => {
  for (const part of ['Goal:', 'Files:', 'Keep:', 'Check:', 'Hand back:', 'Report:']) assert.ok(body.includes(part), part);
  assert.match(body, /codegraph explore/);
  assert.match(body, /operant test/);
  assert.match(body, /operant msg <your tile id> "<short result>"/);
  assert.match(body, /don't report back/);
  assert.match(body, /never add a requirement they did not state/);
  assert.match(body, /at most one question|exactly one question/i);
});

test('it shows the brief and waits for a yes, then sends with operant send, never as a plain send when team mode is off', () => {
  assert.match(body, /Send nothing until the user answers yes/);
  for (const cmd of ['operant send --file', 'operant send <tile id> --file', '--new', 'operant send --team --file']) assert.ok(body.includes(cmd), cmd);
  assert.match(body, /turn on team mode/);
  assert.match(body, /do not resend it as a plain send/);
  assert.match(body, /never interrupted/);
  assert.match(body, /can't approve|cannot approve/);
});

test('no Terminal, refiner service or prompt box wording', () => {
  assert.doesNotMatch(text, /terminal|refiner|prompt box/i);
});
