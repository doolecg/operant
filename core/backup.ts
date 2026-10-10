import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BackupEntry } from '../shared/ops'

export type { BackupEntry }

// One JSON file holds the whole backup: each part is a JSON document kept as text, and the manifest gives the sha256
// and size of every part. A restore checks all of them before it changes anything.
export const BACKUP_FORMAT = 'operant-backup'
export const BACKUP_VERSION = 1
export const AUTO_PREFIX = 'pre-update-'
export const MANUAL_PREFIX = 'operant-backup-'
export const KEEP_AUTO = 5

// The parts a backup holds, restored in this order.
export const BACKUP_PARTS = ['settings.json', 'presets.json', 'teams.json', 'learn.json'] as const
export type BackupPart = (typeof BACKUP_PARTS)[number]

export interface BackupBundle {
  format: typeof BACKUP_FORMAT
  version: number
  createdAt: number
  label: string
  manifest: { files: Record<string, { sha256: string; bytes: number }> }
  files: Record<string, string>
}

export const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

// Keys that hold a credential are dropped wherever they sit. Keys such as "tokens" (the settings section) stay.
const SECRET_KEY = /(api[-_]?key|secret|password|passwd|^token$|_token$|access[-_]?token|authorization|credential)/i
export function stripSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripSecrets(v)) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(k)) continue
      out[k] = stripSecrets(v)
    }
    return out as T
  }
  return value
}

// Builds a bundle from the parts (any JSON value per part name). Secrets are stripped from every part.
export function buildBackup(parts: Partial<Record<BackupPart, unknown>>, label: string, now: number): BackupBundle {
  const files: Record<string, string> = {}
  const manifest: BackupBundle['manifest'] = { files: {} }
  for (const name of BACKUP_PARTS) {
    if (!(name in parts)) continue
    const text = JSON.stringify(stripSecrets(parts[name]), null, 2)
    files[name] = text
    manifest.files[name] = { sha256: sha256(text), bytes: Buffer.byteLength(text, 'utf8') }
  }
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, createdAt: now, label, manifest, files }
}

// Parses and verifies a backup. Throws with the reason on any problem: wrong format, unknown or missing part, or a
// checksum that does not match. Returns the parsed parts so the caller applies only what passed.
export function verifyBackup(text: string): { bundle: BackupBundle; parts: Partial<Record<BackupPart, unknown>> } {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    throw new Error('That file is not valid JSON, so it is not an Operant backup. Nothing was restored.')
  }
  const b = doc as Partial<BackupBundle>
  if (!b || b.format !== BACKUP_FORMAT || typeof b.version !== 'number' || !b.manifest?.files || !b.files) {
    throw new Error('That is not an Operant backup. Nothing was restored.')
  }
  if (b.version > BACKUP_VERSION) throw new Error(`This backup is version ${b.version}; this Operant reads version ${BACKUP_VERSION} or older. Nothing was restored.`)
  const listed = Object.keys(b.manifest.files)
  for (const name of Object.keys(b.files)) {
    if (!listed.includes(name)) throw new Error(`The backup holds ${name}, which its manifest does not list. Nothing was restored.`)
  }
  const parts: Partial<Record<BackupPart, unknown>> = {}
  for (const name of listed) {
    if (!(BACKUP_PARTS as readonly string[]).includes(name)) throw new Error(`The backup lists an unknown part ${name}. Nothing was restored.`)
    const entry = b.manifest.files[name]!
    const text = b.files[name]
    if (typeof text !== 'string') throw new Error(`The backup is missing ${name}. Nothing was restored.`)
    if (sha256(text) !== entry.sha256 || Buffer.byteLength(text, 'utf8') !== entry.bytes) {
      throw new Error(`Checksum mismatch in ${name}: the backup was changed or damaged. Nothing was restored.`)
    }
    try {
      parts[name as BackupPart] = JSON.parse(text)
    } catch {
      throw new Error(`${name} in the backup is not valid JSON. Nothing was restored.`)
    }
  }
  return { bundle: b as BackupBundle, parts }
}

// Verifies first, then applies each part that has a target, in the fixed order. Nothing is applied if verification fails.
export async function restoreBackup(
  text: string,
  targets: Partial<Record<BackupPart, (value: unknown) => void | Promise<void>>>,
): Promise<BackupPart[]> {
  const { parts } = verifyBackup(text)
  const applied: BackupPart[] = []
  for (const name of BACKUP_PARTS) {
    if (!(name in parts)) continue
    const apply = targets[name]
    if (!apply) continue
    await apply(parts[name])
    applied.push(name)
  }
  return applied
}

export const backupFileName = (now: number, prefix = MANUAL_PREFIX): string => `${prefix}${new Date(now).toISOString().replace(/[:.]/g, '-')}.json`

export function writeBackup(dir: string, bundle: BackupBundle, prefix = MANUAL_PREFIX): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, backupFileName(bundle.createdAt, prefix))
  writeFileSync(path, JSON.stringify(bundle, null, 2))
  return path
}

const SAFE_NAME = /^[A-Za-z0-9._-]+\.json$/

export function listBackups(dir: string): BackupEntry[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => SAFE_NAME.test(n) && (n.startsWith(MANUAL_PREFIX) || n.startsWith(AUTO_PREFIX)))
    .map((name) => {
      const path = join(dir, name)
      const st = statSync(path)
      return { name, path, bytes: st.size, modified: st.mtimeMs, kind: name.startsWith(AUTO_PREFIX) ? ('pre-update' as const) : ('manual' as const) }
    })
    .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
}

// Keeps the newest `keep` pre-update snapshots; manual backups are never pruned.
export function pruneAuto(dir: string, keep = KEEP_AUTO): string[] {
  const old = listBackups(dir).filter((e) => e.kind === 'pre-update').slice(keep)
  for (const e of old) unlinkSync(e.path)
  return old.map((e) => e.name)
}

// Only a file the listing names, directly in the backup folder, can be read or deleted.
export function backupPath(dir: string, name: string): string {
  if (!SAFE_NAME.test(name) || !listBackups(dir).some((e) => e.name === name)) throw new Error(`No backup named ${name}`)
  return join(dir, name)
}

export function deleteBackup(dir: string, name: string): void {
  unlinkSync(backupPath(dir, name))
}

export const readBackupFile = (dir: string, name: string): string => readFileSync(backupPath(dir, name), 'utf8')
