const { test } = require('node:test');
const assert = require('node:assert');
const { classify, rewriteCommand } = require('../hooks/long-commands');

test('rewrites test/build/install commands', () => {
  assert.strictEqual(classify('npm test'), 'test');
  assert.strictEqual(rewriteCommand('npm test'), 'operant test "npm test"');
  assert.strictEqual(classify('npm run build'), 'build');
  assert.strictEqual(rewriteCommand('yarn run build'), 'operant build "yarn run build"');
  assert.strictEqual(classify('pytest'), 'test');
  assert.strictEqual(classify('cargo test'), 'test');
  assert.strictEqual(classify('cargo build'), 'build');
  assert.strictEqual(classify('go test ./...'), 'test');
  assert.strictEqual(classify('./gradlew test'), 'test');
  assert.strictEqual(classify('gradlew.bat build'), 'build');
  assert.strictEqual(classify('mvn test'), 'test');
  assert.strictEqual(classify('mvn package'), 'build');
  assert.strictEqual(classify('dotnet test'), 'test');
  assert.strictEqual(classify('npx vitest run'), 'test');
  assert.strictEqual(classify('npx jest'), 'test');

  assert.strictEqual(classify('npm install'), 'install');
  assert.strictEqual(classify('npm ci'), 'install');
  assert.strictEqual(classify('mvn install'), 'install');
  const rewritten = rewriteCommand('npm install');
  assert.match(rewritten, /^id=\$\(operant run "npm install" --title "npm-install" \| awk '\{print \$2\}'\); operant wait "\$id" --errors$/);
});

test('leaves everything else alone', () => {
  assert.strictEqual(classify('ls -la'), null);
  assert.strictEqual(classify('echo hi'), null);
  assert.strictEqual(classify('git status'), null);
  assert.strictEqual(rewriteCommand('git status'), null);
});

test('never rewrites pipes, redirection, && or ;', () => {
  assert.strictEqual(classify('npm test | tee out.log'), null);
  assert.strictEqual(classify('npm test > out.log'), null);
  assert.strictEqual(classify('npm install && npm test'), null);
  assert.strictEqual(classify('npm test; echo done'), null);
  assert.strictEqual(classify('npm test $(echo x)'), null);
  assert.strictEqual(classify('npm test `echo x`'), null);
});

test('leaves commands already using operant alone', () => {
  assert.strictEqual(classify('operant test npm test'), null);
  assert.strictEqual(classify('npm test # via operant'), null);
});

test('rewrites for PowerShell too, Claude Code\'s Windows shell tool', () => {
  assert.strictEqual(rewriteCommand('npm test', 'powershell'), 'operant test "npm test"');
  assert.strictEqual(rewriteCommand('cargo build', 'powershell'), 'operant build "cargo build"');
  const rewritten = rewriteCommand('npm install', 'powershell');
  assert.match(rewritten, /^\$id = \(operant run "npm install" --title "npm-install"\) -split ' ' \| Select-Object -Last 1; operant wait \$id --errors$/);
});
