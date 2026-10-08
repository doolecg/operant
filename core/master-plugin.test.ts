import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Preset } from '../shared/types'
import { buildMasterLaunch, buildOpenCodeMasterLaunch, type LaunchContext } from './launch'
import { OPENCODE_MARKER, claudeSeatAgent, masterHooksJson, openCodeSeatAgent, prepareMaster, removeOpenCodeSeats, seatSlug, seatSubagentType } from './master-plugin'

const preset = (over: Partial<Preset>): Preset => ({
  id: 4,
  builtin: null,
  name: 'Code Reviewer',
  agent: 'claude',
  model: 'claude-sonnet-5-5',
  effort: 'high',
  permissionMode: 'dontAsk',
  tools: 'Read,Grep,Bash',
  allow: [],
  deny: ['Bash(rm:*)'],
  cacheTtl: 'auto',
  contextCap: 0,
  clearBetweenJobs: false,
  mcp: 'none',
  roleText: 'Review the change. Report problems.',
  updatedAt: 0,
  skills: ['codegraph'],
  hindsight: true,
  codegraph: true,
  mcpServers: ['codegraph'],
  ...over,
})

describe('Master plugin generators', () => {
  it('names seats', () => {
    expect(seatSlug(preset({}))).toBe('code-reviewer-p4')
    expect(seatSubagentType('claude', preset({}))).toBe('operant-master:seat-code-reviewer-p4')
    expect(seatSubagentType('opencode', preset({}))).toBe('operant-seat-code-reviewer-p4')
  })

  it('writes a Claude agent with the honoured fields and disallows servers the seat did not pick', () => {
    const f = claudeSeatAgent({ preset: preset({}), roleText: '# Reviewer\nReview the change. Report problems.' }, ['codegraph', 'hindsight'])
    expect(f.path).toBe('agents/seat-code-reviewer-p4.md')
    expect(f.content).toMatch(/^---\nname: seat-code-reviewer-p4\n/)
    expect(f.content).toContain('description: "Code Reviewer: Review the change.')
    expect(f.content).toContain('model: claude-sonnet-5-5')
    expect(f.content).toContain('effort: high')
    expect(f.content).toContain('tools: Read, Grep, Bash')
    expect(f.content).toContain('disallowedTools: "Bash(rm:*)", "mcp__hindsight"')
    expect(f.content).toContain('skills: codegraph')
  })

  it('leaves out effort for Haiku and tools when the seat has all', () => {
    const f = claudeSeatAgent({ preset: preset({ model: 'claude-haiku-5-5', tools: '', deny: [], skills: [] }), roleText: 'x.' }, [])
    expect(f.content).not.toContain('effort:')
    expect(f.content).not.toContain('tools:')
    expect(f.content).not.toContain('disallowedTools')
  })

  it('writes hooks for the six events', () => {
    const j = JSON.parse(masterHooksJson()) as { hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>> }
    expect(Object.keys(j.hooks)).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop', 'Notification', 'SubagentStart', 'SubagentStop'])
    expect(j.hooks.Stop![0]!.hooks[0]).toEqual({ type: 'command', command: 'operant hook Stop' })
  })

  it('writes an OpenCode subagent with the tools on or off and our marker', () => {
    const f = openCodeSeatAgent({ preset: preset({ agent: 'opencode', model: 'zai/glm-5.3-flash#high' }), roleText: 'Review.' }, '/p/.opencode/agents')
    expect(f.content).toMatch(/^---\ndescription: .*\nmode: subagent\ntools:\n  read: true\n  write: false/)
    expect(f.content).toContain(OPENCODE_MARKER)
  })
})

