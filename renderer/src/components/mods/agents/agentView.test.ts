import { describe, expect, it } from 'vitest'
import type { ChatItem } from '@shared/claude-chat'
import { buildRows } from '@shared/claude-chat'
import { CUTE_NAMES, HATS, TINTS, critterFor, cuteName, effortInfo, mcpRows, mcpSummary, mcpTiles, metricsOf, progressOf, sessionRows, shortModel, skillSummary, skillTiles, summarize, todoProgress } from './agentView'

const notice = (over: Record<string, unknown>): ChatItem => ({ kind: 'notice', id: 'n1', parent: null, source: 'info', tone: 'info', text: 'x', at: 0, ...over }) as ChatItem

describe('agent names and critters', () => {
  it('is deterministic and from the list', () => {
    expect(cuteName('toolu_abc')).toBe(cuteName('toolu_abc'))
    expect(CUTE_NAMES).toContain(cuteName('toolu_xyz'))
    expect(CUTE_NAMES.length).toBeGreaterThanOrEqual(60)
  })
  it('picks a stable hat and tint', () => {
    const c = critterFor('toolu_abc')
    expect(c).toEqual(critterFor('toolu_abc'))
    expect(HATS).toContain(c.hat)
    expect(TINTS).toContain(c.tint)
    expect(new Set(Array.from({ length: 80 }, (_, i) => critterFor(`id${i}`).hat)).size).toBe(HATS.length)
  })
})

describe('effort and model', () => {
  it('maps effort to word and tone', () => {
    expect(effortInfo('low')).toEqual({ word: 'light', tone: 'success' })
    expect(effortInfo('medium')?.tone).toBe('info')
    expect(effortInfo('high')).toEqual({ word: 'careful', tone: 'warning' })
    expect(effortInfo('xhigh')?.word).toBe('heavy')
    expect(effortInfo('max')?.tone).toBe('destructive')
    expect(effortInfo(null)).toBeNull()
  })
  it('names the model', () => {
    expect(shortModel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(shortModel(null)).toBeNull()
  })
})

describe('progress and metrics', () => {
  it('uses todos when present, else context, else nothing', () => {
    expect(progressOf({ todos: { done: 1, total: 4 }, model: null, context: null })).toEqual({ label: '1/4', pct: 25 })
    expect(progressOf({ todos: null, model: null, context: { used: 8, window: 200, pct: 4 } })).toEqual({ label: null, pct: 4 })
    expect(progressOf({ todos: null, model: null, context: null })).toEqual({ label: null, pct: null })
  })
  it('reads the newest TodoWrite of the agent', () => {
    const tool = (id: string, parent: string, todos: unknown[]) => ({ kind: 'tool', id, parent, name: 'TodoWrite', input: { todos } }) as unknown as ChatItem
    const items = [tool('a', 'ag', [{ status: 'pending' }]), tool('b', 'ag', [{ status: 'completed' }, { status: 'pending' }])]
    expect(todoProgress(items, 'ag')).toEqual({ done: 1, total: 2 })
    expect(todoProgress(items, 'other')).toBeNull()
  })
  it('composes metrics and omits unknown parts', () => {
    expect(metricsOf({ context: { used: 1, window: 2, pct: 4 }, tokens: 41000, cost: 0.08 }, 44000)).toBe('ctx 4% · 41k ≈$0.08 0:44')
    expect(metricsOf({ context: null, tokens: null, cost: null }, null)).toBe('')
  })
  it('sums known values only', () => {
    const s = summarize(
      [
        { cost: 0.1, tokens: 100, startedAt: 1000, endedAt: 5000, dot: 'done' },
        { cost: null, tokens: 50, startedAt: 2000, endedAt: null, dot: 'running' },
      ],
      9000,
    )
    expect(s).toEqual({ cost: 0.1, tokens: 150, ms: 8000 })
    expect(summarize([], 1)).toEqual({ cost: null, tokens: null, ms: null })
  })
})

describe('status section', () => {
  it('summarises MCP servers and sorts problems first', () => {
    const servers = [
      { name: 'b', status: 'connected' as const },
      { name: 'a', status: 'failed' as const },
      { name: 'c', status: 'connected' as const },
    ]
    expect(mcpSummary(servers)).toBe('MCP · 2 connected · 1 failed')
    expect(mcpRows(servers)[0]).toMatchObject({ name: 'a', tone: 'destructive', reason: 'Failed to connect' })
    expect(mcpRows(servers)[1]!.reason).toBeNull()
  })
  it('makes MCP tiles: claude.ai prefix split, failed and sign-in first, one-word states', () => {
    const servers = [
      { name: 'claude.ai Mem0', status: 'needs-auth' as const },
      { name: 'context7', status: 'connected' as const },
      { name: 'idea', status: 'failed' as const },
      { name: 'claude.ai Gmail', status: 'pending' as const },
    ]
    const tiles = mcpTiles(servers)
    expect(tiles.map((t) => t.name)).toEqual(['idea', 'claude.ai Mem0', 'claude.ai Gmail', 'context7'])
    expect(tiles[0]).toMatchObject({ prefix: null, short: 'idea', state: 'Failed', tone: 'destructive', attention: true, reason: 'Failed to connect' })
    expect(tiles[1]).toMatchObject({ prefix: 'claude.ai', short: 'Mem0', state: 'Needs sign-in', tone: 'warning', attention: true })
    expect(tiles[2]).toMatchObject({ state: 'Pending', tone: 'muted', attention: false })
    expect(tiles[3]).toMatchObject({ prefix: null, short: 'context7', state: 'Connected', tone: 'success', attention: false, reason: null })
  })
  it('lists SessionStart notices and keeps them out of the chat rows', () => {
    const items = [notice({ id: 'n1', category: 'session', origin: 'SessionStart:startup', text: 'SessionStart hook · Hindsight is tracking' }), notice({ id: 'n2', category: 'mcp', text: '1 MCP server failed' }), notice({ id: 'n3', text: 'Effort set to Medium' })]
    expect(sessionRows(items)).toEqual([{ origin: 'startup', text: 'Hindsight is tracking' }])
    expect(buildRows(items).map((r) => (r.type === 'item' ? r.item.id : r.id))).toEqual(['n3'])
  })
  it('makes one skill tile per skill, newest first, with its state', () => {
    const skill = (id: string, summary: string, status: string, over: Record<string, unknown> = {}) => ({ kind: 'tool', id, parent: null, name: 'Skill', summary, status, result: null, ...over }) as unknown as ChatItem
    const items = [
      skill('t1', 'plugin-authoring', 'done'),
      skill('t2', 'superpowers:brainstorming', 'failed', { result: { summary: 'Skill not found', text: '', isError: true, truncated: false, images: [] } }),
      skill('t3', 'plugin-authoring', 'running'),
      { kind: 'tool', id: 't4', parent: null, name: 'Read', summary: 'a.ts', status: 'done' } as unknown as ChatItem,
    ]
    const tiles = skillTiles(items)
    expect(tiles.map((t) => t.name)).toEqual(['plugin-authoring', 'superpowers:brainstorming'])
    expect(tiles[0]).toMatchObject({ short: 'plugin-authoring', state: 'Loading…', tone: 'muted', attention: false })
    expect(tiles[1]).toMatchObject({ prefix: 'superpowers', short: 'brainstorming', state: 'Failed', tone: 'destructive', attention: true, reason: 'Skill not found' })
    expect(skillSummary(tiles)).toBe('Skills · 0 loaded')
    expect(skillSummary(skillTiles([skill('t5', 'hindsight-coding-agent', 'done')]))).toBe('Skills · 1 loaded')
  })
})
