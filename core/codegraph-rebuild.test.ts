import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CrewIndexes } from './codegraph'

describe('CodeGraph full rebuild', () => {
  let dir = ''
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

  it('discards the index and indexes every file again on request', async () => {
    dir = mkdtempSync(join(tmpdir(), 'operant-cg-rebuild-'))
    writeFileSync(join(dir, 'a.ts'), 'export function greet(n: string) { return n }\n')
    writeFileSync(join(dir, 'b.ts'), 'export const b = 1\n')
    const idx = new CrewIndexes()
    expect((await idx.index(dir)).files).toBe(2)
    unlinkSync(join(dir, 'b.ts'))
    expect(await idx.rebuild(dir)).toMatchObject({ initialized: true, indexing: false, files: 1 })
  }, 120_000)
})
