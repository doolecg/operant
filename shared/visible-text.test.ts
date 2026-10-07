import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The concept is called a project everywhere the user can read it. "Crew" lives on only in internal names (the crews table,
// the crews:* calls, the Crew type, ids and keys), which this test lets through by only looking at prose: string literals and
// JSX text that hold the word "crew" next to other words, or a lone "Crew"/"Crews" label.
const root = resolve(import.meta.dirname, '..')
const DIRS = ['renderer/src', 'main', 'core', 'cli', 'plugin', 'shared']

// Strings that may keep the word: SQL, and internal wording that is never shown.
// Also let through the launch file name and code inside a template.
const ALLOWED: RegExp[] = [/^crew-\s+-mcp\.json$/, /\.crews\b/,/^\s*(SELECT|INSERT|UPDATE|DELETE|ALTER|CREATE|PRAGMA)\b/i, /\b(crew_id|crews)\b.*\b(FROM|INTO|SET|WHERE|JOIN|TABLE)\b|\b(FROM|INTO|UPDATE|JOIN|TABLE)\s+crews\b/i]

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) files(p, out)
    else if (/\.(tsx?|md|json)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p)
  }
  return out
}

function prose(file: string): string[] {
  const hits: string[] = []
  const md = /\.(md|json)$/.test(file)
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (!/crew/i.test(line)) return
      if (!md && /^\s*(\/\/|\*|\/\*|import )/.test(line)) return
      const texts: string[] = md ? [line] : []
      if (!md) {
        for (const m of line.matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)) texts.push((m[2] ?? '').replace(/\$\{[^}]*\}/g, ' '))
        const jsx = line.replace(/\{[^{}]*\}/g, ' ').match(/>([^<>]*crew[^<>]*)</i)
        if (jsx) texts.push(jsx[1] ?? '')
      }
      for (const t of texts) {
        if (!/\bcrews?\b/i.test(t) || ALLOWED.some((a) => a.test(t))) continue
        if (/\s/.test(t.trim()) || /^crews?$/i.test(t.trim()) && /^[A-Z]/.test(t.trim())) hits.push(`${relative(root, file)}:${i + 1}: ${t.trim().slice(0, 80)}`)
      }
    })
  return hits
}

describe('visible text', () => {
  it('never calls a project a crew', () => {
    const hits = DIRS.flatMap((d) => files(join(root, d))).flatMap(prose)
    expect(hits).toEqual([])
  })
})
