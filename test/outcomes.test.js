// Tests for outcomes.js: an append-only JSONL log, trimmed by age, summarised per type and tier.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const o = require('../outcomes.js');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'outcomes-')), 'outcomes.jsonl');
const DAY = 86400e3;

test('append and read back, skipping bad lines and old entries', () => {
  const f = tmp();
  o.appendOutcome(f, { t: 1000, taskId: 1 });
  fs.appendFileSync(f, 'not json\n');
  o.appendOutcome(f, { t: 5000, taskId: 2 });
  assert.deepEqual(o.readOutcomes(f).map(e => e.taskId), [1, 2]);
  assert.deepEqual(o.readOutcomes(f, { sinceMs: 2000 }).map(e => e.taskId), [2]);
  assert.deepEqual(o.readOutcomes(path.join(path.dirname(f), 'missing')), []);
});

test('trim drops old entries and rewrites only when needed', () => {
  const f = tmp(), now = 100 * DAY;
  o.appendOutcome(f, { t: now - 91 * DAY, taskId: 1 });
  o.appendOutcome(f, { t: now - DAY, taskId: 2 });
  assert.equal(o.trimOutcomes(f, 90 * DAY, now), 1);
  assert.deepEqual(o.readOutcomes(f).map(e => e.taskId), [2]);
  const before = fs.statSync(f).mtimeMs;
  assert.equal(o.trimOutcomes(f, 90 * DAY, now), 0);
  assert.equal(fs.statSync(f).mtimeMs, before);
});

test('summarize groups by type and tier', () => {
  const tok = n => ({ input: n, output: 0, cacheWrite: 0, cacheRead: 0 });
  const s = o.summarize([
    { type: 'fix', tier: 'small', status: 'escalated', usd: 0.1, tokens: tok(100) },
    { type: 'fix', tier: 'small', status: 'done', usd: 0.3, tokens: tok(300) },
    { type: 'fix', tier: 'medium', status: 'failed', usd: null, tokens: tok(50) },
    { type: 'docs', tier: 'small', status: 'done', usd: 0, tokens: tok(10) },
  ]);
  assert.deepEqual(s.fix.small, { n: 2, passed: 1, failed: 0, escalated: 1, avgUsd: 0.2, avgTokens: 200 });
  assert.equal(s.fix.medium.avgUsd, null);
  assert.equal(s.fix.medium.failed, 1);
  assert.equal(s.docs.small.avgUsd, 0);
});
