import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Operator, Preset, ScratchTerminal } from '../shared/types'
import {
  buildClaudeLaunch,
  buildClaudeResume,
  buildCodexLaunch,
  buildMasterLaunch,
  buildScratchLaunch,
  capFlag,
  commandLine,
  LaunchError,
  planChange,
  quoteArg,
  ROLE_FILE_BY_PRESET,
  SOCKET_PLACEHOLDER,
  TOKEN_PLACEHOLDER,
  validateLaunchSettings,
  writeLaunchFiles,
  type LaunchContext,
} from './launch'
import { BUILTIN_PRESETS } from './store'

const UUID = '123e4567-e89b-42d3-a456-426614174000'

const winCtx: LaunchContext = {
  platform: 'win32',
  crewId: 3,
  crewFolder: 'C:\\work\\my crew',
  pluginDir: 'C:\\app\\plugin',
  launchDir: 'C:\\data\\launch',
  rolesDir: 'C:\\data\\roles',
  commonRoleText: 'COMMON',
  presetRoleText: 'ROLE',
  codegraphIndexed: true,
  sessionId: UUID,
}
const posixCtx: LaunchContext = {
  ...winCtx,
  platform: 'linux',
  crewFolder: '/work/crew',
  pluginDir: '/app/plugin',
  launchDir: '/data/launch',
  rolesDir: '/data/roles',
}

function presetOf(builtin: string, id = 1): Preset {
  const p = BUILTIN_PRESETS.find((b) => b.builtin === builtin)!
  return { ...p, id, updatedAt: 0 }
}

function operatorOf(preset: Preset, id = 7, over: Partial<Operator> = {}): Operator {
  const { id: _i, builtin: _b, name: _n, roleText: _r, updatedAt: _u, ...launch } = preset
  return { ...launch, id, squadId: 1, role: 'x', status: 'stopped', kind: 'worker', presetId: preset.id, roleText: null, dailyCapUsd: null, sessionId: null, modified: false, ...over }
}

const hashOf = (path: string) => /-([0-9a-f]{12})\.md$/.exec(path)![1]
const roleOf = (files: Array<{ path: string; content: string }>) => files.find((f) => /[\\/]roles[\\/]/.test(f.path))!

