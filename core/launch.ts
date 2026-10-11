import { createHash } from 'node:crypto'
import { posix, win32 } from 'node:path'
import type { CacheTtl, LaunchSettings, Preset, ScratchTerminal } from '../shared/types'

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
  '--input-format',
  '--output-format',
  '--include-partial-messages',
  '--include-hook-events',
  '--forward-subagent-text',
  '--verbose',
  '--permission-prompt-tool',
  '--allow-dangerously-skip-permissions',
] as const

export interface LaunchContext {
  platform: NodeJS.Platform
  // Defaults from the platform (PowerShell on Windows, sh elsewhere).
  shell?: ShellKind
  // Settings > Tokens: the TTL when a tile's own is 'auto', the sub-agent TTL, and whether the Claude
  // Code version is pinned (DISABLE_AUTOUPDATER). Defaults: auto, 5m, pinned.
  defaultCacheTtl?: CacheTtl
  subagentCacheTtl?: CacheTtl
  pinClaudeVersion?: boolean
  crewId: number
  crewFolder: string
  pluginDir: string
  // <userData>/launch (settings files) and <userData>/roles (preset guidance files).
  launchDir: string
  rolesDir: string
  sessionId: string
  // Flags this install's `claude --help` lists; unlisted ones are left out. Default: all of CLAUDE_FLAGS.
  supported?: ReadonlySet<string>
  operantCli?: string
  operantNode?: string
  // Claude Code hooks and status line (claude-events.ts), written into a Claude tile's settings file next to its permissions.
  mods?: Record<string, unknown>
  // The plugin folders of the enabled native Claude mods (plugin/mods/<id>), one --plugin-dir each.
  modPlugins?: string[]
  // The embedded browser's MCP endpoint. The config file holds no secret: Claude expands ${OPERANT_TOKEN} from the tile's env.
  browserMcp?: { url: string }
}

const MODEL_RE = /^[a-z0-9][a-z0-9.\-[\]]{0,63}$/
const TOOL_RE = /^[A-Za-z]{1,40}$/
const RULE_RE = /^[A-Za-z][A-Za-z0-9_]{0,60}(\([^\0\r\n]{1,300}\))?$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const MODES = ['acceptEdits', 'bypassPermissions', 'manual', 'dontAsk', 'plan']
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

