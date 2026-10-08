import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildBrief } from './brief'
import { buildClaudeRunLaunch } from './launch'
import { McpError, McpService, maskArg, maskUrl, parseClaudeList, parseOpencodeList, redact, stripJsonc, type McpDeps } from './mcp'
import { Store } from './store'
import type { McpServerInput } from '../shared/types'

// A project folder built with the platform's separator, so the fake config files match on every OS.
const folder = join('/code', 'shop')
const folderKey = folder.replace(/\\/g, '/')

// Output as `claude mcp list` and `opencode mcp list` printed it on the machine this was built on.
const CLAUDE_LIST = `Checking MCP server health…

claude.ai Claude Docs: https://api.anthropic.com/v1/pages/mcp - ✔ Connected
claude.ai Mem0: https://mcp.mem0.ai/mcp - ! Needs authentication
plugin:playwright:playwright: npx @playwright/mcp@latest - ✔ Connected
idea: http://127.0.0.1:64342/stream (HTTP) - ✘ Failed to connect — ECONNREFUSED: ECONNREFUSED: Unable to connect. Is the computer able to access the url?
codegraph: codegraph serve --mcp - ✔ Connected
hindsight: node C:\\Users\\Dayle Frost\\.hindsight\\mcp-server.js - ✔ Connected
secretive: npx srv --token=sk-live-123456789012 - ✘ Failed to connect — 401 for sk-live-123456789012
`
// Captured from opencode 2.0.24 against a throwaway config (the failure message wraps onto a second line).
const OPENCODE_LIST =
  "✗ badcmd     failed: Connection closed: MCP server process exited with code 1: 'nonexistent-cmd-xyz' is not recognized as an internal or external command,\r\n" +
  'operable program or batch file.\r\n' +
  '✓ codegraph  connected\r\n' +
  '⚠ needauth   needs authentication\r\n' +
  '○ off        disabled\r\n' +
  '○ okcmd      pending\r\n' +
  '✗ remotebad  failed: Unable to connect. Is the computer able to access the url? (ConnectionRefused)\r\n'

const SECRET = 'sk-live-123456789012'

interface Call {
  cmd: string
  args: string[]
  cwd?: string
}

function setup(over: { claude?: object; project?: object; opencode?: string; listOut?: string; failAdd?: boolean } = {}) {
  const files = new Map<string, string>()
  files.set(
    '/h/.claude.json',
    JSON.stringify({
      mcpServers: {
        codegraph: { type: 'stdio', command: 'codegraph', args: ['serve', '--mcp'] },
        secretive: { type: 'stdio', command: 'npx', args: ['srv', `--token=${SECRET}`], env: { API_KEY: SECRET } },
        remote: { type: 'http', url: `https://x.test/mcp?api_key=${SECRET}`, headers: { Authorization: `Bearer ${SECRET}` } },
      },
      projects: { [folderKey]: { mcpServers: { local1: { command: 'node', args: ['a.js'] } }, disabledMcpServers: ['remote'] } },
      ...over.claude,
    }),
  )
  if (over.opencode !== undefined) files.set('/h/opencode.jsonc', over.opencode)
  files.set(join(folder, '.mcp.json'), JSON.stringify({ mcpServers: { proj: { command: 'p' } }, ...over.project }))
  const calls: Call[] = []
  const logs: string[] = []
  const deps: Partial<McpDeps> = {
    claudeConfig: '/h/.claude.json',
    opencodeGlobal: ['/h/opencode.jsonc'],
    readFile: (p) => files.get(p) ?? null,
    writeFile: (p, t) => void files.set(p, t),
    run: async (cmd, args, o) => {
      calls.push({ cmd, args, cwd: o.cwd })
      if (args[1] === 'list') return cmd === 'claude' ? { code: 0, stdout: over.listOut ?? CLAUDE_LIST, stderr: '' } : { code: 0, stdout: OPENCODE_LIST, stderr: '' }
      if (over.failAdd && args[1] === 'add') return { code: 1, stdout: '', stderr: `invalid ${SECRET}` }
      return { code: 0, stdout: '', stderr: '' }
    },
  }
  const svc = new McpService({ log: (m) => logs.push(m), builtin: async (n) => ({ ok: n === 'codegraph', error: 'down' }), now: () => 1000 }, deps)
  return { svc, files, calls, logs }
}

