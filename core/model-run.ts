import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { killTree, spawnHidden } from './proc'
import { buildClaudeRunLaunch } from './launch'

export interface MasterEvent {
  kind: string
  text?: string
}

export interface MasterRun {
  stop(): Promise<void>
  done: Promise<{ ok: boolean; text: string }>
}

// A one-shot model call's deadline: past `ms` the run is stopped (no child process is left behind) and the call fails.
export const MODEL_TIMEOUT_MS = 120_000

export async function resultWithin(run: MasterRun, ms: number, what: string): Promise<{ ok: boolean; text: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms)
  })
  try {
    return await Promise.race([run.done, late])
  } catch (err) {
    void run.stop().catch(() => undefined)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

// What one one-shot model call runs.
export interface MasterStart {
  cwd: string
  prompt: string
  model?: string
  effort?: string
  // The project's permission mode; only the OpenCode adapter reads it (to decide on --auto).
  permissionMode?: string
  onEvent: (e: MasterEvent) => void
}

// One CLI a one-shot model call can run on. `start` resolves once the CLI is running; `done` settles when the job ends.
export interface MasterAdapter {
  start(o: MasterStart): Promise<MasterRun>
}

export interface ClaudeChild {
  stdin: { write(data: string): unknown; end(): unknown }
  stdout: { on(event: 'data', fn: (chunk: Buffer | string) => void): unknown }
  stderr: { on(event: 'data', fn: (chunk: Buffer | string) => void): unknown }
  on(event: 'exit', fn: (code: number | null) => void): unknown
  on(event: 'error', fn: (err: Error) => void): unknown
  kill(): unknown
}

export type ClaudeSpawn = (file: string, args: string[], opts: { cwd: string }) => ClaudeChild

// Tests and e2e runs must never reach the owner's real `claude` or `opencode` (they cost money and run their hooks):
// the first one on PATH has to be a fixture, and unit tests have to inject a spawn.
export function assertFakeClaude(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, cli: 'claude' | 'opencode' = 'claude'): void {
  if (!env.VITEST && !env.OPERANT_E2E) return
  if (env.VITEST) throw new Error(`A test tried to start the real ${cli}: inject a spawn or a model instead`)
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  const names = platform === 'win32' ? [`${cli}.cmd`, `${cli}.exe`, `${cli}.bat`, cli] : [cli]
  for (const dir of (env[key] ?? '').split(platform === 'win32' ? ';' : ':')) {
    if (dir && names.some((n) => existsSync(join(dir, n)))) {
      if (/[\\/]fixtures[\\/]/.test(`${dir}/`)) return
      break
    }
  }
  throw new Error(`An e2e run tried to start the real ${cli}: put e2e/fixtures/bin first on PATH`)
}

// A settings file whose only content turns hooks off; `claude --settings` layers it over the user's own settings.
export function noHooksSettingsFile(dir: string = tmpdir()): string {
  const file = join(dir, 'operant-claude-no-hooks.json')
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, '{"disableAllHooks":true}\n')
  return file
}

const realSpawn: ClaudeSpawn = (file, args, opts) => {
  assertFakeClaude()
  const child = spawnHidden(file, args, { cwd: opts.cwd, shell: process.platform === 'win32', stdio: 'pipe', source: 'claude-run' })
  const kill = () => killTree(child)
  return Object.assign(child, { kill }) as unknown as ClaudeChild
}

export interface ClaudeAdapterOptions {
  spawn?: ClaudeSpawn
  supported?: ReadonlySet<string>
  permissionMode?: string
  // Whether the user's own Claude hooks and plugins run in this call (read per start, so a setting applies live).
  // Default false: short model calls and runs never fire hooks, which open console windows from a no-console process.
  userHooks?: () => boolean
}

interface StreamLine {
  type?: string
  subtype?: string
  session_id?: string
  is_error?: boolean
  result?: string
  message?: { content?: Array<{ type?: string; text?: string; name?: string }> }
}

// Claude Code: `claude -p` with stream-json output, built on the same checks as the interactive launch.
export class ClaudeAdapter implements MasterAdapter {
  constructor(private readonly opts: ClaudeAdapterOptions = {}) {}

  async start(o: MasterStart): Promise<MasterRun> {
    const launch = buildClaudeRunLaunch(
      { cwd: o.cwd, model: o.model, effort: o.effort, permissionMode: this.opts.permissionMode ?? 'acceptEdits', ...(this.opts.userHooks?.() ? {} : { settingsFile: noHooksSettingsFile() }) },
      { supported: this.opts.supported },
    )
    const child = (this.opts.spawn ?? realSpawn)(launch.file, launch.args, { cwd: launch.cwd })

    let result: { ok: boolean; text: string } | null = null
    let lastText = ''
    let stderr = ''
    let buffer = ''
    let sessionSent = false
    const line = (raw: string) => {
      let msg: StreamLine
      try {
        msg = JSON.parse(raw) as StreamLine
      } catch {
        return
      }
      if (msg.session_id && !sessionSent) {
        sessionSent = true
        o.onEvent({ kind: 'session', text: msg.session_id })
      }
      if (msg.type === 'assistant') {
        for (const block of msg.message?.content ?? []) {
          if (block.type === 'text' && block.text) {
            lastText = block.text
            o.onEvent({ kind: 'text', text: block.text })
          } else if (block.type === 'tool_use') o.onEvent({ kind: 'tool', text: block.name })
        }
      } else if (msg.type === 'result') {
        result = { ok: !msg.is_error && (msg.subtype === undefined || msg.subtype === 'success'), text: String(msg.result ?? lastText) }
      }
    }
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString()
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        line(buffer.slice(0, nl).trim())
        buffer = buffer.slice(nl + 1)
      }
    })
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-2000)
    })

    let stopped = false
    const done = new Promise<{ ok: boolean; text: string }>((resolve) => {
      child.on('error', (err) => resolve({ ok: false, text: `Could not start claude: ${err.message}` }))
      child.on('exit', (code) => {
        if (buffer.trim()) line(buffer.trim())
        if (result) resolve(result)
        else if (stopped) resolve({ ok: false, text: 'Stopped' })
        else resolve({ ok: false, text: stderr.trim() || lastText || `claude exited with code ${code ?? 'unknown'}` })
      })
    })

    child.stdin.write(o.prompt)
    child.stdin.end()

    return {
      done,
      stop: async () => {
        stopped = true
        child.kill()
        await done
      },
    }
  }
}
