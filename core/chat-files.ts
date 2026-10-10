import { readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { runHidden } from './proc'

const SKIP = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', 'target'])
const WALK_MAX = 5000

// A bounded directory walk (when the folder is not a git repo).
function walk(root: string): string[] {
  const out: string[] = []
  const stack = [root]
  while (stack.length && out.length < WALK_MAX) {
    const dir = stack.pop()!
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && !e.name.startsWith('.')) stack.push(join(dir, e.name))
      } else if (out.length < WALK_MAX) out.push(relative(root, join(dir, e.name)).split(sep).join('/'))
    }
  }
  return out
}

// Subsequence match scored by where it lands: file name hits first, then shorter paths.
export function fuzzyFiles(files: string[], query: string, limit = 20): string[] {
  const q = query.trim().toLowerCase()
  if (!q) return files.slice(0, limit)
  const scored: Array<[number, string]> = []
  for (const f of files) {
    const low = f.toLowerCase()
    const base = low.slice(low.lastIndexOf('/') + 1)
    let score = -1
    if (base.startsWith(q)) score = 0
    else if (base.includes(q)) score = 1
    else if (low.includes(q)) score = 2
    else {
      let i = 0
      for (const c of low) if (c === q[i]) i++
      if (i === q.length) score = 3
    }
    if (score >= 0) scored.push([score * 1000 + low.length, f])
  }
  return scored.sort((a, b) => a[0] - b[0]).slice(0, limit).map((x) => x[1])
}

// @file suggestions for the Chat composer: git ls-files in the tile's folder, else a bounded walk.
export async function listChatFiles(cwd: string, query: string): Promise<string[]> {
  const r = await runHidden('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd, timeoutMs: 5000, source: 'git' })
  const files = r.code === 0 && r.stdout.trim() ? r.stdout.split(/\r?\n/).filter(Boolean) : walk(cwd)
  return fuzzyFiles(files, query)
}
