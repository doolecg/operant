// Tests for the 2.7 additions: pods, team templates and the ready check.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../seats.js');
const M = require('../messaging.js');
const R = require('../ready-check.js');

const T0 = 1700000000000;
const fresh = () => S.defaultSeats(T0);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pods-'));

test('default pods: feature and research, stored once with their seats', () => {
  const st = fresh();
  assert.deepEqual(st.pods.map(p => [p.id, p.seatIds]), [['feature', ['planner', 'implementer', 'reviewer', 'tester']], ['research', ['explorer', 'docs']]]);
  assert.equal(S.podOf(st, 'tester').id, 'feature');
  assert.equal(S.podOf(st, 'hard-1'), null);
  assert.ok(st.seats.every(s => !('brief' in s) && s.podId === null));
});

test('pod brief is set once and reaches a launch once, by reference plus the text', () => {
  const st = fresh();
  S.setPodBrief(st, 'feature', 'Use CodeGraph first. Never commit.');
  const b = S.launchBrief(st, 'planner');
  assert.match(b, /^Pod "feature" \(planner, implementer, reviewer, tester\) shares the brief below/);
  assert.equal(b.split('Use CodeGraph first').length, 2);
  assert.match(b, /You hold the "planner" seat/);
  assert.equal(S.launchBrief(st, 'hard-1'), S.brief(S.find(st, 'hard-1')));
  assert.equal(JSON.stringify(st.seats).includes('CodeGraph'), false);
  assert.throws(() => S.setPodBrief(st, 'nope', 'x'), /no pod/);
  assert.equal(S.setPodBrief(st, 'feature', 'x'.repeat(5000)).brief.length, S.CAPS.podBrief);
});

test('take binds the seat to its pod; an explicit pod wins; pods survive save and load', () => {
  const dir = tmp();
  S.update(dir, st => { S.setPodBrief(st, 'research', 'facts'); S.take(st, 'explorer', { tileId: 4 }); S.take(st, 'docs', { tileId: 5, podId: 'feature' }); }, T0);
  const st = S.load(dir, T0);
  assert.equal(S.find(st, 'explorer').podId, 'research');
  assert.equal(S.find(st, 'docs').podId, 'feature');
  assert.equal(S.findPod(st, 'research').brief, 'facts');
});

test('normalize: pods are cleaned and the defaults added back', () => {
  const st = S.normalize({ schema: 1, seats: [{ id: 'planner' }], pods: [{ id: 'mine', name: 'Mine', brief: ' hi ', seatIds: ['planner', 'ghost', 'planner'] }, { id: 'BAD' }, null] }, T0);
  assert.deepEqual(S.findPod(st, 'mine'), { id: 'mine', name: 'Mine', brief: 'hi', seatIds: ['planner'] });
  assert.ok(S.findPod(st, 'feature') && S.findPod(st, 'research') && !S.findPod(st, 'BAD'));
  assert.ok(S.normalize({ schema: 1, seats: [] }, T0).pods.length >= 2);
  assert.match(S.formatPods(fresh()), /^feature {2}feature {2}seats: planner, implementer, reviewer, tester\n {2}brief: /);
});

test('templates: shipped defaults use cheap tiers and no medium seat', () => {
  const list = S.loadTemplates(tmp());
  assert.deepEqual(list.map(t => t.name), ['feature team', 'review team']);
  assert.deepEqual(S.findTemplate(list, 'Feature Team').seats.map(e => [e.seat, e.tier]), [['planner', 'small'], ['implementer', 'small'], ['reviewer', 'xsmall'], ['tester', 'free']]);
  for (const t of list) assert.ok(t.seats.every(e => !['medium', 'high', 'max'].includes(e.tier)), t.name);
});

