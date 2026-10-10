import { describe, expect, it } from 'vitest'
import type { ChatItem, TurnStatus } from '@shared/claude-chat'
import { folderOf, isUncommitted, legendFiles, rightNowHeadline, touchedFiles } from './rightNow'

const tool = (name: string, input: Record<string, unknown>, over: Record<string, unknown> = {}): ChatItem =>
  ({ kind: 'tool', id: `t${Math.random()}`, parent: null, name, input, status: 'done', diff: null, partial: '', summary: '', result: null, background: false, startedAt: 0, endedAt: null, ...over }) as ChatItem
const turnEnd = (): ChatItem => ({ kind: 'turn', id: 'turn', durationMs: 1, ok: true, costUsd: null, at: 0 }) as ChatItem
const idle: Pick<TurnStatus, 'phase' | 'pendingCount' | 'pendingLabel'> = { phase: 'idle', pendingCount: 0, pendingLabel: null }
const working = { ...idle, phase: 'working' as const }

describe('right now headline', () => {
  it('says idle with no file calls', () => {
    expect(rightNowHeadline([], idle)).toEqual({ headline: 'Claude is idle', subline: 'no files touched yet', diff: null })
  })
  it('waits for the user when a prompt is pending', () => {
    const r = rightNowHeadline([], { ...idle, pendingCount: 1, pendingLabel: 'Bash: npm test' })
    expect(r.headline).toBe('Waiting for you')
    expect(r.subline).toBe('Bash: npm test')
  })
  it('thinks while the turn runs with no tool running', () => {
    expect(rightNowHeadline([], working).headline).toBe('Claude is thinking')
  })
  it('reads the file of a running Read, in its folder', () => {
    const r = rightNowHeadline([tool('Read', { file_path: 'C:\\repo\\src\\app.ts' }, { status: 'running' })], working)
    expect(r).toEqual({ headline: 'Claude is reading app.ts', subline: 'in src', diff: null })
  })
  it('edits a running Edit and names the file', () => {
    const r = rightNowHeadline([tool('Edit', { file_path: '/repo/lib/a.ts' }, { status: 'running' })], working)
    expect(r.headline).toBe('Claude is editing a.ts')
    expect(r.subline).toBe('in lib')
  })
  it('names the command of a running Bash', () => {
    const r = rightNowHeadline([tool('Bash', { command: 'npm test' }, { status: 'running' })], working)
    expect(r).toEqual({ headline: 'Claude is running a command', subline: 'npm test', diff: null })
  })
  it('ignores sub-agent tools for the headline', () => {
    const r = rightNowHeadline([tool('Bash', { command: 'x' }, { status: 'running', parent: 'agent1' })], working)
    expect(r.headline).toBe('Claude is thinking')
  })
  it('reports the edits of the turn that just ended, with the last diff', () => {
    const diff = { path: '/r/b.ts', created: false, added: 14, removed: 3, hunks: [] }
    const items = [
      tool('Read', { file_path: '/r/x.ts' }),
      turnEnd(),
      tool('Edit', { file_path: '/r/a.ts' }),
      tool('Write', { file_path: '/r/a.ts' }),
      tool('Edit', { file_path: '/r/b.ts' }, { diff }),
    ]
    expect(rightNowHeadline(items, idle)).toEqual({ headline: 'Claude edited 2 files', subline: 'b.ts', diff: { added: 14, removed: 3 } })
  })
  it('falls back to the last file when idle after reads', () => {
    const r = rightNowHeadline([tool('Read', { file_path: '/r/x.ts' }), turnEnd()], idle)
    expect(r).toEqual({ headline: 'Claude is idle', subline: 'last: x.ts', diff: null })
  })
})

describe('touched files', () => {
  it('lists files most recent first, edited wins over read, search tools are left out', () => {
    const items = [
      tool('Read', { file_path: '/r/a.ts' }),
      tool('Grep', { pattern: 'foo', path: '/r' }),
      tool('Read', { file_path: '/r/b.ts' }),
      tool('Edit', { file_path: '/r/a.ts' }),
    ]
    const files = touchedFiles(items)
    expect(files.map((f) => [f.name, f.kind])).toEqual([
      ['a.ts', 'edited'],
      ['b.ts', 'read'],
    ])
  })
  it('marks files that git reports as uncommitted', () => {
    const files = touchedFiles([tool('Read', { file_path: 'C:\\repo\\src\\a.ts' }), tool('Read', { file_path: '/repo/b.ts' })], ['src/a.ts'])
    expect(files.map((f) => [f.name, f.uncommitted])).toEqual([
      ['b.ts', false],
      ['a.ts', true],
    ])
  })
  it('matches git paths on whole segments only', () => {
    expect(isUncommitted('/repo/src/a.ts', ['src/a.ts'])).toBe(true)
    expect(isUncommitted('/repo/xsrc/a.ts', ['src/a.ts'])).toBe(false)
    expect(isUncommitted('/repo/a.ts', ['src/a.ts'])).toBe(false)
  })
  it('caps the legend list at five with the rest counted', () => {
    const files = touchedFiles(Array.from({ length: 7 }, (_, i) => tool('Read', { file_path: `/r/f${i}.ts` })))
    const { shown, more } = legendFiles(files)
    expect(shown).toHaveLength(5)
    expect(more).toBe(2)
    expect(legendFiles(files.slice(0, 3))).toEqual({ shown: files.slice(0, 3), more: 0 })
  })
  it('gives the folder of a path', () => {
    expect(folderOf('C:\\repo\\src\\a.ts')).toBe('src')
    expect(folderOf('a.ts')).toBe('')
  })
})
