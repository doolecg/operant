import { describe, expect, it } from 'vitest'
import type { ChatCommand, ChatItem, ChatModel, SubagentItem, ToolItem } from '@shared/claude-chat'
import { agentContext, agentElapsed, agentTitle, agentTldr, agentList, applySuggestion, capItems, contextHeadline, contextTone, currentModel, effortDisabledReason, effortStops, filterCommands, formatDuration, highlightParts, kTokens, noticeChipIcon, withLocalCommands, mainThread, modeLabel, modeOptions, nextMode, toolRowParts, triggerAt } from './chatHelpers'

const model = (over: Partial<ChatModel> = {}): ChatModel => ({ value: 'opus', displayName: 'Opus 5.5', description: '', resolvedModel: 'claude-opus-5-5', supportsEffort: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], supportsAutoMode: true, ...over })

const tool = (over: Partial<ToolItem> = {}): ToolItem => ({
  kind: 'tool', id: 't1', parent: null, name: 'Edit', input: {}, partial: '', summary: 'TileSurface.tsx', status: 'done', result: null, diff: null, background: false, startedAt: 0, endedAt: 1, ...over,
})

const agent = (over: Partial<SubagentItem> = {}): SubagentItem => ({
  kind: 'subagent', id: 'a1', parent: null, description: 'Check tiles', agentType: 'Explore', prompt: '', model: null, agentId: null, background: false, status: 'running', latest: 'Reading x.ts', toolUses: 0, outputTokens: 0, startedAt: 1000, endedAt: null, result: null, ...over,
})

describe('formatting', () => {
  it('formats durations', () => {
    expect(formatDuration(4600)).toBe('4.6s')
    expect(formatDuration(46_000)).toBe('46s')
    expect(formatDuration(64_000)).toBe('1m 4s')
    expect(formatDuration(3_720_000)).toBe('1h 2m')
  })
  it('formats tokens', () => {
    expect(kTokens(950)).toBe('950')
    expect(kTokens(1234)).toBe('1.2k')
    expect(kTokens(1_000_000)).toBe('1M')
  })
  it('writes the context headline', () => {
    expect(contextHeadline(95_000, 1_000_000, 967_000)).toBe('95k of 1M · compacts at 967k')
    expect(contextHeadline(95_000, 1_000_000, null)).toBe('95k of 1M')
  })
  it('picks the context tone', () => {
    expect(contextTone(10, 60, 85)).toBe('ok')
    expect(contextTone(60, 60, 85)).toBe('warn')
    expect(contextTone(90, 60, 85)).toBe('danger')
  })
})

describe('modes and effort', () => {
  const base = { models: [model()], model: 'claude-opus-5-5', bypassAllowed: false, permissionMode: 'default' }
  it('lists only real modes', () => {
    expect(modeOptions(base)).toEqual(['default', 'acceptEdits', 'plan', 'auto'])
    expect(modeOptions({ ...base, models: [model({ supportsAutoMode: false })] })).toEqual(['default', 'acceptEdits', 'plan'])
    expect(modeOptions({ ...base, bypassAllowed: true })).toContain('bypassPermissions')
    expect(modeOptions({ ...base, permissionMode: 'dontAsk' })).toContain('dontAsk')
  })
  it('cycles and labels', () => {
    expect(nextMode(base)).toBe('acceptEdits')
    expect(nextMode({ ...base, permissionMode: 'auto' })).toBe('default')
    expect(modeLabel('default')).toBe('Ask')
    expect(modeLabel('acceptEdits')).toBe('Accept edits')
  })
  it('gives one stop per real level and none without effort', () => {
    expect(effortStops(model())).toHaveLength(5)
    expect(effortStops(model({ efforts: ['low', 'medium', 'high', 'max'] }))).toHaveLength(4)
    expect(effortStops(model({ supportsEffort: false, efforts: [] }))).toEqual([])
    expect(effortDisabledReason(model({ supportsEffort: false, efforts: [], displayName: 'Haiku 4.5' }), null)).toBe('Haiku 4.5 has no effort setting')
    expect(effortDisabledReason(model(), null)).toBeNull()
  })
})

