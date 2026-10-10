import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunResult } from './proc'
import { CapabilityProber, capabilitiesFrom, parseVersion, type ProbeDeps } from './capabilities'

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' })

function deps(answer: (command: string) => RunResult | Promise<RunResult>, extra: Partial<ProbeDeps> = {}): ProbeDeps & { run: ReturnType<typeof vi.fn> } {
  const run = vi.fn((command: string) => Promise.resolve(answer(command)))
  return { run, openCodeDbExists: () => false, now: () => 1000, platform: 'linux', ...extra } as ProbeDeps & { run: ReturnType<typeof vi.fn> }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('capabilities', () => {
  it('reads the version from the first version-looking token', () => {
    expect(parseVersion('2.1.295 (Claude Code)\n')).toBe('2.1.295')
    expect(parseVersion('opencode 1.4.0-beta.2')).toBe('1.4.0-beta.2')
    expect(parseVersion('no version here')).toBeNull()
    expect(parseVersion('opencode v2.0.24')).toBe('2.0.24')
  })

  it('marks Claude Code hooks, status line and sub-agent events true when installed', () => {
    const c = capabilitiesFrom('claude', ok('2.1.295 (Claude Code)'), false, 'transcript')
    expect(c).toEqual({
      id: 'claude',
      command: 'claude',
      installed: true,
      version: '2.1.295',
      hooks: true,
      statusLine: true,
      subagentEvents: true,
      usageSource: 'transcript',
    })
    expect(c.error).toBeUndefined()
  })

  it('keeps OpenCode without hooks, status line or sub-agent events', () => {
    const c = capabilitiesFrom('opencode', ok('1.4.0'), false, 'opencode-db')
    expect(c).toMatchObject({ installed: true, version: '1.4.0', hooks: false, statusLine: false, subagentEvents: false, usageSource: 'opencode-db' })
  })

  it('reports a missing executable as a clear error, not a crash', () => {
    const c = capabilitiesFrom('claude', { code: null, stdout: '', stderr: 'spawn claude ENOENT' }, false, 'transcript')
    expect(c).toMatchObject({ installed: false, version: null, error: 'claude is not on PATH', hooks: false, statusLine: false })
    const win = capabilitiesFrom('opencode', { code: 1, stdout: '', stderr: "'opencode' is not recognized as an internal or external command" }, false, 'none')
    expect(win.error).toBe('opencode is not on PATH')
  })

  it('reports a probe that did not answer in time', () => {
    const c = capabilitiesFrom('claude', { code: null, stdout: '', stderr: '' }, true, 'transcript')
    expect(c.error).toBe('claude --version did not answer within 5 s')
    expect(c.installed).toBe(false)
  })

  it('reports a failed version command with its exit code', () => {
    const c = capabilitiesFrom('claude', { code: 2, stdout: '', stderr: 'bad config\nmore' }, false, 'transcript')
    expect(c.installed).toBe(false)
    expect(c.error).toBe('claude --version failed (exit 2): bad config')
  })

  it('probes both CLIs once, caches the report and refreshes on demand', async () => {
    const d = deps((cmd) => (cmd === 'claude' ? ok('2.1.295') : { code: null, stdout: '', stderr: 'spawn opencode ENOENT' }), { openCodeDbExists: () => false })
    const prober = new CapabilityProber(d)
    const first = await prober.get()
    expect(first.claude.installed).toBe(true)
    expect(first.opencode).toMatchObject({ installed: false, error: 'opencode is not on PATH', usageSource: 'none' })
    expect(first.checkedAt).toBe(1000)
    await prober.get()
    expect(d.run).toHaveBeenCalledTimes(2)
    await prober.refresh()
    expect(d.run).toHaveBeenCalledTimes(4)
    expect(d.run).toHaveBeenCalledWith('claude', ['--version'], { timeoutMs: 5000, shell: false })
  })

  it('shares one probe between concurrent callers and uses shell on Windows', async () => {
    const d = deps(() => ok('2.1.295'), { platform: 'win32' })
    const prober = new CapabilityProber(d)
    await Promise.all([prober.get(), prober.get(), prober.refresh()])
    expect(d.run).toHaveBeenCalledTimes(2)
    expect(d.run).toHaveBeenCalledWith('claude', ['--version'], { timeoutMs: 5000, shell: true })
  })

  it('gives up on a probe that never answers after 5 seconds', async () => {
    vi.useFakeTimers()
    const d = deps((cmd) => (cmd === 'claude' ? new Promise<RunResult>(() => undefined) : ok('1.4.0')))
    const pending = new CapabilityProber(d).get()
    await vi.advanceTimersByTimeAsync(5000)
    const report = await pending
    expect(report.claude).toMatchObject({ installed: false, error: 'claude --version did not answer within 5 s' })
    expect(report.opencode.installed).toBe(true)
  })

  it('uses the OpenCode database as its usage source when it exists', async () => {
    const report = await new CapabilityProber(deps(() => ok('1.0.0'), { openCodeDbExists: () => true })).get()
    expect(report.opencode.usageSource).toBe('opencode-db')
  })
})
