import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

// Windows gives a process started with DETACHED_PROCESS no console at all, and a console program that process then
// starts opens a console of its own, which Windows Terminal (the default terminal on Windows 11) shows as a visible
// window. Node's detached option and Python's `DETACHED_PROCESS` both do this, so a detached daemon or hook started
// anywhere under Operant (the Hindsight plugin's hooks, `hindsight-embed daemon start`) pops windows even though every
// process Operant starts itself is hidden. These two start-up scripts, loaded through NODE_OPTIONS and PYTHONPATH,
// fix that on Windows. Python: a detached start becomes a hidden-console start (CREATE_NO_WINDOW), so the tree below
// keeps a console nobody sees. Node: a detached child must stay detached (a node child that is not detached is killed
// when its parent exits), so it is marked instead, and a marked process hides the console of everything it starts.
// They change nothing outside Windows and nothing for processes that are not detached.

const NODE_SHIM = `// Operant: what a detached node process starts gets a hidden console (a console program it starts would open a window).
if (process.platform === 'win32') {
  const cp = require(\`node:child_process\`)
  const mark = 'OPERANT_NO_CONSOLE'
  // This process was started detached (no console): hide every console window of what it starts in turn.
  const noConsole = process.env[mark] === '1'
  delete process.env[mark]
  const spawn = cp.ChildProcess.prototype.spawn
  cp.ChildProcess.prototype.spawn = function (options) {
    if (options) {
      if (options.detached && Array.isArray(options.envPairs)) options.envPairs.push(mark + '=1')
      if (noConsole) options.windowsHide = true
    }
    return spawn.call(this, options)
  }
  if (noConsole) {
    for (const name of ['spawnSync', 'execSync', 'execFileSync']) {
      const real = cp[name]
      cp[name] = function (...args) {
        const i = args.findIndex((a, k) => k > 0 && a && typeof a === 'object' && !Array.isArray(a))
        if (i > 0) args[i] = { ...args[i], windowsHide: true }
        else args.push({ windowsHide: true })
        return real.apply(this, args)
      }
    }
  }
}
`

const PY_SHIM = `# Operant: DETACHED_PROCESS becomes CREATE_NO_WINDOW, so what the child starts keeps a hidden console.
import sys

if sys.platform == "win32":
    import subprocess

    _init = subprocess.Popen.__init__

    def _hidden_init(self, *args, **kwargs):
        flags = kwargs.get("creationflags", 0)
        if flags & 0x8:
            kwargs["creationflags"] = (flags & ~0x8) | 0x08000000
        _init(self, *args, **kwargs)

    subprocess.Popen.__init__ = _hidden_init
`

const FILES: Array<[string, string]> = [
  ['node-hide.cjs', NODE_SHIM],
  ['sitecustomize.py', PY_SHIM],
]

const written = new Set<string>()

function ensureFiles(dir: string): boolean {
  if (written.has(dir)) return true
  try {
    mkdirSync(dir, { recursive: true })
    for (const [name, text] of FILES) {
      const file = join(dir, name)
      let current = ''
      try {
        current = readFileSync(file, 'utf8')
      } catch {
        /* not there yet */
      }
      if (current !== text) writeFileSync(file, text)
    }
    written.add(dir)
    return true
  } catch {
    return false
  }
}

// The environment with the two start-up scripts added (Windows only). Existing NODE_OPTIONS and PYTHONPATH are kept.
// Returns the environment unchanged when the scripts cannot be written.
export function hiddenConsoleEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  dir: string = join(tmpdir(), 'operant-hide-console'),
): NodeJS.ProcessEnv {
  if (platform !== 'win32' || !ensureFiles(dir)) return env
  const out: NodeJS.ProcessEnv = { ...env }
  const keyOf = (name: string) => Object.keys(out).find((k) => k.toUpperCase() === name) ?? name
  // NODE_OPTIONS reads a backslash in a quoted path as an escape, so the path goes in with forward slashes.
  const nodeShim = join(dir, 'node-hide.cjs').replace(/\\/g, '/')
  const nodeKey = keyOf('NODE_OPTIONS')
  const nodeOptions = out[nodeKey] ?? ''
  if (!nodeOptions.includes(nodeShim)) out[nodeKey] = `--require "${nodeShim}"${nodeOptions ? ` ${nodeOptions}` : ''}`
  const pyKey = keyOf('PYTHONPATH')
  const pyPath = out[pyKey] ?? ''
  if (!pyPath.split(delimiter).includes(dir)) out[pyKey] = pyPath ? `${dir}${delimiter}${pyPath}` : dir
  return out
}
