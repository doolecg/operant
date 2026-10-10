import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyRead, legacyDataDir, parseRole, previewRead, readBundleText, readSource } from './import'
import { Store } from './store'
import { queryUsage } from './usage-query'

const NOW = 1_790_000_000_000

let dir: string
let legacy: string
let projects: string
let store: Store
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'operant-import-'))
  legacy = join(dir, 'Operant')
  projects = join(dir, 'repos')
  mkdirSync(join(legacy, 'store'), { recursive: true })
  mkdirSync(join(projects, 'Alpha'), { recursive: true })
  mkdirSync(join(projects, 'Beta'), { recursive: true })
  writeFileSync(
    join(legacy, 'config.json'),
    JSON.stringify({
      projects: [],
      projectGroups: [{ name: 'g', projects: [join(projects, 'Alpha'), join(projects, 'Beta'), join(projects, 'Gone'), join(projects, 'Alpha')] }],
      tokenBudget: 20_000_000,
      theme: 'obsidian',
    }),
  )
  const tok = (id: string, t: number, project: string, model: string, input: number) => JSON.stringify({ id, t, v: 1, project, corr: `${project}:${id}`, model, tier: 'small', input, output: 10, cacheRead: 100, cacheWrite: 20 })
  writeFileSync(
    join(legacy, 'store', 'tokenEvents.jsonl'),
    [tok('tok-1', NOW, 'Alpha', 'claude-sonnet-5-5', 1000), tok('tok-2', NOW + 1, 'Beta', 'opencode/big-pickle', 500), '{broken', JSON.stringify({ id: 'tok-3', t: NOW, input: 'x' })].join('\n') + '\n',
  )
  writeFileSync(
    join(legacy, 'store', 'modelRuns.jsonl'),
    [
      JSON.stringify({ id: 'mod-1', t: NOW, corr: 'Alpha:tok-1', model: 'claude-sonnet-5-5', agent: 'claude', usd: 0.5 }),
      JSON.stringify({ id: 'mod-2', t: NOW + 1, corr: 'Beta:tok-2', model: 'opencode/big-pickle', agent: 'opencode', usd: null }),
      JSON.stringify({ id: 'mod-3', t: NOW + 2, corr: 'Alpha:x', model: 'claude-haiku-4-5', agent: 'claude', usd: 0.25 }),
      JSON.stringify({ id: 'mod-4', t: NOW + 3, corr: 'Alpha:y', model: 'claude-haiku-4-5', agent: 'claude', usd: null }),
    ].join('\n') + '\n',
  )
  mkdirSync(join(legacy, 'agent-plugin', 'agents'), { recursive: true })
  writeFileSync(join(legacy, 'agent-plugin', 'agents', 'explore.md'), '---\nname: explore\ndescription: "find things"\nmodel: haiku\ntools: Read, Grep\n---\nYou answer one question.\n')
  store = new Store(':memory:', () => NOW)
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

// Hash of every file in a folder, to prove the old data is only read.
function snapshot(root: string): string {
  const out: string[] = []
  const walk = (d: string) => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f)
      if (statSync(p).isDirectory()) walk(p)
      else out.push(`${p}:${statSync(p).mtimeMs}:${readFileSync(p, 'utf8')}`)
    }
  }
  walk(root)
  return out.join('\n')
}