describe('buildClaudeLaunch argv', () => {
  // [builtin, model, effort flag, mode, tools, cap flag]
  const table: Array<[string, string, string[], string, string, string]> = [
    ['pm', 'claude-sonnet-5-5', ['--effort', 'medium'], 'dontAsk', 'Read,Grep,Glob,Bash', '150k'],
    ['researcher', 'claude-haiku-4-5', [], 'dontAsk', 'Read,Grep,Glob,Bash,WebFetch,WebSearch', '100k'],
    ['designer', 'claude-sonnet-5-5', ['--effort', 'medium'], 'dontAsk', 'Read,Grep,Glob,Edit,Write,Bash', '150k'],
    ['implementor', 'claude-sonnet-5-5', ['--effort', 'medium'], 'acceptEdits', 'Read,Grep,Glob,Edit,Write,Bash', '200k'],
    ['senior', 'claude-opus-5-5', ['--effort', 'medium'], 'acceptEdits', 'Read,Grep,Glob,Edit,Write,Bash', '300k'],
    ['tester', 'claude-sonnet-5-5', ['--effort', 'medium'], 'dontAsk', 'Read,Grep,Glob,Edit,Write,Bash', '120k'],
    ['reviewer', 'claude-sonnet-5-5', ['--effort', 'high'], 'dontAsk', 'Read,Grep,Glob,Bash', '150k'],
  ]

  it('covers all seven built-ins', () => {
    expect(table.map((t) => t[0])).toEqual(BUILTIN_PRESETS.map((b) => b.builtin))
  })

  for (const [name, model, effort, mode, tools, cap] of table) {
    it(`${name} on Windows`, () => {
      const l = buildClaudeLaunch(operatorOf(presetOf(name)), presetOf(name), winCtx)
      const role = roleOf(l.files).path
      expect(l.file).toBe('claude')
      expect(l.args).toEqual([
        '--model', model, ...effort, '--permission-mode', mode, '--tools', tools,
        '--settings', 'C:\\data\\launch\\op-7.json',
        '--append-system-prompt-file', role,
        '--strict-mcp-config', '--mcp-config', 'C:\\data\\launch\\crew-3-mcp.json',
        '--autocompact', cap, '--plugin-dir', 'C:\\app\\plugin', '--session-id', UUID,
      ])
      expect(role).toBe(`C:\\data\\roles\\${name}-${hashOf(role)}.md`)
      expect(l.cwd).toBe('C:\\work\\my crew')
    })

    it(`${name} on POSIX`, () => {
      const l = buildClaudeLaunch(operatorOf(presetOf(name)), presetOf(name), posixCtx)
      const role = roleOf(l.files).path
      expect(l.args).toEqual([
        '--model', model, ...effort, '--permission-mode', mode, '--tools', tools,
        '--settings', '/data/launch/op-7.json',
        '--append-system-prompt-file', role,
        '--strict-mcp-config', '--mcp-config', '/data/launch/crew-3-mcp.json',
        '--autocompact', cap, '--plugin-dir', '/app/plugin', '--session-id', UUID,
      ])
      expect(role).toBe(`/data/roles/${name}-${hashOf(role)}.md`)
      expect(l.cwd).toBe('/work/crew')
    })
  }

  it('prints exact typed lines for both shells', () => {
    const l = buildClaudeLaunch(operatorOf(presetOf('reviewer')), presetOf('reviewer'), posixCtx)
    const role = roleOf(l.files).path
    expect(commandLine(l, 'sh')).toBe(
      `claude --model claude-sonnet-5-5 --effort high --permission-mode dontAsk --tools 'Read,Grep,Glob,Bash' --settings /data/launch/op-7.json --append-system-prompt-file ${role} --strict-mcp-config --mcp-config /data/launch/crew-3-mcp.json --autocompact 150k --plugin-dir /app/plugin --session-id ${UUID}`,
    )
    const w = buildClaudeLaunch(operatorOf(presetOf('reviewer')), presetOf('reviewer'), winCtx)
    const wrole = roleOf(w.files).path
    expect(commandLine(w, 'powershell')).toBe(
      `claude --model claude-sonnet-5-5 --effort high --permission-mode dontAsk --tools 'Read,Grep,Glob,Bash' --settings 'C:\\data\\launch\\op-7.json' --append-system-prompt-file '${wrole}' --strict-mcp-config --mcp-config 'C:\\data\\launch\\crew-3-mcp.json' --autocompact 150k --plugin-dir 'C:\\app\\plugin' --session-id ${UUID}`,
    )
  })

  it('quotes paths with spaces and apostrophes per shell', () => {
    expect(quoteArg("C:\\Dayle's dir\\x", 'powershell')).toBe("'C:\\Dayle''s dir\\x'")
    expect(quoteArg("/home/it's here", 'sh')).toBe(`'/home/it'\\''s here'`)
    expect(quoteArg('$(calc)', 'powershell')).toBe("'$(calc)'")
    expect(quoteArg('`x`', 'sh')).toBe("'`x`'")
    expect(quoteArg('claude-opus-5-5[1m]', 'sh')).toBe("'claude-opus-5-5[1m]'")
    expect(quoteArg('', 'sh')).toBe("''")
    expect(() => quoteArg('a\nb', 'sh')).toThrow(LaunchError)
  })

  it('omits --effort for Haiku or empty effort, even when set', () => {
    const p = presetOf('researcher')
    expect(buildClaudeLaunch(operatorOf(p, 7, { effort: 'high' }), p, posixCtx).args).not.toContain('--effort')
    const pm = presetOf('pm')
    expect(buildClaudeLaunch(operatorOf(pm, 7, { effort: '' }), pm, posixCtx).args).not.toContain('--effort')
  })

  it('sets env: ttl, subagent ttl, compact window, autoupdater, placeholders', () => {
    const l = buildClaudeLaunch(operatorOf(presetOf('pm')), presetOf('pm'), { ...posixCtx, operantCli: '/app/cli.js', operantNode: '/app/node' })
    expect(l.env).toEqual({
      CLAUDE_CODE_PROMPT_CACHE_TTL: '1h',
      CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '5m',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '150k',
      DISABLE_AUTOUPDATER: '1',
      OPERANT_SOCKET: SOCKET_PLACEHOLDER,
      OPERANT_TOKEN: TOKEN_PLACEHOLDER,
      OPERANT_CLI: '/app/cli.js',
      OPERANT_NODE: '/app/node',
    })
    const auto = buildClaudeLaunch(operatorOf(presetOf('implementor')), presetOf('implementor'), posixCtx)
    expect(auto.env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBeUndefined()
  })

  it('writes permissions to the settings file, never to argv', () => {
    const p = presetOf('implementor')
    const l = buildClaudeLaunch(operatorOf(p), p, posixCtx)
    const s = JSON.parse(l.files.find((f) => f.path.endsWith('op-7.json'))!.content)
    expect(s).toEqual({ permissions: { allow: p.allow, deny: ['Bash(git push*)', 'Bash(git commit*)'] } })
    expect(l.args.join(' ')).not.toContain('git push')
  })

  it('writes the strict MCP config: CodeGraph only, or empty', () => {
    const p = presetOf('pm')
    const mcp = (l: { files: Array<{ path: string; content: string }> }) => JSON.parse(l.files.find((f) => f.path.endsWith('mcp.json'))!.content)
    expect(mcp(buildClaudeLaunch(operatorOf(p), p, posixCtx))).toEqual({ mcpServers: { codegraph: { command: 'codegraph', args: ['serve', '--mcp'] } } })
    const off = buildClaudeLaunch(operatorOf(p), p, { ...posixCtx, codegraphIndexed: false })
    expect(mcp(off)).toEqual({ mcpServers: {} })
    expect(off.args).toContain('--strict-mcp-config')
    expect(mcp(buildClaudeLaunch(operatorOf(p, 7, { mcp: 'none' }), p, posixCtx))).toEqual({ mcpServers: {} })
  })

  it('plain overrides replace the operator fields; a preset does not', () => {
    const p = presetOf('pm')
    const o = operatorOf(p, 7, { model: 'claude-opus-5-5' })
    expect(buildClaudeLaunch(o, p, posixCtx).args[1]).toBe('claude-opus-5-5')
    expect(buildClaudeLaunch(o, { model: 'claude-sonnet-5-5', effort: 'high' }, posixCtx).args.slice(0, 4)).toEqual(['--model', 'claude-sonnet-5-5', '--effort', 'high'])
  })

  it('omits unsupported flags and the cap when 0', () => {
    const p = presetOf('pm')
    const supported = new Set(['--model', '--permission-mode', '--session-id'])
    const l = buildClaudeLaunch(operatorOf(p), p, { ...posixCtx, supported })
    expect(l.args).toEqual(['--model', 'claude-sonnet-5-5', '--permission-mode', 'dontAsk', '--session-id', UUID])
    expect(buildClaudeLaunch(operatorOf(p, 7, { contextCap: 0 }), p, posixCtx).args).not.toContain('--autocompact')
    expect(capFlag(1_000_000)).toBe('1M')
  })

  it('resume relaunch swaps --session-id for --resume', () => {
    const p = presetOf('pm')
    const sid = '223e4567-e89b-42d3-a456-426614174000'
    const l = buildClaudeResume(operatorOf(p), p, posixCtx, sid)
    expect(l.args.slice(-2)).toEqual(['--resume', sid])
    expect(l.args).not.toContain('--session-id')
  })
})

describe('role files', () => {
  it('shares one file between same-role operators and prepends the common text', () => {
    const p = presetOf('implementor')
    const ra = roleOf(buildClaudeLaunch(operatorOf(p, 1), p, posixCtx).files)
    const rb = roleOf(buildClaudeLaunch(operatorOf(p, 2), p, posixCtx).files)
    expect(ra.path).toBe(rb.path)
    expect(ra.content).toBe('COMMON\n\nROLE\n')
    expect(ra.path).toMatch(/^\/data\/roles\/implementor-[0-9a-f]{12}\.md$/)
  })

  it('changes the name when the text changes', () => {
    const p = presetOf('implementor')
    const a = roleOf(buildClaudeLaunch(operatorOf(p), p, posixCtx).files)
    const b = roleOf(buildClaudeLaunch(operatorOf(p), p, { ...posixCtx, presetRoleText: 'OTHER' }).files)
    expect(a.path).not.toBe(b.path)
  })

  it('gives an operator with its own text its own key; user presets use p<id>', () => {
    const p = presetOf('implementor')
    const own = roleOf(buildClaudeLaunch(operatorOf(p, 9, { roleText: 'MINE' }), p, posixCtx).files)
    expect(own.path).toMatch(/\/roles\/op9-/)
    expect(own.content).toBe('COMMON\n\nMINE\n')
    const user: Preset = { ...p, id: 12, builtin: null, name: 'mine' }
    expect(roleOf(buildClaudeLaunch(operatorOf(user), user, posixCtx).files).path).toMatch(/\/roles\/p12-/)
  })

  it('writes files through the injected writer into a temp dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'launch-'))
    try {
      const p = presetOf('pm')
      const l = buildClaudeLaunch(operatorOf(p), p, { ...posixCtx, launchDir: join(dir, 'launch'), rolesDir: join(dir, 'roles') })
      const made: string[] = []
      writeLaunchFiles(l.files, {
        mkdir: (d) => {
          made.push(d)
          mkdirSync(d, { recursive: true })
        },
        writeFile: (f, c) => writeFileSync(f, c),
      })
      expect(made).toHaveLength(2)
      for (const f of l.files) expect(readFileSync(f.path, 'utf8')).toBe(f.content)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('validation', () => {
  const p = presetOf('implementor')
  const bad = (over: Partial<Operator>, ctx: LaunchContext = posixCtx) => () => buildClaudeLaunch(operatorOf(p, 7, over), p, ctx)

  it('rejects injection in model', () => {
    for (const m of ['x; rm -rf /', 'a b', "a'b", 'a"b', 'a\nb', '$(whoami)', 'a`b`', 'Claude-Opus', '', 'a|b', 'a&b']) {
      expect(bad({ model: m }), m).toThrow(LaunchError)
    }
  })

  it('accepts 1M-style model ids', () => {
    expect(buildClaudeLaunch(operatorOf(p, 7, { model: 'claude-opus-5-5[1m]' }), p, posixCtx).args[1]).toBe('claude-opus-5-5[1m]')
  })

  it('rejects bad effort, mode (auto too), tools, rules, ttl, cap', () => {
    expect(bad({ effort: 'high; ls' })).toThrow(LaunchError)
    expect(bad({ effort: 'extreme' })).toThrow(LaunchError)
    expect(bad({ permissionMode: 'auto' })).toThrow(LaunchError)
    expect(bad({ permissionMode: '' })).toThrow(LaunchError)
    expect(bad({ permissionMode: 'dontAsk && x' })).toThrow(LaunchError)
    expect(bad({ tools: 'Read; rm -rf /' })).toThrow(LaunchError)
    expect(bad({ tools: 'Read,Bash(ls)' })).toThrow(LaunchError)
    expect(bad({ tools: 'Read\nBash' })).toThrow(LaunchError)
    expect(bad({ tools: 'Read,,Bash' })).toThrow(LaunchError)
    expect(bad({ allow: ['Bash(ls)\nBash(rm *)'] })).toThrow(LaunchError)
    expect(bad({ allow: ['; rm -rf /'] })).toThrow(LaunchError)
    expect(bad({ deny: [`Bash(${'x'.repeat(400)})`] })).toThrow(LaunchError)
    expect(bad({ cacheTtl: '2h' as never })).toThrow(LaunchError)
    expect(bad({ contextCap: 50 })).toThrow(LaunchError)
    expect(bad({ contextCap: 2_000_000 })).toThrow(LaunchError)
    expect(bad({ contextCap: 150000.5 })).toThrow(LaunchError)
  })

  it('rejects a bad session id and paths with control characters', () => {
    expect(bad({}, { ...posixCtx, sessionId: 'x; ls' })).toThrow(LaunchError)
    expect(bad({}, { ...posixCtx, pluginDir: '/a\n/b' })).toThrow(LaunchError)
    expect(bad({}, { ...posixCtx, crewFolder: '' })).toThrow(LaunchError)
  })

  it('carries the field name in the error', () => {
    let err: unknown
    try {
      bad({ model: 'a b' })()
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(LaunchError)
    expect((err as LaunchError | undefined)?.field).toBe('model')
  })

  it('role text goes to a file, never to argv', () => {
    const l = buildClaudeLaunch(operatorOf(p, 7, { roleText: 'line1\n; rm -rf /\n"x"' }), p, posixCtx)
    expect(l.args.join(' ')).not.toContain('rm -rf')
    expect(l.files.some((f) => f.content.includes('rm -rf'))).toBe(true)
  })
})

describe('buildCodexLaunch', () => {
  it('passes the model flag only (R3)', () => {
    const p = presetOf('implementor')
    const l = buildCodexLaunch(operatorOf(p, 7, { agent: 'codex', model: 'gpt-5-codex' }), p, posixCtx)
    expect(l.file).toBe('codex')
    expect(l.args).toEqual(['-m', 'gpt-5-codex'])
    expect(l.files).toEqual([])
    expect(l.firstInput).toBeNull()
    expect(l.env).toEqual({ OPERANT_SOCKET: SOCKET_PLACEHOLDER, OPERANT_TOKEN: TOKEN_PLACEHOLDER })
    expect(() => buildCodexLaunch(operatorOf(p, 7, { agent: 'codex', model: 'x; ls' }), p, posixCtx)).toThrow(LaunchError)
  })

  it('points at a role file only when enabled', () => {
    const p = presetOf('implementor')
    const l = buildCodexLaunch(operatorOf(p, 7, { agent: 'codex', model: 'gpt-5' }), p, { ...posixCtx, codexSendRole: true })
    expect(l.files).toHaveLength(1)
    expect(l.firstInput).toBe(`Read ${l.files[0]!.path} and follow it as your role.`)
  })
})

describe('buildMasterLaunch and buildScratchLaunch', () => {
  it('master: plugin and session id only, token env, no role or settings', () => {
    const l = buildMasterLaunch(posixCtx)
    expect(l.args).toEqual(['--plugin-dir', '/app/plugin', '--session-id', UUID])
    expect(l.env).toEqual({ OPERANT_SOCKET: SOCKET_PLACEHOLDER, OPERANT_TOKEN: TOKEN_PLACEHOLDER })
    expect(l.files).toEqual([])
    expect(l.cwd).toBe('/work/crew')
  })

  it('master: honours the model, effort and permission mode saved on the slot', () => {
    const base = { model: '', effort: '', permissionMode: '' }
    expect(buildMasterLaunch(posixCtx, base).args).toEqual(['--plugin-dir', '/app/plugin', '--session-id', UUID])
    expect(buildMasterLaunch(posixCtx, { ...base, permissionMode: 'default' }).args).toEqual(['--plugin-dir', '/app/plugin', '--session-id', UUID])
    const l = buildMasterLaunch(posixCtx, { model: 'claude-opus-5-5', effort: 'high', permissionMode: 'plan' })
    expect(l.args).toEqual(['--model', 'claude-opus-5-5', '--effort', 'high', '--permission-mode', 'plan', '--plugin-dir', '/app/plugin', '--session-id', UUID])
    expect(buildMasterLaunch(posixCtx, { model: 'claude-haiku-4-5', effort: 'high', permissionMode: '' }).args).not.toContain('--effort')
    expect(() => buildMasterLaunch(posixCtx, { ...base, permissionMode: 'rm -rf' })).toThrow(LaunchError)
  })

  const tile = (over: Partial<ScratchTerminal>): ScratchTerminal => ({
    id: 4, crewId: 3, title: 't', agent: 'claude', model: 'claude-sonnet-5-5', effort: 'low', presetId: null, cwd: '/work/crew/sub', sessionId: null, createdAt: 0, ...over,
  })

  it('shell tile has nothing to type', () => {
    const l = buildScratchLaunch(tile({ agent: 'shell' }), posixCtx)
    expect(l.file).toBeNull()
    expect(commandLine(l, 'sh')).toBeNull()
  })

  it('claude tile: no token, plugin, role or env', () => {
    const l = buildScratchLaunch(tile({}), posixCtx)
    expect(l.args).toEqual(['--model', 'claude-sonnet-5-5', '--effort', 'low', '--session-id', UUID])
    expect(l.env).toEqual({})
    expect(l.files).toEqual([])
    expect(l.cwd).toBe('/work/crew/sub')
  })

  it('claude tile with preset settings writes a rules file; reopening resumes', () => {
    const sid = '323e4567-e89b-42d3-a456-426614174000'
    const l = buildScratchLaunch(tile({ sessionId: sid }), posixCtx, { settings: { permissionMode: 'dontAsk', tools: 'Read,Grep', allow: ['Bash(git log*)'] }, resume: true })
    expect(l.args).toContain('--permission-mode')
    expect(l.args.slice(-2)).toEqual(['--resume', sid])
    expect(l.args).not.toContain('--plugin-dir')
    expect(l.files.map((f) => f.path)).toEqual(['/data/launch/scratch-4.json'])
  })

  it('haiku tile omits effort; codex tile is model only; bad model rejected', () => {
    expect(buildScratchLaunch(tile({ model: 'claude-haiku-4-5' }), posixCtx).args).not.toContain('--effort')
    expect(buildScratchLaunch(tile({ agent: 'codex', model: 'gpt-5' }), posixCtx).args).toEqual(['-m', 'gpt-5'])
    expect(() => buildScratchLaunch(tile({ model: '$(x)' }), posixCtx)).toThrow(LaunchError)
  })
})

describe('review fixes', () => {
  it('doubles every PowerShell single-quote character', () => {
    for (const c of ['‘', '’', '‚', '‛']) {
      expect(quoteArg(`C:\\Dayle${c}s\\x`, 'powershell')).toBe(`'C:\\Dayle${c}${c}s\\x'`)
    }
    const l = buildClaudeLaunch(operatorOf(presetOf('pm')), presetOf('pm'), { ...winCtx, pluginDir: 'C:\\Dayle’s\\plugin' })
    expect(commandLine(l, 'powershell')).toContain("--plugin-dir 'C:\\Dayle’’s\\plugin'")
  })

  it('rejects flag-like values', () => {
    const p = presetOf('pm')
    for (const m of ['--dangerously-skip-permissions', '-x']) {
      expect(() => buildClaudeLaunch(operatorOf(p, 7, { model: m }), p, posixCtx)).toThrow(LaunchError)
      expect(() => buildCodexLaunch(operatorOf(p, 7, { agent: 'codex', model: m }), p, posixCtx)).toThrow(LaunchError)
    }
    expect(() => buildClaudeLaunch(operatorOf(p, 7, { tools: '-Read' }), p, posixCtx)).toThrow(LaunchError)
    expect(() => buildClaudeLaunch(operatorOf(p, 7, { model: undefined as never }), p, posixCtx)).toThrow(LaunchError)
  })

  it('has a shipped role file for every built-in preset', () => {
    for (const b of BUILTIN_PRESETS) {
      const f = ROLE_FILE_BY_PRESET[b.builtin!]
      expect(f, b.builtin!).toBeTruthy()
      expect(existsSync(join(__dirname, '..', 'plugin', 'roles', f!)), f).toBe(true)
    }
  })

  it('fresh restart estimate prefers the first-turn cache write', () => {
    const op = operatorOf(presetOf('implementor'))
    const r = planChange(op, { effort: 'high' }, { running: true, contextTokens: 170_000, firstTurnCacheWriteTokens: 20_000 })
    expect(r.estimateColdCostUsd).toBeCloseTo((20_000 * 2 * 1.25) / 1e6)
    const t = planChange(op, { tools: 'Read' }, { running: true, contextTokens: 170_000, firstTurnCacheWriteTokens: 20_000 })
    expect(t.estimateColdCostUsd).toBeCloseTo((170_000 * 2 * 1.25) / 1e6)
  })
})

describe('planChange', () => {
  const p = presetOf('implementor')
  const op = operatorOf(p)
  const run = { running: true, contextTokens: 170_000 }

  it('effort change on a running Claude operator is a fresh relaunch', () => {
    const r = planChange(op, { effort: 'high' }, run)
    expect(r).toMatchObject({ requiresRestart: true, effort: 'conversation-lost', canResume: false, restartFields: ['effort'] })
    expect(r.model).toBeUndefined()
    expect(r.estimateColdCostUsd).toBeCloseTo((170_000 * 2 * 1.25) / 1e6)
  })

  it('model change loses the cache and prices the new model', () => {
    const r = planChange({ ...op, cacheTtl: '1h' }, { model: 'claude-opus-5-5' }, run)
    expect(r).toMatchObject({ requiresRestart: true, model: 'cache-lost', canResume: false })
    expect(r.estimateColdCostUsd).toBeCloseTo(1.36)
  })

  it('a stopped operator needs no restart', () => {
    const r = planChange(op, { effort: 'high', model: 'claude-opus-5-5' }, { running: false, contextTokens: 0 })
    expect(r).toMatchObject({ requiresRestart: false, effort: 'cache-kept', model: 'cache-lost' })
    expect(r.estimateColdCostUsd).toBeUndefined()
  })

  it('role, squad, cap and clear changes apply live', () => {
    const r = planChange(op, { role: 'other', squadId: 9, dailyCapUsd: 5, clearBetweenJobs: false }, run)
    expect(r.requiresRestart).toBe(false)
    expect(r.liveFields).toEqual(['role', 'squadId', 'dailyCapUsd', 'clearBetweenJobs'])
    expect(r.effort).toBeUndefined()
    expect(r.model).toBeUndefined()
  })

  it('tools, role text and mode changes relaunch but may resume', () => {
    const r = planChange(op, { tools: 'Read,Bash', roleText: 'new', permissionMode: 'dontAsk' }, run)
    expect(r).toMatchObject({ requiresRestart: true, canResume: true, restartFields: ['permissionMode', 'tools', 'roleText'] })
  })

  it('unchanged values change nothing', () => {
    const r = planChange(op, { effort: op.effort, model: op.model, allow: [...op.allow] }, run)
    expect(r).toMatchObject({ requiresRestart: false, restartFields: [], liveFields: [] })
  })

  it('Haiku has no effort control', () => {
    const r = planChange(operatorOf(presetOf('researcher')), { effort: 'high' }, run)
    expect(r.requiresRestart).toBe(false)
    expect(r.effort).toBeUndefined()
  })

  it('Codex: model restarts, effort and other launch fields are inert', () => {
    const c = operatorOf(p, 7, { agent: 'codex', model: 'gpt-5' })
    expect(planChange(c, { effort: 'high', tools: 'Read', cacheTtl: '1h' }, run)).toMatchObject({ requiresRestart: false, restartFields: [] })
    const m = planChange(c, { model: 'gpt-5-codex' }, run)
    expect(m).toMatchObject({ requiresRestart: true, model: 'cache-lost', canResume: false })
    expect(m.estimateColdCostUsd).toBeUndefined()
  })
})

describe('token settings and shells', () => {
  const pm = presetOf('pm')
  const impl = presetOf('implementor')

  it('applies the default TTL to operators on auto, the sub-agent TTL, and the version pin', () => {
    const ctx = { ...posixCtx, defaultCacheTtl: '1h' as const, subagentCacheTtl: '1h' as const, pinClaudeVersion: false }
    const auto = buildClaudeLaunch(operatorOf(impl), impl, ctx)
    expect(auto.env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('1h')
    expect(auto.env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL).toBe('1h')
    expect(auto.env.DISABLE_AUTOUPDATER).toBeUndefined()
    // An operator's own TTL still wins over the default.
    const own = buildClaudeLaunch(operatorOf(impl, 7, { cacheTtl: '5m' }), impl, ctx)
    expect(own.env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('5m')
    const none = buildClaudeLaunch(operatorOf(pm), pm, { ...posixCtx, subagentCacheTtl: 'auto' })
    expect(none.env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL).toBeUndefined()
    expect(() => buildClaudeLaunch(operatorOf(impl), impl, { ...posixCtx, defaultCacheTtl: '2h' as never })).toThrow(LaunchError)
  })

  it('rejects cmd.exe for every launch that types a command, and for quoting', () => {
    const ctx = { ...winCtx, shell: 'cmd' as const }
    expect(() => buildClaudeLaunch(operatorOf(pm), pm, ctx)).toThrow(/cmd\.exe is not supported.*PowerShell or sh/)
    expect(() => buildCodexLaunch(operatorOf(pm, 7, { agent: 'codex', model: 'gpt-5' }), pm, ctx)).toThrow(/cmd\.exe/)
    expect(() => buildMasterLaunch(ctx)).toThrow(/cmd\.exe/)
    const scratch: ScratchTerminal = { id: 1, crewId: 1, title: 't', agent: 'claude', model: 'sonnet', effort: '', presetId: null, cwd: 'C:/x', sessionId: null, createdAt: 0 }
    expect(() => buildScratchLaunch(scratch, ctx)).toThrow(/cmd\.exe/)
    expect(() => quoteArg('a b', 'cmd')).toThrow(/cmd\.exe/)
    // A plain shell tile types nothing, so it works in any shell.
    expect(buildScratchLaunch({ ...scratch, agent: 'shell' }, ctx).file).toBeNull()
  })

  it('validates a launch patch with the builder rules', () => {
    expect(() => validateLaunchSettings({ model: 'claude-sonnet-5-5', effort: 'high', permissionMode: 'dontAsk', contextCap: 150_000 })).not.toThrow()
    expect(() => validateLaunchSettings({ agent: 'shell', model: '-' })).not.toThrow()
    for (const bad of [{ model: 'rm -rf' }, { effort: 'ultra' }, { permissionMode: 'auto' }, { tools: 'Read;ls' }, { allow: ['x y'] }, { cacheTtl: '2h' }, { contextCap: 5 }, { mcp: 'x' }, { agent: 'vim' }] as never[]) {
      expect(() => validateLaunchSettings(bad)).toThrow(LaunchError)
    }
  })
})