function checkMode(mode: string): string {
  const modes = MODES
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

// Whether a model id is acceptable on the command line.
export function validateModel(model: string, agent?: string): string {
  return checkModel(model, agent)
}

// Checks the launch fields present in `patch` with the same rules the launch builders apply, so a bad
// value is refused when it is saved instead of when the tile starts.
export function validateLaunchSettings(patch: Partial<LaunchSettings>): void {
  const agent = patch.agent
  if (agent !== undefined && !AGENT_KINDS.includes(agent)) throw new LaunchError('agent', 'must be claude, opencode, codex or shell')
  if (patch.model !== undefined && agent !== 'shell' && patch.model !== '') checkModel(patch.model, agent)
  if (patch.effort !== undefined) checkEffort(patch.effort, agent)
  if (patch.permissionMode !== undefined && patch.permissionMode !== '') checkMode(patch.permissionMode)
  if (patch.tools !== undefined) checkTools(patch.tools)
  if (patch.allow !== undefined) checkRules('allow', patch.allow)
  if (patch.deny !== undefined) checkRules('deny', patch.deny)
  if (patch.cacheTtl !== undefined) checkTtl(patch.cacheTtl)
  if (patch.contextCap !== undefined) checkCap(patch.contextCap)
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

export const capFlag = (cap: number): string => (cap === 1_000_000 ? '1M' : `${Math.round(cap / 1000)}k`)

// Haiku 4.5 is the only Claude model without --effort; Haiku 5.5 takes it.
export const noEffort = (model: string): boolean => model.startsWith('claude-haiku-4')

export const E2E_CLAUDE_MODEL = 'claude-haiku-5-5'

// e2e runs use the real Claude CLI, always on Haiku 5.5 (cheap); anywhere else the model is unchanged.
export function e2eClaudeModel<T extends string | undefined>(model: T, env: NodeJS.ProcessEnv = process.env): T | typeof E2E_CLAUDE_MODEL {
  return env.OPERANT_E2E ? E2E_CLAUDE_MODEL : model
}

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

// The line typed into the tile's shell. Single quotes switch off expansion in both shells.
export function commandLine(launch: Pick<LaunchResult, 'file' | 'args'>, shell: ShellKind): string | null {
  if (!launch.file) return null
  return [launch.file, ...launch.args.map((a) => quoteArg(a, shell))].join(' ')
}

const stable = (o: unknown): string => JSON.stringify(o, null, 2) + '\n'

function settingsFile(name: string, allow: string[], deny: string[], ctx: LaunchContext, p: typeof posix): LaunchFile {
  return { path: p.join(ctx.launchDir, `${name}.json`), content: stable({ permissions: { allow, deny }, ...ctx.mods }) }
}

// A preset's guidance text, written once per distinct text (identical text gives an identical path).
function guidanceFile(key: string, text: string, ctx: LaunchContext, p: typeof posix): LaunchFile {
  const content = `${text.replace(/\r\n/g, '\n').trim()}\n`
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 12)
  return { path: p.join(ctx.rolesDir, `${key}-${hash}.md`), content }
}

function operantEnv(ctx: LaunchContext): Record<string, string> {
  const env: Record<string, string> = { OPERANT_SOCKET: SOCKET_PLACEHOLDER, OPERANT_TOKEN: TOKEN_PLACEHOLDER }
  if (ctx.operantCli) env.OPERANT_CLI = checkPath('operantCli', ctx.operantCli)
  if (ctx.operantNode) env.OPERANT_NODE = checkPath('operantNode', ctx.operantNode)
  return env
}

interface ClaudeParts {
  settings: LaunchSettings
  settingsName: string
  guidance: LaunchFile | null
  resume?: string
  cwd: string
}

// A Claude Code tile: its settings file, its guidance (a preset's text), the Operant plugin dir (memory skill)
// and the CLI socket and token for `operant memory.*`.
function claudeCore(parts: ClaudeParts, ctx: LaunchContext): LaunchResult {
  assertShell(ctx)
  const p = pathOf(ctx)
  const s = parts.settings
  const model = e2eClaudeModel(checkModel(s.model))
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

  const files: LaunchFile[] = []
  const args: string[] = []
  const supported = ctx.supported
  const add = (flag: string, value?: string) => {
    if (supported && !supported.has(flag)) return
    args.push(flag)
    if (value !== undefined) args.push(value)
  }

  add('--model', model)
  if (effort && !noEffort(model)) add('--effort', effort)
  if (s.permissionMode !== '') add('--permission-mode', checkMode(s.permissionMode))
  if (tools.length) add('--tools', tools.join(','))
  if (parts.settingsName) {
    const f = settingsFile(parts.settingsName, allow, deny, ctx, p)
    files.push(f)
    add('--settings', f.path)
  }
  if (parts.guidance) {
    files.push(parts.guidance)
    add('--append-system-prompt-file', parts.guidance.path)
  }
  if (cap) add('--autocompact', capFlag(cap))
  if (ctx.browserMcp && (!supported || supported.has('--mcp-config'))) {
    const url = checkPath('browserMcp', ctx.browserMcp.url)
    const f: LaunchFile = {
      path: p.join(ctx.launchDir, 'browser-mcp.json'),
      content: stable({ mcpServers: { 'operant-browser': { type: 'http', url, headers: { Authorization: 'Bearer ${OPERANT_TOKEN}' } } } }),
    }
    files.push(f)
    add('--mcp-config', f.path)
  }
  add('--plugin-dir', ctx.pluginDir)
  for (const dir of ctx.modPlugins ?? []) add('--plugin-dir', checkPath('modPlugin', dir))
  if (parts.resume) add('--resume', sessionId)
  else add('--session-id', sessionId)

  const env: Record<string, string> = {}
  if (ttl !== 'auto') env.CLAUDE_CODE_PROMPT_CACHE_TTL = ttl
  if (subagentTtl !== 'auto') env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL = subagentTtl
  if (cap) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = capFlag(cap)
  if (ctx.pinClaudeVersion !== false) env.DISABLE_AUTOUPDATER = '1'
  Object.assign(env, operantEnv(ctx))
  return { file: 'claude', args, env, files, cwd }
}

export interface ScratchOptions {
  // The preset whose settings and guidance text the tile takes (permission mode, tools, rules, cap, TTL, text).
  preset?: Preset | null
  // Reopen the previous conversation instead of starting a new session.
  resume?: boolean
}

// Scratch tiles: a shell has nothing to type; Claude Code and Codex start with the tile's model; OpenCode starts its
// TUI in the folder (its model rides its own config, as OpenCode v2 rejects --model).
export function buildScratchLaunch(scratch: ScratchTerminal, ctx: LaunchContext, opts: ScratchOptions = {}): LaunchResult {
  const cwd = checkPath('cwd', scratch.cwd)
  if (scratch.agent === 'shell') return { file: null, args: [], env: {}, files: [], cwd }
  assertShell(ctx)
  if (scratch.agent === 'codex') return { file: 'codex', args: ['-m', checkModel(scratch.model)], env: operantEnv(ctx), files: [], cwd }
  if (scratch.agent === 'opencode') {
    const env: Record<string, string> = { ...operantEnv(ctx), OPENCODE_CLI_CONFIG_CONTENT: OPENCODE_CLI_OVERLAY }
    const config = opencodeConfigContent(ctx)
    if (config) env.OPENCODE_CONFIG_CONTENT = config
    return { file: 'opencode', args: [], env, files: [], cwd }
  }
  checkId('scratchId', scratch.id)
  const preset = opts.preset ?? null
  const settings: LaunchSettings = {
    agent: 'claude',
    model: scratch.model,
    effort: scratch.effort,
    permissionMode: preset?.permissionMode ?? '',
    tools: preset?.tools ?? '',
    allow: preset?.allow ?? [],
    deny: preset?.deny ?? [],
    cacheTtl: preset?.cacheTtl ?? 'auto',
    contextCap: preset?.contextCap ?? 0,
    mcp: 'none',
  }
  const hasRules = settings.allow.length > 0 || settings.deny.length > 0
  const guidance = preset?.roleText?.trim() ? guidanceFile(`p${checkId('presetId', preset.id)}`, preset.roleText, ctx, pathOf(ctx)) : null
  const resume = opts.resume && scratch.sessionId ? scratch.sessionId : undefined
  return claudeCore({ settings, settingsName: hasRules || ctx.mods ? `scratch-${scratch.id}` : '', guidance, resume, cwd }, { ...ctx, sessionId: scratch.sessionId ?? ctx.sessionId })
}

// OpenCode's TUI in a tile: its own session tabs are off (OpenCode merges this overlay over the owner's cli.json).
const OPENCODE_CLI_OVERLAY = JSON.stringify({ tabs: { mode: 'off' } })

// OpenCode's config overlay (OPENCODE_CONFIG_CONTENT): the embedded browser as a remote MCP server. The token never reaches
// disk or this string: OpenCode expands {env:OPERANT_TOKEN} from the tile's env. `base` is an existing overlay to merge into.
export function opencodeConfigContent(ctx: Pick<LaunchContext, 'browserMcp'>, base?: string): string | null {
  if (!ctx.browserMcp) return base ?? null
  const url = checkPath('browserMcp', ctx.browserMcp.url)
  let cfg: Record<string, unknown> = {}
  if (base) {
    try {
      const parsed: unknown = JSON.parse(base)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) cfg = parsed as Record<string, unknown>
    } catch {
      return base
    }
  }
  const mcp = cfg.mcp && typeof cfg.mcp === 'object' && !Array.isArray(cfg.mcp) ? (cfg.mcp as Record<string, unknown>) : {}
  const servers = mcp.servers && typeof mcp.servers === 'object' && !Array.isArray(mcp.servers) ? (mcp.servers as Record<string, unknown>) : {}
  const entry = { type: 'remote', url, headers: { Authorization: 'Bearer {env:OPERANT_TOKEN}' }, disabled: false }
  return JSON.stringify({ ...cfg, mcp: { ...mcp, servers: { ...servers, 'operant-browser': entry } } })
}

