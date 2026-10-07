import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hiddenConsoleEnv } from './hideshim'

const dir = () => join(mkdtempSync(join(tmpdir(), 'operant-shim-test-')), 'with space')
const slashed = (p: string) => p.replaceAll(String.fromCharCode(92), '/')

describe('hiddenConsoleEnv', () => {
  it('leaves the environment alone off Windows', () => {
    const env = { A: '1' }
    expect(hiddenConsoleEnv(env, 'linux', dir())).toBe(env)
  })

  it('adds the node and python start-up scripts on Windows, keeping what is already set', () => {
    const d = dir()
    const out = hiddenConsoleEnv({ NODE_OPTIONS: '--max-old-space-size=512', PythonPath: 'D:/py', PATH: 'x' }, 'win32', d)
    expect(out.NODE_OPTIONS).toBe(`--require "${slashed(join(d, 'node-hide.cjs'))}" --max-old-space-size=512`)
    expect(out.PythonPath).toBe(`${d}${delimiter}D:/py`)
    expect(out.PYTHONPATH).toBeUndefined()
    expect(out.PATH).toBe('x')
    expect(readFileSync(join(d, 'sitecustomize.py'), 'utf8')).toContain('0x08000000')
  })

  it('does not add itself twice', () => {
    const d = dir()
    const once = hiddenConsoleEnv({}, 'win32', d)
    expect(hiddenConsoleEnv(once, 'win32', d)).toEqual(once)
  })

  // A detached child must stay detached (it outlives its parent), and what it starts in turn must be hidden.
  it.runIf(process.platform === 'win32')('keeps a detached node child detached and hides what that child starts', async () => {
    const work = mkdtempSync(join(tmpdir(), 'operant-shim-run-'))
    const out = join(work, 'out.json')
    const inner = join(work, 'inner.cjs')
    const outer = join(work, 'outer.cjs')
    writeFileSync(
      inner,
      `const { ChildProcess, spawn } = require('node:child_process')
const real = ChildProcess.prototype.spawn
const seen = []
ChildProcess.prototype.spawn = function (o) { seen.push(o); return real.call(this, o) }
const c = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' })
c.on('close', () => setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(slashed(out))}, JSON.stringify(seen.map((o) => o.windowsHide))), 1500))
`,
    )
    writeFileSync(
      outer,
      `require('node:child_process').spawn(process.execPath, [${JSON.stringify(slashed(inner))}], { detached: true, windowsHide: true, stdio: 'ignore' }).unref()\n`,
    )
    const env = hiddenConsoleEnv({ ...process.env }, 'win32', dir())
    const r = spawnSync(process.execPath, [outer], { env, windowsHide: true })
    expect(r.status).toBe(0)
    // The parent has exited; the detached child is still running and reports later.
    for (let i = 0; i < 50 && !existsSync(out); i++) await new Promise((res) => setTimeout(res, 100))
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual([true])
  })
})
