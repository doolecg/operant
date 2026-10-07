import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ClaudeAdapter, MasterRegistry, assertFakeClaude, type ClaudeChild } from './master'
import { buildClaudeRunLaunch, validateMasterCli } from './launch'

class FakeChild extends EventEmitter {
  input = ''
  inputEnded = false
  killed = false
  out = new EventEmitter()
  err = new EventEmitter()
  stdin = {
    write: (d: string) => void (this.input += d),
    end: () => void (this.inputEnded = true),
  }
  stdout = { on: (e: 'data', fn: (c: string) => void) => void this.out.on(e, fn) }
  stderr = { on: (e: 'data', fn: (c: string) => void) => void this.err.on(e, fn) }
  kill() {
    this.killed = true
    this.emit('exit', null)
  }
}

const adapterWith = (child: FakeChild, calls: Array<{ file: string; args: string[]; cwd: string }> = []) =>
  new ClaudeAdapter({
    spawn: (file, args, opts) => {
      calls.push({ file, args, cwd: opts.cwd })
      return child as unknown as ClaudeChild
    },
  })

const line = (o: unknown) => JSON.stringify(o) + '\n'

describe('ClaudeAdapter', () => {
  it('launches claude -p in the project folder, sends the prompt on stdin and finishes with the result', async () => {
    const child = new FakeChild()
    const calls: Array<{ file: string; args: string[]; cwd: string }> = []
    const events: unknown[] = []
    const run = await adapterWith(child, calls).start({ cwd: '/proj', prompt: 'build it', model: 'claude-sonnet-5-5', onEvent: (e) => events.push(e) })
    expect(calls[0]).toMatchObject({ file: 'claude', cwd: '/proj' })
    const settings = calls[0]!.args.at(-1)!
    expect(calls[0]!.args.slice(0, -2)).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--model', 'claude-sonnet-5-5', '--permission-mode', 'acceptEdits'])
    expect(calls[0]!.args.at(-2)).toBe('--settings')
    expect(JSON.parse(readFileSync(settings.replace(/"/g, ''), 'utf8'))).toEqual({ disableAllHooks: true })
    expect(child.input).toBe('build it')
    expect(child.inputEnded).toBe(true)

    child.out.emit('data', line({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }, { type: 'tool_use', name: 'Edit' }] } }).slice(0, 20))
    child.out.emit('data', line({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }, { type: 'tool_use', name: 'Edit' }] } }).slice(20) + 'not json\n')
    child.out.emit('data', line({ type: 'result', subtype: 'success', is_error: false, result: 'Finished' }))
    child.emit('exit', 0)
    expect(events).toEqual([
      { kind: 'text', text: 'working' },
      { kind: 'tool', text: 'Edit' },
    ])
    expect(await run.done).toEqual({ ok: true, text: 'Finished' })
  })

  it('reports an error result as not ok', async () => {
    const child = new FakeChild()
    const run = await adapterWith(child).start({ cwd: '/p', prompt: 'x', onEvent: () => {} })
    child.out.emit('data', line({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'It broke' }))
    child.emit('exit', 1)
    expect(await run.done).toEqual({ ok: false, text: 'It broke' })
  })

  it('fails with the stderr text when the process exits without a result', async () => {
    const child = new FakeChild()
    const run = await adapterWith(child).start({ cwd: '/p', prompt: 'x', onEvent: () => {} })
    child.err.emit('data', 'not logged in\n')
    child.emit('exit', 1)
    expect(await run.done).toEqual({ ok: false, text: 'not logged in' })
  })

  it('stops the process and settles done', async () => {
    const child = new FakeChild()
    const run = await adapterWith(child).start({ cwd: '/p', prompt: 'x', onEvent: () => {} })
    await run.stop()
    expect(child.killed).toBe(true)
    expect(await run.done).toEqual({ ok: false, text: 'Stopped' })
  })

  it('refuses a bad model or folder before spawning', async () => {
    const child = new FakeChild()
    await expect(adapterWith(child).start({ cwd: '/p', prompt: 'x', model: 'bad model; rm', onEvent: () => {} })).rejects.toThrow(/invalid model/)
    await expect(adapterWith(child).start({ cwd: '', prompt: 'x', onEvent: () => {} })).rejects.toThrow(/invalid path/)
  })
})

describe('Master launch and registry', () => {
  it('leaves out flags this install does not list', () => {
    const launch = buildClaudeRunLaunch({ cwd: '/p', model: 'sonnet', permissionMode: 'acceptEdits' }, { supported: new Set(['--model']) })
    expect(launch.args).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--model', 'sonnet'])
  })

  it('passes --effort to a Claude run, except for Haiku', () => {
    const base = ['-p', '--output-format', 'stream-json', '--verbose']
    expect(buildClaudeRunLaunch({ cwd: '/p', model: 'claude-sonnet-5-5', effort: 'high' }).args).toEqual([...base, '--model', 'claude-sonnet-5-5', '--effort', 'high'])
    expect(buildClaudeRunLaunch({ cwd: '/p', model: 'claude-haiku-4-5', effort: 'high' }).args).toEqual([...base, '--model', 'claude-haiku-4-5'])
  })

  it('accepts only claude or opencode as a Master', () => {
    expect(validateMasterCli('claude')).toBe('claude')
    expect(validateMasterCli('opencode')).toBe('opencode')
    expect(() => validateMasterCli('codex')).toThrow(/claude or opencode/)
    expect(() => validateMasterCli('shell')).toThrow()
  })

  it('looks adapters up by CLI', () => {
    const adapter = { start: async () => ({ stop: async () => {}, done: Promise.resolve({ ok: true, text: '' }) }) }
    const registry = new MasterRegistry().register('claude', adapter)
    expect(registry.get('claude')).toBe(adapter)
    expect(registry.has('opencode')).toBe(false)
    expect(() => registry.get('opencode')).toThrow(/No Master adapter/)
  })
})

describe('hooks and the real-claude guard', () => {
  const start = async (userHooks?: () => boolean) => {
    const calls: Array<{ file: string; args: string[]; cwd: string }> = []
    const a = new ClaudeAdapter({ userHooks, spawn: (f, args, o) => (calls.push({ file: f, args, cwd: o.cwd }), new FakeChild() as unknown as ClaudeChild) })
    await a.start({ cwd: '/p', prompt: 'x', onEvent: () => undefined })
    return calls[0]!.args
  }

  it('turns the user hooks off unless the setting is on, read at each start', async () => {
    expect(await start()).toContain('--settings')
    let on = false
    expect(await start(() => on)).toContain('--settings')
    on = true
    expect(await start(() => on)).not.toContain('--settings')
  })

  it('adds --settings only when the CLI supports it', () => {
    const args = buildClaudeRunLaunch({ cwd: '/p', settingsFile: '/t/h.json' }, { supported: new Set(['--model']) }).args
    expect(args).not.toContain('--settings')
    expect(buildClaudeRunLaunch({ cwd: '/p', settingsFile: '/t/h.json' }).args.slice(-2)).toEqual(['--settings', '"/t/h.json"'])
  })

  it('refuses to start a real claude under test', () => {
    expect(() => assertFakeClaude({ VITEST: 'true' })).toThrow(/inject/)
    expect(() => assertFakeClaude({ OPERANT_E2E: '1', PATH: '/nowhere' }, 'linux')).toThrow(/real claude/)
    expect(() => assertFakeClaude({})).not.toThrow()
  })
})
