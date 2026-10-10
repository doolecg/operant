import { describe, expect, it } from 'vitest'
import { LaunchError, buildChatLaunch, type LaunchContext } from './launch'
import type { Preset, ScratchTerminal } from '../shared/types'

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
  effort: 'high',
  presetId: null,
  cwd: '/code/shop',
  sessionId: null,
  view: 'chat',
  createdAt: 0,
  ...over,
})

const STREAM = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--include-hook-events', '--forward-subagent-text', '--permission-prompt-tool', 'stdio']

describe('buildChatLaunch', () => {
  it('prepends the stream flags to the tile launch for a new session', () => {
    const l = buildChatLaunch(tile(), ctx)
    expect(l.file).toBe('claude')
    expect(l.args.slice(0, STREAM.length)).toEqual(STREAM)
    expect(l.args.slice(STREAM.length)).toEqual(['--model', 'claude-sonnet-5-5', '--effort', 'high', '--plugin-dir', '/app/plugin', '--session-id', ctx.sessionId])
    expect(l.args).not.toContain('--allow-dangerously-skip-permissions')
    expect(l.env.OPERANT_TILE_ID).toBeUndefined()
    expect(l.cwd).toBe('/code/shop')
  })

  it('resumes a session with --resume and keeps the settings layering and plugin dirs', () => {
    const id = 'aaaaaaaa-5a4b-4c3d-8e2f-123456789abc'
    const l = buildChatLaunch(tile({ sessionId: id }), { ...ctx, mods: { hooks: {} }, modPlugins: ['/app/plugin/mods/ideaShelf'] }, { resume: true })
    expect(l.args).toContain('--resume')
    expect(l.args[l.args.indexOf('--resume') + 1]).toBe(id)
    expect(l.args).not.toContain('--session-id')
    expect(l.args).toContain('--settings')
    expect(l.args.filter((a) => a === '--plugin-dir')).toHaveLength(2)
    expect(l.files.some((f) => f.path.endsWith('scratch-7.json'))).toBe(true)
  })

  it('adds --allow-dangerously-skip-permissions only for a bypass preset', () => {
    const preset = { id: 3, permissionMode: 'bypassPermissions', tools: '', allow: [], deny: [], cacheTtl: 'auto', contextCap: 0, roleText: null } as unknown as Preset
    expect(buildChatLaunch(tile(), ctx, { preset }).args).toContain('--allow-dangerously-skip-permissions')
    expect(buildChatLaunch(tile(), ctx, { preset: { ...preset, permissionMode: 'plan' } }).args).not.toContain('--allow-dangerously-skip-permissions')
  })

  it('drops flags this install does not list, keeps the hidden prompt tool when --permission-prompts is listed, and refuses old installs', () => {
    const old = new Set(['--model', '--input-format', '--output-format', '--session-id', '--permission-prompts'])
    const l = buildChatLaunch(tile(), { ...ctx, supported: old })
    expect(l.args).toEqual(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--permission-prompt-tool', 'stdio', '--model', 'claude-sonnet-5-5', '--session-id', ctx.sessionId])
    const noPrompts = buildChatLaunch(tile(), { ...ctx, supported: new Set(['--input-format']) })
    expect(noPrompts.args).not.toContain('--permission-prompt-tool')
    expect(() => buildChatLaunch(tile(), { ...ctx, supported: new Set(['--model']) })).toThrow(/Claude Code 2.1/)
    expect(() => buildChatLaunch(tile({ agent: 'opencode' }), ctx)).toThrow(LaunchError)
  })
})
