import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import type { ConsoleSource } from '../shared/console'
import { consoleLog, LineBuffer } from './console'
import { hiddenConsoleEnv } from './hideshim'

// Every background process Operant starts goes through here: it never gets a console window (windowsHide), and its
// output and lifecycle go to the in-app console. Interactive terminal tiles (node-pty) are separate and stay visible.

export interface HiddenSpawnOptions extends Omit<SpawnOptions, 'windowsHide'> {
  source?: ConsoleSource
  // Skip console logging and process tracking (helpers like taskkill).
  quiet?: boolean
}

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

export function sourceFor(cmd: string): ConsoleSource {
  const name = (cmd.split(/[\\/]/).pop() ?? cmd).toLowerCase().replace(/\.(exe|cmd|bat)$/, '')
  if (name === 'uvx' || name === 'uv') return 'hindsight'
  if (name === 'git') return 'git'
  if (name === 'codegraph') return 'codegraph'
  if (name === 'opencode') return 'opencode'
  return 'claude-run'
}

const MAX_ARG = 60

// A command line safe to show: the prompt and other long arguments are clipped, and MCP arguments (which can carry
// tokens) are reduced to their subcommand.
export function describeCommand(cmd: string, args: string[], source: ConsoleSource): string {
  const shown = source === 'mcp' ? args.slice(0, 3) : args
  const parts = shown.map((a) => (a.length > MAX_ARG ? `${a.slice(0, MAX_ARG)}...` : a))
  return [cmd, ...parts, ...(source === 'mcp' && args.length > 3 ? [`(+${args.length - 3} args hidden)`] : [])].join(' ')
}

const children = new Map<number, ChildProcess>()

export function spawnHidden(cmd: string, args: string[], opts: HiddenSpawnOptions = {}): ChildProcess {
  const { source: given, quiet, ...rest } = opts
  const source = given ?? sourceFor(cmd)
  // A detached daemon or hook anywhere in the tree would open a visible console on Windows: see hideshim.ts.
  if (!quiet && process.platform === 'win32') rest.env = hiddenConsoleEnv(rest.env ?? process.env)
  const child = spawn(cmd, args, { ...rest, windowsHide: true })
  if (quiet) return child
  const label = describeCommand(cmd, args, source)
  const out = new LineBuffer()
  const err = new LineBuffer()
  const log = (stream: 'stdout' | 'stderr' | 'info', text: string, error?: boolean) =>
    consoleLog.add(source, stream, text, { ...(child.pid !== undefined ? { pid: child.pid } : {}), ...(error !== undefined ? { error } : {}) })
  child.on('spawn', () => {
    if (child.pid === undefined) return
    children.set(child.pid, child)
    consoleLog.processStarted({ pid: child.pid, source, command: label, startedAt: Date.now() })
    log('info', `started: ${label}`)
  })
  child.stdout?.on('data', (b) => {
    for (const l of out.push(String(b))) log('stdout', l)
  })
  child.stderr?.on('data', (b) => {
    for (const l of err.push(String(b))) log('stderr', l)
  })
  child.on('error', (e) => log('info', `${cmd}: ${e.message}`, true))
  child.on('close', (code, signal) => {
    for (const l of out.flush()) log('stdout', l)
    for (const l of err.flush()) log('stderr', l)
    if (child.pid !== undefined) {
      children.delete(child.pid)
      consoleLog.processEnded(child.pid)
    }
    log('info', `exited ${signal ? `by ${signal}` : `with code ${code}`}: ${cmd}`, !signal && code !== 0 && code !== null)
  })
  return child
}

// Runs a command to completion and collects its output; never rejects.
export function runHidden(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; shell?: boolean; source?: ConsoleSource; quiet?: boolean } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    try {
      const child = spawnHidden(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        shell: opts.shell ?? false,
        timeout: opts.timeoutMs,
        ...(opts.source ? { source: opts.source } : {}),
        ...(opts.quiet ? { quiet: true } : {}),
      })
      child.stdout?.on('data', (b) => (out += String(b)))
      child.stderr?.on('data', (b) => (err += String(b)))
      child.on('error', (e) => resolve({ code: null, stdout: out, stderr: String(e.message) }))
      child.on('close', (code) => resolve({ code, stdout: out, stderr: err }))
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: e instanceof Error ? e.message : String(e) })
    }
  })
}

// Kills a whole tree on Windows (shell: true leaves cmd.exe in front of the real program), else a plain kill.
export function killTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid) spawnHidden('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', quiet: true }).on('error', () => {})
  else child.kill()
}

// Quit path: kills the tree of every background process Operant started (jobs, learn calls, MCP checks, the Hindsight
// service), by pid, and waits briefly for the kills so nothing outlives the app holding its pipes open.
export async function killAllOwn(waitMs = 3000): Promise<void> {
  const waits: Promise<void>[] = []
  for (const child of children.values()) {
    if (child.pid && process.platform === 'win32') {
      waits.push(
        new Promise<void>((resolve) => {
          const k = spawnHidden('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', quiet: true })
          k.on('error', () => resolve())
          k.on('close', () => resolve())
        }),
      )
    } else child.kill()
  }
  if (!waits.length) return
  let timer: NodeJS.Timeout | undefined
  await Promise.race([Promise.all(waits), new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)))])
  clearTimeout(timer)
}

// Stops a process Operant started, by pid; any other pid is refused so a stray number can never hit another program.
export function stopOwnProcess(pid: number): boolean {
  const child = children.get(pid)
  if (!child || !consoleLog.isOwnProcess(pid)) return false
  killTree(child)
  return true
}
