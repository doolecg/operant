import { createHash } from 'node:crypto'
import { posix, win32 } from 'node:path'
import type { AgentKind, CacheTtl, LaunchSettings, MasterCli, Operator, Preset, ScratchTerminal } from '../shared/types'
import { rateFor } from './pricing'

// PowerShell and sh (bash, zsh, ...) are the supported shells for typing a launch line. cmd.exe has no
// quoting that keeps free text and paths inert, so the launch builders refuse it.
export type ShellKind = 'powershell' | 'sh' | 'cmd'

export class LaunchError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(`${field}: ${message}`)
    this.name = 'LaunchError'
  }
}

export interface LaunchFile {
  path: string
  content: string
}

export interface LaunchResult {
  // null for a plain shell tile: nothing to type.
  file: string | null
  args: string[]
  env: Record<string, string>
  files: LaunchFile[]
  cwd: string
  // Codex only: a fixed line typed after launch (a pointer to the role file, never free text).
  firstInput: string | null
}

// Step 4 replaces these in the session env before the PTY starts.
export const SOCKET_PLACEHOLDER = '@@OPERANT_SOCKET@@'
export const TOKEN_PLACEHOLDER = '@@OPERANT_TOKEN@@'

export const CLAUDE_FLAGS = [
  '--model',
  '--effort',
  '--permission-mode',
  '--tools',
  '--settings',
  '--append-system-prompt-file',
  '--strict-mcp-config',
  '--mcp-config',
  '--autocompact',
  '--plugin-dir',
  '--session-id',
  '--resume',
] as const

export interface LaunchContext {
  platform: NodeJS.Platform
  // Defaults from the platform (PowerShell on Windows, sh elsewhere).
  shell?: ShellKind
  // Settings > Tokens: the TTL for operators whose own is 'auto', the sub-agent TTL, and whether the Claude
  // Code version is pinned (DISABLE_AUTOUPDATER). Defaults: auto, 5m, pinned.
  defaultCacheTtl?: CacheTtl
  subagentCacheTtl?: CacheTtl
  pinClaudeVersion?: boolean
  crewId: number
  crewFolder: string
  pluginDir: string
  // <userData>/launch (settings and MCP files) and <userData>/roles.
  launchDir: string
  rolesDir: string
  // plugin/roles/_common.md.
  commonRoleText: string
  // The role text of the operator's preset (shipped file already read); an operator's own text wins.
  presetRoleText: string
  codegraphIndexed: boolean
  codegraphCommand?: { command: string; args: string[] }
  sessionId: string
  // Flags this install's `claude --help` lists; unlisted ones are left out. Default: all of CLAUDE_FLAGS.
  supported?: ReadonlySet<string>
  operantCli?: string
  operantNode?: string
  // Codex: point the operator at its role file after launch. Default off.
  codexSendRole?: boolean
}

const MODEL_RE = /^[a-z0-9][a-z0-9.\-[\]]{0,63}$/
const TOOL_RE = /^[A-Za-z]{1,40}$/
const RULE_RE = /^[A-Za-z][A-Za-z0-9_]{0,60}(\([^\0\r\n]{1,300}\))?$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
// 'auto' is left out on purpose: its classifier calls cost tokens. Only the Master Terminal accepts it (MASTER_MODES).
const MODES = ['acceptEdits', 'bypassPermissions', 'manual', 'dontAsk', 'plan']
// Only the Master Terminal may use 'auto' (unattended PM work); its classifier calls cost some tokens, so it is never a default.
const MASTER_MODES = [...MODES, 'auto']
const TTLS = ['auto', '5m', '1h']
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\0-\x1f\x7f]/

const CAP_MIN = 100_000
const CAP_MAX = 1_000_000

// OpenCode ids are `provider/model` (slashes, dots, colons, underscores, plus signs).
const OPENCODE_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:+/@\-]{0,127}$/

function checkModel(model: string, agent?: string): string {
  const re = agent === 'opencode' ? OPENCODE_MODEL_RE : MODEL_RE
  if (typeof model !== 'string' || !re.test(model) || (agent === 'opencode' && model.includes('..'))) throw new LaunchError('model', `invalid model id ${JSON.stringify(String(model).slice(0, 40))}`)
  return model
}

// OpenCode's effort is a per-model --variant name.
const VARIANT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/

