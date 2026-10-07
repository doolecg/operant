import { existsSync, readdirSync } from 'node:fs'
import { extname } from 'node:path'
import type { GitChanges, GitInfo, IdeId, IdeInfo } from '../shared/projects'
import { runHidden, spawnHidden } from './proc'

// What the project menu runs: finding and launching IDEs, and the short git summary. Every process goes through
// core/proc.ts, so none of them ever opens a console window.

interface IdeSpec {
  id: Exclude<IdeId, 'custom'>
  name: string
  commands: string[]
  // Windows install locations. %VAR% is expanded; one "*" in a folder name matches any folder (versioned installs).
  winPaths: string[]
}

export const IDES: IdeSpec[] = [
  { id: 'code', name: 'VS Code', commands: ['code'], winPaths: ['%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe', '%ProgramFiles%\\Microsoft VS Code\\Code.exe'] },
  { id: 'cursor', name: 'Cursor', commands: ['cursor'], winPaths: ['%LOCALAPPDATA%\\Programs\\cursor\\Cursor.exe'] },
  { id: 'windsurf', name: 'Windsurf', commands: ['windsurf'], winPaths: ['%LOCALAPPDATA%\\Programs\\Windsurf\\Windsurf.exe'] },
  { id: 'zed', name: 'Zed', commands: ['zed'], winPaths: ['%LOCALAPPDATA%\\Programs\\Zed\\Zed.exe'] },
  {
    id: 'idea',
    name: 'IntelliJ IDEA',
    commands: ['idea', 'idea64'],
    winPaths: ['%ProgramFiles%\\JetBrains\\IntelliJ IDEA*\\bin\\idea64.exe', '%LOCALAPPDATA%\\Programs\\IntelliJ IDEA*\\bin\\idea64.exe'],
  },
  {
    id: 'rider',
    name: 'Rider',
    commands: ['rider', 'rider64'],
    winPaths: ['%ProgramFiles%\\JetBrains\\JetBrains Rider*\\bin\\rider64.exe', '%LOCALAPPDATA%\\Programs\\Rider*\\bin\\rider64.exe'],
  },
  { id: 'sublime', name: 'Sublime Text', commands: ['subl'], winPaths: ['%ProgramFiles%\\Sublime Text\\sublime_text.exe', '%ProgramFiles%\\Sublime Text 3\\sublime_text.exe'] },
]

export const CUSTOM_IDE_NAME = 'Custom command'

// The parts of the machine detection looks at, so tests can fake them.
export interface IdeProbe {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  // Paths a command name resolves to on PATH (`where` / `which`); empty when none.
  which(command: string): Promise<string[]>
  exists(path: string): boolean
  listDir(path: string): string[]
}

export const systemProbe: IdeProbe = {
  platform: process.platform,
  env: process.env,
  // Quiet: detection runs for every IDE each time the menu opens and would flood the console.
  which: (command) =>
    new Promise((resolve) => {
      let out = ''
      try {
        const child = spawnHidden(process.platform === 'win32' ? 'where' : 'which', [command], { quiet: true, timeout: 5000 })
        child.stdout?.on('data', (b) => (out += String(b)))
        child.on('error', () => resolve([]))
        child.on('close', (code) => resolve(code === 0 ? out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : []))
      } catch {
        resolve([])
      }
    }),
  exists: existsSync,
  listDir: (p) => {
    try {
      return readdirSync(p)
    } catch {
      return []
    }
  },
}

