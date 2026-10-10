import { describe, expect, it } from 'vitest'
import { buildScratchLaunch, commandLine, quoteArg, type LaunchContext } from './launch'
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
})
