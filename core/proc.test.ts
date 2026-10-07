import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { consoleLog } from './console'
import { describeCommand, killAllOwn, runHidden, sourceFor, spawnHidden, stopOwnProcess } from './proc'

const node = process.execPath
const here = dirname(fileURLToPath(import.meta.url))

describe('spawnHidden', () => {
  it('captures output and lifecycle into the console under its source', async () => {
    consoleLog.clear()
    const r = await runHidden(node, ['-e', "console.log('hello out'); console.error('bad news: error'); process.exit(3)"], { source: 'git' })
    expect(r.code).toBe(3)
    expect(r.stdout).toContain('hello out')
    const lines = consoleLog.list({ source: 'git' })
    expect(lines.some((l) => l.stream === 'stdout' && l.text === 'hello out')).toBe(true)
    expect(lines.some((l) => l.stream === 'stderr' && l.error)).toBe(true)
    expect(lines.some((l) => l.stream === 'info' && /^started:/.test(l.text))).toBe(true)
    expect(lines.some((l) => l.stream === 'info' && l.error && /exited with code 3/.test(l.text))).toBe(true)
  })

  it('scrubs secrets from process output', async () => {
    consoleLog.clear()
    await runHidden(node, ['-e', "console.log('token=abcdef123456789 and Bearer abcdefgh12345678')"], { source: 'mcp' })
    const text = consoleLog
      .list({ source: 'mcp' })
      .map((l) => l.text)
      .join('\n')
    expect(text).not.toContain('abcdef123456789')
    expect(text).not.toContain('abcdefgh12345678')
  })

  it('logs a missing command as an error and still resolves', async () => {
    consoleLog.clear()
    const r = await runHidden('operant-no-such-command', [], { source: 'codegraph' })
    expect(r.code).toBeNull()
    expect(consoleLog.list({ source: 'codegraph' }).some((l) => l.error)).toBe(true)
  })

  it('lists a running process and stops only processes it started', async () => {
    consoleLog.clear()
    const child = spawnHidden(node, ['-e', 'setInterval(() => {}, 1000)'], { source: 'hindsight', stdio: ['ignore', 'pipe', 'pipe'] })
    await new Promise((r) => child.once('spawn', r))
    expect(consoleLog.processes().map((p) => p.pid)).toContain(child.pid)
    expect(stopOwnProcess(process.pid)).toBe(false)
    const closed = new Promise((r) => child.once('close', r))
    expect(stopOwnProcess(child.pid!)).toBe(true)
    await closed
    expect(consoleLog.processes().map((p) => p.pid)).not.toContain(child.pid)
  })

  it('hides the command line of MCP calls beyond the subcommand and clips long arguments', () => {
    expect(describeCommand('claude', ['mcp', 'add', 'x', '--header', 'Authorization: Bearer abc'], 'mcp')).toBe('claude mcp add x (+2 args hidden)')
    expect(describeCommand('opencode', ['run', 'p'.repeat(200)], 'opencode')).toBe(`opencode run ${'p'.repeat(60)}...`)
  })

  it('names the source from the command', () => {
    expect(sourceFor('uvx')).toBe('hindsight')
    expect(sourceFor('C:\\bin\\git.exe')).toBe('git')
    expect(sourceFor('codegraph')).toBe('codegraph')
    expect(sourceFor('opencode')).toBe('opencode')
    expect(sourceFor('claude')).toBe('claude-run')
  })
})

describe('no visible console windows', () => {
  const files = readdirSync(here).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))

  it('only core/proc.ts touches node:child_process', () => {
    const offenders = files.filter(
      (f) => f !== 'proc.ts' && /from ['"](node:)?child_process['"]|require\(['"](node:)?child_process['"]\)/.test(readFileSync(join(here, f), 'utf8')),
    )
    expect(offenders).toEqual([])
  })

  it('every spawn in proc.ts sets windowsHide: true after the caller options, so they cannot override it', () => {
    const src = readFileSync(join(here, 'proc.ts'), 'utf8')
    const calls = [...src.matchAll(/(?<![\w.])(spawn|execFile|exec|fork|spawnSync|execFileSync)\(/g)].filter((m) => !/function\s+$/.test(src.slice(Math.max(0, m.index! - 9), m.index)))
    expect(calls.length).toBeGreaterThan(0)
    for (const m of calls) expect(src.slice(m.index!, m.index! + 120)).toMatch(/\.\.\.rest, windowsHide: true/)
  })
})

describe('killAllOwn', () => {
  it('kills every tracked background process quickly and resolves', async () => {
    const run = runHidden(node, ['-e', 'setInterval(() => {}, 1000)'], { source: 'git' })
    await new Promise((r) => setTimeout(r, 500))
    const t0 = Date.now()
    await killAllOwn()
    const r = await run
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(r.code).not.toBe(0)
  })
})
