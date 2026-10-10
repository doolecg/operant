import { describe, expect, it } from 'vitest'
import { parseArgs, render } from './operant'

describe('operant CLI', () => {
  it('parses memory recall into the query text', () => {
    const p = parseArgs(['memory', 'recall', 'how', 'we', 'deploy'])
    expect(p).toEqual({ kind: 'request', cmd: 'memory.recall', args: { query: 'how we deploy' }, json: false, stdin: null })
  })

  it('collects repeated tags and reads stdin text when asked with -', () => {
    const p = parseArgs(['memory', 'retain', '-', '--tag', 'a', '--tag', 'b'])
    expect(p).toMatchObject({ kind: 'request', cmd: 'memory.retain', args: { text: '-', tag: ['a', 'b'] }, stdin: 'text' })
  })

  it('refuses commands that were removed with the orchestration', () => {
    expect(parseArgs(['job', 'list'])).toMatchObject({ kind: 'error' })
    expect(parseArgs(['inbox'])).toMatchObject({ kind: 'error' })
  })

  it('prints the answer, or the error with its exit code', () => {
    expect(render({ exit: 0, out: 'ok' }, false)).toEqual({ stdout: 'ok\n', stderr: '', code: 0 })
    expect(render({ exit: 4, error: 'busy' }, false)).toEqual({ stdout: '', stderr: 'operant: busy\n', code: 4 })
  })
})
