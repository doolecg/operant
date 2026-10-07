import { describe, expect, it } from 'vitest'
import { ConsoleLog, LineBuffer, scrubConsoleText } from './console'

describe('ConsoleLog', () => {
  it('keeps lines with ids, source, pid and timestamps', () => {
    const log = new ConsoleLog({ now: () => 42 })
    log.add('git', 'stdout', 'one\ntwo\n\n', { pid: 7 })
    expect(log.list()).toEqual([
      { id: 1, at: 42, source: 'git', stream: 'stdout', text: 'one', error: false, pid: 7 },
      { id: 2, at: 42, source: 'git', stream: 'stdout', text: 'two', error: false, pid: 7 },
    ])
  })

  it('caps by line count, dropping the oldest', () => {
    const log = new ConsoleLog({ maxLines: 3 })
    for (let i = 0; i < 5; i++) log.add('mcp', 'stdout', `l${i}`)
    expect(log.list().map((l) => l.text)).toEqual(['l2', 'l3', 'l4'])
  })

  it('caps by size and clips long lines', () => {
    const log = new ConsoleLog({ maxBytes: 300, maxLine: 50 })
    for (let i = 0; i < 20; i++) log.add('mcp', 'stdout', 'x'.repeat(200))
    expect(log.list().length).toBeLessThan(6)
    expect(log.list()[0]!.text).toBe(`${'x'.repeat(50)}...`)
  })

  it('filters by source and after an id, and clears one source or all', () => {
    const log = new ConsoleLog()
    log.add('git', 'stdout', 'g')
    log.add('mcp', 'stdout', 'm')
    expect(log.list({ source: 'mcp' }).map((l) => l.text)).toEqual(['m'])
    expect(log.list({ afterId: 1 }).map((l) => l.text)).toEqual(['m'])
    log.clear('git')
    expect(log.list().map((l) => l.text)).toEqual(['m'])
    log.clear()
    expect(log.list()).toEqual([])
  })

  it('flags error lines: stderr that says so, or an explicit error', () => {
    const log = new ConsoleLog()
    log.add('git', 'stderr', 'fatal: not a repository')
    log.add('git', 'stderr', 'Downloading packages')
    log.add('git', 'info', 'exited with code 1', { error: true })
    expect(log.list().map((l) => l.error)).toEqual([true, false, true])
  })

  it('pushes each line to listeners and survives a throwing one', () => {
    const log = new ConsoleLog()
    const seen: string[] = []
    log.onLine(() => {
      throw new Error('boom')
    })
    const off = log.onLine((l) => seen.push(l.text))
    log.add('git', 'stdout', 'a')
    off()
    log.add('git', 'stdout', 'b')
    expect(seen).toEqual(['a'])
  })

  it('tracks running processes by pid', () => {
    const log = new ConsoleLog()
    log.processStarted({ pid: 5, source: 'git', command: 'git status', startedAt: 1 })
    expect(log.isOwnProcess(5)).toBe(true)
    expect(log.isOwnProcess(6)).toBe(false)
    log.processEnded(5)
    expect(log.processes()).toEqual([])
  })

  it('applies the extra scrubber after the built-in one', () => {
    const log = new ConsoleLog()
    log.setScrubber((t) => t.replace(/hunter2/g, '[x]'))
    log.add('mcp', 'stdout', 'pw hunter2')
    expect(log.list()[0]!.text).toBe('pw [x]')
  })
})

describe('scrubbing', () => {
  it.each([
    ['sk-abcdefghijklmnopqrstuvwx used', 'sk-abcdefghijklmnopqrstuvwx'],
    ['Authorization: Bearer abcdef0123456789abcdef', 'abcdef0123456789abcdef'],
    ['ANTHROPIC_API_KEY=sk_live_notreally1', 'sk_live_notreally1'],
    ['HINDSIGHT_API_LLM_TOKEN: supersecretvalue', 'supersecretvalue'],
    ['fetch https://user:p4ssw0rd@host/x', 'p4ssw0rd'],
    ['ghp_abcdefghijklmnopqrstuvwxyz0123', 'ghp_abcdefghijklmnopqrstuvwxyz0123'],
  ])('removes the secret from %s', (line, secret) => {
    const out = scrubConsoleText(line)
    expect(out).not.toContain(secret)
    expect(out).toContain('[secret]')
  })

  it('leaves ordinary text alone', () => {
    expect(scrubConsoleText('server listening on port 9077')).toBe('server listening on port 9077')
  })
})

describe('LineBuffer', () => {
  it('joins a line split across chunks and flushes the tail', () => {
    const b = new LineBuffer()
    expect(b.push('hel')).toEqual([])
    expect(b.push('lo\r\nwor')).toEqual(['hello'])
    expect(b.flush()).toEqual(['wor'])
    expect(b.flush()).toEqual([])
  })
})
