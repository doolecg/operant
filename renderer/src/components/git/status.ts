import type { GitFileEntry } from '@shared/git'

export type Side = 'staged' | 'unstaged' | 'untracked'

export interface Sel {
  path: string
  orig?: string
  side: Side
  conflicted?: boolean
}

export interface Sections {
  conflicts: GitFileEntry[]
  staged: GitFileEntry[]
  unstaged: GitFileEntry[]
  untracked: GitFileEntry[]
}

export function sectionsOf(files: GitFileEntry[], filter = ''): Sections {
  const q = filter.trim().toLowerCase()
  const shown = q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files
  return {
    conflicts: shown.filter((f) => f.conflicted),
    staged: shown.filter((f) => !f.untracked && !f.conflicted && f.x !== '.'),
    unstaged: shown.filter((f) => !f.untracked && !f.conflicted && f.y !== '.'),
    untracked: shown.filter((f) => f.untracked),
  }
}

const NAMES: Record<string, string> = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', U: 'New, not added to git yet', '!': 'Conflict' }

// The letter shown for a file on one side of the index, with its colour class and plain-words name.
export function letterOf(f: GitFileEntry, side: Side | 'conflict'): { letter: string; color: string; name: string } {
  const letter = side === 'conflict' ? '!' : side === 'untracked' ? 'U' : side === 'staged' ? f.x : f.y
  const color =
    letter === 'D' || letter === '!' ? 'text-destructive' : letter === 'A' || letter === 'U' ? 'text-success' : letter === 'R' || letter === 'C' ? 'text-info' : 'text-warning'
  return { letter, color, name: NAMES[letter] ?? letter }
}

export const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1)
export const dirName = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