describe('composer suggestions', () => {
  const cmds: ChatCommand[] = [
    { name: 'compact', description: 'Compact the conversation', argumentHint: '', source: 'built-in', terminalOnly: false },
    { name: 'context', description: 'Show context', argumentHint: '', source: 'built-in', terminalOnly: false },
    { name: 'review', description: 'Review a compact diff', argumentHint: '', source: 'skill', terminalOnly: false },
  ]
  it('finds the trigger', () => {
    expect(triggerAt('/co', 3)).toEqual({ kind: '/', query: 'co', start: 0 })
    expect(triggerAt('see @src/a', 10)).toEqual({ kind: '@', query: 'src/a', start: 4 })
    expect(triggerAt('hello /co', 9)).toBeNull()
    expect(triggerAt('a@b', 3)).toBeNull()
  })
  it('applies a suggestion', () => {
    const t = triggerAt('see @sr tail', 7)!
    expect(applySuggestion('see @sr tail', t, 7, 'src/a.ts')).toEqual({ text: 'see @src/a.ts  tail', caret: 14 })
  })
  it('filters commands by prefix first', () => {
    expect(filterCommands(cmds, 'co').map((c) => c.name)).toEqual(['compact', 'context', 'review'])
    expect(filterCommands(cmds, '').map((c) => c.name)).toHaveLength(3)
    expect(filterCommands(cmds, 'zzz')).toEqual([])
  })
})

describe('rows', () => {
  it('describes a finished edit', () => {
    const p = toolRowParts(tool({ diff: { path: 'a', created: false, added: 1, removed: 1, hunks: [] } }))
    expect(p).toEqual({ verb: 'Edited', target: 'TileSurface.tsx', stat: '+1 −1', tone: 'normal' })
    expect(toolRowParts(tool({ status: 'running' })).verb).toBe('Editing')
    expect(toolRowParts(tool({ status: 'failed' })).tone).toBe('failed')
  })
  it('keeps sub-agent prompts in the main thread only while pending', () => {
    const perm = (answer: 'once' | null, parent: string | null): ChatItem => ({
      kind: 'permission', id: `p-${String(answer)}-${parent}`, requestId: 'r', toolUseId: 't', parent, toolName: 'Bash', displayName: 'Bash', summary: '', input: {}, description: null, reason: null, diff: null, options: [], answer, at: 0,
    })
    const items = [tool({ parent: 'a1' }), perm(null, 'a1'), perm('once', 'a1'), perm(null, null), tool()]
    expect(mainThread(items).map((i) => i.id)).toEqual(['p-null-a1', 'p-null-null', 't1'])
  })
  it('caps the rendered items', () => {
    expect(capItems([1, 2, 3, 4], 2)).toEqual({ items: [3, 4], hidden: 2 })
    expect(capItems([1], 2)).toEqual({ items: [1], hidden: 0 })
  })
})

describe('agents', () => {
  it('lists open and recent agents newest first', () => {
    const now = 100 * 60_000
    const items = [
      agent({ id: 'old', startedAt: 1, endedAt: 2, status: 'done' }),
      agent({ id: 'run', startedAt: 5 * 60_000 }),
      agent({ id: 'fresh', startedAt: now - 60_000, endedAt: now - 30_000, status: 'done', result: { text: 'All fine\nmore', summary: 'All fine', isError: false, truncated: false, images: [] } }),
    ]
    const { shown, earlier } = agentList(items, now)
    expect(shown.map((a) => a.id)).toEqual(['fresh', 'run'])
    expect(earlier.map((a) => a.id)).toEqual(['old'])
    expect(shown[0]!.now).toBe('Done · All fine')
    expect(shown[1]!.now).toBe('Reading x.ts')
    expect(shown[1]!.dot).toBe('running')
  })
  it('measures elapsed time', () => {
    expect(agentElapsed({ startedAt: 1000, endedAt: null, dot: 'running' }, 4000)).toBe(3000)
    expect(agentElapsed({ startedAt: 1000, endedAt: 2000, dot: 'done' }, 4000)).toBe(1000)
    expect(agentElapsed({ startedAt: null, endedAt: null, dot: 'running' }, 4000)).toBeNull()
  })
})

