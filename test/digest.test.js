// Tests for renderer/digest.js (plan item 34): one realistic fixture per supported runner,
// checking the detected runner, the summary line, and the first failure's file:line.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const digest = require('../renderer/digest.js');

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', 'digest', name), 'utf8');

test('unknown output returns null', () => {
  assert.equal(digest(fixture('unknown.txt')), null);
});

test('empty/blank input returns null', () => {
  assert.equal(digest(''), null);
  assert.equal(digest('   \n\n  '), null);
});

// ---------------------------------------------------------------- jest
test('jest: passing run', () => {
  const d = digest(fixture('jest-pass.txt'));
  assert.equal(d.runner, 'jest');
  assert.equal(d.ok, true);
  assert.equal(d.summary, 'Tests: 2 passed');
  assert.equal(d.failures.length, 0);
});

test('jest: failing run', () => {
  const d = digest(fixture('jest-fail.txt'));
  assert.equal(d.runner, 'jest');
  assert.equal(d.ok, false);
  assert.match(d.summary, /1 failed, 1 passed/);
  assert.equal(d.failures.length, 1);
  const f = d.failures[0];
  assert.match(f.title, /subtracts numbers/);
  assert.match(f.file, /math\.test\.js$/);
  assert.equal(f.line, 8);
  assert.match(f.message, /Expected: 1/);
});

// ---------------------------------------------------------------- vitest
test('vitest: passing run', () => {
  const d = digest(fixture('vitest-pass.txt'));
  assert.equal(d.runner, 'vitest');
  assert.equal(d.ok, true);
});

test('vitest: failing run', () => {
  const d = digest(fixture('vitest-fail.txt'));
  assert.equal(d.runner, 'vitest');
  assert.equal(d.ok, false);
  assert.equal(d.failures.length, 1);
  const f = d.failures[0];
  assert.equal(f.file, 'src/math.test.js');
  assert.equal(f.line, 8);
  assert.match(f.message, /AssertionError/);
});

// ---------------------------------------------------------------- node:test
test('node:test TAP: passing run', () => {
  const d = digest(fixture('node-test-tap-pass.txt'));
  assert.equal(d.runner, 'node:test');
  assert.equal(d.ok, true);
  assert.equal(d.summary, 'Tests: 0 failed, 2 passed');
});

test('node:test TAP: failing run', () => {
  const d = digest(fixture('node-test-tap-fail.txt'));
  assert.equal(d.runner, 'node:test');
  assert.equal(d.ok, false);
  assert.equal(d.summary, 'Tests: 1 failed, 1 passed');
  assert.equal(d.failures.length, 1);
  const f = d.failures[0];
  assert.match(f.title, /subtracts numbers/);
  assert.match(f.file, /math\.test\.js$/);
  assert.equal(f.line, 10);
  assert.match(f.message, /1 !== 2/);
});

test('node:test spec reporter: failing run', () => {
  const d = digest(fixture('node-test-spec-fail.txt'));
  assert.equal(d.runner, 'node:test');
  assert.equal(d.ok, false);
  assert.equal(d.failures.length, 1);
  const f = d.failures[0];
  assert.match(f.file, /math\.test\.js$/);
  assert.equal(f.line, 10);
});

// ---------------------------------------------------------------- mocha
test('mocha: passing run', () => {
  const d = digest(fixture('mocha-pass.txt'));
  assert.equal(d.runner, 'mocha');
  assert.equal(d.ok, true);
});

test('mocha: failing run', () => {
  const d = digest(fixture('mocha-fail.txt'));
  assert.equal(d.runner, 'mocha');
  assert.equal(d.ok, false);
  assert.equal(d.failures.length, 1);
  const f = d.failures[0];
  assert.equal(f.file, 'test/math.test.js');
  assert.equal(f.line, 10);
  assert.match(f.message, /AssertionError/);
});