function checkEffort(effort: string, agent?: string): string {
  if (agent === 'opencode') {
    if (typeof effort !== 'string' || (effort !== '' && !VARIANT_RE.test(effort))) throw new LaunchError('effort', 'invalid variant name')
    return effort
  }
  if (typeof effort !== 'string' || effort !== '' && !EFFORTS.includes(effort)) throw new LaunchError('effort', `must be one of ${EFFORTS.join(', ')}`)
  return effort
}

function checkMode(mode: string, master = false): string {
  const modes = master ? MASTER_MODES : MODES
  if (typeof mode !== 'string' || !modes.includes(mode)) throw new LaunchError('permissionMode', `must be one of ${modes.join(', ')}`)
  return mode
}

function checkTools(tools: string): string[] {
  if (typeof tools !== 'string') throw new LaunchError('tools', 'must be a string')
  if (tools === '') return []
  const names = tools.split(',')
  for (const n of names) if (!TOOL_RE.test(n)) throw new LaunchError('tools', `invalid tool name ${JSON.stringify(n.slice(0, 40))}`)
  return names
}

function checkRules(field: 'allow' | 'deny', rules: string[]): string[] {
  if (rules.length > 100) throw new LaunchError(field, 'too many rules')
  for (const r of rules) if (typeof r !== 'string' || !RULE_RE.test(r)) throw new LaunchError(field, `invalid rule ${JSON.stringify(r.slice(0, 60))}`)
  return rules
}

function checkTtl(ttl: string): string {
  if (typeof ttl !== 'string' || !TTLS.includes(ttl)) throw new LaunchError('cacheTtl', `must be one of ${TTLS.join(', ')}`)
  return ttl
}

function checkCap(cap: number): number {
  if (!Number.isInteger(cap) || (cap !== 0 && (cap < CAP_MIN || cap > CAP_MAX))) throw new LaunchError('contextCap', `must be 0 or ${CAP_MIN}..${CAP_MAX}`)
  return cap
}

const AGENT_KINDS: readonly string[] = ['claude', 'opencode', 'codex', 'shell']
export const MASTER_CLIS: readonly MasterCli[] = ['claude', 'opencode']

// A Master or a seat runs on Claude or OpenCode only.
export function validateMasterCli(cli: unknown, field = 'masterCli'): MasterCli {
  if (cli !== 'claude' && cli !== 'opencode') throw new LaunchError(field, 'must be claude or opencode')
  return cli
}

// Whether a model id is acceptable on the command line.
export function validateModel(model: string, agent?: string): string {
  return checkModel(model, agent)
}

// Checks the launch fields present in `patch` with the same rules the launch builders apply, so a bad
// value is refused when it is saved instead of when the operator starts.
export function validateLaunchSettings(patch: Partial<LaunchSettings>, master = false): void {
  const agent = patch.agent
  if (agent !== undefined && !AGENT_KINDS.includes(agent)) throw new LaunchError('agent', 'must be claude, opencode, codex or shell')
  if (patch.model !== undefined && agent !== 'shell' && patch.model !== '') checkModel(patch.model, agent)
  if (patch.effort !== undefined) checkEffort(patch.effort, agent)
  if (patch.permissionMode !== undefined && patch.permissionMode !== '') checkMode(patch.permissionMode, master)
  if (patch.tools !== undefined) checkTools(patch.tools)
  if (patch.allow !== undefined) checkRules('allow', patch.allow)
  if (patch.deny !== undefined) checkRules('deny', patch.deny)
  if (patch.cacheTtl !== undefined) checkTtl(patch.cacheTtl)
  if (patch.contextCap !== undefined) checkCap(patch.contextCap)
  if (patch.clearBetweenJobs !== undefined && typeof patch.clearBetweenJobs !== 'boolean') throw new LaunchError('clearBetweenJobs', 'must be true or false')
  if (patch.mcp !== undefined && patch.mcp !== 'codegraph' && patch.mcp !== 'none') throw new LaunchError('mcp', 'must be codegraph or none')
}

function checkSessionId(id: string): string {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new LaunchError('sessionId', 'must be a UUID')
  return id
}

function checkPath(field: string, p: string): string {
  if (typeof p !== 'string' || p === '' || CONTROL_RE.test(p)) throw new LaunchError(field, 'invalid path')
  return p
}

