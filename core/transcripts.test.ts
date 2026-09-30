import { appendFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { encodeProjectDir, JsonlTail, parseLine, transcriptPath } from './transcripts'

const assistant = (id: string, usage: object, model = 'claude-opus-5-5') =>
  JSON.stringify({ type: 'assistant', timestamp: '2026-09-30T10:00:00.000Z', message: { id, model, usage } })

describe('transcripts', () => {
  it('encodes a project folder the way Claude Code does', () => {
    expect(encodeProjectDir('F:\\PROGRAMMING\\REPOS\\Operant2')).toBe('F--PROGRAMMING-REPOS-Operant2')
    expect(encodeProjectDir('/home/u/my.app')).toBe('-home-u-my-app')
    expect(transcriptPath('/code/shop', 'abc', { platform: 'linux', home: '/h', env: {} })).toBe(
      join('/h', '.claude', 'projects', '-code-shop', 'abc.jsonl'),
    )
  })

  it('resolves the real folder path before encoding it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'operant-real-'))
    try {
      const env = { platform: process.platform, home: '/h', env: {} }
      expect(transcriptPath(dir, 's', env)).toBe(
        join('/h', '.claude', 'projects', encodeProjectDir(realpathSync.native(dir)), 's.jsonl'),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('parses assistant usage with 5m and 1h cache writes', () => {
    const u = parseLine(
      assistant('m1', {
        input_tokens: 2,
        output_tokens: 500,
        cache_read_input_tokens: 190_000,
        cache_creation_input_tokens: 1_300,
        cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 1_000 },
      }),
    )!
    expect(u).toMatchObject({
      messageId: 'm1',
      model: 'claude-opus-5-5',
      inputTokens: 2,
      outputTokens: 500,
      cacheReadTokens: 190_000,
      cacheWrite5mTokens: 300,
      cacheWrite1hTokens: 1_000,
      contextTokens: 191_302,
      at: Date.parse('2026-09-30T10:00:00.000Z'),
    })
    // 2*4 + 500*20 + 190000*0.2 + 300*5 + 1000*8, per million
    expect(u.costUsd).toBeCloseTo((8 + 10_000 + 38_000 + 1_500 + 8_000) / 1e6, 8)
  })

  it('treats cache writes without a breakdown as 5 minute writes', () => {
    expect(parseLine(assistant('m', { input_tokens: 1, cache_creation_input_tokens: 40 }))).toMatchObject({
      cacheWrite5mTokens: 40,
      cacheWrite1hTokens: 0,
    })
  })

  it('ignores non-assistant, synthetic and malformed lines', () => {
    expect(parseLine(JSON.stringify({ type: 'user', message: { content: 'hi' } }))).toBeNull()
    expect(parseLine(assistant('m', { input_tokens: 1 }, '<synthetic>'))).toBeNull()
    expect(parseLine('{not json')).toBeNull()
  })

  describe('JsonlTail', () => {
    let dir = ''
    afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

    it('returns only new complete lines and holds back a partial one', () => {
      dir = mkdtempSync(join(tmpdir(), 'operant-tail-'))
      const file = join(dir, 't.jsonl')
      const tail = new JsonlTail(file)
      expect(tail.read()).toEqual([])
      writeFileSync(file, 'a\nb\npar')
      expect(tail.read()).toEqual(['a', 'b'])
      expect(tail.read()).toEqual([])
      appendFileSync(file, 'tial\nc\n')
      expect(tail.read()).toEqual(['partial', 'c'])
    })

    it('starts over when the file is truncated', () => {
      dir = mkdtempSync(join(tmpdir(), 'operant-tail-'))
      const file = join(dir, 't.jsonl')
      const tail = new JsonlTail(file)
      writeFileSync(file, 'one\ntwo\n')
      tail.read()
      writeFileSync(file, 'x\n')
      expect(tail.read()).toEqual(['x'])
    })
  })
})
