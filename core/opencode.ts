import { spawnHidden } from './proc'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// The Master adapter shape the job runner (core/master.ts) drives; redeclared here until it is shared.
export interface MasterEvent {
  kind: string
  text?: string
}
export interface MasterStartOptions {
  cwd: string
  prompt: string
  model?: string
  // The model's --variant name (OpenCode's effort).
  effort?: string
  // Environment for the CLI (the servers the job's seats picked).
  mcp?: { env?: Record<string, string> }
  // Only acceptEdits and bypassPermissions add --auto; every other mode (or none) leaves permissions to OpenCode.
  permissionMode?: string
  onEvent: (e: MasterEvent) => void
}
export interface MasterHandle {
  stop(): Promise<void>
  done: Promise<{ ok: boolean; text: string }>
}
export interface MasterAdapter {
  start(o: MasterStartOptions): Promise<MasterHandle>
}

// OpenCode v2's shared background service: where it listens (state) and the password it asks for
// (state carries one too; the private config repeats it). The TUI discovers them the same way.
const STATE_PATH = join(homedir(), '.local', 'state', 'opencode', 'service.json')
const PRIVATE_PATH = join(homedir(), '.config', 'opencode', 'service.json')

export interface ServiceConfig {
  url: string
  auth: string
}

export interface ChildLike {
  stdout: { on(ev: 'data', cb: (d: Buffer | string) => void): unknown } | null
  stderr: { on(ev: 'data', cb: (d: Buffer | string) => void): unknown } | null
  on(ev: 'error', cb: (e: Error) => void): unknown
  on(ev: 'close', cb: (code: number | null) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

export interface OpenCodeDeps {
  spawn: (cmd: string, args: string[], opts: { cwd: string; env?: Record<string, string> }) => ChildLike
  fetch: (
    url: string,
    init?: RequestInit,
  ) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; body: ReadableStream<Uint8Array> | null }>
  readJson: (file: string) => unknown
  sleep: (ms: number) => Promise<void>
  newSessionId: () => string
}

const defaults: OpenCodeDeps = {
  spawn: (cmd, args, opts) =>
    spawnHidden(cmd, args, {
      cwd: opts.cwd,
      ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
      stdio: ['ignore', 'pipe', 'pipe'],
      source: 'opencode',
      // No shell: the prompt is one argument and must not be re-parsed by cmd.exe (opencode installs as an .exe).
    }) as unknown as ChildLike,
  fetch: (url, init) => fetch(url, init) as ReturnType<OpenCodeDeps['fetch']>,
  readJson: (file) => {
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return null
    }
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  newSessionId: () => `ses_${randomUUID().replace(/-/g, '')}`,
}

const AUTO_APPROVE_MODES = ['acceptEdits', 'bypassPermissions']

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {})

// Where the background service listens and its password; null when it is not running.
export function findService(deps: Pick<OpenCodeDeps, 'readJson'> = defaults): ServiceConfig | null {
  const state = obj(deps.readJson(STATE_PATH))
  const priv = obj(deps.readJson(PRIVATE_PATH))
  const url = state.url
  const password = state.password || priv.password
  if (!url || !password) return null
  return {
    url: String(url).replace(/\/+$/, ''),
    auth: 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64'),
  }
}

// A tool result's text: successes come as content blocks, failures as an error (message or plain).
function toolText(d: Obj): string {
  if (Array.isArray(d.content)) return d.content.map((c) => String(obj(c).text ?? '')).join('')
  if (d.error != null) return String(obj(d.error).message ?? d.error)
  return d.output != null ? String(d.output) : ''
}

// One service event for the pinned session -> a Master event (or null when it is not one we report).
export function eventFor(type: string, d: Obj, tools: Map<string, string>): MasterEvent | null {
  switch (type) {
    case 'session.tool.input.started':
      tools.set(String(d.id), String(d.name ?? ''))
      return null
    case 'session.tool.called':
      return { kind: 'tool', text: tools.get(String(d.id)) || '' }
    case 'session.tool.success':
    case 'session.tool.failed':
      tools.delete(String(d.id))
      return { kind: type === 'session.tool.failed' ? 'tool-error' : 'tool-result', text: toolText(d).slice(0, 4000) }
    case 'session.text.ended':
      return d.text ? { kind: 'text', text: String(d.text) } : null
    case 'session.execution.started':
      return { kind: 'busy' }
    case 'session.execution.succeeded':
    case 'session.execution.failed':
      return { kind: 'idle' }
    default:
      return null
  }
}

export interface ChildSession {
  id: string
  title: string
  agent: string
  directory: string
  // providerID/modelID, and whether the child has finished a run (the service sets `outcome`).
  model?: string
  done?: boolean
}