function checkId(field: string, n: number): number {
  if (!Number.isInteger(n) || n < 0) throw new LaunchError(field, 'invalid id')
  return n
}

// Shipped role file (plugin/roles/) for each built-in preset key as seeded in store.ts.
export const ROLE_FILE_BY_PRESET: Record<string, string> = {
  pm: 'project-manager.md',
  researcher: 'researcher.md',
  designer: 'designer.md',
  implementor: 'implementor.md',
  senior: 'senior-implementor.md',
  tester: 'tester.md',
  reviewer: 'reviewer.md',
}

export const capFlag = (cap: number): string => (cap === 1_000_000 ? '1M' : `${Math.round(cap / 1000)}k`)

export const isHaiku = (model: string): boolean => model.startsWith('claude-haiku')

export const shellOf = (ctx: Pick<LaunchContext, 'shell' | 'platform'>): ShellKind => ctx.shell ?? (ctx.platform === 'win32' ? 'powershell' : 'sh')

const CMD_UNSUPPORTED = 'cmd.exe is not supported for launching agents: set Settings > Shell to PowerShell or sh'

function assertShell(ctx: Pick<LaunchContext, 'shell' | 'platform'>): void {
  if (shellOf(ctx) === 'cmd') throw new LaunchError('shell', CMD_UNSUPPORTED)
}
const pathOf = (ctx: LaunchContext) => (ctx.platform === 'win32' ? win32 : posix)

const SAFE_ARG = /^[A-Za-z0-9_./:+=@-]+$/

export function quoteArg(arg: string, shell: ShellKind): string {
  if (shell === 'cmd') throw new LaunchError('shell', CMD_UNSUPPORTED)
  if (CONTROL_RE.test(arg)) throw new LaunchError('argument', 'control characters are not allowed')
  if (arg !== '' && SAFE_ARG.test(arg)) return arg
  if (shell === 'powershell') return `'${arg.replace(/['‘’‚‛]/g, (c) => c + c)}'`
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

// The line typed into the operator's shell. Single quotes switch off expansion in both shells.
export function commandLine(launch: Pick<LaunchResult, 'file' | 'args'>, shell: ShellKind): string | null {
  if (!launch.file) return null
  return [launch.file, ...launch.args.map((a) => quoteArg(a, shell))].join(' ')
}

const stable = (o: unknown): string => JSON.stringify(o, null, 2) + '\n'

function mcpFile(withCodegraph: boolean, ctx: LaunchContext, p: typeof posix): LaunchFile {
  const cg = ctx.codegraphCommand ?? { command: 'codegraph', args: ['serve', '--mcp'] }
  const mcpServers = withCodegraph ? { codegraph: { command: cg.command, args: cg.args } } : {}
  return { path: p.join(ctx.launchDir, `crew-${checkId('crewId', ctx.crewId)}-mcp.json`), content: stable({ mcpServers }) }
}

function settingsFile(name: string, allow: string[], deny: string[], ctx: LaunchContext, p: typeof posix): LaunchFile {
  return { path: p.join(ctx.launchDir, `${name}.json`), content: stable({ permissions: { allow, deny } }) }
}

function roleFile(key: string, text: string, ctx: LaunchContext, p: typeof posix): LaunchFile {
  const lf = (s: string): string => s.replace(/\r\n/g, '\n')
  const content = `${lf(ctx.commonRoleText).trimEnd()}\n\n${lf(text).trim()}\n`
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 12)
  return { path: p.join(ctx.rolesDir, `${key}-${hash}.md`), content }
}

function operantEnv(ctx: LaunchContext): Record<string, string> {
  const env: Record<string, string> = { OPERANT_SOCKET: SOCKET_PLACEHOLDER, OPERANT_TOKEN: TOKEN_PLACEHOLDER }
  if (ctx.operantCli) env.OPERANT_CLI = checkPath('operantCli', ctx.operantCli)
  if (ctx.operantNode) env.OPERANT_NODE = checkPath('operantNode', ctx.operantNode)
  return env
}

export type LaunchSource = Preset | Partial<LaunchSettings> | null

type Effective = LaunchSettings & { roleText: string | null }

