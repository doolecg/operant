import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { splitAttachedImages } from '../shared/attached-images'
import type { RunImage } from '../shared/types'

export const ATTACH_DIR = '.operant-attachments'
export const IMAGE_MAX_COUNT = 8
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

export class AttachmentError extends Error {}

// Writes pasted images into <folder>/.operant-attachments/<id>/ and returns their paths plus a cleanup.
export function saveImages(folder: string, images: RunImage[]): { paths: string[]; remove: () => void } {
  if (images.length > IMAGE_MAX_COUNT) throw new AttachmentError(`At most ${IMAGE_MAX_COUNT} images can be attached`)
  excludeAttachments(folder)
  const dir = join(folder, ATTACH_DIR, randomUUID().slice(0, 8))
  const paths: string[] = []
  const remove = () => rmSync(dir, { recursive: true, force: true })
  try {
    images.forEach((img, i) => {
      const ext = EXT[img?.mime]
      if (!ext || typeof img.data !== 'string') throw new AttachmentError('Only PNG, JPEG, GIF or WebP images can be attached')
      const bytes = Buffer.from(img.data, 'base64')
      if (bytes.length > IMAGE_MAX_BYTES) throw new AttachmentError('An image is larger than 8 MB')
      mkdirSync(dir, { recursive: true })
      const path = join(dir, `image-${i + 1}.${ext}`)
      writeFileSync(path, bytes)
      paths.push(path)
    })
  } catch (err) {
    remove()
    throw err
  }
  return { paths, remove }
}

export const withImages = (task: string, paths: string[]): string =>
  paths.length ? `${task}\n\nAttached images (open each with your file-reading tool to see it):\n${paths.map((p) => `- ${p}`).join('\n')}` : task

// Keeps the attachments folder out of `git status` (only in a git checkout; never fails the caller).
function excludeAttachments(folder: string): void {
  try {
    let git = join(folder, '.git')
    if (!existsSync(git)) return
    if (!statSync(git).isDirectory()) {
      // a worktree or submodule: .git is a file "gitdir: <path>"; its info/exclude lives in the common dir
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(git, 'utf8'))
      if (!m) return
      git = resolve(folder, m[1]!)
      const common = join(git, 'commondir')
      if (existsSync(common)) git = resolve(git, readFileSync(common, 'utf8').trim())
      if (!existsSync(git) || !statSync(git).isDirectory()) return
    }
    const file = join(git, 'info', 'exclude')
    const cur = existsSync(file) ? readFileSync(file, 'utf8') : ''
    if (cur.split(/\r?\n/).includes(`${ATTACH_DIR}/`)) return
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${cur}${cur === '' || cur.endsWith('\n') ? '' : '\n'}${ATTACH_DIR}/\n`)
  } catch {
    // the folder just shows as untracked
  }
}

// Deletes the attachment folders a task points at (the paths withImages appended); anything outside the project's folder is left alone.
export function removeAttachmentsOf(folder: string, task: string): void {
  const root = resolve(folder, ATTACH_DIR) + sep
  const seen = new Set<string>()
  for (const m of task.matchAll(/^- (.+[\\/]\.operant-attachments[\\/][^\\/\n]+)[\\/][^\\/\n]+$/gm)) {
    const dir = resolve(m[1]!)
    if (seen.has(dir) || !`${dir}${sep}`.startsWith(root)) continue
    seen.add(dir)
    rmSync(dir, { recursive: true, force: true })
  }
}

// Deletes every attachment folder of a project (the project is being deleted). Never throws.
export function removeAllAttachments(folder: string): void {
  try {
    rmSync(join(folder, ATTACH_DIR), { recursive: true, force: true })
  } catch {
    // a locked file; the folder is left behind
  }
}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }

// The images a task lists, as data URLs. Only real files (no symlinks) whose real path is inside the project's attachments folder are read.
export function readTaskImages(folder: string, task: string): string[] {
  let root: string
  try {
    root = realpathSync(resolve(folder, ATTACH_DIR)) + sep
  } catch {
    return []
  }
  const out: string[] = []
  for (const p of splitAttachedImages(task).images.slice(0, IMAGE_MAX_COUNT)) {
    try {
      const mime = MIME[(/\.([a-z0-9]+)$/i.exec(p)?.[1] ?? '').toLowerCase()]
      if (!mime) continue
      const abs = resolve(p)
      const st = lstatSync(abs)
      if (!st.isFile() || st.size > IMAGE_MAX_BYTES || !realpathSync(abs).startsWith(root)) continue
      out.push(`data:${mime};base64,${readFileSync(abs).toString('base64')}`)
    } catch {
      // deleted or unreadable: skipped
    }
  }
  return out
}
