import type { Tracker, TrackedFile } from '../types'

export const FILE_LIMIT = 50
export const LIVE_MS = 30 * 60_000
export const PRUNE_MS = 24 * 60 * 60_000
export const SAVE_EVERY_MS = 60_000

export function folderOf(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).join('/').toLowerCase()
}

export function trackerPrefix(cwd: string): string {
  return `tracker|${folderOf(cwd)}|`
}

export function trackerKey(cwd: string, id: string): string {
  return `${trackerPrefix(cwd)}${id}`
}

export function isTracker(value: unknown): value is Tracker {
  const v = value as Tracker
  return typeof v === 'object' && v !== null && typeof v.id === 'string' && typeof v.at === 'number'
    && typeof v.cwd === 'string' && typeof v.phase === 'string' && Array.isArray(v.files)
}

export function isLive(tracker: Tracker, now: number): boolean {
  return tracker.phase !== 'done' && now - tracker.at < LIVE_MS
}

export function sameFile(a: string, b: string): boolean {
  return a.split(/[\\/]/).join('/').toLowerCase() === b.split(/[\\/]/).join('/').toLowerCase()
}

export function addFile(files: readonly TrackedFile[], path: string, at: number): TrackedFile[] {
  return [{ path, at }, ...files.filter(file => !sameFile(file.path, path))].slice(0, FILE_LIMIT)
}

export function relativeTo(cwd: string, path: string): string {
  const folder = folderOf(cwd)
  const file = path.split(/[\\/]/).join('/')
  return file.toLowerCase().startsWith(`${folder}/`) ? file.slice(folder.length + 1) : file
}

export function describeOther(tracker: Tracker, cwd: string): string {
  const last = tracker.files[0]
  if (last === undefined) return `Other session: ${tracker.phase} — no file edits yet`
  const count = tracker.files.length
  return `Other session: ${tracker.phase} — editing ${relativeTo(cwd, last.path)} (${count} file${count === 1 ? '' : 's'})`
}
