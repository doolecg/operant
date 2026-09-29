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
  assert.strictEqual(rewriteCommand('npm test'), 'operant run "npm test" --background --inline --title "npm-test"');
  assert.strictEqual(classify('npm run build'), 'build');
  assert.strictEqual(rewriteCommand('yarn run build'), 'operant run "yarn run build" --background --inline --title "yarn-run"');
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
  assert.strictEqual(rewritten, 'operant run "npm install" --background --inline --title "npm-install"');
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
  assert.strictEqual(rewriteCommand('npm test', 'powershell'), "operant run 'npm test' --background --inline --title 'npm-test'");
  assert.strictEqual(rewriteCommand('cargo build', 'powershell'), "operant run 'cargo build' --background --inline --title 'cargo-build'");
  assert.strictEqual(rewriteCommand('npm install', 'powershell'), "operant run 'npm install' --background --inline --title 'npm-install'");
});

test('the hook rewrites the command without approving it', () => {
  const out = hookOutput(call('Bash', { command: 'npm test', description: 'Run the unit tests', run_in_background: true }), IN_TILE);
  const h = out.hookSpecificOutput;
  assert.strictEqual(h.hookEventName, 'PreToolUse');
  // No decision at all, so Claude Code's own permission flow still judges the rewritten command.
  assert.ok(!('permissionDecision' in h));
  assert.deepStrictEqual(h.updatedInput, {
    command: 'operant run "npm test" --background --inline --title "npm-test"', description: 'Run the unit tests', run_in_background: true, timeout: 600000,
  });
});

test('the hook tells the agent about both commands, and how to opt out', () => {
  const bash = hookOutput(call('Bash', { command: 'npm test' }), IN_TILE).hookSpecificOutput.additionalContext;
  assert.ok(bash.includes('`npm test`'));
  assert.ok(bash.includes('`operant run "npm test" --background --inline --title "npm-test"`'));
  assert.ok(bash.includes('Basement'));
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
  assert.strictEqual(updatedInput.command, "operant run 'npm install' --background --inline --title 'npm-install'");
  assert.strictEqual(updatedInput.description, 'Install');
  assert.strictEqual(hookOutput(call('PowerShell', { command: 'npm test' }), IN_TILE).hookSpecificOutput.updatedInput.command, "operant run 'npm test' --background --inline --title 'npm-test'");
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

const { createBackgroundTasks, basementModel, statusText } = require('../hooks/long-commands');
const waitFor = async (fn) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise(r => setTimeout(r, 50)); };
const node = (code) => `"${process.execPath}" -e "${code}"`;

test('background start returns at once, accumulates output and ends passed', async () => {
  const seen = [];
  const bg = createBackgroundTasks({ onChange: t => seen.push(t.status) });
  const t = bg.start(node("console.log('hello');console.error('warn')"));
  assert.strictEqual(t.status, 'running');
  await waitFor(() => t.status !== 'running');
  assert.strictEqual(t.status, 'passed');
  assert.strictEqual(t.exitCode, 0);
  assert.match(t.output, /hello/);
  assert.match(t.output, /warn/);
  assert.strictEqual(statusText(t), 'passed');
  assert.ok(seen.includes('running') && seen.includes('passed'));
  assert.strictEqual(bg.get(t.id), t);
});

test('background failure keeps the exit code; output is capped', async () => {
  const bg = createBackgroundTasks({ maxBytes: 100 });
  const t = bg.start(node("console.log('x'.repeat(500));process.exit(3)"));
  await waitFor(() => t.status !== 'running');
  assert.strictEqual(t.status, 'failed');
  assert.strictEqual(t.exitCode, 3);
  assert.strictEqual(statusText(t), 'failed (exit 3)');
  assert.ok(t.output.length <= 100 && t.truncated);
});

test('a spawn that throws is a failed task', () => {
  const bg = createBackgroundTasks({ spawn: () => { throw new Error('nope'); } });
  const t = bg.start('x');
  assert.strictEqual(t.status, 'failed');
  assert.match(t.output, /nope/);
});

test('basement model: running first, then newest; selected task carries its output', () => {
  const mk = (id, status, startedAt, output = '') => ({ id, title: 't' + id, command: 'c', status, exitCode: status === 'failed' ? 1 : 0, startedAt, endedAt: status === 'running' ? null : startedAt + 4000, output });
  const tasks = [mk(1, 'passed', 1000, 'one'), mk(2, 'running', 500), mk(3, 'failed', 2000, 'boom')];
  const m = basementModel(tasks, null, 10000);
  assert.deepStrictEqual(m.rows.map(r => r.id), [2, 3, 1]);
  assert.strictEqual(m.running, 1);
  assert.strictEqual(m.selected.id, 2);
  const s = basementModel(tasks, 3, 10000);
  assert.strictEqual(s.selected.output, 'boom');
  assert.strictEqual(s.selected.label, 'failed (exit 1)');
  assert.strictEqual(s.rows.find(r => r.id === 1).seconds, 4);
  assert.deepStrictEqual(basementModel([], null), { rows: [], selected: null, running: 0 });
});

const { taskReport, errorLines } = require('../hooks/long-commands');
const { EventEmitter } = require('node:events');
const fakeSpawn = () => { const kids = []; const spawn = () => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); kids.push(c); return c; }; return { spawn, kids }; };

test('the 5 s rule: a task that ends within the threshold settles with its result, a slower one is handed over', async () => {
  const { spawn, kids } = fakeSpawn();
  const tasks = createBackgroundTasks({ spawn });
  const quick = tasks.start('npm test');
  const p = tasks.settled(quick.id, 5000);
  kids[0].stdout.emit('data', Buffer.from('ok\n'));
  kids[0].emit('close', 0);
  const done = await p;
  assert.strictEqual(done.status, 'passed');
  assert.match(taskReport(done), /^npm-test \(bg1\): passed in \d+s$/);

  const slow = tasks.start('npm run build');
  assert.strictEqual(await tasks.settled(slow.id, 20), null, 'still running after the threshold: null');
  assert.strictEqual(await tasks.settled(slow.id, 0), null, '0 = always handed over at once');
  const waiting = tasks.settled('bg' + slow.id, 5000);
  kids[1].stderr.emit('data', Buffer.from('src/a.js:3 error: boom\nmore noise\n'));
  kids[1].emit('close', 1);
  const fin = await waiting;
  assert.strictEqual(fin.status, 'failed');
  const report = taskReport(fin, { errors: true });
  assert.match(report, /failed \(exit 1\)/);
  assert.match(report, /error: boom/);
  assert.strictEqual(await tasks.settled(99, 10), null, 'no such task');
});

test('a report keeps only the failing lines', () => {
  const output = Array.from({ length: 200 }, (_, i) => `line ${i} fine`).concat(['FAIL test/a.test.js', 'AssertionError: nope']).join('\n');
  const lines = errorLines(output);
  assert.ok(lines.length <= 5, lines.join('|'));
  assert.ok(lines.some(l => /AssertionError/.test(l)));
  const r = taskReport({ id: 2, title: 't', status: 'failed', exitCode: 1, startedAt: 0, endedAt: 3000, output }, { errors: true });
  assert.ok(r.split('\n').length < 10);
  assert.match(taskReport({ id: 3, title: 't', status: 'running', startedAt: Date.now(), output: '' }), /still in the Basement/);
});
