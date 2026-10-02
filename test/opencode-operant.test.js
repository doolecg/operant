// Tests for hooks/opencode-operant.mjs: OpenCode sessions in a tile get the prime in their system
// prompt, subagent sessions the short brief, once per session and again after a compaction.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PLUGIN = pathToFileURL(path.join(__dirname, '..', 'hooks', 'opencode-operant.mjs')).href;

test('prime for sessions, the brief for subagents, refreshed after a compaction', async () => {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const { cmd, args } = JSON.parse(body);
      calls.push(cmd);
      const result = cmd === 'prime'
        ? { v: '1.19.0', role: 'lead', tile: { id: 4, kind: 'ai', agent: 'opencode' }, team: { enabled: false }, tiles: [], ports: [] }
        : {};
      res.end(JSON.stringify({ ok: true, result }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const saved = { ...process.env };
  Object.assign(process.env, { OPERANT: '1', OPERANT_API: `http://127.0.0.1:${server.address().port}`, OPERANT_TILE: '4' });
  try {
    const hooks = await (await import(PLUGIN)).default({ directory: __dirname });
    const system = async sessionID => { const out = { system: [] }; await hooks['experimental.chat.system.transform']({ sessionID }, out); return out.system; };

    const lead = await system('ses_lead');
    assert.equal(lead.length, 1);
    assert.match(lead[0], /lead agent in tile 4 \(OpenCode\)/);
    await system('ses_lead');
    assert.deepEqual(calls, ['prime'], 'worked out once per session');

    await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_child', parentID: 'ses_lead' } } } });
    const child = await system('ses_child');
    assert.match(child[0], /You're a subagent inside Operant/);

    await hooks.event({ event: { type: 'session.compacted', properties: { sessionID: 'ses_lead' } } });
    await system('ses_lead');
    assert.deepEqual(calls, ['prime', 'hook', 'prime']);

    assert.deepEqual(await system(undefined), [], 'title/summary calls get nothing');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    server.close();
  }
});

test('outside a tile the plugin has no hooks', async () => {
  const saved = process.env.OPERANT;
  delete process.env.OPERANT;
  try { assert.deepEqual(await (await import(PLUGIN)).default({ directory: __dirname }), {}); }
  finally { if (saved !== undefined) process.env.OPERANT = saved; }
});

test('the CodeGraph-first gate blocks a code grep until the session has made a CodeGraph call', async () => {
  const saved = { ...process.env };
  Object.assign(process.env, { OPERANT: '1', OPERANT_API: 'http://127.0.0.1:9', OPERANT_TILE: '4' });
  delete process.env.OPERANT_CODEGRAPH_GATE;
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'operant-gate-'));
  fs.mkdirSync(path.join(proj, '.codegraph'));
  try {
    const hooks = await (await import(PLUGIN)).default({ directory: proj });
    const before = (sessionID, tool, args) => hooks['tool.execute.before']({ tool, sessionID }, { args });
    await assert.rejects(before('a', 'grep', { pattern: 'notify' }), /codegraph explore "notify"/);
    await assert.rejects(before('a', 'bash', { command: 'rg notify' }), /CodeGraph index/);
    await before('a', 'grep', { pattern: 'x', include: '*.css' });
    await before('a', 'bash', { command: 'codegraph explore "notify"' });
    await before('a', 'grep', { pattern: 'notify' });
    await assert.rejects(before('b', 'grep', { pattern: 'notify' }), /CodeGraph index/, 'another session still has to ask');
    await before('b', 'codegraph_codegraph_explore', { query: 'x' });
    await before('b', 'grep', { pattern: 'notify' });
    process.env.OPERANT_CODEGRAPH_GATE = '0';
    await before('c', 'grep', { pattern: 'notify' });
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(proj, { recursive: true, force: true });
  }
});
