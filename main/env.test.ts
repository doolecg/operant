import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { consoleLog } from '../core/console'
import { runHidden } from '../core/proc'
import { loadEnv, parseEnv } from './env'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('parseEnv', () => {
  it('reads KEY=VALUE, quotes, comments and export, without expansion', () => {
    const r = parseEnv('# c\nA=1\n export B = "two words"\nC=\'x # y\'\nD=plain # note\nE=$A\nF=\n﻿bad line\n')
    expect(r).toEqual({ A: '1', B: 'two words', C: 'x # y', D: 'plain', E: '$A', F: '' })
  })
})

describe('loadEnv', () => {
  const file = (text: string | null) => (f: string) => (f.endsWith('.env') ? text : null)

  it('never overrides the real environment, skips empty values and logs only key names', () => {
    const env: NodeJS.ProcessEnv = { OPERANT_DATA_DIR: 'real' }
    const lines: string[] = []
    const set = loadEnv({ dir: '/x', env, read: file('OPERANT_DATA_DIR=fromfile\nHINDSIGHT_URL=http://secret-host:1\nDISCORD_BOT_TOKEN=\n'), log: (l) => lines.push(l) })
    expect(set).toEqual(['HINDSIGHT_URL'])
    expect(env).toMatchObject({ OPERANT_DATA_DIR: 'real', HINDSIGHT_URL: 'http://secret-host:1' })
    expect(lines).toEqual(['.env: loaded HINDSIGHT_URL'])
    expect(lines.join()).not.toContain('secret-host')
  })

  it('does nothing without a file and writes nothing to the console service', () => {
    consoleLog.clear()
    const env: NodeJS.ProcessEnv = {}
    expect(loadEnv({ dir: '/x', env, read: file(null) })).toEqual([])
    loadEnv({ dir: '/x', env, read: file('DISCORD_BOT_TOKEN=fake-value-1\n') })
    expect(consoleLog.list()).toEqual([])
  })
})

describe('.env.example', () => {
  const text = readFileSync(join(root, '.env.example'), 'utf8')
  const entries = Object.entries(parseEnv(text))
  const ALLOWED = new Set(['', 'your-token-here', 'your-key-here', 'http://127.0.0.1:9077', '1'])

  it('lists the variables the app reads', () => {
    expect(entries.map(([k]) => k).sort()).toEqual(['DISCORD_BOT_TOKEN', 'HINDSIGHT_API_KEY', 'HINDSIGHT_URL', 'OPERANT_BACKGROUND', 'OPERANT_DATA_DIR', 'OPERANT_UPDATE_TEST'])
  })

  it('holds only empty values or obvious placeholders', () => {
    for (const [k, v] of entries) expect(ALLOWED.has(v), `${k} has a non-placeholder value`).toBe(true)
  })

  it('has nothing shaped like a real secret or a user path anywhere in the file', () => {
    expect(text).not.toMatch(/[MN][A-Za-z\d_-]{23,27}\.[\w-]{6}\.[\w-]{27,}/)
    expect(text).not.toMatch(/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/)
    expect(text).not.toMatch(/[A-Za-z0-9+/_-]{32,}={0,2}/)
    expect(text).not.toMatch(/\b[0-9a-f]{32,}\b/i)
    expect(text).not.toMatch(/[A-Za-z]:\Users|\/Users\/|\/home\//i)
  })

  it('is committed while .env stays ignored', async () => {
    const ignored = async (f: string) => (await runHidden('git', ['check-ignore', '-q', f], { cwd: root, source: 'git' })).code
    expect(await ignored('.env')).toBe(0)
    expect(await ignored('.env.example')).toBe(1)
  })
})
