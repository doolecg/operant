import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SuperpowersStatus } from '../shared/ops'

// Whether the superpowers skill set is installed for Claude Code: a plugin under ~/.claude/plugins or a skill folder
// under ~/.claude/skills. Only detected; nothing here invokes it.
export type { SuperpowersStatus }

const NAME = /superpowers/i
const SKIP = new Set(['node_modules', '.git'])
const MAX_DEPTH = 5

function versionOf(dir: string): string | undefined {
  for (const f of [join(dir, '.claude-plugin', 'plugin.json'), join(dir, 'plugin.json'), join(dir, 'package.json')]) {
    try {
      const v = (JSON.parse(readFileSync(f, 'utf8')) as { version?: unknown }).version
      if (typeof v === 'string' && v.trim()) return v.trim()
    } catch {
      // no manifest here
    }
  }
  return undefined
}

// A superpowers install has a manifest or a SKILL.md in a folder whose name says so.
function isInstall(dir: string): boolean {
  return existsSync(join(dir, '.claude-plugin', 'plugin.json')) || existsSync(join(dir, 'plugin.json')) || existsSync(join(dir, 'SKILL.md'))
}

function safeDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(dir, e.name))
  } catch {
    return []
  }
}

function findPlugin(root: string, depth: number): string | null {
  if (depth > MAX_DEPTH || !existsSync(root)) return null
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return null
  }
  for (const e of entries) {
    if (!e.isDirectory() || SKIP.has(e.name) || !NAME.test(e.name)) continue
    const path = join(root, e.name)
    if (isInstall(path)) return path
    // The plugin cache keeps each version in its own folder under the plugin's name.
    const version = safeDirs(path).find(isInstall)
    if (version) return version
  }
  for (const e of entries) {
    if (!e.isDirectory() || SKIP.has(e.name)) continue
    const hit = findPlugin(join(root, e.name), depth + 1)
    if (hit) return hit
  }
  return null
}

export function detectSuperpowers(claudeDir: string): SuperpowersStatus {
  const path = findPlugin(join(claudeDir, 'plugins'), 0) ?? findSkill(join(claudeDir, 'skills'))
  if (!path) return { installed: false }
  const version = versionOf(path)
  return version ? { installed: true, path, version } : { installed: true, path }
}

function findSkill(root: string): string | null {
  if (!existsSync(root)) return null
  try {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory() || !NAME.test(e.name)) continue
      const p = join(root, e.name)
      if (existsSync(join(p, 'SKILL.md'))) return p
    }
  } catch {
    // unreadable folder: not installed here
  }
  return null
}