describe('parsing real CLI output', () => {
  it('reads every Claude status line, with the error and plugin and connector names', () => {
    const m = parseClaudeList(CLAUDE_LIST)
    expect(m.get('claude.ai Mem0')).toMatchObject({ state: 'needs-auth' })
    expect(m.get('plugin:playwright:playwright')).toMatchObject({ state: 'connected', target: 'npx @playwright/mcp@latest' })
    expect(m.get('idea')).toMatchObject({ state: 'failed' })
    expect(m.get('idea')!.error).toMatch(/^ECONNREFUSED/)
    expect(m.get('hindsight')!.target).toContain('Dayle Frost')
    expect(m.size).toBe(7)
  })
  it('reads the disabled and pending-approval lines of Claude 2.1.292', () => {
    const m = parseClaudeList(
      'userv: node -e 1 - ⊘ Disabled for this project (re-enable via /mcp)\npserv: node -e 1 - ⏸ Pending approval (run `claude` to approve)\n',
    )
    expect(m.get('userv')).toMatchObject({ state: 'disabled', target: 'node -e 1' })
    expect(m.get('pserv')!.state).toBe('pending')
  })
  it('reads OpenCode status lines', () => {
    const m = parseOpencodeList(OPENCODE_LIST)
    expect(m.get('codegraph')!.state).toBe('connected')
    expect(m.get('badcmd')).toMatchObject({ state: 'failed', error: expect.stringMatching(/^Connection closed.*batch file\.$/) })
    expect(m.get('remotebad')).toMatchObject({ state: 'failed', error: 'Unable to connect. Is the computer able to access the url? (ConnectionRefused)' })
    expect(m.get('off')!.state).toBe('disabled')
    expect(m.get('okcmd')!.state).toBe('pending')
    expect(m.get('needauth')!.state).toBe('needs-auth')
    expect(m.size).toBe(6)
  })
  it('reads the "No MCP servers configured" line as an empty list', () => {
    expect(parseOpencodeList('No MCP servers configured\r\n').size).toBe(0)
  })
  it('strips JSONC comments and trailing commas but not text inside strings', () => {
    expect(JSON.parse(stripJsonc('{ // c\n "a": "x // y", /* z */ "b": [1,], }'))).toEqual({ a: 'x // y', b: [1] })
  })
})

describe('masking', () => {
  it('masks secret flags, bearer tokens, URL query and userinfo', () => {
    expect(maskArg('--token=abc')).toBe('--token=***')
    expect(maskArg('abc', '--api-key')).toBe('***')
    expect(maskArg('Bearer abc123')).toBe('Bearer ***')
    expect(maskArg('--port=80')).toBe('--port=80')
    expect(maskUrl('https://u:p@x.test/a?api_key=1&q=2')).toBe('https://***@x.test/a?api_key=***&q=2')
    expect(redact(`bad ${SECRET} Bearer zzz`, [SECRET])).toBe('bad *** Bearer ***')
  })
})

