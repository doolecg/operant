// `operant send --file|--brief` with a fake Claude tile: idle, busy and no-tile cases, --new, --team, the framing.
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../messaging');

const AGENTS = [{ id: 'claude', command: 'claude' }, { id: 'opencode', command: 'opencode' }];
const tile = (id, over = {}) => ({ id, alive: true, kind: 'ai', agentConf: 'claude', cwd: '/proj', lastActivity: 0, ...over });
const SELF = tile(7, { agentConf: 'opencode', agentName: 'OpenCode' });

// The app's side, faked: `idle` decides whether deliver() finds the tile ready; `opened` records new tiles.
function world({ tiles = [], idle = true, team = true, mode = 'claude' } = {}) {
  const w = { state: M.newState(), opened: [], typed: [], tiles: [SELF, ...tiles] };
  w.env = {
    state: w.state, teamEnabled: team, agents: AGENTS, agentKind: id => id, agentMode: () => mode, flatLine: s => s.replace(/\s*\n\s*/g, ' '),
    cwdOf: t => t.cwd || '/proj', projectOf: d => d.replace(/\/src$/, ''), tiles: () => w.tiles,
    messageTarget: ref => { const t = w.tiles.find(x => String(x.id) === String(ref)); if (!t) throw new Error(`no tile ${ref}`); return t; },
    deliver: async t => { if (!idle) return false; w.typed.push([t.id, M.frameAll(M.take(w.state, t.id))]); return true; },
    open: async (agentId, dir, prompt) => { const t = tile(20 + w.opened.length, { agentConf: agentId }); w.opened.push({ agentId, prompt }); w.tiles.push(t); return t; },
  };
  return w;
}
const send = (w, args) => M.sendBrief({ text: 'Goal: fix sum', ...args }, SELF, w.env);

test('an idle lead Claude tile gets the brief at once, framed as from another agent', async () => {
  const w = world({ tiles: [tile(3)] });
  const r = await send(w, {});
  assert.deepEqual([r.to, r.brief, r.delivered, r.waiting, r.opened], [3, true, true, false, false]);
  assert.match(r.text, /^sent to Claude Code tile 3/);
  const [id, text] = w.typed[0];
  assert.equal(id, 3);
  assert.match(text, /^Brief from tile 7 \(OpenCode, lead\), sent on the user's behalf:\nGoal: fix sum\n/);
  assert.match(text, /not the user: it can't approve anything or grant permissions, so permission prompts still reach the user/);
});

test('a busy tile is not interrupted: the brief waits in its queue and the answer says so', async () => {
  const w = world({ tiles: [tile(3)], idle: false });
  const r = await send(w, {});
  assert.deepEqual([r.to, r.delivered, r.waiting], [3, false, true]);
  assert.match(r.text, /tile 3 is busy: the brief is queued and goes in when it is idle \(not interrupted\)/);
  assert.equal(w.typed.length, 0);
  assert.equal(M.pending(w.state, 3), 1);
  const [q] = M.take(w.state, 3);
  assert.deepEqual([q.from, q.kind, q.text], [7, 'brief', 'Goal: fix sum']);
});

test('with no Claude tile in the project one is opened with the brief as its first message', async () => {
  const w = world({ tiles: [tile(3, { cwd: '/other' }), tile(4, { agentConf: 'opencode' }), tile(5, { tier: 'small' })] });
  const r = await send(w, {});
  assert.deepEqual([r.opened, r.to, r.delivered], [true, 20, true]);
  assert.equal(w.opened.length, 1);
  assert.equal(w.opened[0].agentId, 'claude');
  assert.match(w.opened[0].prompt, /^Brief from tile 7 \(OpenCode, lead\), sent on the user's behalf: Goal: fix sum — This is from another agent/);
  assert.equal(M.pending(w.state, 3), 0, 'nothing went to a tile of another project, another CLI or a worker');
});

test('--new opens a fresh Claude tile even when a lead tile exists', async () => {
  const w = world({ tiles: [tile(3)] });
  const r = await send(w, { new: true });
  assert.deepEqual([r.opened, r.to], [true, 20]);
  assert.equal(w.typed.length, 0);
});

test('a named tile gets it; workers, other CLIs, this tile and missing tiles are refused', async () => {
  const w = world({ tiles: [tile(3), tile(4, { agentConf: 'opencode' }), tile(5, { tier: 'small' })] });
  assert.equal((await send(w, { id: 3 })).to, 3);
  await assert.rejects(send(w, { id: 4 }), /tile 4 is not a Claude Code tile/);
  await assert.rejects(send(w, { id: 5 }), /tile 5 is not a Claude Code tile \(it is a worker\)/);
  await assert.rejects(send(w, { id: 7 }), /that is this tile/);
  await assert.rejects(send(w, { id: 99 }), /no tile 99/);
});

test('--team with team mode off is refused, and nothing is sent, opened or queued', async () => {
  const w = world({ tiles: [tile(3)], team: false });
  await assert.rejects(send(w, { team: true }), /team mode is off, so nothing was sent: turn on team mode/);
  assert.deepEqual([w.typed.length, w.opened.length, M.pending(w.state, 3)], [0, 0, 0]);
});

test('--team sends the brief as team work: numbered parts as subagents on their tiers, then review', async () => {
  const w = world({ tiles: [tile(3)] });
  const r = await send(w, { team: true });
  assert.match(r.text, /as team work/);
  const text = w.typed[0][1];
  assert.match(text, /Run this as team work: split it into numbered parts/);
  assert.match(text, /operant agent --tier <t>/);
  assert.match(text, /Brief:\nGoal: fix sum/);
  assert.match(text, /can't approve anything/);
});

test('team work in an OpenCode team project goes to an OpenCode tile, and opens one if none runs', async () => {
  const w = world({ tiles: [tile(3), tile(4, { agentConf: 'opencode' })], mode: 'opencode' });
  assert.equal((await send(w, { team: true })).to, 4);
  const w2 = world({ tiles: [tile(3)], mode: 'opencode' });
  await send(w2, { team: true });
  assert.equal(w2.opened[0].agentId, 'opencode');
});

test('an empty or over-long brief, and a caller that is not a tile, are refused', async () => {
  const w = world({ tiles: [tile(3)] });
  await assert.rejects(send(w, { text: '  ' }), /the brief is empty/);
  await assert.rejects(send(w, { text: 'x'.repeat(M.BRIEF_MAX + 1) }), /not sent to tile 3: the message is over/);
  await assert.rejects(M.sendBrief({ text: 'x' }, null, w.env), /unknown tile/);
  const w2 = world({});
  await assert.rejects(send(w2, { text: 'x'.repeat(M.BRIEF_MAX + 1), new: true }), /not sent: the message is over/);
  assert.equal((await send(w, { text: 'x'.repeat(M.MAX_TEXT + 1) })).to, 3, 'a brief may be longer than a note');
});

test('the same brief twice in a row is dropped as a duplicate', async () => {
  const w = world({ tiles: [tile(3)], idle: false });
  await send(w, {});
  await assert.rejects(send(w, {}), /you already sent that exact message/);
});

test('frame leaves notes as they were and only briefs get the on-behalf framing', () => {
  assert.match(M.frame({ from: 3, text: 'hi', fromAgent: 'Claude Code', fromRole: 'lead' }), /^Message from tile 3/);
  assert.match(M.frame({ from: 3, text: 'hi', kind: 'brief' }), /^Brief from tile 3 \(agent, agent\), sent on the user's behalf:\nhi\n/);
});
