// Offline check of the grader's command classification and the child-env safety rules (no claude
// session, no spend): node selftest.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { classifyCommand, grade, outcomeCheck, parseOpencode, parseStream, totals, childEnv } from './run.mjs';

const cc = classifyCommand;
const sub = c => cc(c).operant.map(w => w[0]);

// operant is recognised, and operant's own quoted arguments never count as a raw long command
assert.deepEqual(sub('operant test'), ['test']);
assert.equal(cc('operant test "npm test"').raw, 0);
const bashId = 'id=$(operant run "npm run dev" --title dev | awk \'{print $2}\'); operant wait "$id" --errors';
assert.deepEqual(sub(bashId), ['run', 'wait']);
assert.equal(cc(bashId).raw, 0);
assert.equal(cc(bashId).first, 'operant');
const psId = '$id = (operant run "npm install" --title "npm-install") -split \' \' | Select-Object -Last 1; operant wait $id --errors';
assert.deepEqual(sub(psId), ['run', 'wait']);
assert.equal(cc(psId).raw, 0);
assert.equal(cc('operant help test').first, null);
assert.deepEqual(sub('"C:\\x y\\operant.cmd" build'), ['build']);
assert.deepEqual(sub('cd src && operant plan plan.md'), ['plan']);
assert.deepEqual(sub('operants test'), []);

// raw long commands
for (const cmd of ['npm test', 'npm run build', 'npm install', 'npm ci', 'npm start', 'npm run dev', 'npx vitest run', 'pnpm test', 'yarn build',
  'node --test', 'node build.js', 'node server.js', 'node ./server.js &', 'pytest -k foo', 'python -m pytest', 'cargo test', 'cargo build --release',
  'go test ./...', './gradlew test', 'gradlew.bat build', 'mvn test', 'mvn -q package', 'dotnet test', 'dotnet build',
  'cd foo && npm test 2>&1', 'bash -c "npm test"', 'powershell -Command "npm run build"', 'cmd /c npm test', 'FOO=1 npm test']) {
  assert.ok(cc(cmd).raw >= 1, `expected raw long: ${cmd}`);
  assert.equal(cc(cmd).first, 'raw', `first should be raw: ${cmd}`);
}

// ordinary commands are not
for (const cmd of ['git status', 'git log -1 --format=%s', 'git commit -m "npm test fix"', 'ls -la src', 'cat package.json', 'node -e "console.log(2+2)"',
  'Get-Content package.json', 'Get-ChildItem src', 'echo hello', 'npm --version', 'npm ls', 'cat package.json | grep test', 'grep -n "npm test" README.md']) {
  assert.equal(cc(cmd).raw, 0, `should not be raw long: ${cmd}`);
  assert.equal(cc(cmd).first, null);
}

// whichever comes first inside one command wins
assert.equal(cc('operant test && npm run build').first, 'operant');
assert.equal(cc('npm run build && operant test').first, 'raw');

// stream -> grade
const line = o => JSON.stringify(o);
const asst = (...blocks) => line({ type: 'assistant', message: { id: 'm' + Math.random(), content: blocks } });
const tu = (id, name, input) => ({ type: 'tool_use', id, name, input });

const s = parseStream([
  line({ type: 'system', subtype: 'init', tools: ['Bash', 'Skill'], skills: ['x'], slash_commands: ['operant'] }),
  asst(tu('1', 'Skill', { skill: 'operant' })),
  asst(tu('2', 'Bash', { command: 'operant test' })),
  asst(tu('3', 'Agent', { prompt: 'x' })),
  line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: '2', content: [{ type: 'text', text: 'ok' }], is_error: false }] } }),
  line({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, result: 'done', total_cost_usd: 0.1, usage: { input_tokens: 1 } }),
].join('\n'));
assert.equal(s.toolUses.length, 3);
assert.equal(s.results.get('2').text, 'ok');
const g = grade({ expect: { routed: true, operant: ['test'], delegated: true } }, s, [{ argv: ['test'] }]);
assert.equal(g.skillInvoked, true);
assert.equal(g.routed, true);
assert.equal(g.delegated, true);
assert.equal(g.checksPassed, true);

// a plugin-namespaced skill counts; another skill does not; a raw attempt with no operant call is not routed
const g2 = grade({ expect: { routed: true } },
  parseStream([asst(tu('1', 'Skill', { skill: 'operant:operant' })), asst(tu('2', 'PowerShell', { command: 'npm test' })), asst(tu('3', 'Skill', { skill: 'claude-api' }))].join('\n')), []);