describe('import from Operant 2.8.2', () => {
  it('previews counts, then applies them, reading the old data only', () => {
    const before = snapshot(legacy)
    const read = readSource({ kind: 'legacy', dir: legacy })
    const preview = previewRead(store, read)
    expect(preview).toMatchObject({
      format: 'operant-2.8.2',
      found: true,
      projects: { add: 2, existing: 0, skipped: 1 },
      usage: { add: 3, existing: 0 },
      presets: { add: 1, existing: 0 },
    })
    // Imported: tok-1 (cost from its model run), tok-2 (no cost, not priced) and mod-3 (cost only). Skipped: mod-4 (neither), tok-3, the broken line.
    expect(preview.skipped.map((s) => s.kind + ':' + s.ref).sort()).toEqual(
      expect.arrayContaining(['project:' + join(projects, 'Gone'), 'usage:mod-4', 'usage:tok-3', 'setting:tokenBudget', 'usage:tokenEvents.jsonl line 3']),
    )
    expect(preview.skipped.find((s) => s.ref === join(projects, 'Gone'))!.reason).toMatch(/not found/)
    // Previewing changed nothing.
    expect(store.listCrews()).toHaveLength(0)
    expect(queryUsage({ store, now: () => NOW }, {}).totals.turns).toBe(0)

    const result = applyRead(store, read)
    expect(result.applied).toBe(true)
    expect(result.projects.add).toBe(2)
    expect(store.listCrews().map((c) => c.name).sort()).toEqual(['Alpha', 'Beta'])
    expect(store.listPresets().find((p) => p.name === 'explore (from 2.8.2)')).toMatchObject({ agent: 'claude', model: 'haiku', tools: 'Read, Grep', roleText: 'You answer one question.' })
    const report = queryUsage({ store, now: () => NOW }, { groupBy: ['project'] })
    expect(report.totals.turns).toBe(3)
    expect(report.totals.legacyTurns).toBe(3)
    expect(report.rows.map((r) => [r.labels[0], r.turns]).sort()).toEqual([['Alpha', 1], ['Beta', 1], ['No project', 1]])
    expect(queryUsage({ store, now: () => NOW }, { filter: { legacy: 'only' } }).totals.costUsd).toBeCloseTo(0.75, 9)
    expect(queryUsage({ store, now: () => NOW }, { groupBy: ['cli'] }).rows.map((r) => [r.keys[0], r.turns]).sort()).toEqual([['claude', 2], ['opencode', 1]])
    expect(snapshot(legacy)).toBe(before)
  })

  it('adds nothing the second time', () => {
    const read = readSource({ kind: 'legacy', dir: legacy })
    applyRead(store, read)
    const counts = () => [store.listCrews().length, store.listPresets().length, queryUsage({ store, now: () => NOW }, {}).totals.turns]
    const first = counts()
    const again = applyRead(store, readSource({ kind: 'legacy', dir: legacy }))
    expect(counts()).toEqual(first)
    expect(again).toMatchObject({ projects: { add: 0, existing: 2 }, usage: { add: 0, existing: 3 }, presets: { add: 0, existing: 1 } })
    expect(previewRead(store, readSource({ kind: 'legacy', dir: legacy })).usage.add).toBe(0)
  })

  it('reports a folder with no data, and honours OPERANT_USER_DATA', () => {
    const none = previewRead(store, readSource({ kind: 'legacy', dir: join(dir, 'nothing') }))
    expect(none.found).toBe(false)
    expect(none.notes[0]).toMatch(/No Operant 2.8.2 data/)
    expect(legacyDataDir({ platform: 'win32', home: 'C:\\h', env: { OPERANT_USER_DATA: 'D:\\custom', APPDATA: 'C:\\a' } })).toBe('D:\\custom')
    expect(legacyDataDir({ platform: 'win32', home: 'C:\\h', env: { APPDATA: 'C:\\a', OPERANT_DATA_DIR: 'X' } })).toMatch(/Operant$/)
    expect(legacyDataDir({ platform: 'win32', home: 'C:\\h', env: { APPDATA: 'C:\\a' } })).not.toMatch(/Operant2/)
    expect(readSource({ kind: 'legacy', dir: legacy }, { env: undefined }).found).toBe(true)
  })

  it('names a project that collides with an existing one and matches rows by folder name', () => {
    store.createCrew('Alpha', join(dir, 'elsewhere'))
    const preview = previewRead(store, readSource({ kind: 'legacy', dir: legacy }))
    expect(preview.projects.add).toBe(2)
    applyRead(store, readSource({ kind: 'legacy', dir: legacy }))
    expect(store.listCrews().map((c) => c.name).sort()).toEqual(['Alpha', 'Alpha (2)', 'Beta'])
  })

  it('parses a role file', () => {
    expect(parseRole('fix.md', '---\r\nname: fix\r\nmodel: sonnet\r\n---\r\nBody\r\n')).toMatchObject({ name: 'fix (from 2.8.2)', model: 'sonnet', roleText: 'Body' })
    expect(parseRole('x.md', '---\nname: x\n---\n')).toBeNull()
  })
})

describe('export and import between machines', () => {

  it('refuses files that are not exports and lists unusable rows', () => {
    expect(readBundleText('nope', 'x').found).toBe(false)
    expect(readBundleText('{"format":"other"}', 'x').notes[0]).toMatch(/not an Operant export/)
    const read = readBundleText(JSON.stringify({ format: 'operant-export', version: 1, usage: [{ key: 'a', at: 1, inputTokens: -1, outputTokens: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }, { at: 1 }], projects: [{ name: 'x' }] }), 'x')
    expect(read.skipped.map((s) => s.kind)).toEqual(['project', 'usage', 'usage'])
    expect(previewRead(store, read).usage.skipped).toBe(2)
  })

  it('validates imported presets and warns about bypassPermissions before applying', () => {
    const p = (name: string, o: object) => ({ name, agent: 'claude', model: 'sonnet', ...o })
    const read = readBundleText(
      JSON.stringify({
        format: 'operant-export',
        version: 1,
        presets: [p('ok', {}), p('badagent', { agent: 'shell' }), p('badmode', { permissionMode: 'yolo' }), p('badmodel', { model: 'x; rm -rf /' }), p('risky', { permissionMode: 'bypassPermissions' })],
      }),
      'x',
    )
    expect(read.skipped.filter((s) => s.kind === 'preset').map((s) => s.ref)).toEqual(['badagent', 'badmode', 'badmodel'])
    expect(read.skipped.every((s) => s.reason)).toBe(true)
    const preview = previewRead(store, read)
    expect(preview.presets).toMatchObject({ add: 2, skipped: 3 })
    expect(preview.notes.some((n) => n.startsWith('Warning:') && n.includes('"risky"') && n.includes('bypassPermissions'))).toBe(true)
    expect(applyRead(store, read).notes).toEqual(preview.notes)
  })
})