describe('McpService.list', () => {
  it('merges scopes with statuses and never returns a secret value', async () => {
    const { svc } = setup()
    const o = await svc.list(folder)
    const by = (n: string) => o.servers.find((s) => s.name === n)!
    expect(by('codegraph')).toMatchObject({ scope: 'user', state: 'connected', builtin: true, editable: true })
    expect(by('local1').scope).toBe('local')
    expect(by('proj').scope).toBe('project')
    expect(by('remote').state).toBe('disabled')
    expect(by('idea').editable).toBe(false)
    expect(o.servers.find((s) => s.name === 'plugin:playwright:playwright')!.scope).toBe('plugin')
    expect(o.servers.find((s) => s.name === 'claude.ai Mem0')!.scope).toBe('connector')
    expect(by('hindsight')).toMatchObject({ scope: 'other', state: 'connected', builtin: true, editable: false })
    expect(by('secretive')).toMatchObject({ state: 'failed', env: { API_KEY: '***' } })
    expect(by('secretive').error).not.toContain(SECRET)
    expect(by('remote').headers).toEqual({ Authorization: '***' })
    expect(JSON.stringify(o)).not.toContain(SECRET)
    expect(o.installed).toEqual({ claude: true, opencode: true })
  })

  it('lists the built-in servers when no config has them, with their own status', async () => {
    const { svc } = setup({ listOut: CLAUDE_LIST.replace(/^hindsight.*$/m, '') })
    const o = await svc.list(folder)
    expect(o.servers.find((s) => s.name === 'hindsight')).toMatchObject({ scope: 'builtin', state: 'failed', error: 'down', editable: false, builtin: true })
  })

  it('keeps servers listed with an unknown status when the check times out', async () => {
    const { svc } = setup()
    const slow = new McpService({}, { claudeConfig: '/h/.claude.json', opencodeGlobal: [], readFile: (p) => (p === '/h/.claude.json' ? JSON.stringify({ mcpServers: { a: { command: 'a' } } }) : null), writeFile: () => {}, run: async () => ({ code: null, stdout: '', stderr: 'timed out' }) })
    void svc
    const o = await slow.list(null)
    expect(o.servers[0]).toMatchObject({ name: 'a', state: 'unknown', error: 'status check timed out' })
  })

  it('reports a CLI that is not installed', async () => {
    const svc = new McpService({}, { claudeConfig: '/h/.claude.json', opencodeGlobal: [], readFile: () => null, writeFile: () => {}, run: async () => ({ code: null, stdout: '', stderr: 'spawn claude ENOENT' }) })
    expect((await svc.list(null)).installed).toEqual({ claude: false, opencode: false })
  })

  it('reads OpenCode servers from mcp.servers, and from the flat layout', async () => {
    const a = setup({ opencode: '{ // c\n "mcp": { "servers": { "codegraph": { "type": "local", "command": ["codegraph","serve"], "disabled": false }, "off": { "type": "remote", "url": "https://r.test", "headers": {"X-Key":"k1234"}, "disabled": true } } } }' })
    const o = await a.svc.list(null)
    expect(o.servers.find((s) => s.cli === 'opencode' && s.name === 'off')).toMatchObject({ scope: 'global', state: 'disabled', transport: 'http', headers: { 'X-Key': '***' } })
    expect(o.servers.find((s) => s.cli === 'opencode' && s.name === 'codegraph')).toMatchObject({ state: 'connected', target: 'codegraph serve' })
    const b = setup({ opencode: '{ "mcp": { "flat": { "type": "local", "command": ["x"] } } }' })
    expect((await b.svc.list(null)).servers.some((s) => s.cli === 'opencode' && s.name === 'flat')).toBe(true)
  })
})

