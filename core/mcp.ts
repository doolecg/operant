import { killTree, spawnHidden } from './proc'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  MCP_MASK,
  type McpCli,
  type McpDown,
  type McpOverview,
  type OptionalMcpEntry,
  type OptionalMcpId,
  type OptionalMcpTarget,
  type McpScope,
  type McpServer,
  type McpServerInput,
  type McpState,
  type McpTransport,
} from '../shared/types'
import type { RunResult } from './hindsight'
import { OPTIONAL_MCP, aliasesOf, isAppAdded, isOptionalMcp, optionalEntry, optionalMcp, writtenKey } from './mcp-optional'

// What the CLIs print and store, as found on this machine (Claude Code 2.x, OpenCode 2.x):
//  claude mcp list   one line per server: `name: command-or-url [(HTTP)] - <mark> <status>` where the mark is
//                    `✔ Connected`, `! Needs authentication`, `✘ Failed to connect — <error>`, `⏸ Pending approval` or
//                    `⊘ Disabled for this project`. Disabling is `disabledMcpServers` in the project's entry of ~/.claude.json
//                    (user and local servers) and `disabledMcpjsonServers`/`enabledMcpjsonServers` in
//                    `<folder>/.claude/settings.local.json` (.mcp.json servers: Claude 2.1 moves them out of ~/.claude.json
//                    on its next run, so only the settings file counts); `claude mcp list` rewrites ~/.claude.json.
//                    It lists plugin and claude.ai connector servers too; it never prints the scope.
//  ~/.claude.json    `mcpServers` (user scope) and `projects["<folder>"].mcpServers` (local scope); `<folder>/.mcp.json`
//                    holds project scope. Entries: { type?, command, args, env } or { type: 'http'|'sse', url, headers }.
//  opencode mcp list `<mark> <name>  <status>` per line, checked on 2.0.24: `✓ name  connected`, `○ name  pending` (still
//                    connecting), `○ name  disabled`, `⚠ name  needs authentication`, `✗ name  failed: <error>` (the error can
//                    wrap onto the next lines). Statuses fill in over the first seconds after a config change: an early call
//                    prints `No MCP servers configured` or only some servers, so a server missing from it is unknown.
//                    Subcommands: list, add, auth, logout (no remove). `add <name> -- <cmd...>` or `--url`; without `--global`
//                    it writes ./opencode.json.
//  opencode.jsonc    `mcp.servers.<name>` here (older versions: `mcp.<name>`): { type: 'local', command: [..], disabled }.
// Unverified here: OpenCode's OPENCODE_CONFIG_CONTENT; it follows the documented format.

export class McpError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpError'
  }
}

export interface McpDeps {
  run: (cmd: string, args: string[], opts: { cwd?: string; timeoutMs: number }) => Promise<RunResult>
  readFile: (path: string) => string | null
  writeFile: (path: string, text: string) => void
  claudeConfig: string
  opencodeGlobal: string[]
  // End-to-end tests only: which runtimes count as present, instead of probing the machine. Null means probe.
  runtimeOverride?: () => Record<string, boolean> | null
}

const quoteWin = (a: string) => `"${a.replace(/"/g, '\\"')}"`

const realRun: McpDeps['run'] = (cmd, args, opts) =>
  new Promise((resolve) => {
    let out = ''
    let err = ''
    let settled = false
    const done = (r: RunResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    let child: ReturnType<typeof spawnHidden> | null = null
    const timer = setTimeout(() => {
      if (child) killTree(child)
      done({ code: null, stdout: out, stderr: 'timed out' })
    }, opts.timeoutMs)
    try {
      const win = process.platform === 'win32'
      child = spawnHidden(cmd, win ? args.map(quoteWin) : args, { cwd: opts.cwd, shell: win, stdio: ['ignore', 'pipe', 'pipe'], source: 'mcp' })
      child.stdout?.on('data', (b) => (out += String(b)))
      child.stderr?.on('data', (b) => (err += String(b)))
      child.on('error', (e) => done({ code: null, stdout: out, stderr: e.message }))
      child.on('close', (code) => done({ code, stdout: out, stderr: err }))
    } catch (e) {
      done({ code: null, stdout: '', stderr: e instanceof Error ? e.message : String(e) })
    }
  })

export function defaultMcpDeps(env: NodeJS.ProcessEnv = process.env): McpDeps {
  const dot = join(homedir(), '.config', 'opencode')
  return {
    run: realRun,
    readFile: (p) => {
      try {
        return existsSync(p) ? readFileSync(p, 'utf8') : null
      } catch {
        return null
      }
    },
    writeFile: (p, text) => {
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, text, 'utf8')
    },
    claudeConfig: env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : join(homedir(), '.claude.json'),
    opencodeGlobal: [...(env.OPENCODE_CONFIG ? [env.OPENCODE_CONFIG] : []), join(dot, 'opencode.jsonc'), join(dot, 'opencode.json')],
    runtimeOverride:
      env.OPERANT_E2E === '1' && env.OPERANT_E2E_RUNTIMES
        ? () => {
            try {
              return JSON.parse(readFileSync(env.OPERANT_E2E_RUNTIMES!, 'utf8')) as Record<string, boolean>
            } catch {
              return null
            }
          }
        : undefined,
  }
}

