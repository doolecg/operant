import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CrewIndexes } from './codegraph'

describe('CrewIndexes', () => {
  let dir = ''
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

  it('reports an unindexed folder, then indexes it on request', async () => {
    dir = mkdtempSync(join(tmpdir(), 'operant-cg-'))
    writeFileSync(join(dir, 'a.ts'), 'export function greet(n: string) { return helper(n) }\nfunction helper(n: string) { return n }\n')
    const idx = new CrewIndexes()

    expect(idx.status(dir)).toMatchObject({ initialized: false, files: 0 })

    const after = await idx.index(dir)
    expect(after).toMatchObject({ initialized: true, indexing: false, files: 1 })
    expect(after.symbols).toBeGreaterThanOrEqual(2)

    // Re-indexing an existing index syncs instead of starting over.
    writeFileSync(join(dir, 'b.ts'), 'export const b = 1\n')
    expect((await idx.index(dir)).files).toBe(2)
  }, 60_000)
})