// A one-shot model call (learn, skill drafts): one non-interactive `claude -p` run whose events stream as JSON lines.
// The prompt is written to its stdin, never put on the command line.
export interface RunLaunch {
  file: 'claude'
  args: string[]
  cwd: string
}

export function buildClaudeRunLaunch(
  run: { cwd: string; model?: string; effort?: string; permissionMode?: string; settingsFile?: string },
  ctx: Pick<LaunchContext, 'supported'> = {},
): RunLaunch {
  const args: string[] = ['-p', '--output-format', 'stream-json', '--verbose']
  const add = (flag: string, value: string) => {
    if (!ctx.supported || ctx.supported.has(flag)) args.push(flag, value)
  }
  const model = e2eClaudeModel(run.model ? checkModel(run.model) : undefined)
  if (model) add('--model', model)
  if (run.effort && !noEffort(model ?? '')) add('--effort', checkEffort(run.effort))
  if (run.permissionMode && run.permissionMode !== 'default') add('--permission-mode', checkMode(run.permissionMode))
  // A settings file that turns every hook off (the user's and plugins'); quoted because the spawn goes through a shell.
  if (run.settingsFile) add('--settings', `"${checkPath('settingsFile', run.settingsFile)}"`)
  return { file: 'claude', args, cwd: checkPath('cwd', run.cwd) }
}

