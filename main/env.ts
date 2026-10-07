import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// A tiny .env reader: KEY=VALUE lines, # comments, optional `export `, single or double quotes. No variable
// expansion and no multi-line values.
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw)
    if (!m) continue
    const key = m[1]!
    let v = (m[2] ?? '').trim()
    const q = v[0]
    if ((q === '"' || q === "'") && v.indexOf(q, 1) > 0) v = v.slice(1, v.indexOf(q, 1))
    else v = v.replace(/\s+#.*$/, '')
    out[key] = v
  }
  return out
}

export interface LoadEnvOptions {
  // The folder holding .env: the repo root when unpackaged, the app data folder when installed.
  dir: string
  env?: NodeJS.ProcessEnv
  read?: (file: string) => string | null
  // Receives one line naming the keys that were set, never their values.
  log?: (line: string) => void
}

const readFileOrNull = (file: string): string | null => {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8') : null
  } catch {
    return null
  }
}

// Sets the variables the real environment does not already have, skipping empty values. Returns the keys it set.
export function loadEnv(o: LoadEnvOptions): string[] {
  const env = o.env ?? process.env
  const text = (o.read ?? readFileOrNull)(join(o.dir, '.env'))
  if (text === null) return []
  const set: string[] = []
  for (const [k, v] of Object.entries(parseEnv(text))) {
    if (v === '' || env[k] !== undefined) continue
    env[k] = v
    set.push(k)
  }
  if (set.length > 0) o.log?.(`.env: loaded ${set.join(', ')}`)
  return set
}