function effective(operator: Operator, source: LaunchSource): Effective {
  const merged: Effective = {
    agent: operator.agent,
    model: operator.model,
    effort: operator.effort,
    permissionMode: operator.permissionMode,
    tools: operator.tools,
    allow: operator.allow,
    deny: operator.deny,
    cacheTtl: operator.cacheTtl,
    contextCap: operator.contextCap,
    clearBetweenJobs: operator.clearBetweenJobs,
    mcp: operator.mcp,
    roleText: operator.roleText,
  }
  // A Preset only supplies the role text and file key; plain overrides replace the operator's own fields.
  if (source && !('id' in source)) {
    for (const [k, v] of Object.entries(source)) {
      if (v === undefined || k === 'roleText' || k === 'id' || k === 'builtin' || k === 'name' || k === 'updatedAt') continue
      ;(merged as unknown as Record<string, unknown>)[k] = v
    }
  }
  return merged
}

function roleKey(operator: Operator, source: LaunchSource): string {
  if (operator.roleText != null) return `op${checkId('operatorId', operator.id)}`
  const preset = source as Preset | null
  if (preset && 'id' in preset && typeof preset.id === 'number') {
    if (preset.builtin == null) return `p${checkId('presetId', preset.id)}`
    if (!/^[a-z0-9-]+$/.test(preset.builtin)) throw new LaunchError('builtin', 'invalid built-in id')
    return preset.builtin
  }
  if (operator.presetId != null) return `p${checkId('presetId', operator.presetId)}`
  return `op${checkId('operatorId', operator.id)}`
}

interface ClaudeParts {
  settings: LaunchSettings
  settingsName: string
  role: { key: string; text: string } | null
  mcp: boolean
  pluginDir: boolean
  token: boolean
  resume?: string
  cwd: string
  ttlEnv: boolean
}

function claudeCore(parts: ClaudeParts, ctx: LaunchContext): LaunchResult {
  assertShell(ctx)
  const p = pathOf(ctx)
  const s = parts.settings
  const model = checkModel(s.model)
  const effort = checkEffort(s.effort)
  const tools = checkTools(s.tools)
  const ttl = checkTtl(s.cacheTtl === 'auto' ? (ctx.defaultCacheTtl ?? 'auto') : s.cacheTtl)
  const subagentTtl = checkTtl(ctx.subagentCacheTtl ?? '5m')
  const cap = checkCap(s.contextCap)
  const sessionId = checkSessionId(parts.resume ?? ctx.sessionId)
  const allow = checkRules('allow', s.allow)
  const deny = checkRules('deny', s.deny)
  const cwd = checkPath('crewFolder', parts.cwd)
  checkPath('pluginDir', ctx.pluginDir)
  checkPath('launchDir', ctx.launchDir)
  checkPath('rolesDir', ctx.rolesDir)

  const files: LaunchFile[] = []
  const args: string[] = []
  const supported = ctx.supported
  const add = (flag: string, value?: string) => {
    if (supported && !supported.has(flag)) return
    args.push(flag)
    if (value !== undefined) args.push(value)
  }

  add('--model', model)
  if (effort && !isHaiku(model)) add('--effort', effort)
  if (s.permissionMode !== '') add('--permission-mode', checkMode(s.permissionMode))
  if (tools.length) add('--tools', tools.join(','))
  if (parts.settingsName) {
    const f = settingsFile(parts.settingsName, allow, deny, ctx, p)
    files.push(f)
    add('--settings', f.path)
  }
  if (parts.role) {
    const f = roleFile(parts.role.key, parts.role.text, ctx, p)
    files.push(f)
    add('--append-system-prompt-file', f.path)
  }
  if (parts.mcp) {
    const f = mcpFile(s.mcp === 'codegraph' && ctx.codegraphIndexed, ctx, p)
    files.push(f)
    add('--strict-mcp-config')
    add('--mcp-config', f.path)
  }
  if (cap) add('--autocompact', capFlag(cap))
  if (parts.pluginDir) add('--plugin-dir', ctx.pluginDir)
  if (parts.resume) add('--resume', sessionId)
  else add('--session-id', sessionId)

  const env: Record<string, string> = {}
  if (parts.ttlEnv) {
    if (ttl !== 'auto') env.CLAUDE_CODE_PROMPT_CACHE_TTL = ttl
    if (subagentTtl !== 'auto') env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL = subagentTtl
    if (cap) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = capFlag(cap)
    if (ctx.pinClaudeVersion !== false) env.DISABLE_AUTOUPDATER = '1'
  }
  if (parts.token) Object.assign(env, operantEnv(ctx))
  return { file: 'claude', args, env, files, cwd, firstInput: null }
}

