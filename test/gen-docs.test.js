const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { buildArchitecture, buildDependencies, leadingComment } = require('../scripts/gen-docs');

const root = path.join(__dirname, '..');

test('architecture lists modules with descriptions', () => {
  const md = buildArchitecture(root);
  assert.ok(md.length > 500);
  assert.match(md, /`store\.js`/);
  assert.match(md, /`bin\/operant-cli\.js`/);
  assert.match(md, /`platform\/mac\.js`/);
});

test('dependencies lists direct deps and lockfile stats', () => {
  const md = buildDependencies(root);
  assert.match(md, /@xterm\/xterm/);
  assert.match(md, /electron-builder/);
  assert.match(md, /Transitive packages: \d+/);
  assert.match(md, /Duplicates/);
});

test('leadingComment skips shebang and joins the block', () => {
  assert.strictEqual(leadingComment('#!/usr/bin/env node\n// Does a thing here that is long enough.\n// More.\ncode'), 'Does a thing here that is long enough.');
});