assert.equal(g2.skillInvoked, true);
assert.equal(g2.rawLongAttempts, 1);
assert.equal(g2.routed, false);
assert.equal(g2.firstLongRouted, false);
assert.equal(g2.checksPassed, false);
assert.equal(grade({ expect: {} }, parseStream(asst(tu('1', 'Skill', { skill: 'claude-api' }))), []).skillInvoked, false);

// raw command first, operant after: not routed, but both facts are recorded
const g3 = grade({ expect: { routed: true } },
  parseStream([asst(tu('1', 'Bash', { command: 'npm test' })), asst(tu('2', 'Bash', { command: 'operant test' }))].join('\n')), [{ argv: ['test'] }]);
assert.equal(g3.routed, false);
assert.equal(g3.firstLongRouted, false);
assert.equal(g3.rawLongAttempts, 1);
assert.equal(g3.routeCalls, 1);

// several result events (background subagents wake the session up again): turns and durations add up,
// cost and modelUsage are session totals; denial events are kept per tool call
const mu = { 'claude-haiku-4-5': { inputTokens: 208, outputTokens: 11985, cacheReadInputTokens: 478537, cacheCreationInputTokens: 121448 } };
const multi = parseStream([
  asst(tu('a', 'Bash', { command: 'npm test' })),
  line({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 'a' }),
  line({ type: 'result', subtype: 'success', is_error: false, num_turns: 7, duration_ms: 1000, total_cost_usd: 0.27, modelUsage: mu, result: 'first', usage: { input_tokens: 1 } }),
  line({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 500, total_cost_usd: 0.27, modelUsage: mu, result: 'last', usage: { input_tokens: 1 } }),
].join('\n'));
const t = totals(multi);
assert.equal(t.turns, 8);
assert.equal(t.durationMs, 1500);
assert.equal(t.costUsd, 0.27);
assert.equal(t.usage.cacheRead, 478537);
assert.equal(t.finalText, 'last');
assert.equal(t.isError, false);
assert.ok(multi.denied.has('a'));
assert.equal(totals(parseStream('')).turns, 0);
assert.equal(totals(parseStream(line({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 13 }))).subtype, 'error_max_turns');

// an operant command refused by the permission rules is counted, other refusals are not
const denial = 'Permission to use PowerShell has been denied because Claude Code is running in don\'t ask mode.';
const gd = grade({ expect: {} }, parseStream([
  asst(tu('1', 'PowerShell', { command: 'cd C:\\ws; operant test' })),
  line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: '1', content: denial, is_error: true }] } }),
  asst(tu('2', 'PowerShell', { command: 'npm test' })),
  line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: '2', content: denial, is_error: true }] } }),
].join('\n')), []);
assert.equal(gd.operantDenied, 1);
assert.equal(gd.rawLongAttempts, 1);

// negatives: an attempt that never reached the stub still counts
const noRun = { expect: { noOperant: ['run', 'test', 'build', 'agent'] } };
assert.equal(grade(noRun, parseStream(asst(tu('1', 'Bash', { command: 'cd src && operant run "ls"' }))), []).checksPassed, false);
assert.equal(grade(noRun, parseStream(asst(tu('1', 'Bash', { command: 'git status' }))), []).checksPassed, true);

// multi-word expectations; delegation through the log or the Agent tool, not through the todo tools
assert.equal(grade({ expect: { operant: ['task done 12'] } }, parseStream(''), [{ argv: ['task', 'done', '12', '--note', 'x'] }]).checksPassed, true);
assert.equal(grade({ expect: { delegated: true } }, parseStream(''), [{ argv: ['task', 'add', 'x'] }]).checksPassed, true);
assert.equal(grade({ expect: { delegated: true } }, parseStream(asst(tu('1', 'TaskCreate', {}))), []).delegated, false);

