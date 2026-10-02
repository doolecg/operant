const test = require('node:test');
const assert = require('node:assert/strict');
const { installCommand, decide } = require('../codegraph-install');

test('the install command is npm then codegraph install, chained per shell', () => {
  assert.equal(installCommand(true), 'npm i -g @colbymchenry/codegraph@latest && codegraph install');
  assert.equal(installCommand(false), 'npm i -g @colbymchenry/codegraph@latest; if ($?) { codegraph install }');
});

test('a follow-up command runs only when the install worked', () => {
  assert.equal(installCommand(true, 'echo hi'), 'npm i -g @colbymchenry/codegraph@latest && codegraph install && echo hi');
  assert.equal(installCommand(false, 'echo hi'), 'npm i -g @colbymchenry/codegraph@latest; if ($?) { codegraph install; if ($?) { echo hi } }');
});

const base = { enabled: true, installed: false, npm: true, tried: null, version: '2.7.5' };

test('a missing CodeGraph with npm is installed; without npm the user is told', () => {
  assert.equal(decide(base), 'install');
  assert.equal(decide({ ...base, npm: false }), 'no-npm');
});

test('nothing happens when the setting is off or CodeGraph is there', () => {
  assert.equal(decide({ ...base, enabled: false }), null);
  assert.equal(decide({ ...base, installed: true }), null);
});

test('an attempt is not repeated on the same version, but is after an upgrade', () => {
  assert.equal(decide({ ...base, tried: { version: '2.7.5', npm: true } }), null);
  assert.equal(decide({ ...base, tried: { version: '2.7.5', npm: false }, npm: false }), null);
  assert.equal(decide({ ...base, tried: { version: '2.7.4', npm: true } }), 'install');
  assert.equal(decide({ ...base, tried: { version: '2.7.4', npm: false }, npm: false }), 'no-npm');
});

test('an attempt that found no npm is made again once npm is there', () => {
  assert.equal(decide({ ...base, tried: { version: '2.7.5', npm: false } }), 'install');
});
