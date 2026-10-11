import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { clampTimeout, formatScriptResult, redactSecrets, runScriptInWorker } from './script-runner'

const dir = mkdtempSync(join(tmpdir(), 'operant-script-test-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

// A stand-in for playwright-core: connectOverCDP gives one context with two pages.
const fakePw = join(dir, 'fake-pw')
mkdirSync(fakePw)
writeFileSync(
  join(fakePw, 'index.js'),
  `
const mk = (url) => ({ url: () => url, setDefaultTimeout() {}, title: async () => 'T ' + url, fail: async () => { throw new Error('connect to ws://127.0.0.1:9/cdp/1/' + 'a'.repeat(64) + ' failed') } })
exports.chromium = {
  connectOverCDP: async (endpoint) => {
    if (endpoint.includes('refuse')) throw new Error('refused ' + endpoint)
    const pages = [mk('https://a.test/'), mk('https://b.test/')]
    return { contexts: () => [{ pages: () => pages, setDefaultTimeout() {} }] }
  },
}
`,
)

const run = (code: string, over: Partial<{ timeoutMs: number; pageUrl: string | null; endpoint: string }> = {}) =>
  runScriptInWorker({ endpoint: 'ws://127.0.0.1:1/cdp/1/' + 'f'.repeat(64), playwrightPath: fakePw, code, pageUrl: 'https://a.test/', timeoutMs: 8000, ...over })

describe('runScriptInWorker', () => {
  it('runs a body against the active page and returns its value and console output', async () => {
    const r = await run("console.log('hi', 1); console.warn('careful'); return await page.title()")
    expect(r).toMatchObject({ ok: true, value: '"T https://a.test/"', output: ['hi 1', 'warn: careful'] })
  })

  it('picks the page by URL, else the newest', async () => {
    expect((await run('return page.url()', { pageUrl: 'https://b.test/' })).value).toBe('"https://b.test/"')
    expect((await run('return page.url()', { pageUrl: null })).value).toBe('"https://b.test/"')
  })

  it('accepts a function expression, like browser_run_code_unsafe', async () => {
    const r = await run('async (page) => { return { url: page.url() } }')
    expect(r.ok).toBe(true)
    expect(JSON.parse(r.value!)).toEqual({ url: 'https://a.test/' })
  })

  it('reports a thrown error without crashing', async () => {
    const r = await run("throw new Error('nope')")
    expect(r).toMatchObject({ ok: false, error: 'nope' })
    expect(formatScriptResult(r)).toBe('Error: nope')
  })

  it('reports a syntax error', async () => {
    const r = await run('this is not javascript (')
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
  })

  it('stops an endless loop at the timeout', async () => {
    const t = Date.now()
    const r = await run('while (true) {}', { timeoutMs: 1000 })
    expect(r).toMatchObject({ ok: false, timedOut: true })
    expect(Date.now() - t).toBeLessThan(5000)
  })

  it('survives process.exit and an uncaught rejection in the script', async () => {
    const a = await run('process.exit(3)')
    expect(a.ok).toBe(false)
    const b = await run('setTimeout(() => { throw new Error("late") }, 1); await sleep(50); return 1')
    expect(b.ok).toBe(false)
  })

  it('never lets the endpoint or a token reach the result', async () => {
    const r = await run("console.log(String(await page.fail().catch((e) => e.message))); throw new Error('x ' + 'ws://127.0.0.1:1/cdp/1/' + 'f'.repeat(64))")
    const text = formatScriptResult(r)
    expect(text).not.toMatch(/f{20}|a{20}/)
    expect(text).not.toContain('/cdp/1/')
  })

  it('scrubs the endpoint from a connect failure', async () => {
    const r = await run('return 1', { endpoint: 'ws://127.0.0.1:1/cdp/1/refuse' + 'f'.repeat(64) })
    expect(r.ok).toBe(false)
    expect(r.error).not.toContain('/cdp/1/')
  })

  it('stops when cancelled', async () => {
    const ac = new AbortController()
    const p = runScriptInWorker({ endpoint: 'ws://127.0.0.1:1/x', playwrightPath: fakePw, code: 'await sleep(5000)', pageUrl: null, timeoutMs: 8000 }, ac.signal)
    setTimeout(() => ac.abort(), 100)
    expect(await p).toMatchObject({ ok: false, error: 'The script was cancelled.' })
  })
})

describe('helpers', () => {
  it('redacts the proxy URL, secret path and long hex', () => {
    const secret = 'a'.repeat(64)
    const out = redactSecrets(`failed ws://127.0.0.1:5000/cdp/2/${secret} and ${secret} and /cdp/2/${secret}`, [`ws://127.0.0.1:5000/cdp/2/${secret}`])
    expect(out).not.toContain(secret)
    expect(out).not.toContain('5000')
  })

  it('clamps the timeout', () => {
    expect(clampTimeout(undefined)).toBe(30_000)
    expect(clampTimeout(5)).toBe(1000)
    expect(clampTimeout(10 ** 9)).toBe(120_000)
    expect(clampTimeout('x')).toBe(30_000)
  })

  it('formats result, output and errors', () => {
    expect(formatScriptResult({ ok: true, value: '1', output: ['a'] })).toBe('Result: 1\nConsole output:\na')
  })
})