function operatorParts(operator: Operator, source: LaunchSource, ctx: LaunchContext, resume?: string): ClaudeParts {
  const settings = effective(operator, source)
  if (settings.permissionMode === '') throw new LaunchError('permissionMode', 'operators need an explicit permission mode')
  const roleText = operator.roleText ?? (source && 'roleText' in source && source.roleText != null ? source.roleText : ctx.presetRoleText)
  return {
    settings,
    settingsName: `op-${checkId('operatorId', operator.id)}`,
    role: { key: roleKey(operator, source), text: roleText },
    mcp: true,
    pluginDir: true,
    token: true,
    ttlEnv: true,
    resume,
    cwd: ctx.crewFolder,
  }
}

export function buildClaudeLaunch(operator: Operator, source: LaunchSource, ctx: LaunchContext): LaunchResult {
  return claudeCore(operatorParts(operator, source, ctx), ctx)
}

// Same settings, relaunched with the conversation kept (tool, role and MCP changes still cost a cold cache).
export function buildClaudeResume(operator: Operator, source: LaunchSource, ctx: LaunchContext, sessionId: string): LaunchResult {
  return claudeCore(operatorParts(operator, source, ctx, sessionId), ctx)
}

// Codex: model flag only (ruling R3). Effort, instruction file and resume are not available.
export function buildCodexLaunch(operator: Operator, source: LaunchSource, ctx: LaunchContext): LaunchResult {
  assertShell(ctx)
  const eff = effective(operator, source)
  const model = checkModel(eff.model)
  const cwd = checkPath('crewFolder', ctx.crewFolder)
  const files: LaunchFile[] = []
  let firstInput: string | null = null
  if (ctx.codexSendRole) {
    checkPath('rolesDir', ctx.rolesDir)
    const roleText = operator.roleText ?? (source && 'roleText' in source && source.roleText != null ? source.roleText : ctx.presetRoleText)
    const f = roleFile(roleKey(operator, source), roleText, ctx, pathOf(ctx))
    files.push(f)
    firstInput = `Read ${f.path} and follow it as your role.`
  }
  return { file: 'codex', args: ['-m', model], env: operantEnv(ctx), files, cwd, firstInput }
}

export function buildAgentLaunch(operator: Operator, source: LaunchSource, ctx: LaunchContext): LaunchResult | null {
  const agent: AgentKind = (source && 'agent' in source && source.agent) || operator.agent
  if (agent === 'claude') return buildClaudeLaunch(operator, source, ctx)
  if (agent === 'codex') return buildCodexLaunch(operator, source, ctx)
  return null
}

// The Master Terminal: the user's ordinary interactive Claude Code, no preset or role file. The only
// settings Operant adds are the ones edited on the Master slot (model, effort, permission mode); empty
// (or 'default') means Claude Code's own default.
// What prepareMaster (core/master-plugin.ts) made for the launch: the PM role file, the generated plugin dir and the MCP union.
export interface MasterLaunchPrep {
  role: LaunchFile
  pluginDir?: string | null
  mcpConfigPath?: string | null
  // Relaunch the conversation (--resume) instead of starting a new session id.
  resume?: boolean
}

export function buildMasterLaunch(ctx: LaunchContext, master?: Pick<Operator, 'model' | 'effort' | 'permissionMode'>, prep?: MasterLaunchPrep): LaunchResult {
  assertShell(ctx)
  const sessionId = checkSessionId(ctx.sessionId)
  const supported = ctx.supported
  const args: string[] = []
  const add = (flag: string, value: string) => {
    if (!supported || supported.has(flag)) args.push(flag, value)
  }
  if (master?.model) add('--model', checkModel(master.model))
  if (master?.effort && !isHaiku(master.model)) add('--effort', checkEffort(master.effort))
  if (master?.permissionMode && master.permissionMode !== 'default') add('--permission-mode', checkMode(master.permissionMode, true))
  if (prep) add('--append-system-prompt-file', checkPath('role', prep.role.path))
  add('--plugin-dir', checkPath('pluginDir', ctx.pluginDir))
  if (prep?.pluginDir) add('--plugin-dir', checkPath('masterPluginDir', prep.pluginDir))
  // Not strict: the owner's own MCP servers stay available to the Master.
  if (prep?.mcpConfigPath) add('--mcp-config', checkPath('mcpConfig', prep.mcpConfigPath))
  add(prep?.resume ? '--resume' : '--session-id', sessionId)
  return { file: 'claude', args, env: operantEnv(ctx), files: prep ? [prep.role] : [], cwd: checkPath('crewFolder', ctx.crewFolder), firstInput: null }
}