export interface LaunchWriter {
  mkdir(dir: string): void
  writeFile(path: string, content: string): void
}

// Identical text gives an identical path, so rewriting is harmless.
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

// The flags of a Chat view process: one long-lived `claude -p` that reads stream-json user messages on stdin and writes
// stream-json events on stdout (core/claude-chat.ts). Flags this install's --help does not list are dropped;
// --permission-prompt-tool is hidden from --help, so it is kept whenever --permission-prompts is listed.
export function buildChatLaunch(scratch: ScratchTerminal, ctx: LaunchContext, opts: ScratchOptions = {}): LaunchResult {
  if (scratch.agent !== 'claude') throw new LaunchError('agent', 'the Chat view is for Claude Code tiles')
  const base = buildScratchLaunch(scratch, ctx, opts)
  const supported = ctx.supported
  const has = (flag: string): boolean => !supported || supported.has(flag)
  if (!has('--input-format')) throw new LaunchError('claude', 'Chat needs Claude Code 2.1 or newer')
  const stream: string[] = ['-p', '--input-format', 'stream-json']
  const add = (flag: string, value?: string) => {
    if (!has(flag)) return
    stream.push(flag)
    if (value !== undefined) stream.push(value)
  }
  add('--output-format', 'stream-json')
  add('--verbose')
  add('--include-partial-messages')
  add('--include-hook-events')
  add('--forward-subagent-text')
  if (!supported || supported.has('--permission-prompt-tool') || supported.has('--permission-prompts')) stream.push('--permission-prompt-tool', 'stdio')
  if (opts.preset?.permissionMode === 'bypassPermissions') add('--allow-dangerously-skip-permissions')
  // Chat starts in Auto mode unless a preset sets its own.
  if (!base.args.includes('--permission-mode')) add('--permission-mode', 'auto')
  return { ...base, args: [...stream, ...base.args] }
}