// Child sessions of a session (GET /api/session?parentID=, answered as { data: [...] }), for the subagent reader. Empty when the service is down or errors.
export async function listChildSessions(
  sessionId: string,
  deps: Partial<Pick<OpenCodeDeps, 'fetch' | 'readJson'>> = {},
): Promise<ChildSession[]> {
  const d = { ...defaults, ...deps }
  const cfg = findService(d)
  if (!cfg) return []
  try {
    const r = await d.fetch(`${cfg.url}/api/session?parentID=${encodeURIComponent(sessionId)}`, { headers: { Authorization: cfg.auth } })
    if (!r.ok) return []
    const data = await r.json()
    const body = obj(data)
    const list = Array.isArray(data) ? data : Array.isArray(body.data) ? body.data : Array.isArray(body.items) ? body.items : []
    return list.map((s) => {
      const o = obj(s)
      return {
        id: String(o.id ?? ''),
        title: String(o.title ?? o.id ?? ''),
        agent: String(o.agent ?? 'subagent'),
        directory: String(obj(o.location).directory ?? o.directory ?? ''),
        model: obj(o.model).id ? `${String(obj(o.model).providerID ?? '')}/${String(obj(o.model).id)}`.replace(/^\//, '') : '',
        done: typeof o.outcome === 'string' && o.outcome !== '',
      }
    })
  } catch {
    return []
  }
}

// A session's messages, oldest first ({ data: [...] }: user { text }, assistant { content: reasoning/text/tool blocks },
// idle). Anything unrecognised yields no lines. Empty when the service is down or errors.
export async function listSessionMessages(
  sessionId: string,
  deps: Partial<Pick<OpenCodeDeps, 'fetch' | 'readJson'>> = {},
): Promise<unknown[]> {
  const d = { ...defaults, ...deps }
  const cfg = findService(d)
  if (!cfg) return []
  try {
    const r = await d.fetch(`${cfg.url}/api/session/${encodeURIComponent(sessionId)}/message`, { headers: { Authorization: cfg.auth } })
    if (!r.ok) return []
    const data = await r.json()
    const body = obj(data)
    return Array.isArray(data) ? data : Array.isArray(body.data) ? body.data : Array.isArray(body.items) ? body.items : []
  } catch {
    return []
  }
}

function missing(e: unknown): Error {
  const code = (e as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT') return new Error('OpenCode is not installed or not on PATH (the `opencode` command was not found)')
  return e instanceof Error ? e : new Error(String(e))
}

export function createOpenCodeAdapter(deps: Partial<OpenCodeDeps> = {}): MasterAdapter {
  const d: OpenCodeDeps = { ...defaults, ...deps }

  // The service's event stream for this one session; best effort, the process output flows without it.
  async function streamEvents(
    sessionId: string,
    onEvent: MasterStartOptions['onEvent'],
    signal: AbortSignal,
    over: () => boolean,
  ): Promise<void> {
    const cfg = findService(d)
    if (!cfg) return
    const tools = new Map<string, string>()
    const dec = new TextDecoder()
    try {
      const r = await d.fetch(`${cfg.url}/api/event`, { headers: { Authorization: cfg.auth }, signal })
      const reader = r.body?.getReader()
      if (!reader) return
      let buf = ''
      while (!over()) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i: number
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim()
          buf = buf.slice(i + 1)
          if (!line.startsWith('data:')) continue
          try {
            const e = obj(JSON.parse(line.slice(5)))
            const data = obj(e.data)
            if (data.sessionID !== sessionId) continue
            const ev = eventFor(String(e.type), data, tools)
            if (ev) onEvent(ev)
          } catch {
            // a malformed line is skipped
          }
        }
      }
    } catch {
      // service restarting, or aborted at the end of the job
    }
  }

  async function start(o: MasterStartOptions): Promise<MasterHandle> {
    // The session id is pinned up front so the event stream and interrupt can address it before it exists.
    const sessionId = d.newSessionId()
    const args = ['run', '--session', sessionId]
    // `run` has no --variant flag: the effort rides on the model as provider/model#variant.
    if (o.model) {
      const variant = o.effort && /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(o.effort) ? `#${o.effort}` : ''
      args.push('--model', `${o.model.split('#')[0]}${variant}`)
    }
    if (o.permissionMode && AUTO_APPROVE_MODES.includes(o.permissionMode)) args.push('--auto')
    args.push(o.prompt)

    let child: ChildLike
    try {
      child = d.spawn('opencode', args, { cwd: o.cwd, ...(o.mcp?.env ? { env: o.mcp.env } : {}) })
    } catch (e) {
      throw missing(e)
    }

    let text = ''
    let finished = false
    let spawnError: Error | null = null
    const abort = new AbortController()

    const done = new Promise<{ ok: boolean; text: string }>((resolve, reject) => {
      child.stdout?.on('data', (b) => {
        const s = String(b)
        text += s
        o.onEvent({ kind: 'output', text: s })
      })
      child.stderr?.on('data', (b) => o.onEvent({ kind: 'stderr', text: String(b) }))
      child.on('error', (e) => {
        spawnError = missing(e)
        finished = true
        abort.abort()
        reject(spawnError)
      })
      child.on('close', (code) => {
        if (spawnError) return
        finished = true
        abort.abort()
        resolve({ ok: code === 0, text: text.trim() })
      })
    })
    done.catch(() => {})
    // A missing executable reports its error on the next tick: surface it from start().
    await d.sleep(0)
    if (spawnError) throw spawnError

    o.onEvent({ kind: 'session', text: sessionId })
    void streamEvents(sessionId, o.onEvent, abort.signal, () => finished)

    return {
      async stop() {
        if (finished) return
        const cfg = findService(d)
        if (cfg) {
          try {
            await d.fetch(`${cfg.url}/api/session/${sessionId}/interrupt`, {
              method: 'POST',
              headers: { Authorization: cfg.auth },
            })
          } catch {
            // the kill below still stops it
          }
        }
        try {
          child.kill()
        } catch {
          // already gone
        }
      },
      done,
    }
  }

  return { start }
}
