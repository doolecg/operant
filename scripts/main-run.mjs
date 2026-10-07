// Main Run: exports the code committed on main to build/main-run and runs it there, leaving the working
// tree untouched. It uses its own data folder (build/profiles/main, outside main-run so it survives the
// re-export), so it runs beside an installed Operant without touching its data.
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const out = resolve(root, 'build', 'main-run')
const profile = resolve(root, 'build', 'profiles', 'main')
const npm = (args) => {
  const r = spawnSync('npm', args, {
    cwd: out,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, OPERANT_DATA_DIR: process.env.OPERANT_DATA_DIR ?? profile },
  })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
mkdirSync(profile, { recursive: true })

const archive = spawnSync('git', ['archive', '--format=tar', 'main'], { cwd: root, maxBuffer: 1 << 30 })
if (archive.status !== 0) {
  console.error('git archive main failed: is there a main branch with a commit?')
  process.exit(1)
}
const untar = spawnSync('tar', ['-x'], { cwd: out, input: archive.stdout, stdio: ['pipe', 'inherit', 'inherit'] })
if (untar.status !== 0) process.exit(untar.status ?? 1)

npm(['ci'])
npm(['run', 'build'])
npm(['start'])
