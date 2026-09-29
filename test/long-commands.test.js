const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { classify, rewriteCommand, hookOutput } = require('../hooks/long-commands');

const SCRIPT = path.join(__dirname, '..', 'hooks', 'long-commands.js');
const IN_TILE = { OPERANT: '1' };
const call = (tool_name, tool_input, extra) => ({ hook_event_name: 'PreToolUse', tool_name, tool_input, ...extra });

// Runs the hook script the way Claude Code does, with the event on stdin. OPERANT is set only when
// a test passes it, so the tile these tests run in can't leak its own.
function runScript(stdin, env) {
  const childEnv = { ...process.env };
  delete childEnv.OPERANT;
  return spawnSync(process.execPath, [SCRIPT], { input: stdin, env: { ...childEnv, ...env }, encoding: 'utf8' });
}

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

test('leaves commands with quotes alone', () => {
  for (const cmd of ['npm test -- -t "adds numbers"', "npm test -- -t 'adds numbers'", 'pytest -k "a or b"']) {
    assert.strictEqual(classify(cmd), null, cmd);
    assert.strictEqual(rewriteCommand(cmd), null, cmd);
    assert.strictEqual(rewriteCommand(cmd, 'powershell'), null, cmd);
  }
});

test('a command ending in # raw is the agent opting out', () => {
  for (const cmd of ['npm test # raw', 'npm test #raw', 'npm install  #   raw  ', 'cargo build # RAW']) {
    assert.strictEqual(classify(cmd), null, cmd);
    assert.strictEqual(hookOutput(call('Bash', { command: cmd }), IN_TILE), null, cmd);
  }
});

test('rewrites for PowerShell too, Claude Code\'s Windows shell tool', () => {
  assert.strictEqual(rewriteCommand('npm test', 'powershell'), "operant test 'npm test'");
  assert.strictEqual(rewriteCommand('cargo build', 'powershell'), "operant build 'cargo build'");
  const rewritten = rewriteCommand('npm install', 'powershell');
  assert.strictEqual(rewritten, "$id = (operant run 'npm install' --title 'npm-install') -split ' ' | Select-Object -Last 1; operant wait $id --errors");
});

test('the hook rewrites the command without approving it', () => {
  const out = hookOutput(call('Bash', { command: 'npm test', description: 'Run the unit tests', run_in_background: true }), IN_TILE);
  const h = out.hookSpecificOutput;
  assert.strictEqual(h.hookEventName, 'PreToolUse');
  // No decision at all, so Claude Code's own permission flow still judges the rewritten command.
  assert.ok(!('permissionDecision' in h));
  assert.deepStrictEqual(h.updatedInput, {
    command: 'operant test "npm test"', description: 'Run the unit tests', run_in_background: true, timeout: 600000,
  });
});

test('the hook tells the agent about both commands, and how to opt out', () => {
  const bash = hookOutput(call('Bash', { command: 'npm test' }), IN_TILE).hookSpecificOutput.additionalContext;
  assert.ok(bash.includes('`npm test`'));
  assert.ok(bash.includes('`operant test "npm test"`'));
  assert.ok(bash.includes('`# raw`'));
  const ps = hookOutput(call('PowerShell', { command: 'npm install' }), IN_TILE).hookSpecificOutput;
  assert.ok(ps.additionalContext.includes('`npm install`'));
  assert.ok(ps.additionalContext.includes(`\`${ps.updatedInput.command}\``));
});

test('the hook raises a short tool timeout to the 600 s operant test/build wait, and never lowers a longer one', () => {
  const timeoutFor = (command, timeout) => hookOutput(call('Bash', { command, timeout }), IN_TILE).hookSpecificOutput.updatedInput.timeout;
  assert.strictEqual(timeoutFor('npm test'), 600000);
  assert.strictEqual(timeoutFor('npm test', 120000), 600000);
  assert.strictEqual(timeoutFor('npm test', 900000), 900000);
  assert.strictEqual(timeoutFor('npm install', 30000), 600000);
});

test('the hook gives PowerShell calls PowerShell quoting', () => {
  const { updatedInput } = hookOutput(call('PowerShell', { command: 'npm install', description: 'Install' }), IN_TILE).hookSpecificOutput;
  assert.strictEqual(updatedInput.command, "$id = (operant run 'npm install' --title 'npm-install') -split ' ' | Select-Object -Last 1; operant wait $id --errors");
  assert.strictEqual(updatedInput.description, 'Install');
  assert.strictEqual(hookOutput(call('PowerShell', { command: 'npm test' }), IN_TILE).hookSpecificOutput.updatedInput.command, "operant test 'npm test'");
});

test('the hook does nothing outside an Operant tile, for other tools or events, or for other commands', () => {
  const npmTest = call('Bash', { command: 'npm test' });
  assert.ok(hookOutput(npmTest, IN_TILE));
  assert.strictEqual(hookOutput(npmTest, {}), null);
  assert.strictEqual(hookOutput(npmTest, { OPERANT: '0' }), null);
  assert.strictEqual(hookOutput(call('Edit', { command: 'npm test' }), IN_TILE), null);
  assert.strictEqual(hookOutput(call('Bash', { command: 'npm test' }, { hook_event_name: 'PostToolUse' }), IN_TILE), null);
  assert.strictEqual(hookOutput(call('Bash', { command: 'git status' }), IN_TILE), null);
  assert.strictEqual(hookOutput(call('Bash', { command: 'npm test # raw' }), IN_TILE), null);
  assert.strictEqual(hookOutput(call('Bash', { command: 'npm test -- -t "x"' }), IN_TILE), null);
  assert.strictEqual(hookOutput(call('Bash', {}), IN_TILE), null);
  assert.strictEqual(hookOutput(null, IN_TILE), null);
});

test('the script prints the hook reply for a rerouted command', () => {
  const event = call('Bash', { command: 'npm test' });
  const r = runScript(JSON.stringify(event), IN_TILE);
  assert.strictEqual(r.status, 0);
  assert.deepStrictEqual(JSON.parse(r.stdout), hookOutput(event, IN_TILE));
  assert.strictEqual(runScript(JSON.stringify(event), {}).stdout, '');
});

test('the script exits 0 with no output for garbage, empty or unrelated input', () => {
  for (const stdin of ['not json {{', '', '[]', 'null', JSON.stringify(call('Bash', { command: 'ls' }))]) {
    const r = runScript(stdin, IN_TILE);
    assert.strictEqual(r.status, 0, JSON.stringify(stdin));
    assert.strictEqual(r.stdout, '', JSON.stringify(stdin));
  }
});
