import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Static guard for the "no console windows" rule: a detached start on Windows has no console, so any console program
// it starts opens a visible window (see core/hideshim.ts). And a process started outside core/proc.ts has to hide itself.

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return sources(full)
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [full] : []
  })
}

const files = [...sources(join(root, 'core')), ...sources(join(root, 'main'))]
const rel = (f: string) => f.slice(root.length + 1).replaceAll(String.fromCharCode(92), '/')

describe('background processes never open a console window', () => {
  it('no spawn is detached on Windows', () => {
    const offenders: string[] = []
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      for (const m of src.matchAll(/\bdetached\s*:\s*([^,}\n]+)/g)) {
        const value = m[1]!.trim()
        // Allowed: explicitly off, a Windows-aware expression, or the POSIX-only /bin/sh installer start.
        const posixOnly = src.slice(Math.max(0, m.index! - 160), m.index!).includes("'/bin/sh'")
        if (value !== 'false' && !value.includes('win32') && !posixOnly) offenders.push(`${rel(f)}: detached: ${value}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('every direct child_process spawn outside core/proc.ts sets windowsHide: true (or is POSIX-only)', () => {
    const offenders: string[] = []
    for (const f of files) {
      if (rel(f) === 'core/proc.ts') continue
      const src = readFileSync(f, 'utf8')
      if (!/from ['"](node:)?child_process['"]/.test(src)) continue
      for (const m of src.matchAll(/(?<![\w.])(spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\(/g)) {
        const call = src.slice(m.index!, m.index! + 400)
        if (/^[\w]+\(\s*'\/bin\/sh'/.test(call) || /windowsHide:\s*true/.test(call)) continue
        offenders.push(`${rel(f)}: ${call.split('\n')[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