// ---- secrets ----

const SECRET_NAME = /(token|key|secret|passw|auth|credential|signature|session)/i

export function maskArg(arg: string, prev?: string): string {
  if (prev !== undefined && /^--?[\w-]+$/.test(prev) && SECRET_NAME.test(prev)) return MCP_MASK
  const eq = /^(--?[\w-]+)=(.*)$/.exec(arg)
  if (eq && SECRET_NAME.test(eq[1]!)) return `${eq[1]}=${MCP_MASK}`
  return arg.replace(/(Bearer|Basic)\s+\S+/gi, `$1 ${MCP_MASK}`).replace(/\b(sk|ghp|gho|xox[a-z]|AKIA)[-_A-Za-z0-9]{12,}/g, MCP_MASK)
}

export function maskUrl(url: string): string {
  return url
    .replace(/\/\/[^/@\s]*@/, `//${MCP_MASK}@`)
    .replace(/([?&])([^=&#]+)=([^&#]*)/g, (m, sep: string, k: string) => (SECRET_NAME.test(k) ? `${sep}${k}=${MCP_MASK}` : m))
}

// Removes every known secret value (and token-shaped text) from free text such as a CLI's error.
export function redact(text: string, secrets: string[] = []): string {
  let t = text
  for (const s of secrets) if (s.length >= 4) t = t.split(s).join(MCP_MASK)
  return t
    .split(/\r?\n/)
    .map((l) => maskUrl(l.replace(/(Bearer|Basic)\s+\S+/gi, `$1 ${MCP_MASK}`)))
    .join('\n')
}

// ---- config files ----

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [])
const strMap = (v: unknown): Record<string, string> => Object.fromEntries(Object.entries(obj(v)).map(([k, x]) => [k, String(x)]))

// The common shape of a stored server, secrets included; it never leaves this file except into launch config.
interface Raw {
  transport: McpTransport
  command?: string
  args?: string[]
  url?: string
  env: Record<string, string>
  headers: Record<string, string>
  disabled?: boolean
}

export function stripJsonc(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2)
      i = i < 0 ? text.length : i + 2
    } else {
      out += c
      i++
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1')
}

const parseJsonc = (text: string | null): Obj | null => {
  if (text == null) return null
  try {
    return obj(JSON.parse(stripJsonc(text.replace(/^﻿/, ''))))
  } catch {
    return null
  }
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

function claudeRaw(v: unknown): Raw {
  const o = obj(v)
  const url = typeof o.url === 'string' ? o.url : undefined
  const transport: McpTransport = o.type === 'sse' ? 'sse' : o.type === 'http' || (url && o.type !== 'stdio') ? 'http' : 'stdio'
  return {
    transport,
    command: typeof o.command === 'string' ? o.command : undefined,
    args: Array.isArray(o.args) ? o.args.map(String) : [],
    url,
    env: strMap(o.env),
    headers: strMap(o.headers),
  }
}

function claudeJson(r: Raw): Obj {
  if (r.transport === 'stdio') return { type: 'stdio', command: r.command, args: r.args ?? [], ...(Object.keys(r.env).length ? { env: r.env } : {}) }
  return { type: r.transport, url: r.url, ...(Object.keys(r.headers).length ? { headers: r.headers } : {}) }
}

function opencodeRaw(v: unknown): Raw {
  const o = obj(v)
  const remote = o.type === 'remote' || typeof o.url === 'string'
  const cmd = Array.isArray(o.command) ? o.command.map(String) : typeof o.command === 'string' ? [o.command] : []
  return {
    transport: remote ? 'http' : 'stdio',
    command: cmd[0],
    args: cmd.slice(1),
    url: typeof o.url === 'string' ? o.url : undefined,
    env: strMap(o.environment ?? o.env),
    headers: strMap(o.headers),
    disabled: o.disabled === true || o.enabled === false,
  }
}

function opencodeJson(r: Raw, prev: Obj = {}): Obj {
  const { command: _c, url: _u, environment: _e, headers: _h, type: _t, ...keep } = prev
  if (r.transport === 'stdio') return { ...keep, type: 'local', command: [r.command, ...(r.args ?? [])], ...(Object.keys(r.env).length ? { environment: r.env } : {}) }
  return { ...keep, type: 'remote', url: r.url, ...(Object.keys(r.headers).length ? { headers: r.headers } : {}) }
}

// Where an OpenCode config keeps its servers: `mcp.servers` (this version) or `mcp` itself (documented).
function opencodeBox(cfg: Obj, create: boolean): Obj | null {
  const mcp = obj(cfg.mcp)
  if (mcp.servers && typeof mcp.servers === 'object') return obj(mcp.servers)
  if (Object.keys(mcp).length > 0 && !create) return mcp
  if (!create) return null
  cfg.mcp = { ...mcp, servers: obj(mcp.servers) }
  return obj(obj(cfg.mcp).servers)
}

function describe(r: Raw): { target: string; env: Record<string, string>; headers: Record<string, string> } {
  const target =
    r.transport === 'stdio'
      ? [r.command ?? '', ...(r.args ?? [])].map((a, i, all) => maskArg(a, all[i - 1])).join(' ').trim()
      : maskUrl(r.url ?? '')
  const mask = (m: Record<string, string>) => Object.fromEntries(Object.keys(m).map((k) => [k, MCP_MASK]))
  return { target, env: mask(r.env), headers: mask(r.headers) }
}

const secretsOf = (r: Raw): string[] => [...Object.values(r.env), ...Object.values(r.headers), ...(r.args ?? []).filter((_a, i) => SECRET_NAME.test(r.args?.[i - 1] ?? ''))]

// ---- parsing CLI output ----

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g

interface Status {
  state: McpState
  error?: string
}

export function parseClaudeList(out: string): Map<string, Status & { target: string }> {
  const found = new Map<string, Status & { target: string }>()
  for (const raw of out.replace(ANSI, '').split(/\r?\n/)) {
    const m = /^(.+?): (.+) - ([✔✓✘✗!⚠⏸⊘].*)$/u.exec(raw.trim())
    if (!m) continue
    const mark = m[3]!
    let state: McpState = 'unknown'
    let error: string | undefined
    if (/connected/i.test(mark) && !/fail/i.test(mark)) state = 'connected'
    else if (/auth/i.test(mark)) state = 'needs-auth'
    else if (/pending|approval/i.test(mark)) state = 'pending'
    else if (/disabled/i.test(mark)) state = 'disabled'
    else if (/fail|✘|✗|error/i.test(mark)) {
      state = 'failed'
      error = mark.replace(/^[✘✗]\s*/u, '').replace(/^Failed to connect\s*[—-]?\s*/i, '').trim() || 'Failed to connect'
    }
    found.set(m[1]!, { state, error, target: m[2]! })
  }
  return found
}

export function parseOpencodeList(out: string): Map<string, Status> {
  const found = new Map<string, Status>()
  let last: string | null = null
  for (const raw of out.replace(ANSI, '').split(/\r?\n/)) {
    const m = /^\s*([^\w\s])\s+([\w.:-]+)\s*(.*)$/u.exec(raw)
    if (!m) {
      // A failure message that wrapped onto the next line belongs to the server above it.
      const more = raw.trim()
      const prev = last ? found.get(last) : undefined
      if (more && prev?.state === 'failed') prev.error = `${prev.error ?? ''} ${more}`.trim()
      else last = null
      continue
    }
    const rest = m[3]!.trim()
    let state: McpState = 'failed'
    if (/^connected/i.test(rest) || (!rest && /[✓✔]/u.test(m[1]!))) state = 'connected'
    else if (/^disabled/i.test(rest)) state = 'disabled'
    else if (/^pending/i.test(rest)) state = 'pending'
    else if (/^needs auth|^auth/i.test(rest)) state = 'needs-auth'
    found.set(m[2]!, { state, ...(state === 'failed' ? { error: rest.replace(/^failed:?\s*/i, '') || 'Failed to connect' } : {}) })
    last = m[2]!
  }
  return found
}

// ---- the service ----

const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/
const BUILTINS: Record<string, string> = { codegraph: 'codegraph serve --mcp', hindsight: 'Hindsight memory server (managed by Operant)' }
const LIST_TIMEOUT_MS = 30_000
const WRITE_TIMEOUT_MS = 30_000
const CACHE_MS = 60_000
const RUNTIME_TIMEOUT_MS = 5_000
const RUNTIME_CACHE_MS = 10 * 60_000

export interface McpOptions {
  log?: (message: string) => void
  now?: () => number
  // Whether a built-in server that is not in any config works right now.
  builtin?: (name: string) => Promise<{ ok: boolean; error?: string }>
  // The keys (cli:scope:name) of the entries Operant wrote for optional servers that record them. Kept by the app.
  written?: { get: () => string[]; set: (keys: string[]) => void }
}

export interface RunMcp {
  // The --mcp-config content for Claude, with real values; null when the seats picked nothing.
  claudeConfig: string | null
  // Environment for OpenCode that turns off the servers the seats did not pick.
  opencodeEnv: Record<string, string> | null
  down: McpDown[]
}

interface Located {
  id: string
  name: string
  cli: McpCli
  scope: McpScope
  raw: Raw
  file?: string
}

export class McpService {
  private readonly d: McpDeps
  private readonly cache = new Map<string, McpOverview>()
  private readonly runtimes = new Map<string, { at: number; ok: boolean; error?: string }>()
  private writtenMem: string[] = []

  constructor(
    private readonly opts: McpOptions = {},
    deps: Partial<McpDeps> = {},
  ) {
    this.d = { ...defaultMcpDeps(), ...deps }
  }

  private now(): number {
    return (this.opts.now ?? Date.now)()
  }

  private log(message: string): void {
    this.opts.log?.(redact(message))
  }

  // ---- reading ----

  private claudeProjectKey(cfg: Obj, folder: string): string | null {
    const projects = obj(cfg.projects)
    return Object.keys(projects).find((k) => norm(k) === norm(folder)) ?? null
  }

  private locate(folder: string | null): Located[] {
    const out: Located[] = []
    const cfg = parseJsonc(this.d.readFile(this.d.claudeConfig)) ?? {}
    for (const [name, v] of Object.entries(obj(cfg.mcpServers))) out.push({ id: `claude:user:${name}`, name, cli: 'claude', scope: 'user', raw: claudeRaw(v), file: this.d.claudeConfig })
    if (folder) {
      const key = this.claudeProjectKey(cfg, folder)
      const proj = key ? obj(obj(cfg.projects)[key]) : {}
      const disabled = new Set(Array.isArray(proj.disabledMcpServers) ? proj.disabledMcpServers.map(String) : [])
      const approval = obj(parseJsonc(this.d.readFile(join(folder, '.claude', 'settings.local.json'))))
      const disabledJson = new Set([...strList(proj.disabledMcpjsonServers), ...strList(approval.disabledMcpjsonServers)])
      for (const l of out) if (disabled.has(l.name)) l.raw.disabled = true
      for (const [name, v] of Object.entries(obj(proj.mcpServers))) {
        const raw = claudeRaw(v)
        raw.disabled = disabled.has(name)
        out.push({ id: `claude:local:${name}`, name, cli: 'claude', scope: 'local', raw, file: this.d.claudeConfig })
      }
      const mcpJson = join(folder, '.mcp.json')
      for (const [name, v] of Object.entries(obj(parseJsonc(this.d.readFile(mcpJson))?.mcpServers))) {
        const raw = claudeRaw(v)
        raw.disabled = disabledJson.has(name)
        out.push({ id: `claude:project:${name}`, name, cli: 'claude', scope: 'project', raw, file: mcpJson })
      }
    }
    const globalFile = this.d.opencodeGlobal.find((f) => this.d.readFile(f) != null)
    const files: Array<[McpScope, string | undefined]> = [['global', globalFile]]
    if (folder) files.push(['project', [join(folder, 'opencode.jsonc'), join(folder, 'opencode.json')].find((f) => this.d.readFile(f) != null)])
    for (const [scope, file] of files) {
      if (!file) continue
      const box = opencodeBox(parseJsonc(this.d.readFile(file)) ?? {}, false) ?? {}
      for (const [name, v] of Object.entries(box)) out.push({ id: `opencode:${scope}:${name}`, name, cli: 'opencode', scope, raw: opencodeRaw(v), file })
    }
    return out
  }

  private view(l: Located, status: Status | undefined): McpServer {
    const d = describe(l.raw)
    const state: McpState = l.raw.disabled ? 'disabled' : (status?.state ?? 'unknown')
    const error = state === 'failed' || (state === 'unknown' && status?.error) ? redact(status?.error ?? '', secretsOf(l.raw)) : undefined
    return { id: l.id, name: l.name, cli: l.cli, scope: l.scope, transport: l.raw.transport, ...d, state, ...(error ? { error } : {}), editable: true, builtin: l.name in BUILTINS }
  }

  private async builtinView(name: string): Promise<McpServer> {
    let state: McpState = 'unknown'
    let error: string | undefined
    try {
      const r = await this.opts.builtin?.(name)
      if (r) [state, error] = [r.ok ? 'connected' : 'failed', r.ok ? undefined : r.error ?? 'not available']
    } catch (e) {
      ;[state, error] = ['failed', e instanceof Error ? e.message : String(e)]
    }
    return { id: `builtin:${name}`, name, cli: 'claude', scope: 'builtin', transport: 'stdio', target: BUILTINS[name]!, env: {}, headers: {}, state, ...(error ? { error: redact(error) } : {}), editable: false, builtin: true }
  }

  // Whether a command runs (`uvx --version`, `npx --version`), probed once per command and cached.
  private async runtime(command: string, refresh: boolean): Promise<{ ok: boolean; error?: string }> {
    const forced = this.d.runtimeOverride?.()
    if (forced && command in forced) return forced[command] ? { ok: true } : { ok: false, error: `${command} is not installed` }
    const hit = this.runtimes.get(command)
    if (hit && !refresh && this.now() - hit.at < RUNTIME_CACHE_MS) return hit
    const r = await this.d.run(command, ['--version'], { timeoutMs: RUNTIME_TIMEOUT_MS })
    const res = r.code === 0 ? { ok: true } : { ok: false, error: `${command} --version did not run` }
    this.runtimes.set(command, { at: this.now(), ...res })
    return res
  }

  private written(): string[] {
    return this.opts.written ? this.opts.written.get() : this.writtenMem
  }

  private setWritten(keys: string[]): void {
    if (this.opts.written) this.opts.written.set(keys)
    else this.writtenMem = keys
  }

  // The status of each optional integration for this folder, from the cached overview unless `refresh`.
  async optional(folder: string | null, refresh = false): Promise<OptionalMcpEntry[]> {
    const overview = refresh ? await this.list(folder) : await this.cached(folder)
    const out: OptionalMcpEntry[] = []
    for (const def of OPTIONAL_MCP) out.push(optionalEntry(def, overview.servers, await this.runtime(def.runtime.command, refresh), folder != null, this.written()))
    return out
  }

  // The user clicked Add: writes the server into each chosen CLI and scope through the same add path as any server.
  async addOptional(folder: string | null, id: OptionalMcpId, targets: OptionalMcpTarget[]): Promise<McpOverview> {
    const def = optionalMcp(id)
    if (!def) throw new McpError('That is not an optional integration')
    if (!targets.length) throw new McpError('Pick Claude Code, OpenCode or both')
    if (def.needsProject && !folder) throw new McpError('Select a project first: Git MCP reads one project folder')
    const rt = await this.runtime(def.runtime.command, true)
    if (!rt.ok) throw new McpError(`${def.runtime.command} is not installed: ${def.runtime.hint}`)
    const { command, args } = def.launch(folder ?? '')
    let overview = await this.list(folder)
    const keys: string[] = []
    for (const t of targets) {
      overview = await this.add(folder, { name: def.server, cli: t.cli, scope: t.scope, transport: 'stdio', command, args, env: {} })
      keys.push(`${t.cli}:${t.scope}:${def.server}`)
    }
    if (def.recordsWrites) this.setWritten([...new Set([...this.written(), ...keys])])
    return overview
  }

  // Removes only the entries Operant added (the name and package it writes); a server the user added by hand stays.
  async removeOptional(folder: string | null, id: OptionalMcpId): Promise<McpOverview> {
    const def = optionalMcp(id)
    if (!def) throw new McpError('That is not an optional integration')
    const written = this.written()
    const own = (await this.list(folder)).servers.filter((s) => isAppAdded(def, s, written))
    if (!own.length) throw new McpError(`${def.name} was not added by Operant`)
    let overview: McpOverview | null = null
    for (const s of own) overview = await this.remove(folder, s.id)
    if (def.recordsWrites) this.setWritten(written.filter((k) => !own.some((s) => writtenKey(s) === k)))
    return overview!
  }

  private missing(r: RunResult): boolean {
    return r.code === null && /ENOENT|not found|not recognized/i.test(r.stderr)
  }

  // Every server both CLIs know for this folder, with a status check each (bounded by a timeout).
  async list(folder: string | null): Promise<McpOverview> {
    const located = this.locate(folder)
    const timedOut = (r: RunResult) => (r.code === null && /timed out/i.test(r.stderr) ? 'status check timed out' : undefined)
    const [c, o] = await Promise.all([
      this.d.run('claude', ['mcp', 'list'], { cwd: folder ?? undefined, timeoutMs: LIST_TIMEOUT_MS }),
      this.d.run('opencode', ['mcp', 'list'], { cwd: folder ?? undefined, timeoutMs: LIST_TIMEOUT_MS }),
    ])
    const installed = { claude: !this.missing(c), opencode: !this.missing(o) }
    const cs = c.code === 0 ? parseClaudeList(c.stdout) : null
    const os = o.code === 0 ? parseOpencodeList(o.stdout) : null
    const fallback = (r: RunResult): Status | undefined => {
      const t = timedOut(r)
      return t ? { state: 'unknown', error: t } : undefined
    }
    const servers: McpServer[] = located.map((l) => this.view(l, (l.cli === 'claude' ? cs?.get(l.name) : os?.get(l.name)) ?? fallback(l.cli === 'claude' ? c : o)))
    if (cs) {
      const own = new Set(located.filter((l) => l.cli === 'claude').map((l) => l.name))
      for (const [name, s] of cs) {
        if (own.has(name)) continue
        const scope: McpScope = name.startsWith('plugin:') ? 'plugin' : name.startsWith('claude.ai ') ? 'connector' : 'other'
        servers.push({ id: `claude:${scope}:${name}`, name, cli: 'claude', scope, transport: /^https?:/.test(s.target) ? 'http' : 'stdio', target: maskUrl(s.target.replace(/ \((HTTP|SSE)\)$/, '')), env: {}, headers: {}, state: s.state, ...(s.error ? { error: redact(s.error) } : {}), editable: false, builtin: name in BUILTINS })
      }
    }
    for (const name of Object.keys(BUILTINS)) if (!servers.some((s) => s.name === name)) servers.push(await this.builtinView(name))
    const overview: McpOverview = { folder, servers, installed, checkedAt: this.now() }
    this.cache.set(folder ?? '', overview)
    return overview
  }

  async cached(folder: string | null, maxAgeMs = CACHE_MS): Promise<McpOverview> {
    const hit = this.cache.get(folder ?? '')
    return hit && this.now() - hit.checkedAt < maxAgeMs ? hit : this.list(folder)
  }

  // ---- changing ----

  private find(folder: string | null, id: string): Located {
    const l = this.locate(folder).find((x) => x.id === id)
    if (!l) throw new McpError('That server is not in the CLI\'s config (it may have been removed already)')
    return l
  }

  private needFolder(scope: McpScope, folder: string | null): string | undefined {
    if ((scope === 'project' || scope === 'local') && !folder) throw new McpError('Select a project first: project and local servers belong to a project folder')
    return folder ?? undefined
  }

  private clean(input: McpServerInput, old?: Raw): { raw: Raw; scope: McpScope } {
    const bad = (m: string) => new McpError(m)
    if (!input || typeof input !== 'object') throw bad('Missing server details')
    if (!NAME_RE.test(input.name ?? '')) throw bad('The name may use letters, digits, dot, dash and underscore (up to 64)')
    if (input.cli !== 'claude' && input.cli !== 'opencode') throw bad('The CLI must be claude or opencode')
    const scopes = input.cli === 'claude' ? ['user', 'project', 'local'] : ['global', 'project']
    if (!scopes.includes(input.scope)) throw bad(`${input.cli} servers use the ${scopes.join(', ')} scope`)
    if (input.transport !== 'stdio' && input.transport !== 'http' && input.transport !== 'sse') throw bad('The transport must be stdio, http or sse')
    if (input.cli === 'opencode' && input.transport === 'sse') throw bad('OpenCode has local and remote servers only')
    const plain = (field: string, v: string) => {
      if (/["%\r\n\0]/.test(v)) throw bad(`${field} cannot contain quotes, percent signs or line breaks`)
      return v
    }
    const map = (field: string, m: Record<string, string> | undefined, oldM: Record<string, string>, keyRe: RegExp) => {
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(m ?? {})) {
        if (!keyRe.test(k)) throw bad(`${field} name ${k} is not valid`)
        const value = v === MCP_MASK ? oldM[k] : v
        if (value === undefined || value === '') throw bad(`Enter a value for ${field} ${k}`)
        out[k] = plain(`${field} ${k}`, value)
      }
      return out
    }
    const raw: Raw = {
      transport: input.transport,
      env: map('Environment variable', input.env, old?.env ?? {}, /^[A-Za-z_][A-Za-z0-9_]*$/),
      headers: map('Header', input.headers, old?.headers ?? {}, /^[A-Za-z0-9-]+$/),
    }
    if (input.transport === 'stdio') {
      const command = plain('The command', (input.command ?? '').trim())
      if (!command) throw bad('Enter the command that starts the server')
      raw.command = command
      raw.args = (input.args ?? []).map((a, i) => (a.includes(MCP_MASK) && old?.args?.[i] != null && maskArg(old.args[i]!, old.args[i - 1]) === a ? old.args[i]! : plain('An argument', String(a))))
      raw.headers = {}
    } else {
      let url = (input.url ?? '').trim()
      if (url.includes(MCP_MASK) && old?.url && maskUrl(old.url) === url) url = old.url
      plain('The URL', url)
      if (!/^https?:\/\/\S+$/i.test(url)) throw bad('Enter an http or https URL')
      raw.url = url
      raw.env = {}
    }
    return { raw, scope: input.scope }
  }

  private async cli(cmd: string, args: string[], folder: string | undefined, secrets: string[]): Promise<void> {
    const r = await this.d.run(cmd, args, { cwd: folder, timeoutMs: WRITE_TIMEOUT_MS })
    if (r.code === 0) return
    if (this.missing(r)) throw new McpError(`${cmd} is not installed`)
    const why = redact(`${r.stderr}\n${r.stdout}`.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' '), secrets)
    throw new McpError(`${cmd} mcp failed${r.code != null ? ` (exit ${r.code})` : ''}${why ? `: ${why}` : ''}`)
  }

  private writeClaude(name: string, scope: McpScope, raw: Raw): string[] {
    if (raw.transport === 'stdio') {
      const args = ['mcp', 'add', name, '-s', scope, '-t', 'stdio']
      for (const [k, v] of Object.entries(raw.env)) args.push('-e', `${k}=${v}`)
      return [...args, '--', raw.command!, ...(raw.args ?? [])]
    }
    const args = ['mcp', 'add', '-t', raw.transport, '-s', scope, name, raw.url!]
    for (const [k, v] of Object.entries(raw.headers)) args.push('-H', `${k}: ${v}`)
    return args
  }

  private opencodeFile(scope: McpScope, folder: string | undefined): string | null {
    if (scope === 'project') return [join(folder ?? '', 'opencode.jsonc'), join(folder ?? '', 'opencode.json')].find((f) => this.d.readFile(f) != null) ?? null
    return this.d.opencodeGlobal.find((f) => this.d.readFile(f) != null) ?? null
  }

  private editOpencode(file: string, fn: (box: Obj) => void): void {
    const text = this.d.readFile(file)
    const cfg = parseJsonc(text)
    if (!cfg) throw new McpError(`Could not read ${file}`)
    if (text != null && this.d.readFile(`${file}.operant-backup`) == null) this.d.writeFile(`${file}.operant-backup`, text)
    const box = opencodeBox(cfg, true)!
    fn(box)
    this.d.writeFile(file, JSON.stringify(cfg, null, 2) + '\n')
  }

  async add(folder: string | null, input: McpServerInput): Promise<McpOverview> {
    const { raw, scope } = this.clean(input)
    const cwd = this.needFolder(scope, folder)
    if (this.locate(folder).some((l) => l.cli === input.cli && l.scope === scope && l.name === input.name)) throw new McpError(`${input.name} already exists in the ${scope} scope`)
    await this.write(input, raw, scope, cwd, null)
    this.log(`MCP server ${input.name} added to ${input.cli} (${scope})`)
    return this.list(folder)
  }

  private async write(input: McpServerInput, raw: Raw, scope: McpScope, cwd: string | undefined, prev: Located | null): Promise<void> {
    const secrets = secretsOf(raw)
    if (input.cli === 'claude') {
      await this.cli('claude', this.writeClaude(input.name, scope, raw), cwd, secrets)
      return
    }
    const file = this.opencodeFile(scope, cwd)
    if (prev && file) {
      this.editOpencode(file, (box) => void (box[input.name] = opencodeJson(raw, obj(box[input.name]))))
      return
    }
    const args = ['mcp', 'add']
    if (scope === 'global') args.push('--global')
    if (raw.transport === 'stdio') {
      for (const [k, v] of Object.entries(raw.env)) args.push('--env', `${k}=${v}`)
      await this.cli('opencode', [...args, input.name, '--', raw.command!, ...(raw.args ?? [])], cwd, secrets)
    } else {
      args.push('--url', raw.url!)
      for (const [k, v] of Object.entries(raw.headers)) args.push('--header', `${k}=${v}`)
      await this.cli('opencode', [...args, input.name], cwd, secrets)
    }
  }

  async update(folder: string | null, id: string, input: McpServerInput): Promise<McpOverview> {
    const old = this.find(folder, id)
    if (input.cli !== old.cli || input.scope !== old.scope || input.name !== old.name) throw new McpError('The name, CLI and scope cannot change: add a new server and remove this one instead')
    const { raw, scope } = this.clean(input, old.raw)
    const cwd = this.needFolder(scope, folder)
    if (old.cli === 'claude') {
      await this.cli('claude', ['mcp', 'remove', '-s', scope, old.name], cwd, secretsOf(old.raw))
      try {
        await this.write(input, raw, scope, cwd, old)
      } catch (err) {
        await this.write({ ...input, ...rawInput(old.raw) }, old.raw, scope, cwd, old).catch(() => undefined)
        throw err
      }
    } else await this.write(input, raw, scope, cwd, old)
    this.log(`MCP server ${old.name} edited (${old.cli}, ${scope})`)
    return this.list(folder)
  }

  async remove(folder: string | null, id: string): Promise<McpOverview> {
    const l = this.find(folder, id)
    const cwd = this.needFolder(l.scope, folder)
    if (l.cli === 'claude') await this.cli('claude', ['mcp', 'remove', '-s', l.scope, l.name], cwd, secretsOf(l.raw))
    else this.editOpencode(l.file!, (box) => void delete box[l.name])
    this.log(`MCP server ${l.name} removed from ${l.cli} (${l.scope})`)
    return this.list(folder)
  }

  async setEnabled(folder: string | null, id: string, enabled: boolean): Promise<McpOverview> {
    const l = this.find(folder, id)
    if (l.cli === 'opencode') {
      this.editOpencode(l.file!, (box) => {
        const e = obj(box[l.name])
        delete e.enabled
        if (enabled) delete e.disabled
        else e.disabled = true
        box[l.name] = e
      })
    } else if (l.scope === 'project') {
      // Claude 2.1 keeps the approval of a .mcp.json server in <project>/.claude/settings.local.json (it moves the older
      // copy out of ~/.claude.json), so that is the file it reads back.
      const cwd = this.needFolder('project', folder)!
      const file = join(cwd, '.claude', 'settings.local.json')
      const text = this.d.readFile(file)
      const settings = text == null ? {} : parseJsonc(text)
      if (!settings) throw new McpError(`Could not read ${file}`)
      const off = new Set(strList(settings.disabledMcpjsonServers))
      const on = new Set(strList(settings.enabledMcpjsonServers))
      if (enabled) {
        off.delete(l.name)
        on.add(l.name)
      } else {
        off.add(l.name)
        on.delete(l.name)
      }
      settings.disabledMcpjsonServers = [...off]
      settings.enabledMcpjsonServers = [...on]
      this.d.writeFile(file, JSON.stringify(settings, null, 2) + '\n')
    } else {
      const cwd = this.needFolder('local', folder)!
      const cfg = parseJsonc(this.d.readFile(this.d.claudeConfig)) ?? {}
      const projects = obj(cfg.projects)
      const key = this.claudeProjectKey(cfg, cwd) ?? cwd.replace(/\\/g, '/')
      const proj = obj(projects[key])
      const list = new Set(strList(proj.disabledMcpServers))
      if (enabled) list.delete(l.name)
      else list.add(l.name)
      proj.disabledMcpServers = [...list]
      cfg.projects = { ...projects, [key]: proj }
      this.d.writeFile(this.d.claudeConfig, JSON.stringify(cfg, null, 2) + '\n')
    }
    this.log(`MCP server ${l.name} ${enabled ? 'enabled' : 'disabled'} (${l.cli}, ${l.scope})`)
    return this.list(folder)
  }

  // ---- seats and jobs ----

  // The servers the seats need that are not working, named once each with the seats that need them.
  async down(needs: Array<{ seat: string; servers: string[] }>, folder: string | null, opts: { fresh?: boolean; includeMissing?: boolean } = {}): Promise<McpDown[]> {
    const overview = opts.fresh ? await this.list(folder) : await this.cached(folder)
    const out = new Map<string, McpDown>()
    for (const n of needs) {
      for (const name of n.servers) {
        const found = overview.servers.filter((s) => aliasesOf(name).includes(s.name))
        const ok = found.some((s) => s.state === 'connected' || s.state === 'unknown')
        if (ok) continue
        const worst = found[0]
        if (!worst && !opts.includeMissing) continue
        const entry = out.get(name) ?? { server: name, state: worst ? worst.state : 'missing', ...(worst?.error ? { error: worst.error } : {}), seats: [] }
        if (!entry.seats.includes(n.seat)) entry.seats.push(n.seat)
        out.set(name, entry)
      }
    }
    return [...out.values()]
  }

  // The --mcp-config content (real values) for these Claude server names, without checking their health; null for none.
  // Used at the synchronous Master Terminal launch.
  claudeConfigFor(names: string[], folder: string | null): string | null {
    if (!names.length) return null
    const located = this.locate(folder)
    const servers: Obj = {}
    for (const name of names) {
      const l = located.find((x) => x.cli === 'claude' && x.name === name && !x.raw.disabled)
      if (l) servers[name] = claudeJson(l.raw)
      else if (name === 'codegraph') servers[name] = { command: 'codegraph', args: ['serve', '--mcp'] }
    }
    return JSON.stringify({ mcpServers: servers }, null, 2) + '\n'
  }

  // What a job launches with: the picked servers as launch config, and which of them are down. An optional server
  // that the CLI does not have is left out silently: presets only recommend it. CodeGraph is also Operant's built-in,
  // which a launch runs without any config entry, so it is never left out here.
  async forRun(needs: Array<{ seat: string; servers: string[] }>, cli: McpCli, folder: string | null): Promise<RunMcp> {
    const located = this.locate(folder)
    const has = (name: string) => located.some((x) => x.cli === cli && aliasesOf(name).includes(x.name))
    const wanted = needs.map((n) => ({ seat: n.seat, servers: n.servers.filter((s) => !isOptionalMcp(s) || s in BUILTINS || has(s)) })).filter((n) => n.servers.length > 0)
    const names = [...new Set(wanted.flatMap((n) => n.servers))]
    if (!names.length) return { claudeConfig: null, opencodeEnv: null, down: [] }
    const down = await this.down(wanted, folder, { fresh: true, includeMissing: true })
    const pick = (name: string) =>
      located.find((x) => x.cli === cli && x.name === name && !x.raw.disabled) ?? located.find((x) => x.cli === cli && !x.raw.disabled && aliasesOf(name).includes(x.name))
    if (cli === 'claude') {
      const servers: Obj = {}
      for (const name of names) {
        const l = pick(name)
        if (l) servers[name] = claudeJson(l.raw)
        else if (name === 'codegraph') servers[name] = { command: 'codegraph', args: ['serve', '--mcp'] }
      }
      return { claudeConfig: JSON.stringify({ mcpServers: servers }, null, 2) + '\n', opencodeEnv: null, down }
    }
    const off: Obj = {}
    for (const l of located) if (l.cli === 'opencode' && !names.some((n) => aliasesOf(n).includes(l.name))) off[l.name] = { disabled: true }
    const cfg: Obj = {}
    if (Object.keys(off).length) {
      const g = this.d.opencodeGlobal.find((f) => this.d.readFile(f) != null)
      const flat = g ? !obj(obj(parseJsonc(this.d.readFile(g))?.mcp)).servers : false
      cfg.mcp = flat ? off : { servers: off }
    }
    return { claudeConfig: null, opencodeEnv: Object.keys(cfg).length ? { OPENCODE_CONFIG_CONTENT: JSON.stringify(cfg) } : null, down }
  }
}

function rawInput(r: Raw): Partial<McpServerInput> {
  return { transport: r.transport, command: r.command, args: r.args, url: r.url, env: r.env, headers: r.headers }
}
