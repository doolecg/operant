import { existsSync } from 'node:fs'
import type { CapabilityReport, CapabilityTerminal, TerminalCapabilities, UsageSource } from '../shared/claude-mods'
import { runHidden, type RunResult } from './proc'

export const PROBE_TIMEOUT_MS = 5000

export interface ProbeDeps {
  // Runs `command --version`; the real one is runHidden. A missing command comes back as a failed run.
  run: (command: string, args: string[], opts: { timeoutMs: number; shell: boolean }) => Promise<RunResult>
  // Whether OpenCode's local database exists, the source of its usage.
  openCodeDbExists: () => boolean
  now: () => number
  platform: NodeJS.Platform
}

const COMMANDS: Record<CapabilityTerminal, string> = { claude: 'claude', opencode: 'opencode' }

const VERSION_RE = /(?<![\d.])(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/

// The first version-looking token of the output, or null.
export function parseVersion(output: string): string | null {
  return VERSION_RE.exec(output)?.[1] ?? null
}

const NOT_ON_PATH = /ENOENT|not recognized|not found|No such file|cannot find the (file|path)/i

// Turns one `--version` run into the terminal's capabilities. Only a run that printed a version counts as installed.
export function capabilitiesFrom(id: CapabilityTerminal, run: RunResult, timedOut: boolean, usageSource: UsageSource): TerminalCapabilities {
  const command = COMMANDS[id]
  const version = parseVersion(run.stdout) ?? parseVersion(run.stderr)
  const base = { id, command, hooks: false, statusLine: false, subagentEvents: false, usageSource }
  if (timedOut) return { ...base, installed: false, version: null, error: `${command} --version did not answer within ${PROBE_TIMEOUT_MS / 1000} s` }
  if (run.code === 0 && version) {
    // Claude Code's hooks, status line and sub-agent events are used whenever the CLI is installed.
    if (id === 'claude') return { ...base, installed: true, version, hooks: true, statusLine: true, subagentEvents: true }
    return { ...base, installed: true, version }
  }
  const detail = (run.stderr || run.stdout).trim().split('\n')[0] ?? ''
  if (NOT_ON_PATH.test(`${run.stderr}\n${run.stdout}`) || (run.code === null && !version)) {
    return { ...base, installed: false, version: null, error: `${command} is not on PATH` }
  }
  return { ...base, installed: false, version, error: `${command} --version failed${run.code !== null ? ` (exit ${run.code})` : ''}${detail ? `: ${detail.slice(0, 200)}` : ''}` }
}

// Runs one probe with the timeout enforced here too, so a hung command never blocks the report.
async function probe(deps: ProbeDeps, id: CapabilityTerminal, usageSource: UsageSource): Promise<TerminalCapabilities> {
  let timer: NodeJS.Timeout | undefined
  let timedOut = false
  const timeout = new Promise<RunResult>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true
      resolve({ code: null, stdout: '', stderr: '' })
    }, PROBE_TIMEOUT_MS)
  })
  try {
    const run = await Promise.race([
      deps.run(COMMANDS[id], ['--version'], { timeoutMs: PROBE_TIMEOUT_MS, shell: deps.platform === 'win32' }),
      timeout,
    ])
    return capabilitiesFrom(id, run, timedOut, usageSource)
  } catch (err) {
    return capabilitiesFrom(id, { code: null, stdout: '', stderr: err instanceof Error ? err.message : String(err) }, false, usageSource)
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// The PATH probe, cached until refresh(). Concurrent callers share one probe.
export class CapabilityProber {
  private cache: CapabilityReport | null = null
  private inflight: Promise<CapabilityReport> | null = null

  constructor(private readonly deps: ProbeDeps) {}

  get(): Promise<CapabilityReport> {
    if (this.cache) return Promise.resolve(this.cache)
    return this.refresh()
  }

  refresh(): Promise<CapabilityReport> {
    if (this.inflight) return this.inflight
    this.inflight = this.runAll().then(
      (report) => {
        this.cache = report
        this.inflight = null
        return report
      },
      (err: unknown) => {
        this.inflight = null
        throw err
      },
    )
    return this.inflight
  }

  private async runAll(): Promise<CapabilityReport> {
    const [claude, opencode] = await Promise.all([
      probe(this.deps, 'claude', 'transcript'),
      probe(this.deps, 'opencode', this.deps.openCodeDbExists() ? 'opencode-db' : 'none'),
    ])
    return { claude, opencode, checkedAt: this.deps.now() }
  }
}

// The real probe: spawns the commands with the hidden-console helper; a missing command is reported, never thrown.
export function systemProbeDeps(openCodeDb: string, platform: NodeJS.Platform = process.platform): ProbeDeps {
  return {
    run: (command, args, opts) => runHidden(command, args, { timeoutMs: opts.timeoutMs, shell: opts.shell, quiet: true }),
    openCodeDbExists: () => existsSync(openCodeDb),
    now: Date.now,
    platform,
  }
}