function expand(template: string, probe: IdeProbe): string[] {
  const env = (name: string) => Object.entries(probe.env).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1]
  let missing = false
  const path = template.replace(/%([^%]+)%/g, (_m, name: string) => {
    const v = env(name)
    if (!v) missing = true
    return v ?? ''
  })
  if (missing) return []
  const parts = path.split('\\')
  const star = parts.findIndex((seg) => seg.includes('*'))
  if (star < 0) return [path]
  const parent = parts.slice(0, star).join('\\')
  const re = new RegExp(`^${parts[star]!.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i')
  return probe
    .listDir(parent)
    .filter((d) => re.test(d))
    .sort()
    .reverse()
    .map((d) => [parent, d, ...parts.slice(star + 1)].join('\\'))
}

const rank = (p: string) => (/\.exe$/i.test(p) ? 0 : /\.(cmd|bat)$/i.test(p) ? 1 : 2)

// Where the IDE's launcher is: on PATH first, then the usual Windows install folders. Null when it is not installed.
export async function findIde(spec: IdeSpec, probe: IdeProbe): Promise<string | null> {
  for (const command of spec.commands) {
    const hits = await probe.which(command)
    // On Windows `where code` also lists the extensionless shell script, which cannot be started directly.
    const usable = probe.platform === 'win32' ? hits.filter((p) => rank(p) < 2).sort((a, b) => rank(a) - rank(b)) : hits
    if (usable[0]) return usable[0]
  }
  if (probe.platform === 'win32') {
    for (const template of spec.winPaths) {
      const found = expand(template, probe).find((p) => probe.exists(p))
      if (found) return found
    }
  }
  return null
}

export async function listIdes(custom: string, probe: IdeProbe = systemProbe): Promise<IdeInfo[]> {
  const found = await Promise.all(IDES.map(async (s): Promise<IdeInfo> => ({ id: s.id, name: s.name, available: (await findIde(s, probe)) !== null })))
  return [...found, { id: 'custom', name: CUSTOM_IDE_NAME, available: custom.trim().length > 0 }]
}

// Characters that could end a quoted argument or chain a command when a shell reads the line.
const SHELL_UNSAFE = /["&|<>^%\r\n]/

export interface LaunchDeps {
  probe: IdeProbe
  spawn: typeof spawnHidden
  // How long to wait for a quick failure before calling the launch a success.
  settleMs: number
}

export const systemLaunch: LaunchDeps = { probe: systemProbe, spawn: spawnHidden, settleMs: 1500 }

// Starts the IDE on the folder, detached from Operant (off Windows). Rejects with a message fit for a toast when it cannot start.
export async function openInIde(folder: string, ide: IdeId, custom: string, deps: LaunchDeps = systemLaunch): Promise<void> {
  if (typeof folder !== 'string' || !folder.trim() || /[\0-\x1f\x7f]/.test(folder)) throw new Error('The project folder is not valid')
  let file: string
  let args: string[] = []
  let shell = false
  let name: string
  if (ide === 'custom') {
    if (!custom.trim()) throw new Error('No custom IDE command is set; add one in Settings')
    if (SHELL_UNSAFE.test(folder)) throw new Error('The folder name has characters that cannot be passed to a custom command')
    file = `${custom.trim()} "${folder}"`
    shell = true
    name = CUSTOM_IDE_NAME
  } else {
    const spec = IDES.find((s) => s.id === ide)
    if (!spec) throw new Error('Unknown IDE')
    const found = await findIde(spec, deps.probe)
    if (!found) throw new Error(`${spec.name} was not found on this computer. Install it, or pick another IDE in Settings`)
    name = spec.name
    if (deps.probe.platform === 'win32' && /\.(cmd|bat)$/i.test(extname(found))) {
      if (SHELL_UNSAFE.test(folder)) throw new Error('The folder name has characters that cannot be passed to the launcher')
      file = `"${found}" "${folder}"`
      shell = true
    } else {
      file = found
      args = [folder]
    }
  }
  await new Promise<void>((resolve, reject) => {
    let child: ReturnType<typeof spawnHidden> | undefined
    let done = false
    const finish = (err?: Error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (err) reject(err)
      else {
        child?.unref()
        resolve()
      }
    }
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => finish(), deps.settleMs)
    try {
      // Not detached on Windows: a detached start has no console, so a console program the launcher runs (code.cmd, a custom command) opens a visible window.
      child = deps.spawn(file, args, { cwd: folder, detached: deps.probe.platform !== 'win32', stdio: 'ignore', shell, quiet: true })
    } catch (e) {
      finish(new Error(`${name} could not start: ${e instanceof Error ? e.message : String(e)}`))
      return
    }
    child.once('error', (e) => finish(new Error(`${name} could not start: ${e.message}`)))
    child.once('close', (code) => finish(code ? new Error(`${name} could not start (exit code ${code})`) : undefined))
  })
}

const MAX_FILES = 200

// `git status` as a short list. A folder that is not a git repository is reported, not treated as an error.
export async function gitChanges(folder: string): Promise<GitChanges> {
  const r = await runHidden('git', ['status', '--porcelain=v1', '-b', '-uall'], { cwd: folder, timeoutMs: 15_000, source: 'git' })
  if (r.code !== 0) {
    if (/not a git repository/i.test(r.stderr)) return { isRepo: false, branch: '', files: [], more: 0 }
    throw new Error(r.stderr.trim().split(/\r?\n/)[0] || 'git could not be run')
  }
  const lines = r.stdout.split(/\r?\n/).filter(Boolean)
  const head = lines[0]?.startsWith('## ') ? lines.shift()!.slice(3) : ''
  const branch = head.startsWith('No commits yet on ') ? head.slice('No commits yet on '.length) : (head.split('...')[0] ?? '').replace(/ \[.*\]$/, '')
  const files = lines.map((l) => ({ status: l.slice(0, 2).trim(), path: l.slice(3).replace(/^"|"$/g, '') }))
  return { isRepo: true, branch, files: files.slice(0, MAX_FILES), more: Math.max(0, files.length - MAX_FILES) }
}

// `git status --porcelain=v2 --branch` read into the branch chip's numbers.
export function parseGitInfo(out: string): GitInfo {
  let head = ''
  let oid = ''
  let ahead = 0
  let behind = 0
  let changes = 0
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('# branch.head ')) head = line.slice(14).trim()
    else if (line.startsWith('# branch.oid ')) oid = line.slice(13).trim()
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line)
      if (m) [ahead, behind] = [Number(m[1]), Number(m[2])]
    } else if (line && !line.startsWith('#')) changes++
  }
  const detached = head === '(detached)'
  return { branch: detached ? oid.slice(0, 7) : head, ahead, behind, changes, detached }
}

// Null for a folder that is not a git repository (or where git cannot be run): the chip then shows nothing.
export async function gitInfo(folder: string): Promise<GitInfo | null> {
  const r = await runHidden('git', ['status', '--porcelain=v2', '--branch'], { cwd: folder, timeoutMs: 10_000, source: 'git', quiet: true }).catch(() => null)
  return r && r.code === 0 ? parseGitInfo(r.stdout) : null
}
