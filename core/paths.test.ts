import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appDataDir, claudeDir, claudeProjectsDir, defaultShell, linkDir, type PathEnv } from './paths'

const env = (platform: NodeJS.Platform, extra: NodeJS.ProcessEnv = {}): PathEnv => ({
  platform,
  home: '/home/u',
  env: extra,
})

describe('paths', () => {
  it('resolves ~/.claude, honouring CLAUDE_CONFIG_DIR', () => {
    expect(claudeDir(env('linux'))).toBe(join('/home/u', '.claude'))
    expect(claudeDir(env('linux', { CLAUDE_CONFIG_DIR: '/x' }))).toBe('/x')
    expect(claudeProjectsDir(env('darwin'))).toBe(join('/home/u', '.claude', 'projects'))
  })

  it('resolves the app data dir per OS', () => {
    expect(appDataDir(env('win32', { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }))).toBe(
      join('C:\\Users\\u\\AppData\\Roaming', 'Operant2'),
    )
    expect(appDataDir(env('darwin'))).toBe(join('/home/u', 'Library', 'Application Support', 'Operant2'))
    expect(appDataDir(env('linux'))).toBe(join('/home/u', '.config', 'Operant2'))
    expect(appDataDir(env('linux', { XDG_CONFIG_HOME: '/cfg' }))).toBe(join('/cfg', 'Operant2'))
    expect(appDataDir(env('win32', { OPERANT_DATA_DIR: 'D:\\tmp\\op' }))).toBe('D:\\tmp\\op')
  })

  it('picks a default shell per OS', () => {
    expect(defaultShell(env('win32')).file).toBe('powershell.exe')
    expect(defaultShell(env('darwin')).file).toBe('/bin/zsh')
    expect(defaultShell(env('linux')).file).toBe('/bin/bash')
    expect(defaultShell(env('linux', { SHELL: '/usr/bin/fish' })).file).toBe('/usr/bin/fish')
  })

  describe('linkDir', () => {
    let tmp = ''
    afterEach(() => tmp && rmSync(tmp, { recursive: true, force: true }))

    it('links a directory so its contents are visible through the link', () => {
      tmp = mkdtempSync(join(tmpdir(), 'operant-paths-'))
      const target = join(tmp, 'target')
      const link = join(tmp, 'nested', 'link')
      mkdirSync(target)
      writeFileSync(join(target, 'SKILL.md'), 'x')
      linkDir(target, link)
      linkDir(target, link) // idempotent
      expect(readdirSync(link)).toEqual(['SKILL.md'])
    })
  })
})