test('templates: save from current seats, reload, override a default, reject bad input', () => {
  const userDir = tmp(), st = fresh();
  assert.throws(() => S.templateFromSeats(st, 'x'), /no seats are in use/);
  S.take(st, 'planner', { tileId: 1 }); S.take(st, 'explorer', { tileId: 2 }); S.setTier(st, 'explorer', 'free'); S.setPodBrief(st, 'research', 'r-brief');
  const t = S.saveTemplate(userDir, S.templateFromSeats(st, 'my team'));
  assert.deepEqual(t.seats, [{ seat: 'planner', tier: 'small' }, { seat: 'explorer', tier: 'free' }]);
  assert.deepEqual(t.podBriefs, { research: 'r-brief' });
  assert.deepEqual(S.loadTemplates(userDir).map(x => x.name), ['feature team', 'review team', 'my team']);
  S.saveTemplate(userDir, { name: 'Feature Team', seats: [{ seat: 'planner', tier: 'free' }] });
  assert.deepEqual(S.loadTemplates(userDir).map(x => x.name), ['review team', 'my team', 'Feature Team']);
  assert.throws(() => S.saveTemplate(userDir, { name: '' }), /needs a name/);
  fs.writeFileSync(S.templatesFile(userDir), '{not json');
  assert.equal(S.loadTemplates(userDir).length, 2);
  assert.deepEqual(S.normalizeTemplate({ name: 'a', seats: [{ seat: 'x', tier: 'bogus', budget: 5.7 }, { seat: 'BAD' }, { seat: 'x' }] }).seats, [{ seat: 'x', tier: 'small', budget: 5 }]);
});

test('template start marks seats ready and launches nothing', () => {
  const st = fresh();
  S.take(st, 'tester', { tileId: 9 });
  const tpl = { name: 'feature team', seats: [{ seat: 'planner', tier: 'free', budget: 1000 }, { seat: 'tester', tier: 'free' }, { seat: 'ghost', tier: 'small' }], podBriefs: { feature: 'be brief' } };
  const r = S.startTemplate(st, tpl);
  assert.deepEqual(r.ready, ['planner']);
  assert.deepEqual(r.skipped, ['tester (already active)', 'ghost (no such seat)']);
  const p = S.find(st, 'planner');
  assert.equal(p.readyFor, 'feature team'); assert.equal(p.tier, 'free'); assert.equal(p.budget, 1000);
  assert.equal(p.state, 'empty'); assert.equal(p.tileId, null);
  assert.equal(S.findPod(st, 'feature').brief, 'be brief');
  assert.equal(S.find(S.normalize(JSON.parse(JSON.stringify(st)), T0), 'planner').readyFor, 'feature team');
  S.take(st, 'planner', { tileId: 3 });
  assert.equal('readyFor' in S.find(st, 'planner'), false);
});

test('ready check: process, agent, prompt and busy, in that order', () => {
  const ok = { alive: true, ptyId: 3, started: true, working: false, waitingPrompt: false };
  assert.deepEqual(R.readyCheck(ok), { ready: true });
  assert.match(R.readyCheck(null).reason, /no tile/);
  assert.match(R.readyCheck({ ...ok, alive: false }).reason, /process is not running/);
  assert.match(R.readyCheck({ ...ok, ptyId: null }).reason, /process is not running/);
  assert.match(R.readyCheck({ ...ok, started: false }).reason, /agent has not started/);
  assert.match(R.readyCheck({ ...ok, waitingPrompt: true, working: true }).reason, /permission prompt/);
  assert.match(R.readyCheck({ ...ok, working: true }).reason, /busy/);
  assert.equal(S.readyCheck, R.readyCheck);
});

test('sendBrief: a seat tile that is not ready keeps the brief queued and says why', async () => {
  const state = M.newState(), self = { id: 1, kind: 'ai', alive: true };
  const w = { id: 2, alive: true, kind: 'ai', agentConf: 'claude', cwd: '/p', lastActivity: 0, notReady: 'its agent has not started yet' };
  const env = { state, teamEnabled: false, agents: [], agentKind: () => 'claude', agentMode: () => 'claude', messageTarget: () => w, deliver: async () => false, flatLine: s => s,
    cwdOf: t => t.cwd || '/p', projectOf: d => d, tiles: () => [w], open: async () => null, notReady: t => t.notReady };
  const r = await M.sendBrief({ text: 'Goal: x', id: 2 }, self, env);
  assert.equal(r.delivered, false);
  assert.match(r.text, /not ready \(its agent has not started yet\).*queued/);
  assert.equal(M.pending(state, 2), 1);
});