describe('changing servers', () => {
  const stdio: McpServerInput = { name: 'new1', cli: 'claude', scope: 'user', transport: 'stdio', command: 'npx', args: ['srv'], env: { API_KEY: SECRET } }

  it('adds through claude mcp add and masks the secret in the log', async () => {
    const { svc, calls, logs } = setup()
    await svc.add(folder, stdio)
    const add = calls.find((c) => c.args[1] === 'add')!
    expect(add.args).toEqual(['mcp', 'add', 'new1', '-s', 'user', '-t', 'stdio', '-e', `API_KEY=${SECRET}`, '--', 'npx', 'srv'])
    expect(logs.join('\n')).toContain('new1 added')
    expect(logs.join('\n')).not.toContain(SECRET)
  })

  it('adds an http server with headers, and an OpenCode server through its own command', async () => {
    const { svc, calls } = setup()
    await svc.add(folder, { name: 'r2', cli: 'claude', scope: 'project', transport: 'http', url: 'https://a.test/mcp', headers: { 'X-Key': 'v' } })
    expect(calls.find((c) => c.args[1] === 'add')).toMatchObject({ args: ['mcp', 'add', '-t', 'http', '-s', 'project', 'r2', 'https://a.test/mcp', '-H', 'X-Key: v'], cwd: folder })
    await svc.add(folder, { name: 'oc', cli: 'opencode', scope: 'global', transport: 'stdio', command: 'x', args: ['y'], env: { K: 'v' } })
    expect(calls.filter((c) => c.cmd === 'opencode' && c.args[1] === 'add')[0]!.args).toEqual(['mcp', 'add', '--global', '--env', 'K=v', 'oc', '--', 'x', 'y'])
  })

  it('refuses bad input before running anything', async () => {
    const { svc, calls } = setup()
    for (const bad of [{ ...stdio, name: 'a b' }, { ...stdio, scope: 'global' as const }, { ...stdio, command: '' }, { ...stdio, env: { 'bad key': 'x' } }, { ...stdio, env: { K: 'a"b' } }, { name: 'u', cli: 'claude' as const, scope: 'user' as const, transport: 'http' as const, url: 'ftp://x' }]) {
      await expect(svc.add(folder, bad)).rejects.toBeInstanceOf(McpError)
    }
    await expect(svc.add(null, { ...stdio, scope: 'project' })).rejects.toThrow(/project first/)
    expect(calls.filter((c) => c.args[1] === 'add')).toEqual([])
  })

  it('refuses a name that exists in the scope', async () => {
    const { svc } = setup()
    await expect(svc.add(folder, { ...stdio, name: 'secretive' })).rejects.toThrow(/already exists/)
  })

  it('does not leak a secret from a failing CLI', async () => {
    const { svc } = setup({ failAdd: true })
    const err = await svc.add(folder, stdio).catch((e: Error) => e)
    expect((err as Error).message).toMatch(/claude mcp failed \(exit 1\)/)
    expect((err as Error).message).not.toContain(SECRET)
  })

  it('edits by remove then add, keeping a masked value, and restores the old server when the add fails', async () => {
    const { svc, calls } = setup()
    await svc.update(folder, 'claude:user:secretive', { name: 'secretive', cli: 'claude', scope: 'user', transport: 'stdio', command: 'npx', args: ['srv2'], env: { API_KEY: '***' } })
    const add = calls.find((c) => c.args[1] === 'add')!
    expect(calls.find((c) => c.args[1] === 'remove')!.args).toEqual(['mcp', 'remove', '-s', 'user', 'secretive'])
    expect(add.args).toContain(`API_KEY=${SECRET}`)
    const f = setup({ failAdd: true })
    await expect(f.svc.update(folder, 'claude:user:secretive', { name: 'secretive', cli: 'claude', scope: 'user', transport: 'stdio', command: 'npx', args: ['x'], env: { API_KEY: '***' } })).rejects.toThrow()
    expect(f.calls.filter((c) => c.args[1] === 'add')).toHaveLength(2)
  })

  it('removes through the CLI (Claude) and the config file (OpenCode, with a backup)', async () => {
    const { svc, calls, files } = setup({ opencode: '{ "mcp": { "servers": { "gone": { "type": "local", "command": ["x"] }, "stay": { "type": "local", "command": ["y"] } } } }' })
    await svc.remove(folder, 'claude:project:proj')
    expect(calls.find((c) => c.args[1] === 'remove')!.args).toEqual(['mcp', 'remove', '-s', 'project', 'proj'])
    await svc.remove(folder, 'opencode:global:gone')
    expect(Object.keys(JSON.parse(files.get('/h/opencode.jsonc')!).mcp.servers)).toEqual(['stay'])
    expect(files.get('/h/opencode.jsonc.operant-backup')).toContain('gone')
  })

  it('disables and enables OpenCode and Claude servers in their config', async () => {
    const { svc, files } = setup({ opencode: '{ "mcp": { "servers": { "a": { "type": "local", "command": ["x"] } } } }' })
    await svc.setEnabled(folder, 'opencode:global:a', false)
    expect(JSON.parse(files.get('/h/opencode.jsonc')!).mcp.servers.a.disabled).toBe(true)
    await svc.setEnabled(folder, 'opencode:global:a', true)
    expect(JSON.parse(files.get('/h/opencode.jsonc')!).mcp.servers.a.disabled).toBeUndefined()
    await svc.setEnabled(folder, 'claude:user:codegraph', false)
    expect(JSON.parse(files.get('/h/.claude.json')!).projects[folderKey].disabledMcpServers).toEqual(['remote', 'codegraph'])
    await svc.setEnabled(folder, 'claude:project:proj', false)
    const approval = () => JSON.parse(files.get(join(folder, '.claude', 'settings.local.json'))!)
    expect(approval()).toEqual({ disabledMcpjsonServers: ['proj'], enabledMcpjsonServers: [] })
    expect(JSON.parse(files.get('/h/.claude.json')!).projects[folderKey].disabledMcpjsonServers).toBeUndefined()
    expect((await svc.list(folder)).servers.find((x) => x.id === 'claude:project:proj')!.state).toBe('disabled')
    await svc.setEnabled(folder, 'claude:project:proj', true)
    expect(approval()).toEqual({ disabledMcpjsonServers: [], enabledMcpjsonServers: ['proj'] })
  })
})