// The Master Terminal on OpenCode: its TUI in the project folder, with --model provider/model when one is set.
// With `prep`, its first line points the TUI at the PM role file (the one fixed pointer line Operant types).
// With `prep.resume`, --continue reopens the last session of the folder, which already read its role (no pointer line).
export function buildOpenCodeMasterLaunch(ctx: LaunchContext, model = '', prep?: Pick<MasterLaunchPrep, 'role' | 'resume'>): LaunchResult {
  assertShell(ctx)
  const args = model ? ['--model', checkModel(model, 'opencode')] : []
  if (prep?.resume) args.push('--continue')
  const role = prep && !prep.resume ? checkPath('role', prep.role.path) : null
  return { file: 'opencode', args, env: operantEnv(ctx), files: prep ? [prep.role] : [], cwd: checkPath('crewFolder', ctx.crewFolder), firstInput: role ? `Read ${role} and follow it as your role.` : null }
}

export interface RunLaunch {
  file: 'claude'
  args: string[]
  cwd: string
}

// A job on the Claude Master: one non-interactive `claude -p` run whose events stream as JSON lines. The
// prompt is written to its stdin, never put on the command line.
export function buildClaudeRunLaunch(
  run: { cwd: string; model?: string; effort?: string; permissionMode?: string; mcpConfig?: string; settingsFile?: string },
  ctx: Pick<LaunchContext, 'supported'> = {},
): RunLaunch {
  const args: string[] = ['-p', '--output-format', 'stream-json', '--verbose']
  const add = (flag: string, value: string) => {
    if (!ctx.supported || ctx.supported.has(flag)) args.push(flag, value)
  }
  if (run.model) add('--model', checkModel(run.model))
  if (run.effort && !isHaiku(run.model ?? '')) add('--effort', checkEffort(run.effort))
  if (run.permissionMode && run.permissionMode !== 'default') add('--permission-mode', checkMode(run.permissionMode))
  if (run.mcpConfig && (!ctx.supported || ctx.supported.has('--mcp-config'))) {
    args.push('--strict-mcp-config', '--mcp-config', checkPath('mcpConfig', run.mcpConfig))
  }
  // A settings file that turns every hook off (the user's and plugins'); quoted because the spawn goes through a shell.
  if (run.settingsFile) add('--settings', `"${checkPath('settingsFile', run.settingsFile)}"`)
  return { file: 'claude', args, cwd: checkPath('cwd', run.cwd) }
}

export interface ScratchOptions {
  // Preset or custom launch settings applied to a Claude tile (permission mode, tools, rules, cap, TTL).
  settings?: Partial<LaunchSettings>
  // Reopen the previous conversation instead of starting a new session.
  resume?: boolean
}

// Scratch tiles carry no Operant token, plugin or role text. A shell tile has nothing to type.
export function buildScratchLaunch(scratch: ScratchTerminal, ctx: LaunchContext, opts: ScratchOptions = {}): LaunchResult {
  const cwd = checkPath('cwd', scratch.cwd)
  if (scratch.agent === 'shell') return { file: null, args: [], env: {}, files: [], cwd, firstInput: null }
  assertShell(ctx)
  if (scratch.agent === 'codex') return { file: 'codex', args: ['-m', checkModel(scratch.model)], env: {}, files: [], cwd, firstInput: null }
  checkId('scratchId', scratch.id)
  const s = opts.settings ?? {}
  const settings: LaunchSettings = {
    agent: 'claude',
    model: scratch.model,
    effort: scratch.effort,
    permissionMode: s.permissionMode ?? '',
    tools: s.tools ?? '',
    allow: s.allow ?? [],
    deny: s.deny ?? [],
    cacheTtl: s.cacheTtl ?? 'auto',
    contextCap: s.contextCap ?? 0,
    clearBetweenJobs: false,
    mcp: 'none',
  }
  const hasRules = settings.allow.length > 0 || settings.deny.length > 0
  const resume = opts.resume && scratch.sessionId ? scratch.sessionId : undefined
  return claudeCore(
    {
      settings,
      settingsName: hasRules ? `scratch-${scratch.id}` : '',
      role: null,
      mcp: false,
      pluginDir: false,
      token: false,
      ttlEnv: false,
      resume,
      cwd,
    },
    { ...ctx, sessionId: scratch.sessionId ?? ctx.sessionId },
  )
}

