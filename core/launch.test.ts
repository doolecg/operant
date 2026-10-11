import { describe, expect, it } from 'vitest'
import { buildClaudeRunLaunch, buildScratchLaunch, commandLine, e2eClaudeModel, opencodeConfigContent, quoteArg, type LaunchContext } from './launch'
import type { ScratchTerminal } from '../shared/types'

const ctx: LaunchContext = {
  platform: 'linux',
  crewId: 1,
  crewFolder: '/code/shop',
  pluginDir: '/app/plugin',
  launchDir: '/tmp/launch',
  rolesDir: '/tmp/roles',
  sessionId: '6f1c0f1e-5a4b-4c3d-8e2f-123456789abc',
  operantCli: '/app/cli/operant',
  operantNode: '/app/operant',
}

const tile = (over: Partial<ScratchTerminal> = {}): ScratchTerminal => ({
  id: 7,
  crewId: 1,
  title: 'work',
  agent: 'claude',
  model: 'claude-sonnet-5-5',
  effort: '',
  presetId: null,
  cwd: '/code/shop',
  sessionId: null,
  view: 'terminal',
  createdAt: 0,
  ...over,
})

describe('tile launches', () => {
  it('passes one --plugin-dir per enabled native Claude mod, and none when there are none', () => {
    const on = buildScratchLaunch(tile(), { ...ctx, modPlugins: ['/app/plugin/mods/ideaShelf', '/app/plugin/mods/folderTracker'] })
    expect(on.args.filter((a) => a === '--plugin-dir')).toHaveLength(3)
    expect(on.args).toEqual(expect.arrayContaining(['/app/plugin/mods/ideaShelf', '/app/plugin/mods/folderTracker']))
    const off = buildScratchLaunch(tile(), { ...ctx, modPlugins: [] })
    expect(off.args.filter((a) => a === '--plugin-dir')).toHaveLength(1)
  })

  it('adds --mcp-config and a secret-free browser-mcp.json only when browserMcp is set', () => {
    const on = buildScratchLaunch(tile(), { ...ctx, browserMcp: { url: 'http://127.0.0.1:53817/mcp' } })
    const i = on.args.indexOf('--mcp-config')
    expect(on.args[i + 1]).toBe('/tmp/launch/browser-mcp.json')
    const f = on.files.find((x) => x.path === '/tmp/launch/browser-mcp.json')
    expect(JSON.parse(f?.content ?? '{}')).toEqual({
      mcpServers: { 'operant-browser': { type: 'http', url: 'http://127.0.0.1:53817/mcp', headers: { Authorization: 'Bearer ${OPERANT_TOKEN}' } } },
    })
    expect(f?.content).not.toContain('@@OPERANT_TOKEN@@')
    const off = buildScratchLaunch(tile(), ctx)
    expect(off.args).not.toContain('--mcp-config')
    expect(off.files.some((x) => x.path.endsWith('browser-mcp.json'))).toBe(false)
    const unsupported = buildScratchLaunch(tile(), { ...ctx, supported: new Set(['--model']), browserMcp: { url: 'http://127.0.0.1:1/mcp' } })
    expect(unsupported.args).not.toContain('--mcp-config')
  })

  it('gives OpenCode tiles the browser as a remote MCP server only when browserMcp is set, with no literal token', () => {
    const on = buildScratchLaunch(tile({ agent: 'opencode' }), { ...ctx, browserMcp: { url: 'http://127.0.0.1:53817/mcp' } })
    expect(on.files).toEqual([])
    const content = on.env.OPENCODE_CONFIG_CONTENT ?? ''
    expect(JSON.parse(content)).toEqual({
      mcp: { servers: { 'operant-browser': { type: 'remote', url: 'http://127.0.0.1:53817/mcp', headers: { Authorization: 'Bearer {env:OPERANT_TOKEN}' }, disabled: false } } },
    })
    expect(content).not.toContain('@@OPERANT_TOKEN@@')
    expect(on.env.OPENCODE_CLI_CONFIG_CONTENT).toBe(JSON.stringify({ tabs: { mode: 'off' } }))
    expect(on.env.OPERANT_TOKEN).toBe('@@OPERANT_TOKEN@@')
    const off = buildScratchLaunch(tile({ agent: 'opencode' }), ctx)
    expect(off.env).not.toHaveProperty('OPENCODE_CONFIG_CONTENT')
  })

  it('merges the browser MCP server into an existing OpenCode overlay', () => {
    const base = JSON.stringify({ mcp: { servers: { b: { disabled: true } }, other: 1 }, theme: 'x' })
    const merged = JSON.parse(opencodeConfigContent({ browserMcp: { url: 'http://127.0.0.1:1/mcp' } }, base) ?? '{}')
    expect(merged.theme).toBe('x')
    expect(merged.mcp.other).toBe(1)
    expect(merged.mcp.servers.b).toEqual({ disabled: true })
    expect(merged.mcp.servers['operant-browser'].type).toBe('remote')
    expect(opencodeConfigContent({}, base)).toBe(base)
    expect(opencodeConfigContent({})).toBeNull()
  })

  it('starts a Claude tile with the plugin dir and the CLI token placeholders', () => {
    const l = buildScratchLaunch(tile(), ctx)
    expect(l.file).toBe('claude')
    expect(l.args).toEqual(expect.arrayContaining(['--model', 'claude-sonnet-5-5', '--plugin-dir', '/app/plugin', '--session-id']))
    expect(l.env).toMatchObject({ OPERANT_TOKEN: '@@OPERANT_TOKEN@@', OPERANT_SOCKET: '@@OPERANT_SOCKET@@' })
    expect(l.files).toEqual([])
  })

  it('passes --effort to Haiku 5.5 and leaves it out for Haiku 4.5', () => {
    const haiku5 = buildScratchLaunch(tile({ model: 'claude-haiku-5-5', effort: 'high' }), ctx)
    expect(haiku5.args).toEqual(expect.arrayContaining(['--effort', 'high']))
    const haiku4 = buildScratchLaunch(tile({ model: 'claude-haiku-4-5', effort: 'high' }), ctx)
    expect(haiku4.args).not.toContain('--effort')
  })

  it('writes a preset guidance text as an appended system prompt file', () => {
    const l = buildScratchLaunch(tile({ presetId: 3 }), ctx, { preset: { id: 3, roleText: 'Be brief.' } as never })
    expect(l.args).toContain('--append-system-prompt-file')
    expect(l.files[0]!.content).toBe('Be brief.\n')
  })

  it('has nothing to type for a shell tile and an OpenCode tile starts its TUI', () => {
    expect(buildScratchLaunch(tile({ agent: 'shell' }), ctx)).toMatchObject({ file: null, args: [] })
    expect(buildScratchLaunch(tile({ agent: 'opencode' }), ctx)).toMatchObject({ file: 'opencode', args: [] })
  })

  it('quotes arguments for the shell it types into', () => {
    expect(quoteArg("it's", 'sh')).toBe("'it'" + String.fromCharCode(92) + "''s'")
    expect(commandLine({ file: 'claude', args: ['--model', 'a b'] }, 'powershell')).toBe("claude --model 'a b'")
  })

  it('forces Haiku for Claude only in an e2e run', () => {
    expect(e2eClaudeModel('claude-sonnet-5-5', {})).toBe('claude-sonnet-5-5')
    expect(e2eClaudeModel('claude-sonnet-5-5', { OPERANT_E2E: '1' })).toBe('claude-haiku-5-5')
    expect(e2eClaudeModel(undefined, { OPERANT_E2E: '1' })).toBe('claude-haiku-5-5')
    const old = process.env.OPERANT_E2E
    process.env.OPERANT_E2E = '1'
    try {
      expect(buildScratchLaunch(tile(), ctx).args).toEqual(expect.arrayContaining(['--model', 'claude-haiku-5-5']))
      expect(buildClaudeRunLaunch({ cwd: '/code/shop', model: 'claude-sonnet-5-5' }).args).toEqual(expect.arrayContaining(['--model', 'claude-haiku-5-5']))
      expect(buildScratchLaunch(tile({ agent: 'codex', model: 'gpt-5' }), ctx).args).toEqual(['-m', 'gpt-5'])
    } finally {
      if (old === undefined) delete process.env.OPERANT_E2E
      else process.env.OPERANT_E2E = old
    }
  })
})