// team-work keys: operantAny (each group needs one hit), agentTier, maxCalls, noShell
const gA = (expect, calls, blocks = []) => grade({ expect }, parseStream(blocks.join('\n')), calls.map(argv => ({ argv }))).checks;
assert.deepEqual(Object.values(gA({ operantAny: [['read 20', 'board'], ['task approve 14', 'task reject 14']] }, [['board'], ['task', 'reject', '14', '--note', 'x']])), [true, true]);
assert.deepEqual(Object.values(gA({ operantAny: [['read 20', 'board'], ['task approve 14', 'task reject 14']] }, [['board']])), [true, false]);
assert.equal(Object.values(gA({ agentTier: ['xsmall', 'small'] }, [['agent', 'do it', '--tier', 'xsmall']]))[0], true);
assert.equal(Object.values(gA({ agentTier: ['xsmall', 'small'] }, [['agent', 'do it']]))[0], false);
assert.equal(Object.values(gA({ agentTier: ['xsmall'] }, [['agent', 'do it', '--tier', 'medium']]))[0], false);
assert.equal(Object.values(gA({ maxCalls: { board: 2 } }, [['board'], ['board']]))[0], true);
assert.equal(Object.values(gA({ maxCalls: { board: 2 } }, [['board'], ['board'], ['board']]))[0], false);
assert.equal(Object.values(gA({ noShell: ['npm '] }, [], [asst(tu('1', 'Bash', { command: 'operant test' }))]))[0], true);
assert.equal(Object.values(gA({ noShell: ['npm '] }, [], [asst(tu('1', 'Bash', { command: 'npm test' }))]))[0], false);
// baseline arm: operant expectations are not graded
assert.deepEqual(grade({ expect: { operant: ['task done 1'], delegated: true } }, parseStream(''), [], { baseline: true }).checks, {});

// expect.outcome runs in the workspace; exit 0 passes
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'operant-eval-selftest-'));
assert.equal(outcomeCheck({ expect: {} }, tmp), null);
assert.equal(outcomeCheck({ expect: { outcome: 'node -e "process.exit(0)"' } }, tmp).ok, true);
assert.equal(outcomeCheck({ expect: { outcome: 'node -e "process.exit(3)"' } }, tmp).ok, false);
fs.rmSync(tmp, { recursive: true, force: true });

// opencode --format json events map onto the same shape
const ocLine = o => JSON.stringify({ sessionID: 's', ...o });
const oc = parseOpencode([
  ocLine({ type: 'step_start', part: { type: 'step-start' } }),
  ocLine({ type: 'tool_use', part: { type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'completed', input: { command: 'operant test' }, output: 'ok' } } }),
  ocLine({ type: 'step_finish', part: { reason: 'tool-calls', tokens: { input: 10, output: 2, cache: { read: 5, write: 1 } }, cost: 0.01 } }),
  ocLine({ type: 'text', part: { type: 'text', text: 'done' } }),
  ocLine({ type: 'step_finish', part: { reason: 'stop', tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } }, cost: 0.02 } }),
].join('\n'));
assert.equal(oc.toolUses[0].name, 'Bash');
assert.equal(classifyCommand(oc.toolUses[0].input.command).first, 'operant');
const ot = totals(oc);
assert.equal(ot.turns, 2);
assert.ok(Math.abs(ot.costUsd - 0.03) < 1e-9);
assert.equal(ot.usage.cacheRead, 5);
assert.equal(ot.finalText, 'done');
assert.equal(parseOpencode(ocLine({ type: 'error', error: { data: { message: 'boom' } } })).apiError, 'boom');
assert.equal(parseOpencode('').result, null);

// child env: nothing OPERANT-ish or session-ish from the parent survives, the stub is first on PATH
process.env.OPERANT_API = 'http://127.0.0.1:1234';
process.env.OPERANT_TOKEN = 'secret';
process.env.OPERANT_EXE = 'C:\\somewhere\\Operant.exe';
process.env.CLAUDE_CODE_SESSION_ID = 'abc';
process.env.CLAUDECODE = '1';
const { env } = childEnv({ OPERANT_WORKER: '1' }, { log: 'l', scenario: 's' });
assert.equal(env.OPERANT_API, 'http://127.0.0.1:9');
assert.equal(env.OPERANT_TOKEN, 'eval');
assert.equal(env.OPERANT_WORKER, '1');
assert.equal(env.OPERANT_EXE, undefined);
assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined);
assert.equal(env.CLAUDECODE, undefined);
assert.equal((env.Path || env.PATH).split(path.delimiter)[0], path.join(path.dirname(fileURLToPath(import.meta.url)), 'stub'));
// baseline env: no stub on PATH, no OPERANT vars at all
const base = childEnv({ OPERANT_WORKER: '1' }, { log: 'l', scenario: 's' }, true).env;
assert.ok(!Object.keys(base).some(k => k.toUpperCase().startsWith('OPERANT')));
assert.ok(!(base.Path || base.PATH).split(path.delimiter).includes(path.join(path.dirname(fileURLToPath(import.meta.url)), 'stub')));
const realExit = process.exit, realErr = console.error;
process.exit = c => { throw new Error('exit ' + c); };
console.error = () => {};
assert.throws(() => childEnv({ OPERANT_API: 'http://127.0.0.1:1234' }, { log: 'l', scenario: 's' }), /exit 1/);
process.exit = realExit;
console.error = realErr;

console.log('selftest ok');