// ---------------------------------------------------------------- pytest
test('pytest: passing run', () => {
  const d = digest(fixture('pytest-pass.txt'));
  assert.equal(d.runner, 'pytest');
  assert.equal(d.ok, true);
  assert.match(d.summary, /2 passed/);
});

test('pytest: failing run', () => {
  const d = digest(fixture('pytest-fail.txt'));
  assert.equal(d.runner, 'pytest');
  assert.equal(d.ok, false);
  assert.match(d.summary, /1 failed, 1 passed/);
  assert.equal(d.failures.length, 1);
  const f = d.failures[0];
  assert.equal(f.title, 'test_sub');
  assert.equal(f.file, 'test_math.py');
  assert.equal(f.line, 8);
  assert.match(f.message, /assert 1 == 2/);
});

// ---------------------------------------------------------------- cargo
test('cargo test: passing run', () => {
  const d = digest(fixture('cargo-test-pass.txt'));
  assert.equal(d.runner, 'cargo test');
  assert.equal(d.ok, true);
  assert.equal(d.summary, 'Tests: 0 failed, 2 passed');
});

test('cargo test: failing run', () => {
  const d = digest(fixture('cargo-test-fail.txt'));
  assert.equal(d.runner, 'cargo test');
  assert.equal(d.ok, false);
  assert.equal(d.summary, 'Tests: 1 failed, 1 passed');
  assert.equal(d.failures.length, 1);
  const f = d.failures[0];
  assert.match(f.title, /subtracts_numbers/);
  assert.equal(f.file, 'src/lib.rs');
  assert.equal(f.line, 10);
  assert.match(f.message, /assertion/);
});

test('cargo build: compile error', () => {
  const d = digest(fixture('cargo-build-fail.txt'));
  assert.equal(d.runner, 'cargo build');
  assert.equal(d.ok, false);
  assert.equal(d.failures.length, 1);
  const f = d.failures[0];
  assert.match(f.title, /E0308/);
  assert.equal(f.file, 'src/lib.rs');
  assert.equal(f.line, 5);
});

// ---------------------------------------------------------------- go
test('go test: passing run', () => {
  const d = digest(fixture('go-test-pass.txt'));
  assert.equal(d.runner, 'go test');
  assert.equal(d.ok, true);
  assert.equal(d.summary, 'Tests: 0 failed, 2 passed');
});

test('go test: failing run', () => {
  const d = digest(fixture('go-test-fail.txt'));
  assert.equal(d.runner, 'go test');
  assert.equal(d.ok, false);
  assert.equal(d.summary, 'Tests: 1 failed, 1 passed');
  assert.equal(d.failures.length, 1);
  const f = d.failures[0];
  assert.equal(f.title, 'TestSub');
  assert.equal(f.file, 'math_test.go');
  assert.equal(f.line, 10);
  assert.match(f.message, /expected 1, got 2/);
});

test('go build: compile error', () => {
  const d = digest(fixture('go-build-fail.txt'));
  assert.equal(d.runner, 'go build');
  assert.equal(d.ok, false);
  assert.equal(d.failures.length, 2);
  assert.equal(d.failures[0].file, './math.go');
  assert.equal(d.failures[0].line, 5);
});

// ---------------------------------------------------------------- tsc
test('tsc: passing (watch) run', () => {
  const d = digest(fixture('tsc-pass.txt'));
  assert.equal(d.runner, 'tsc');
  assert.equal(d.ok, true);
});

test('tsc: failing run', () => {
  const d = digest(fixture('tsc-fail.txt'));
  assert.equal(d.runner, 'tsc');
  assert.equal(d.ok, false);
  assert.equal(d.failures.length, 2);
  const f = d.failures[0];
  assert.equal(f.title, 'TS2322');
  assert.equal(f.file, 'src/math.ts');
  assert.equal(f.line, 10);
});

