import { realpathSync } from 'node:fs'
import { posix, win32 } from 'node:path'

// Files that run or install when opened: these are shown in the file manager, never launched.
const RUNNABLE = new Set([
  'exe', 'bat', 'cmd', 'com', 'ps1', 'psm1', 'psd1', 'vbs', 'vbe', 'js', 'jse', 'mjs', 'cjs', 'wsf', 'wsh', 'lnk', 'url',
  'msi', 'msp', 'jar', 'scr', 'reg', 'sh', 'bash', 'zsh', 'command', 'app', 'pif', 'cpl', 'hta', 'dll', 'appref-ms',
  'desktop', 'run', 'bin', 'py', 'pl', 'rb', 'apk', 'dmg', 'pkg', 'deb', 'rpm', 'gadget',
])

export function isRunnable(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot >= 0 && RUNNABLE.has(name.slice(dot + 1).toLowerCase())
}

// A file the terminal may open: inside the project folder, nowhere else. Both sides are resolved through
// symlinks and junctions first, so a link inside the project cannot lead out of it. Missing paths give null.
export function resolveAllowedPath(
  folder: string,
  raw: string,
  platform: NodeJS.Platform = process.platform,
  real: (p: string) => string = (p) => realpathSync.native(p),
): string | null {
  if (!raw || raw.includes('\0') || !folder) return null
  const p = platform === 'win32' ? win32 : posix
  const fold = (s: string) => (platform === 'win32' ? s.toLowerCase() : s)
  let root: string
  let target: string
  try {
    root = real(p.resolve(folder))
    target = real(p.isAbsolute(raw) ? p.resolve(raw) : p.resolve(folder, raw))
  } catch {
    return null
  }
  const rel = p.relative(fold(root), fold(target))
  return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel)) ? target : null
}