describe('seats and degraded jobs', () => {
  it('names the down servers once with the seats that need them, and a missing one only when asked', async () => {
    const { svc } = setup()
    const needs = [
      { seat: 'pm', servers: ['codegraph', 'idea', 'ghost'] },
      { seat: 'dev', servers: ['idea'] },
    ]
    const down = await svc.down(needs, folder)
    expect(down).toEqual([{ server: 'idea', state: 'failed', error: expect.stringMatching(/ECONNREFUSED/), seats: ['pm', 'dev'] }])
    const withMissing = await svc.down(needs, folder, { fresh: true, includeMissing: true })
    expect(withMissing.map((d) => [d.server, d.state])).toEqual([['idea', 'failed'], ['ghost', 'missing']])
  })

  it('builds the Claude launch config from the picked servers only, with real values, and starts when one is down', async () => {
    const { svc } = setup()
    const r = await svc.forRun([{ seat: 'pm', servers: ['codegraph', 'secretive', 'idea'] }], 'claude', folder)
    const cfg = JSON.parse(r.claudeConfig!)
    expect(Object.keys(cfg.mcpServers)).toEqual(['codegraph', 'secretive'])
    expect(cfg.mcpServers.secretive.env.API_KEY).toBe(SECRET)
    expect(r.down.map((d) => d.server).sort()).toEqual(['idea', 'secretive'])
    expect((await svc.forRun([], 'claude', folder)).claudeConfig).toBeNull()
  })

  it('turns off the OpenCode servers the seats did not pick', async () => {
    const { svc } = setup({ opencode: '{ "mcp": { "servers": { "a": { "type": "local", "command": ["x"] }, "b": { "type": "local", "command": ["y"] } } } }' })
    const r = await svc.forRun([{ seat: 'pm', servers: ['a'] }], 'opencode', null)
    expect(JSON.parse(r.opencodeEnv!.OPENCODE_CONFIG_CONTENT!)).toEqual({ mcp: { servers: { b: { disabled: true } } } })
  })

  it('passes the config file to claude -p with --strict-mcp-config', () => {
    const l = buildClaudeRunLaunch({ cwd: '/p', mcpConfig: '/d/run-1-mcp.json' })
    expect(l.args.slice(-3)).toEqual(['--strict-mcp-config', '--mcp-config', '/d/run-1-mcp.json'])
    expect(buildClaudeRunLaunch({ cwd: '/p' }).args).not.toContain('--mcp-config')
  })
})

describe('brief and seat data', () => {
  let store: Store
  beforeEach(() => {
    store = new Store(':memory:')
  })
  afterEach(() => store.close())

  it('names a down server in the brief and still builds it', async () => {
    const crewId = store.createCrew('shop', '/code/shop').id
    const run = store.createRun({ crewId, task: 'do it', masterCli: 'claude', teamId: null, seats: [], limits: { maxWorkers: 0, topTier: '', tokenBudget: 0 }, rules: '' })
    const b = await buildBrief(
      {
        store,
        explorer: { explore: async () => ({ ok: true, text: 'src' }) },
        hindsight: { recall: async () => ({ ok: true, items: [] }) },
        mcpDown: async () => [{ server: 'idea', state: 'failed', error: 'ECONNREFUSED', seats: ['pm'] }],
      },
      run,
    )
    expect(b.text).toMatch(/MCP servers down: idea failed \(ECONNREFUSED\), needed by pm\. The job is starting anyway/)
    const ok = await buildBrief({ store, explorer: { explore: async () => ({ ok: true, text: '' }) }, hindsight: { recall: async () => ({ ok: true, items: [] }) }, mcpDown: async () => { throw new Error('x') } }, run)
    expect(ok.text).not.toContain('MCP servers down')
  })

  it('keeps mcpServers and the older mcp, codegraph and hindsight fields in step', () => {
    const p = store.createPreset({ name: 'a', agent: 'claude', model: 'm', permissionMode: 'dontAsk' })
    expect(p.mcpServers).toEqual(['codegraph', 'hindsight'])
    expect(store.updatePreset(p.id, { mcpServers: ['hindsight', 'idea'] })).toMatchObject({ codegraph: false, hindsight: true, mcp: 'none', mcpServers: ['hindsight', 'idea'] })
    expect(store.updatePreset(p.id, { codegraph: true })).toMatchObject({ mcp: 'codegraph', mcpServers: ['hindsight', 'idea', 'codegraph'] })
    expect(store.updatePreset(p.id, { mcp: 'none', hindsight: false })).toMatchObject({ codegraph: false, hindsight: false, mcpServers: ['idea'] })
    const old = store.createPreset({ name: 'b', agent: 'claude', model: 'm', permissionMode: 'dontAsk', mcp: 'none', hindsight: false })
    expect(old).toMatchObject({ mcpServers: [], codegraph: false, hindsight: false })
  })
})