// ---------------------------------------------------------------- eslint
test('eslint: stylish output', () => {
  const d = digest(fixture('eslint-fail.txt'));
  assert.equal(d.runner, 'eslint');
  assert.equal(d.ok, false);
  assert.equal(d.failures.length, 3);
  const f = d.failures[0];
  assert.match(f.file, /math\.js$/);
  assert.equal(f.line, 10);
});

// ---------------------------------------------------------------- gradle
test('gradle: build successful', () => {
  const d = digest(fixture('gradle-pass.txt'));
  assert.equal(d.runner, 'gradle');
  assert.equal(d.ok, true);
});

test('gradle: test failure', () => {
  const d = digest(fixture('gradle-test-fail.txt'));
  assert.equal(d.runner, 'gradle');
  assert.equal(d.ok, false);
  assert.equal(d.failures.length, 1);
  const f = d.failures[0];
  assert.match(f.title, /testAdd/);
  assert.equal(f.file, 'MathTest.java');
  assert.equal(f.line, 10);
});

test('gradle: compile error', () => {
  const d = digest(fixture('gradle-compile-fail.txt'));
  assert.equal(d.runner, 'gradle');
  assert.equal(d.ok, false);
  const f = d.failures.find(x => /cannot find symbol/.test(x.message));
  assert.ok(f, 'expected a compile-error failure');
  assert.match(f.file, /Math\.java$/);
  assert.equal(f.line, 10);
});

// ---------------------------------------------------------------- maven
test('maven: surefire failure', () => {
  const d = digest(fixture('maven-fail.txt'));
  assert.equal(d.runner, 'maven');
  assert.equal(d.ok, false);
  assert.equal(d.summary, 'Tests: 1 failed, 1 passed');
  assert.equal(d.failures.length, 1);
  const f = d.failures[0];
  assert.match(f.title, /testSubtract/);
  assert.equal(f.file, 'MathTest.java');
  assert.equal(f.line, 14);
});

// ---------------------------------------------------------------- dotnet
test('dotnet test: failing run', () => {
  const d = digest(fixture('dotnet-test-fail.txt'));
  assert.equal(d.runner, 'dotnet test');
  assert.equal(d.ok, false);
  assert.equal(d.summary, 'Tests: 1 failed, 1 passed');
  assert.equal(d.failures.length, 1);
  const f = d.failures[0];
  assert.match(f.title, /SubtractTest/);
  assert.match(f.file, /MathTests\.cs$/);
  assert.equal(f.line, 14);
  assert.match(f.message, /Assert\.Equal/);
});

test('dotnet build: MSBuild error', () => {
  const d = digest(fixture('dotnet-build-fail.txt'));
  assert.equal(d.runner, 'dotnet build');
  assert.equal(d.ok, false);
  assert.equal(d.failures.length, 1);
  const f = d.failures[0];
  assert.match(f.title, /CS0103/);
  assert.match(f.file, /Math\.cs$/);
  assert.equal(f.line, 10);
});

// ---------------------------------------------------------------- npm ERR!
test('npm ERR! fallback', () => {
  const d = digest(fixture('npm-err.txt'));
  assert.equal(d.runner, 'npm');
  assert.equal(d.ok, false);
  assert.match(d.summary, /ELIFECYCLE/);
  assert.equal(d.failures.length, 1);
  assert.match(d.failures[0].message, /Exit status 1/);
});

// ---------------------------------------------------------------- cap at 20 failures
test('caps failures at 20 and reports how many more', () => {
  let text = 'Test Suites: 1 failed, 1 total\nTests:       25 failed, 25 total\n';
  let body = '';
  for (let i = 1; i <= 25; i++) {
    body += `  ● test ${i}\n\n    Error: boom ${i}\n\n      at Object.<anonymous> (src/foo.test.js:${i}:1)\n\n`;
  }
  const full = body + text;
  const d = digest(full);
  assert.equal(d.runner, 'jest');
  assert.equal(d.failures.length, 20);
  assert.equal(d.more, 5);
});