describe('prepareMaster and the Master launch', () => {
  let dir: string
  let project: string
  const crew = () => ({ id: 3, name: 'shop', folder: project })
  const base = () => ({ platform: process.platform, launchDir: join(dir, 'launch'), rolesDir: join(dir, 'roles'), roleText: '# PM\nRun tasks.', crew: crew() })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'operant-master-'))
    project = join(dir, 'project')
    mkdirSync(join(project, '.git', 'info'), { recursive: true })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('generates the Claude plugin dir, drops files of deleted seats and writes the MCP union', () => {
    const a = { preset: preset({}), roleText: 'A.' }
    const b = { preset: preset({ id: 5, name: 'Tester', mcpServers: ['hindsight'] }), roleText: 'B.' }
    const first = prepareMaster({ ...base(), cli: 'claude', seats: [a, b], mcpConfig: '{"mcpServers":{}}' })
    const root = first.pluginDir!
    expect(readdirSync(join(root, 'agents')).sort()).toEqual(['seat-code-reviewer-p4.md', 'seat-tester-p5.md'])
    expect(JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe('operant-master')
    expect(readFileSync(join(root, 'agents', 'seat-tester-p5.md'), 'utf8')).toContain('disallowedTools: "Bash(rm:*)", "mcp__codegraph"')
    expect(first.mcpConfigPath).toBe(join(dir, 'launch', 'master-3-mcp.json'))
    expect(first.seats.map((s) => s.subagentType)).toEqual(['operant-master:seat-code-reviewer-p4', 'operant-master:seat-tester-p5'])
    const second = prepareMaster({ ...base(), cli: 'claude', seats: [a] })
    expect(readdirSync(join(root, 'agents'))).toEqual(['seat-code-reviewer-p4.md'])
    expect(second.mcpConfigPath).toBeNull()
    expect(existsSync(join(dir, 'launch', 'master-3-mcp.json'))).toBe(false)
    expect(second.role.path).toBe(first.role.path)
  })

  it('builds the Claude Master args from the prep', () => {
    const prep = prepareMaster({ ...base(), cli: 'claude', seats: [{ preset: preset({}), roleText: 'A.' }], mcpConfig: '{}' })
    const ctx: LaunchContext = { platform: 'linux', shell: 'sh', crewId: 3, crewFolder: project, pluginDir: '/app/plugin', launchDir: '/l', rolesDir: '/r', commonRoleText: '', presetRoleText: '', codegraphIndexed: false, sessionId: '11111111-2222-3333-4444-555555555555' }
    const l = buildMasterLaunch(ctx, { model: 'claude-opus-5-1', effort: 'high', permissionMode: 'auto' }, prep)
    expect(l.args).toEqual([
      '--model', 'claude-opus-5-1', '--effort', 'high', '--permission-mode', 'auto',
      '--append-system-prompt-file', prep.role.path,
      '--plugin-dir', '/app/plugin',
      '--plugin-dir', prep.pluginDir,
      '--mcp-config', prep.mcpConfigPath,
      '--session-id', ctx.sessionId,
    ])
    expect(l.files).toEqual([prep.role])
    expect(buildMasterLaunch(ctx, undefined, { ...prep, resume: true }).args).toContain('--resume')
    expect(buildMasterLaunch(ctx).args).toEqual(['--plugin-dir', '/app/plugin', '--session-id', ctx.sessionId])
  })

  it('points the OpenCode TUI at the role file with no model flag', () => {
    const prep = prepareMaster({ ...base(), cli: 'opencode', seats: [] })
    const ctx = { platform: 'linux', shell: 'sh', crewFolder: project } as LaunchContext
    const l = buildOpenCodeMasterLaunch(ctx, prep)
    expect(l.args).toEqual([])
    expect(l.firstInput).toBe(`Read ${prep.role.path} and follow it as your role.`)
    expect(l.files).toEqual([prep.role])
    // Session tabs are off inside Operant (an env overlay, so the owner's cli.json is untouched).
    expect(JSON.parse(l.env.OPENCODE_CLI_CONFIG_CONTENT!)).toEqual({ tabs: { mode: 'off' } })
    expect(buildOpenCodeMasterLaunch(ctx).firstInput).toBeNull()
    expect(buildOpenCodeMasterLaunch(ctx, { ...prep, resume: true }).args).toEqual(['--continue'])
  })

  it('writes the Master model into .opencode/opencode.json, merging the owner file', () => {
    const cfgPath = join(project, '.opencode', 'opencode.json')
    mkdirSync(join(project, '.opencode'), { recursive: true })
    writeFileSync(cfgPath, JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { enabled: true } }))
    prepareMaster({ ...base(), cli: 'opencode', seats: [], model: 'zai-coding-plan/glm-5.3-flash' })
    expect(JSON.parse(readFileSync(cfgPath, 'utf8'))).toEqual({
      $schema: 'https://opencode.ai/config.json',
      mcp: { enabled: true },
      model: 'zai-coding-plan/glm-5.3-flash',
    })
    // No model: our key goes, the owner's keys stay.
    prepareMaster({ ...base(), cli: 'opencode', seats: [] })
    expect(JSON.parse(readFileSync(cfgPath, 'utf8'))).toEqual({ $schema: 'https://opencode.ai/config.json', mcp: { enabled: true } })
    // An unparseable owner file is left alone and reported.
    writeFileSync(cfgPath, '{ not json')
    const r = prepareMaster({ ...base(), cli: 'opencode', seats: [], model: 'zai/x' })
    expect(r.skipped).toEqual([cfgPath])
    expect(readFileSync(cfgPath, 'utf8')).toBe('{ not json')
    // No file is created when there is no model to write.
    rmSync(cfgPath)
    prepareMaster({ ...base(), cli: 'opencode', seats: [] })
    expect(existsSync(cfgPath)).toBe(false)
  })

  it('never overrides or removes a model the owner wrote in opencode.json', () => {
    const cfgPath = join(project, '.opencode', 'opencode.json')
    mkdirSync(join(project, '.opencode'), { recursive: true })
    const owner = JSON.stringify({ model: 'anthropic/owner-pick', mcp: {} })
    writeFileSync(cfgPath, owner)
    prepareMaster({ ...base(), cli: 'opencode', seats: [], model: 'zai/x' })
    expect(readFileSync(cfgPath, 'utf8')).toBe(owner)
    prepareMaster({ ...base(), cli: 'opencode', seats: [] })
    expect(readFileSync(cfgPath, 'utf8')).toBe(owner)
    rmSync(cfgPath)
    prepareMaster({ ...base(), cli: 'opencode', seats: [], model: 'zai/a' })
    prepareMaster({ ...base(), cli: 'opencode', seats: [], model: 'zai/b' })
    expect(JSON.parse(readFileSync(cfgPath, 'utf8')).model).toBe('zai/b')
    writeFileSync(cfgPath, JSON.stringify({ model: 'owner/changed' }))
    prepareMaster({ ...base(), cli: 'opencode', seats: [], model: 'zai/c' })
    prepareMaster({ ...base(), cli: 'opencode', seats: [] })
    expect(JSON.parse(readFileSync(cfgPath, 'utf8')).model).toBe('owner/changed')
  })

  it('writes OpenCode seat files into .opencode/agents, migrates our v1 files, excludes them from git, never overwrites the owner files and removes stale ones', () => {
    const agentDir = join(project, '.opencode', 'agents')
    const oldDir = join(project, '.opencode', 'agent')
    const seat = { preset: preset({ agent: 'opencode', model: 'zai/m' }), roleText: 'Review.' }
    // Our v1 file moves to the new folder; the owner's v1 file stays.
    mkdirSync(oldDir, { recursive: true })
    const v1 = join(oldDir, 'operant-seat-code-reviewer-p4.md')
    writeFileSync(v1, `old\n${OPENCODE_MARKER}\n`)
    const ownerV1 = join(oldDir, 'operant-seat-owner.md')
    writeFileSync(ownerV1, 'the owner wrote this')
    const r1 = prepareMaster({ ...base(), cli: 'opencode', seats: [seat] })
    expect(r1.skipped).toEqual([])
    expect(existsSync(v1)).toBe(false)
    expect(readFileSync(ownerV1, 'utf8')).toBe('the owner wrote this')
    expect(readFileSync(join(agentDir, 'operant-seat-code-reviewer-p4.md'), 'utf8')).toContain(OPENCODE_MARKER)
    // An owner file at a seat's path in the new folder is left alone and reported.
    const mine = join(agentDir, 'operant-seat-code-reviewer-p4.md')
    writeFileSync(mine, 'the owner wrote this')
    const rOwner = prepareMaster({ ...base(), cli: 'opencode', seats: [seat] })
    expect(rOwner.skipped).toEqual([mine])
    expect(readFileSync(mine, 'utf8')).toBe('the owner wrote this')
    rmSync(mine)
    const r2 = prepareMaster({ ...base(), cli: 'opencode', seats: [seat, { preset: preset({ id: 9, name: 'Old', agent: 'opencode' }), roleText: 'x.' }] })
    expect(r2.skipped).toEqual([])
    expect(readdirSync(agentDir).sort()).toEqual(['operant-seat-code-reviewer-p4.md', 'operant-seat-old-p9.md'])
    writeFileSync(join(agentDir, 'operant-seat-notours.md'), 'owner file with our prefix')
    prepareMaster({ ...base(), cli: 'opencode', seats: [seat] })
    expect(readdirSync(agentDir).sort()).toEqual(['operant-seat-code-reviewer-p4.md', 'operant-seat-notours.md'])
    const exclude = readFileSync(join(project, '.git', 'info', 'exclude'), 'utf8').split('\n')
    expect(exclude.filter((l) => l === '/.opencode/agents/operant-seat-*.md')).toHaveLength(1)
    expect(exclude.filter((l) => l === '/.opencode/opencode.json')).toHaveLength(1)
    expect(exclude.some((l) => l === '/.opencode/agent/operant-seat-*.md')).toBe(false)
    removeOpenCodeSeats(project)
    expect(readdirSync(agentDir)).toEqual(['operant-seat-notours.md'])
  })

  it('skips the git exclude when the folder is not a checkout', () => {
    const plain = join(dir, 'plain')
    mkdirSync(plain)
    prepareMaster({ ...base(), crew: { id: 4, name: 'p', folder: plain }, cli: 'opencode', seats: [{ preset: preset({ agent: 'opencode' }), roleText: 'x.' }] })
    expect(existsSync(join(plain, '.git'))).toBe(false)
  })
})