describe('agent rows', () => {
  it('titles with the model only when known', () => {
    expect(agentTitle({ description: 'Check tiles', agentType: 'Explore', model: 'claude-haiku-5-5' })).toBe('Explore – Haiku 5.5')
    expect(agentTitle({ description: 'Check tiles', agentType: null, model: null })).toBe('Check tiles')
  })
  it('writes the TL;DR by status', () => {
    expect(agentTldr(agent())).toBe('Reading x.ts')
    const result = { text: 'Found three bugs in the tile code. More detail follows.', summary: '', isError: false, images: [] } as unknown as SubagentItem['result']
    expect(agentTldr(agent({ status: 'done', result }))).toBe('Found three bugs in the tile code.')
    expect(agentTldr(agent({ status: 'failed', result: { ...result!, text: 'Boom' } }))).toBe('Boom')
    expect(agentTldr(agent({ status: 'done', result: { ...result!, text: 'x'.repeat(300) } }), 20)).toHaveLength(20)
  })
  it('measures context against the window, hidden when unknown', () => {
    expect(agentContext(agent({ model: 'claude-haiku-5-5', contextTokens: 50_000 }))).toEqual({ used: 50_000, window: 200_000, pct: 25 })
    expect(agentContext(agent({ model: null, contextTokens: 50_000 }))).toBeNull()
    expect(agentContext(agent({ model: 'claude-haiku-5-5' }))).toBeNull()
    expect(agentContext(agent({ model: 'glm-5', contextTokens: 5 }))).toBeNull()
  })
})

describe('currentModel before the first message', () => {
  const m = (value: string, resolvedModel: string) => ({ value, resolvedModel, displayName: value, supportsEffort: true, efforts: ['low', 'high'] }) as never
  const state = { model: null, models: [m('default', 'claude-opus-5-5'), m('sonnet', 'claude-sonnet-5-5')] }
  it('uses the tile model, else the default entry', () => {
    expect(currentModel(state as never, 'claude-sonnet-5-5')?.value).toBe('sonnet')
    expect(currentModel(state as never, '')?.value).toBe('default')
    expect(currentModel(state as never)).toBeNull()
  })
})

describe('suggestion highlighting', () => {
  it('marks the words that contain what was typed', () => {
    expect(highlightParts('Keep the prompt cache warm', 'warm')).toEqual([
      { text: 'Keep the prompt cache ', hit: false },
      { text: 'warm', hit: true },
    ])
    expect(highlightParts('Keep the prompt cache warm', 'ca')).toEqual([
      { text: 'Keep the prompt ', hit: false },
      { text: 'cache', hit: true },
      { text: ' warm', hit: false },
    ])
  })
  it('marks nothing for an empty or unmatched query', () => {
    expect(highlightParts('Keep warm', '')).toEqual([{ text: 'Keep warm', hit: false }])
    expect(highlightParts('Keep warm', 'zzz')).toEqual([{ text: 'Keep warm', hit: false }])
  })
  it('lists /keepwarm with Claude commands and finds it by name or description', () => {
    const all = withLocalCommands([])
    expect(all.map((c) => c.name)).toEqual(['keepwarm'])
    expect(withLocalCommands(all)).toHaveLength(1)
    expect(filterCommands(all, 'keep')[0]?.name).toBe('keepwarm')
    expect(filterCommands(all, 'cache')[0]?.name).toBe('keepwarm')
    expect(withLocalCommands([], false)).toEqual([])
  })
})

describe('notice chips', () => {
  it('picks an icon by source and tone', () => {
    expect(noticeChipIcon('ping', 'info')).toBe('cube')
    expect(noticeChipIcon('keepwarm', 'warn')).toBe('cube')
    expect(noticeChipIcon('effort', 'info')).toBe('gauge')
    expect(noticeChipIcon('hook', 'info')).toBe('hook')
    expect(noticeChipIcon('crash', 'warn')).toBe('alert')
    expect(noticeChipIcon('info', 'error')).toBe('alert')
    expect(noticeChipIcon('info', 'info')).toBe('info')
  })
})