export interface LaunchWriter {
  mkdir(dir: string): void
  writeFile(path: string, content: string): void
}

// Identical role text gives an identical path, so rewriting is harmless.
export function writeLaunchFiles(files: LaunchFile[], w: LaunchWriter): void {
  const seen = new Set<string>()
  for (const f of files) {
    const dir = f.path.replace(/[\\/][^\\/]*$/, '')
    if (!seen.has(dir)) {
      w.mkdir(dir)
      seen.add(dir)
    }
    w.writeFile(f.path, f.content)
  }
}

export type NewSettings = Partial<LaunchSettings> & {
  role?: string
  squadId?: number
  dailyCapUsd?: number | null
  roleText?: string | null
}

export interface PlanInputs {
  running: boolean
  // Current context size of the running session.
  contextTokens: number
  // Last session's first-turn cache write; used for a fresh restart (model or effort change) when known.
  firstTurnCacheWriteTokens?: number
}

export interface ChangePlan {
  requiresRestart: boolean
  // Present only when effort changes. 'conversation-lost': a fresh relaunch (R1). 'cache-kept': nothing is running, so nothing is lost.
  effort?: 'cache-kept' | 'conversation-lost'
  // Present only when the model changes.
  model?: 'cache-lost'
  // Relaunch may use --resume: only when neither model nor effort changes.
  canResume: boolean
  // Launch fields that differ, and ones applied live.
  restartFields: string[]
  liveFields: string[]
  estimateColdCostUsd?: number
}

const LIVE_KEYS = ['role', 'squadId', 'dailyCapUsd', 'clearBetweenJobs'] as const
const RESTART_KEYS = ['permissionMode', 'tools', 'allow', 'deny', 'cacheTtl', 'contextCap', 'mcp', 'roleText'] as const

const differs = (a: unknown, b: unknown): boolean => JSON.stringify(a) !== JSON.stringify(b)

export function planChange(operator: Operator, next: NewSettings, inputs: PlanInputs): ChangePlan {
  const cur = operator as unknown as Record<string, unknown>
  const nx = next as Record<string, unknown>
  const changed = (k: string) => k in nx && nx[k] !== undefined && differs(nx[k], cur[k])

  const liveFields: string[] = LIVE_KEYS.filter(changed)
  const restartFields: string[] = []
  const claude = operator.agent === 'claude'

  const modelChanged = changed('model')
  const effortChanged = claude && changed('effort') && !isHaiku(String(next.model ?? operator.model))
  const agentChanged = changed('agent')
  if (agentChanged) restartFields.push('agent')
  if (modelChanged) restartFields.push('model')
  if (effortChanged) restartFields.push('effort')
  // Codex takes only the model flag; every other launch field is inert for it.
  if (claude) for (const k of RESTART_KEYS) if (changed(k)) restartFields.push(k)

  const plan: ChangePlan = {
    requiresRestart: inputs.running && restartFields.length > 0,
    canResume: claude && !modelChanged && !effortChanged && !agentChanged,
    restartFields,
    liveFields,
  }
  if (effortChanged) plan.effort = inputs.running ? 'conversation-lost' : 'cache-kept'
  if (modelChanged) plan.model = 'cache-lost'

  if (plan.requiresRestart && claude) {
    const model = String(next.model ?? operator.model)
    const rate = rateFor(model)
    const ttl = String(next.cacheTtl ?? operator.cacheTtl)
    const fresh = modelChanged || effortChanged
    const tokens = fresh && inputs.firstTurnCacheWriteTokens ? inputs.firstTurnCacheWriteTokens : inputs.contextTokens
    if (rate && tokens > 0) {
      const mult = ttl === '1h' ? 2 : 1.25
      plan.estimateColdCostUsd = (tokens * rate.input * mult) / 1_000_000
    }
  }
  return plan
}
