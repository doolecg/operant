import { readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import type { HindsightStatus, HindsightTestResult } from '../shared/types'
import type { ConsoleSource } from '../shared/console'
import { runHidden } from './proc'

// Ported from Operant 2.8.2 (hindsight-server.js): the local daemon is `uvx hindsight-embed daemon`
// on the profile the agent plugins use, port 9077 unless its own settings file says otherwise.
export const PROFILE = 'coding-agent'
export const DEFAULT_PORT = 9077
const NO_UV = "uv isn't installed, and the memory server runs through it: winget install astral-sh.uv (or https://docs.astral.sh/uv/)"

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface HindsightDeps {
  fetch: (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>
  now: () => number
  kill: (pid: number) => void
  run: (cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; cwd?: string; source?: ConsoleSource }) => Promise<RunResult>
  readJson: (file: string) => unknown
  sleep: (ms: number) => Promise<void>
}

export const runCommand: HindsightDeps['run'] = (cmd, args, opts) =>
  // git and uvx are real executables; the rest may be .cmd shims on Windows, which need a shell.
  runHidden(cmd, args, { ...opts, shell: process.platform === 'win32' && !/^(git|uvx)$/i.test(cmd) })

const defaults: HindsightDeps = {
  fetch: (url, init) => fetch(url, init),
  run: runCommand,
  readJson: (file) => {
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return null
    }
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  kill: (pid) => process.kill(pid),
}

export interface HindsightOptions {
  // A server hosted elsewhere (Docker, LAN). When set, Operant only probes it.
  url?: () => string
  // Shared mode: Operant runs the daemon bound to `host` so other machines can connect. Null in the other modes.
  lan?: () => { host: string; port: number; openBind: boolean } | null
  // The API key sent as `Authorization: Bearer` (and set on the daemon in shared mode); null when none.
  key?: () => string | null
  // The environment a start passes to the daemon, mostly its LLM (HINDSIGHT_API_LLM_*).
  llmEnv?: () => NodeJS.ProcessEnv
  settingsFile?: string
  // The hindsight-embed profile; coding-agent unless a test uses a throwaway one.
  profile?: string
}

// On a shared or remote server the bank also has to be unique across machines. The project's git origin identifies it
// the same way everywhere (clones of one repo share a bank); without one, the machine name keeps two PCs apart.
let sharedBanks = false
export const setSharedBanks = (on: boolean): void => {
  sharedBanks = on
}

export function projectKey(folder: string): string | null {
  try {
    const cfg = readFileSync(join(folder, '.git', 'config'), 'utf8')
    const m = /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/.exec(cfg)
    if (!m) return null
    return m[1]!.toLowerCase().replace(/^[a-z+]+:\/\//, '').replace(/^[^@/]*@/, '').replace(':', '/').replace(/\.git$/, '').replace(/\/+$/, '')
  } catch {
    return null
  }
}

// A project's bank name: readable, and unique per folder so two projects named alike never share memory.
export function bankFor(folder: string): string {
  const base = folder.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const leaf = base.split('/').pop() ?? 'project'
  const norm = sharedBanks ? `${projectKey(folder) ?? `${hostname().toLowerCase()}:${base}`}|${leaf}` : base
  let h = 5381
  for (let i = 0; i < norm.length; i++) h = ((h * 33) ^ norm.charCodeAt(i)) >>> 0
  const name = leaf.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project'
  return `operant-${name}-${h.toString(36)}`
}

export type RecallResult = { ok: true; items: string[] } | { ok: false; error: string }
export type RetainResult = { ok: true } | { ok: false; error: string }

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {})

// Hindsight memory server. Nothing here throws into a job: every call answers with a status or a result.
export class HindsightService {
  private readonly d: HindsightDeps

  constructor(
    private readonly opts: HindsightOptions = {},
    deps: Partial<HindsightDeps> = {},
  ) {
    this.d = { ...defaults, ...deps }
  }

  // What the running daemon was last started with by this app (shared mode); null when this session never started it.
  private applied: string | null = null
  private appliedAddr: { host: string; port: number } | null = null
  private reached: string | null = null

  private settings(): { port: number; embedVersion: string } {
    const j = obj(this.d.readJson(this.opts.settingsFile ?? join(homedir(), '.hindsight', 'coding-agent.json')))
    return { port: Number(j.apiPort) || DEFAULT_PORT, embedVersion: typeof j.embedVersion === 'string' ? j.embedVersion : '' }
  }

  // The server the agent plugins already use (self-hosted, apiUrl in coding-agent.json), taken only when Operant's own
  // URL is unset and it is not sharing a daemon of its own.
  get adoptedUrl(): string {
    if ((this.opts.url?.() ?? '').trim() || this.opts.lan?.()) return ''
    const j = obj(this.d.readJson(this.opts.settingsFile ?? join(homedir(), '.hindsight', 'coding-agent.json')))
    const url = typeof j.apiUrl === 'string' ? j.apiUrl.trim().replace(/\/+$/, '') : ''
    return j.serverMode === 'self-hosted' && /^https?:\/\/[^\s/]+/i.test(url) ? url : ''
  }

  get managed(): boolean {
    return !(this.opts.url?.() ?? '').trim() && !this.adoptedUrl
  }

  get mode(): 'local' | 'lan' | 'remote' {
    return !this.managed ? 'remote' : this.opts.lan?.() ? 'lan' : 'local'
  }

  // Where Operant itself reaches the server. The daemon's own checks only probe 127.0.0.1, so a shared server is
  // probed there too, then on the bound address when that is a specific adapter and loopback is not served.
  private candidates(): string[] {
    const remote = (this.opts.url?.() ?? '').trim().replace(/\/+$/, '') || this.adoptedUrl
    if (remote) return [remote]
    const lan = this.opts.lan?.()
    const port = lan?.port ?? this.settings().port
    const list = [`http://127.0.0.1:${port}`]
    if (lan && !['127.0.0.1', '0.0.0.0', 'localhost', '::'].includes(lan.host)) list.push(`http://${lan.host}:${port}`)
    return list
  }

  get url(): string {
    const list = this.candidates()
    return this.reached && list.includes(this.reached) ? this.reached : list[0]!
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const key = this.opts.key?.()
    return key ? { ...extra, authorization: `Bearer ${key}` } : extra
  }

  private async up(): Promise<boolean> {
    for (const base of this.candidates()) {
      try {
        if ((await this.d.fetch(`${base}/health`, { headers: this.headers(), signal: AbortSignal.timeout(4000) })).ok) {
          this.reached = base
          return true
        }
      } catch {
        // try the next address
      }
    }
    return false
  }

  // Reachability, whether the key is accepted, the bank count and the round trip, with the server's own words on failure.
  async test(): Promise<HindsightTestResult> {
    const base = { url: this.url, ok: false, reachable: false, auth: 'unknown' as const, latencyMs: null, info: '', open: false }
    const started = this.d.now()
    const key = this.opts.key?.() ?? ''
    const scrub = (t: string) => (key ? t.split(key).join('***') : t)
    let reached = ''
    let lastError = ''
    for (const c of this.candidates()) {
      try {
        const r = await this.d.fetch(`${c}/health`, { headers: this.headers(), signal: AbortSignal.timeout(5000) })
        if (r.ok) {
          reached = c
          break
        }
        lastError = `${c} answered ${r.status}`
      } catch (err) {
        lastError = scrub(err instanceof Error ? err.message : String(err))
      }
    }
    if (!reached) return { ...base, error: lastError || 'No answer' }
    const latencyMs = this.d.now() - started
    try {
      const r = await this.d.fetch(`${reached}/v1/default/banks`, { headers: this.headers(), signal: AbortSignal.timeout(5000) })
      if (r.status === 401 || r.status === 403) {
        return { ...base, url: reached, reachable: true, auth: 'denied', latencyMs, error: key ? 'The server refused the API key' : 'The server needs an API key and none is saved' }
      }
      if (!r.ok) return { ...base, url: reached, reachable: true, latencyMs, error: `Banks list answered ${r.status}` }
      const body = obj(await r.json().catch(() => null))
      const open = key ? await this.d.fetch(`${reached}/v1/default/banks`, { signal: AbortSignal.timeout(5000) }).then((x) => x.ok, () => false) : true
      const list = [body.banks, body.items, body.results].find(Array.isArray) as unknown[] | undefined
      return { ...base, url: reached, ok: true, reachable: true, auth: 'ok', open, latencyMs, info: list ? `${list.length} ${list.length === 1 ? 'bank' : 'banks'}` : 'Answered', error: '' }
    } catch (err) {
      return { ...base, url: reached, reachable: true, latencyMs, error: scrub(err instanceof Error ? err.message : String(err)) }
    }
  }

  private async hasUv(): Promise<boolean> {
    return (await this.d.run('uvx', ['--version'], { timeoutMs: 15000 })).code === 0
  }

  async status(): Promise<HindsightStatus> {
    const mode = this.mode
    const mk = (): { url: string; managed: boolean; mode: typeof mode } => ({ url: this.url, managed: this.managed, mode })
    try {
      if (await this.up()) {
        const pendingRestart = mode === 'lan' && this.applied !== this.lanSignature() ? true : undefined
        return { ...mk(), state: 'running', pendingRestart, detail: mode === 'remote' ? `${this.url} · ${this.adoptedUrl ? 'adopted from the agent plugins (coding-agent.json)' : 'hosted elsewhere'}` : mode === 'lan' ? `${this.url} · shared` : this.url }
      }
      if (mode === 'remote') return { ...mk(), state: 'error', detail: `${this.url} isn't answering` }
      if (!(await this.hasUv())) return { ...mk(), state: 'no-uv', detail: NO_UV }
      return { ...mk(), state: 'stopped', detail: `${this.url} is not running` }
    } catch (err) {
      return { ...mk(), state: 'error', detail: err instanceof Error ? err.message : String(err) }
    }
  }

  // The embed CLI only checks 127.0.0.1, so `daemon stop` cannot see a daemon bound to another address (verified on a
  // throwaway profile bound to 127.0.0.2: it says "not running" and leaves the process). A shared server is stopped by
  // ending the process that listens on its port, after the health check has shown a Hindsight server answers there.
  private async listenerPid(port: number): Promise<number | null> {
    const win = process.platform === 'win32'
    const r = win ? await this.d.run('netstat', ['-ano', '-p', 'TCP'], { timeoutMs: 15000 }) : await this.d.run('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { timeoutMs: 15000 })
    if (r.code !== 0) return null
    if (!win) return Number(r.stdout.trim().split(/\r?\n/)[0]) || null
    for (const line of r.stdout.split(/\r?\n/)) {
      const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/.exec(line)
      if (m && Number(m[1]) === port) return Number(m[2])
    }
    return null
  }

  private async killListener(): Promise<void> {
    const port = this.appliedAddr?.port ?? this.opts.lan?.()?.port
    const pid = port ? await this.listenerPid(port) : null
    if (pid) this.d.kill(pid)
  }

  private lanSignature(): string | null {
    const lan = this.opts.lan?.()
    return lan ? `${lan.host}|${lan.port}|${this.opts.key?.() ? 'key' : 'open'}` : null
  }

  // Shared mode: the bind address and port, and the API key requirement, go to the daemon as its environment.
  private lanEnv(): NodeJS.ProcessEnv {
    const lan = this.opts.lan?.()
    if (!lan) return {}
    const key = this.opts.key?.()
    return {
      HINDSIGHT_API_HOST: lan.host,
      HINDSIGHT_API_PORT: String(lan.port),
      ...(key
        ? { HINDSIGHT_API_TENANT_EXTENSION: 'hindsight_api.extensions.builtin.tenant:ApiKeyTenantExtension', HINDSIGHT_API_TENANT_API_KEY: key }
        : {}),
    }
  }

  private async daemon(action: 'start' | 'stop'): Promise<string | null> {
    const env = { ...process.env, ...(action === 'start' ? { ...this.opts.llmEnv?.(), ...this.lanEnv() } : {}) }
    const version = this.settings().embedVersion || 'latest'
    const r = await this.d.run('uvx', [`hindsight-embed@${version}`, 'daemon', '--profile', this.opts.profile ?? PROFILE, action], { env, timeoutMs: 300000 })
    if (r.code === 0) return null
    let text = `${r.stdout}\n${r.stderr}`.trim().split(/\r?\n/).slice(-6).join('\n')
    for (const secret of [env.HINDSIGHT_API_LLM_API_KEY, env.HINDSIGHT_API_TENANT_API_KEY]) if (secret) text = text.split(secret).join('***')
    return `hindsight-embed daemon ${action} exited ${r.code ?? 'abnormally'}${text ? `: ${text}` : ''}`
  }

  private async wait(up: boolean): Promise<boolean> {
    for (let i = 0; i < 30; i++) {
      if ((await this.up()) === up) return true
      await this.d.sleep(1000)
    }
    return false
  }

  // Start or stop the local daemon. A hosted-elsewhere server is never touched. Returns the status after.
  async act(action: 'start' | 'stop' | 'restart'): Promise<HindsightStatus> {
    if (!this.managed) return { ...(await this.status()), detail: 'Hosted elsewhere: Operant does not start or stop it' }
    const mode = this.mode
    const fail = (state: HindsightStatus['state'], detail: string): HindsightStatus => ({ url: this.url, managed: true, mode, state, detail })
    const lan = this.opts.lan?.()
    if (action !== 'stop' && lan && !this.opts.key?.() && !lan.openBind && !['127.0.0.1', 'localhost'].includes(lan.host)) {
      return fail('error', 'A shared server needs an API key. Set or generate one, or confirm an open server in settings.')
    }
    try {
      if (!(await this.hasUv())) return fail('no-uv', NO_UV)
      for (const step of action === 'restart' ? (['stop', 'start'] as const) : ([action] as const)) {
        const failed = await this.daemon(step)
        if (failed) return fail('error', failed)
        if (step === 'stop' && (lan || this.applied) && (await this.up())) await this.killListener()
        if (!(await this.wait(step === 'start'))) return fail('error', `${this.url} ${step === 'start' ? "didn't come up in 30 s" : 'is still answering after stop'}`)
        if (step === 'start') {
          this.applied = this.lanSignature()
          this.appliedAddr = lan ? { host: lan.host, port: lan.port } : null
        } else {
          this.applied = null
          this.appliedAddr = null
        }
      }
    } catch (err) {
      return fail('error', err instanceof Error ? err.message : String(err))
    }
    return this.status()
  }

  private async post(path: string, body: unknown): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
    try {
      const r = await this.d.fetch(`${this.url}${path}`, {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      })
      if (!r.ok) return { ok: false, error: `Hindsight answered ${r.status}` }
      return { ok: true, data: await r.json().catch(() => null) }
    } catch {
      return { ok: false, error: `unreachable at ${this.url}` }
    }
  }

  // Memories matching the query, as plain text. Tolerant of the response shape (results / memories / items).
  async recall(bank: string, query: string, limit = 8): Promise<RecallResult> {
    const r = await this.post(`/v1/default/banks/${encodeURIComponent(bank)}/memories/recall`, { query, max_tokens: 2000 })
    if (!r.ok) return r
    const body = obj(r.data)
    const list = [body.results, body.memories, body.items, r.data].find(Array.isArray) as unknown[] | undefined
    const items = (list ?? [])
      .map((m) => (typeof m === 'string' ? m : String(obj(m).text ?? obj(m).content ?? '')))
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, limit)
    return { ok: true, items }
  }

  async retain(bank: string, content: string, tags: string[], context = 'Operant job outcome'): Promise<RetainResult> {
    const r = await this.post(`/v1/default/banks/${encodeURIComponent(bank)}/memories`, { items: [{ content, tags, context }], async: true })
    return r.ok ? { ok: true } : r
  }
}
