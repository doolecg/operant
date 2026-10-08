import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isRunnable, resolveAllowedPath } from './openpath'

describe('resolveAllowedPath (paths, injected realpath)', () => {
  const id = (p: string) => p
  const ok = (raw: string) => resolveAllowedPath('C:\\proj', raw, 'win32', id)

  it('allows files inside the project folder (windows)', () => {
    expect(ok('C:\\proj\\src\\a.ts')).toBe('C:\\proj\\src\\a.ts')
    expect(ok('src\\a.ts')).toBe('C:\\proj\\src\\a.ts')
    expect(ok('C:\\PROJ\\a.ts')).toBe('C:\\PROJ\\a.ts')
  })
  it('refuses outside, temp, traversal, sibling prefixes and empty input', () => {
    expect(ok('C:\\Windows\\notepad.exe')).toBeNull()
    expect(ok('C:\\Temp\\x.png')).toBeNull()
    expect(ok('..\\secret.txt')).toBeNull()
    expect(ok('C:\\proj-other\\a')).toBeNull()
    expect(ok('')).toBeNull()
  })
  it('works for unix paths and is case sensitive there', () => {
    expect(resolveAllowedPath('/home/u/p', '/home/u/p/a.ts', 'linux', id)).toBe('/home/u/p/a.ts')
    expect(resolveAllowedPath('/home/u/p', '/home/u/P/a.ts', 'linux', id)).toBeNull()
    expect(resolveAllowedPath('/home/u/p', '../q/a', 'linux', id)).toBeNull()
  })
  it('refuses a path that does not exist', () => {
    expect(resolveAllowedPath('/home/u/p', 'nope.txt', 'linux')).toBeNull()
  })
})

describe('resolveAllowedPath (real files)', () => {
  it('refuses a symlink or junction inside the project that points outside', () => {
    const base = mkdtempSync(join(tmpdir(), 'op-open-'))
    try {
      const proj = join(base, 'proj')
      const outside = join(base, 'outside')
      mkdirSync(proj)
      mkdirSync(outside)
      writeFileSync(join(outside, 'secret.txt'), 'x')
      writeFileSync(join(proj, 'ok.txt'), 'x')
      expect(resolveAllowedPath(proj, 'ok.txt')).not.toBeNull()
      try {
        symlinkSync(outside, join(proj, 'link'), 'junction')
      } catch {
        return // the OS refused to make a link; nothing to test
      }
      expect(resolveAllowedPath(proj, join('link', 'secret.txt'))).toBeNull()
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('isRunnable', () => {
  it('flags executables and scripts, not documents', () => {
    for (const f of ['a.exe', 'C:\\x\\b.BAT', 'c.cmd', 'd.ps1', 'e.vbs', 'f.js', 'g.lnk', 'h.msi', 'i.jar', 'j.scr', 'k.reg', 'l.sh', 'm.app', 'n.wsf'])
      expect(isRunnable(f), f).toBe(true)
    for (const f of ['a.txt', 'b.png', 'c.ts', 'README', 'd.pdf']) expect(isRunnable(f), f).toBe(false)
  })
})
