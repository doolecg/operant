import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('electron-builder files', () => {
  const yml = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8')
  const start = yml.search(/^files:/m)
  const end = yml.search(/^extraResources:/m)
  const files = yml
    .slice(start, end)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).replace(/^"|"$/g, ''))

  it('packs only the main bundles and the renderer, without source maps, screenshots or the CLI copy', () => {
    expect(files).toEqual(expect.arrayContaining(['out/main/*.cjs', 'out/renderer/**', 'package.json', '!**/*.map']))
    expect(files).not.toContain('out/**')
    expect(files.some((f) => /demo|e2e|out\/cli/.test(f) && !f.startsWith('!'))).toBe(false)
  })
})
