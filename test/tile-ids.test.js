const test = require('node:test');
const assert = require('node:assert/strict');
const { createIdPool, lowestFreeId, ID_HOLD_MS } = require('../renderer/tile-ids');

const clock = (t = 1000000) => ({ now: () => t, set: v => { t = v; }, add: v => { t += v; } });

test('lowestFreeId skips ids in use, held and referenced', () => {
  const now = 1000000;
  const released = new Map([[2, now - 1000], [4, now - ID_HOLD_MS]]);
  assert.equal(lowestFreeId({ inUse: new Set([1]), released, now }), 3);
  assert.equal(lowestFreeId({ inUse: new Set([1]), released, now, isReferenced: id => id === 3 }), 4);
  assert.equal(lowestFreeId({ inUse: new Set([1, 3]), released: new Map([[2, now - ID_HOLD_MS + 1]]), now }), 4);
});

test('a fresh pool counts up from 1', () => {
  const pool = createIdPool();
  assert.deepEqual([pool.take(), pool.take(), pool.take()], [1, 2, 3]);
});

test('a closed id is held for 5 minutes, then reused lowest first', () => {
  const c = clock();
  const pool = createIdPool({ now: c.now });
  pool.take(); pool.take(); pool.take();
  pool.release(2);
  assert.equal(pool.take(), 4);
  c.add(ID_HOLD_MS - 1);
  assert.equal(pool.take(), 5);
  c.add(1);
  assert.equal(pool.take(), 2);
  assert.equal(pool.take(), 6);
});

test('the hold is measured from the last close of that id', () => {
  const c = clock();
  const pool = createIdPool({ now: c.now });
  pool.take();
  pool.release(1);
  c.add(ID_HOLD_MS);
  assert.equal(pool.take(), 1);
  pool.release(1);
  c.add(1000);
  assert.equal(pool.take(), 2);
  c.add(ID_HOLD_MS);
  assert.equal(pool.take(), 1);
});

test('an id something still refers to is not reused, and is once that lets go', () => {
  const c = clock();
  const pool = createIdPool({ now: c.now });
  pool.take(); pool.take(); pool.take();
  pool.release(1); pool.release(2);
  c.add(ID_HOLD_MS);
  const refs = new Set([1]);
  assert.equal(pool.take(id => refs.has(id)), 2);
  pool.release(2);
  c.add(ID_HOLD_MS);
  refs.clear();
  assert.equal(pool.take(id => refs.has(id)), 1);
  assert.equal(pool.take(), 2);
});

test('releasing an id that is not active changes nothing', () => {
  const c = clock();
  const pool = createIdPool({ now: c.now });
  pool.take();
  pool.release(7);
  pool.release(1);
  pool.release(1);
  c.add(ID_HOLD_MS);
  assert.equal(pool.take(), 1);
});

test('a taken id is never handed out twice, even without a close', () => {
  const pool = createIdPool();
  const ids = Array.from({ length: 50 }, () => pool.take());
  assert.equal(new Set(ids).size, 50);
  assert.ok(pool.has(25));
});

test('ids taken while others are held stay small', () => {
  const c = clock();
  const pool = createIdPool({ now: c.now });
  for (let round = 0; round < 100; round++) {
    const id = pool.take();
    pool.release(id);
    c.add(ID_HOLD_MS);
  }
  assert.equal(pool.take(), 1);
});
