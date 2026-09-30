import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type Platform = 'win32' | 'darwin' | 'linux'

export interface PathEnv {
  platform: NodeJS.Platform
  home: string
  env: NodeJS.ProcessEnv
}

const currentEnv = (): PathEnv => ({ platform: process.platform, home: homedir(), env: process.env })

export function claudeDir(e: PathEnv = currentEnv()): string {
  return e.env.CLAUDE_CONFIG_DIR || join(e.home, '.claude')
}

export function claudeProjectsDir(e: PathEnv = currentEnv()): string {
  return join(claudeDir(e), 'projects')
}

// Mirrors Electron's app.getPath('appData') so core/ can resolve it without Electron.
export function appDataDir(e: PathEnv = currentEnv(), appName = 'Operant2'): string {
  if (e.env.OPERANT_DATA_DIR) return e.env.OPERANT_DATA_DIR
  switch (e.platform) {
    case 'win32':
      return join(e.env.APPDATA || join(e.home, 'AppData', 'Roaming'), appName)
    case 'darwin':
      return join(e.home, 'Library', 'Application Support', appName)
    default:
      return join(e.env.XDG_CONFIG_HOME || join(e.home, '.config'), appName)
  }
}

export interface ShellSpec {
  file: string
  args: string[]
}

export function defaultShell(e: PathEnv = currentEnv()): ShellSpec {
  switch (e.platform) {
    case 'win32':
      return { file: 'powershell.exe', args: ['-NoLogo'] }
    case 'darwin':
      return { file: e.env.SHELL || '/bin/zsh', args: ['-l'] }
    default:
      return { file: e.env.SHELL || '/bin/bash', args: ['-l'] }
  }
}

// Directory link that needs no admin rights: a junction on Windows, a symlink elsewhere.
export function linkDir(target: string, linkPath: string, platform: NodeJS.Platform = process.platform): void {
  if (existsSync(linkPath)) return
  mkdirSync(dirname(linkPath), { recursive: true })
  symlinkSync(target, linkPath, platform === 'win32' ? 'junction' : 'dir')
}
