import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildRows,
  diffFromInput,
  emptyChatState,
  itemsOf,
  mapContextUsage,
  partialJsonString,
  partialTarget,
  permissionOptions,
  reduceChat,
  statusWord,
  tileState,
  toolTarget,
  type ChatItem,
  type ChatOp,
  type NoticeItem,
  type PermissionItem,
  type QuestionItem,
  type SubagentItem,
  type ToolItem,
} from '../shared/claude-chat'
import { ChatMapper, mapTranscript } from './claude-chat-map'

const fixture = (name: string): Array<Record<string, unknown>> =>
  readFileSync(join(__dirname, 'fixtures', 'chat', `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)

let clock = 1_000_000
const mapper = () => new ChatMapper({ scratchId: 4, now: () => (clock += 10) })

// Feeds the lines; `onLine` can answer prompts between lines. Returns every op produced.
function run(m: ChatMapper, lines: Array<Record<string, unknown>>, onLine?: (line: Record<string, unknown>) => void): ChatOp[] {
  const ops: ChatOp[] = []
  for (const l of lines) {
    ops.push(...m.feed(l))
    onLine?.(l)
  }
  return ops
}

const kinds = (m: ChatMapper): string[] => m.items.map((i) => i.kind)
const of = <K extends ChatItem['kind']>(m: ChatMapper, kind: K): Array<Extract<ChatItem, { kind: K }>> => m.items.filter((i): i is Extract<ChatItem, { kind: K }> => i.kind === kind)

describe('stream mapper: a Write that needs permission (perm.log)', () => {
  it('maps thinking, the tool call, the prompt, the result and the answer text', () => {
    const m = mapper()
    const answered: Array<{ body: Record<string, unknown> }> = []
    run(m, fixture('perm'), (l) => {
      const req = l.request as { subtype?: string } | undefined
      if (l.type === 'control_request' && req?.subtype === 'can_use_tool') {
        expect(m.state.turn.phase).toBe('waiting')
        expect(m.state.turn.pendingLabel).toBe('Write: hello.txt')
        const r = m.answer(l.request_id as string, { kind: 'allow' })
        if (r) answered.push(r)
      }
    })
    expect(kinds(m)).toEqual(['thinking', 'tool', 'permission', 'text', 'turn'])
    const [think] = of(m, 'thinking')
    expect(think).toMatchObject({ tokens: 260 })
    expect(think!.endedAt).not.toBeNull()
    const [tool] = of(m, 'tool') as ToolItem[]
    expect(tool).toMatchObject({ name: 'Write', status: 'done', summary: 'hello.txt' })
    expect(tool!.diff).toMatchObject({ created: true, added: 1, removed: 0, path: 'C:\\proj\\hello.txt' })
    expect(tool!.result?.text).toContain('File created successfully')
    const [perm] = of(m, 'permission')
    expect(perm).toMatchObject({ toolName: 'Write', answer: 'once', summary: 'hello.txt', description: 'hello.txt' })
    expect(perm!.options).toEqual([{ index: 0, kind: 'mode', label: 'Allow all edits this session' }])
    expect(answered[0]!.body).toMatchObject({ behavior: 'allow', updatedInput: { content: 'hi' } })
    const [text] = of(m, 'text')
    expect(text!.streaming).toBe(false)
    expect(text!.md).toContain('Created `hello.txt`')
    expect(of(m, 'turn')[0]).toMatchObject({ ok: true })
    expect(m.state.turn).toMatchObject({ phase: 'idle', startedAt: null, pendingCount: 0 })
    expect(m.state.model).toBe('claude-haiku-5-5')
    expect(m.state.costUsd).toBeCloseTo(0.0101331)
    expect(m.state.context).toMatchObject({ windowTokens: 1_000_000 })
  })

  it('shows hook messages with ANSI codes stripped, once, and failures with their stderr', () => {
    const m = mapper()
    const hook = (id: string, extra: Record<string, unknown>) => ({ type: 'system', subtype: 'hook_response', hook_id: id, hook_name: 'SessionStart:startup', hook_event: 'SessionStart', exit_code: 0, outcome: 'success', ...extra })
    const msg = JSON.stringify({ systemMessage: '\u001b[38;2;0;116;217mHindsight\u001b[0m is tracking this repo\n  memory bank' })
    m.feed(hook('h1', { output: msg }))
    m.feed(hook('h1', { output: msg }))
    m.feed(hook('h2', { output: '', exit_code: 2, outcome: 'error', stderr: 'bad hook', hook_name: 'UserPromptSubmit' }))
    m.feed(hook('h3', { output: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'no rm' } }) }))
    const ns = of(m, 'notice')
    expect(ns.map((n) => n.text)).toEqual(['SessionStart hook · Hindsight is tracking this repo memory bank', 'Hook UserPromptSubmit failed (exit 2)', 'Blocked by hook: no rm'])
    expect(ns[1]).toMatchObject({ tone: 'warn', detail: 'bad hook' })
  })

  it('streams text deltas as append ops and tool input as a partial target', () => {
    const m = mapper()
    const ops = run(m, fixture('perm'))
    const appends = ops.filter((o): o is Extract<ChatOp, { op: 'append' }> => o.op === 'append')
    expect(appends.length).toBeGreaterThan(5)
    const tool = of(m, 'tool')[0] as ToolItem
    expect(ops.some((o) => o.op === 'upsert' && o.item.kind === 'tool' && o.item.status === 'preparing' && o.item.summary === 'hello.txt')).toBe(true)
    expect(tool.partial).toBe('')
  })

  it('applying the ops to an empty state gives the mapper state', () => {
    for (const name of ['perm', 'ask', 'always', 'interrupt', 'slash', 'mod', 'resume']) {
      const m = mapper()
      const ops = run(m, fixture(name))
      const state = reduceChat(emptyChatState(4), ops)
      expect(JSON.parse(JSON.stringify(state))).toEqual(JSON.parse(JSON.stringify(m.state)))
    }
  })
})

describe('questions, plans, permissions', () => {
  it('maps AskUserQuestion to a question item and answers it with updatedInput.answers', () => {
    const m = mapper()
    let body: Record<string, unknown> | undefined
    run(m, fixture('ask'), (l) => {
      if (l.type === 'control_request') body = m.answer(l.request_id as string, { kind: 'answer', answers: { 'Do you prefer red or blue?': 'Blue' } })?.body
    })
    const [q] = of(m, 'question') as QuestionItem[]
    expect(q).toMatchObject({ toolUseId: expect.stringMatching(/^toolu_/), answers: { 'Do you prefer red or blue?': 'Blue' } })
    expect(q!.questions[0]).toMatchObject({ header: 'Color', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] })
    expect(body).toMatchObject({ behavior: 'allow', updatedInput: { answers: { 'Do you prefer red or blue?': 'Blue' } } })
    // the question has no extra tool row
    expect(of(m, 'tool')).toHaveLength(0)
  })

  it('always allow sends the chosen suggestion, deny sends the reason, rule-allowed calls are tagged (always.log)', () => {
    const m = mapper()
    const bodies: Array<Record<string, unknown>> = []
    let n = 0
    run(m, fixture('always'), (l) => {
      if (l.type !== 'control_request') return
      const req = l.request as { subtype?: string }
      if (req.subtype !== 'can_use_tool') return
      const item = m.items.find((i) => i.kind === 'permission' && i.requestId === l.request_id) as PermissionItem
      const dec = n++ === 0 ? ({ kind: 'always', index: 0 } as const) : ({ kind: 'deny', message: 'Not that file' } as const)
      expect(item.options.length).toBeGreaterThan(0)
      bodies.push(m.answer(l.request_id as string, dec)!.body)
    })
    const perms = of(m, 'permission')
    expect(perms).toHaveLength(2)
    expect(perms[0]).toMatchObject({ answer: 'always', toolName: 'Bash', summary: 'git --version', reason: 'This command requires approval' })
    expect(perms[0]!.options[0]).toEqual({ index: 0, kind: 'rule', label: 'Always allow git --version in this project' })
    expect(perms[1]!.options.map((o) => o.kind)).toEqual(['rule', 'directory', 'mode'])
    expect(bodies[0]).toMatchObject({ behavior: 'allow', updatedPermissions: [{ type: 'addRules' }] })
    expect(bodies[1]).toEqual({ behavior: 'deny', message: 'Not that file' })
    const tools = of(m, 'tool') as ToolItem[]
    expect(tools.map((t) => t.status)).toEqual(['done', 'done', 'done', 'denied'])
    expect(tools[1]!.autoAllowed).toBe('rule')
    expect(tools[3]!.result).toMatchObject({ isError: true, text: 'The user denied this.' })
    expect(of(m, 'turn').map((t) => t.ok)).toEqual([true, true, true])
  })

  it('expires prompts that are cancelled or whose process ended', () => {
    const m = mapper()
    const lines = fixture('perm')
    const at = lines.findIndex((l) => l.type === 'control_request')
    run(m, lines.slice(0, at + 1))
    expect(m.state.turn.pendingCount).toBe(1)
    m.feed({ type: 'control_cancel_request', request_id: lines[at]!.request_id })
    expect(of(m, 'permission')[0]!.answer).toBe('expired')
    expect(m.state.turn.pendingCount).toBe(0)
    const m2 = mapper()
    run(m2, lines.slice(0, at + 1))
    m2.noteProcessGone()
    expect(of(m2, 'permission')[0]!.answer).toBe('expired')
    expect((of(m2, 'tool')[0] as ToolItem).status).toBe('interrupted')
  })

  it('plan approval can switch to accept-edits', () => {
    const m = mapper()
    m.feed({ type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'tu1', name: 'ExitPlanMode', input: { plan: '1. do it' } }] }, parent_tool_use_id: null })
    m.feed({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: '1. do it' }, tool_use_id: 'tu1' } })
    const plan = of(m, 'plan')[0]!
    expect(plan).toMatchObject({ plan: '1. do it', requestId: 'r1', answer: null })
    const r = m.answer('r1', { kind: 'plan', approve: 'approve-edits' })!
    expect(r.body).toMatchObject({ behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits' }] })
    expect(of(m, 'plan')[0]!.answer).toBe('approved-edits')
  })

  it('returns null for an unknown request id or a mismatched decision', () => {
    const m = mapper()
    expect(m.answer('nope', { kind: 'allow' })).toBeNull()
  })
})

describe('interrupt, slash commands, mods, effort', () => {
  it('maps an interrupt to a notice and a turn that is not ok, without an error notice (interrupt.log)', () => {
    const m = mapper()
    run(m, fixture('interrupt'))
    const notices = of(m, 'notice')
    expect(notices.filter((n) => n.source !== 'mcp').map((n) => [n.source, n.text])).toEqual([['interrupt', 'Interrupted']])
    expect(of(m, 'turn')[0]!.ok).toBe(false)
    expect(m.state.permissionMode).toBe('plan')
    expect(m.state.turn.phase).toBe('idle')
    expect(of(m, 'text').every((t) => !t.streaming)).toBe(true)
  })

  it('turns local slash command output into command cards and no turn footer (slash.log)', () => {
    const m = mapper()
    const cmds = ['/context', '/cost', '/compact', '/model', 'say ok']
    let i = 0
    m.noteUserMessage(cmds[i++]!, [])
    run(m, fixture('slash'), (l) => {
      if (l.type === 'result' && i < cmds.length) m.noteUserMessage(cmds[i++]!, [])
    })
    // (the probe log cut its longest lines, so the /context and /model output are missing from the recording)
    const c = of(m, 'command')
    expect(c).toHaveLength(2)
    expect(c.every((x) => x.command.startsWith('/'))).toBe(true)
    expect(c.some((x) => x.md.includes('Not enough messages to compact'))).toBe(true)
    expect(c.some((x) => x.md.includes('Current model: `Haiku 5.5`'))).toBe(true)
    expect(of(m, 'user').map((u) => u.text)).toEqual(cmds)
    expect(of(m, 'turn')).toHaveLength(1)
    m.feed({ type: 'assistant', message: { id: 'syn', model: '<synthetic>', content: [{ type: 'text', text: '## Context Usage' }] }, local_command_source: '<local-command-stdout>## Context Usage\n\n**Tokens:** 28k</local-command-stdout>' })
    expect(of(m, 'command').at(-1)).toMatchObject({ md: '## Context Usage\n\n**Tokens:** 28k' })
  })

  it('turns the /effort reply into a notice and updates the effort (ctx.log)', () => {
    const m = mapper()
    m.noteCommand('/effort')
    let i = 0
    const next = ['/effort', '/context']
    run(m, fixture('ctx'), (l) => {
      if (l.type === 'result' && i < next.length) m.noteCommand(next[i++]!)
    })
    const n = of(m, 'notice').find((x) => x.source === 'effort')
    expect(n?.text).toBe('Effort set to High (this session)')
    expect(m.state.effort).toBe('high')
    expect(of(m, 'command').map((c) => c.command)).not.toContain('')
  })

  it('shows plugin toasts and pane openings (mod.log)', () => {
    const m = mapper()
    run(m, fixture('mod'))
    const ns = of(m, 'notice') as NoticeItem[]
    expect(ns.find((n) => n.source === 'toast')?.text).toBe("Idea Shelf: Idea parked on this project's shelf (/ideas to review)")
    const pane = ns.find((n) => n.source === 'pane')!
    expect(pane.text).toBe('Idea Shelf opened a pane. Panes show in the Terminal view.')
    expect(pane.actions).toEqual(['terminal'])
  })

  it('reads commands, models and the failed MCP servers from initialize and system/init', () => {
    const m = mapper()
    m.expect('init', 'initialize')
    run(m, fixture('mod').slice(0, 14))
    expect(m.state.models.find((x) => x.value === 'opus')).toMatchObject({ displayName: 'Opus 5.5', supportsEffort: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], resolvedModel: 'claude-opus-5-5' })
    const idea = m.state.commands.find((c) => c.name === 'idea')!
    expect(idea).toMatchObject({ source: 'plugin', argumentHint: '<text>' })
    expect(m.state.commands.find((c) => c.name === 'context')?.source).toBe('built-in')
    expect(m.state.commands.find((c) => c.name === 'doctor')?.terminalOnly).toBe(true)
    expect(m.state.mcpFailed).toEqual(['idea'])
    expect(m.state.claudeVersion).toBe('2.1.296')
    expect(m.state.modelDisplayName).toBe('Haiku 5.5')
    expect(of(m, 'notice').some((n) => n.source === 'mcp')).toBe(true)
  })
})

describe('status words and turn status', () => {
  it('derives the word from real events only', () => {
    const m = mapper()
    const words: string[] = []
    run(m, fixture('perm'), (l) => {
      if (m.state.turn.phase !== 'idle') words.push(m.state.turn.word)
      void l
    })
    const seen = new Set(words)
    expect(seen.has('Thinking…')).toBe(true)
    expect(seen.has('Writing hello.txt…')).toBe(true)
    expect(seen.has('Waiting for you')).toBe(true)
    expect(seen.has('Writing…')).toBe(true)
    for (const w of seen) expect(['Thinking…', 'Writing…', 'Waiting for you', 'Working…', 'Writing hello.txt…']).toContain(w)
  })

  it('statusWord covers every derived state', () => {
    const base = { pending: 0, compacting: false, tool: null, thinking: false, writing: false }
    expect(statusWord(base)).toBe('Working…')
    expect(statusWord({ ...base, thinking: true })).toBe('Thinking…')
    expect(statusWord({ ...base, writing: true })).toBe('Writing…')
    expect(statusWord({ ...base, compacting: true })).toBe('Compacting…')
    expect(statusWord({ ...base, tool: { name: 'Read', input: { file_path: 'C:\\a\\TileFrame.tsx' } } })).toBe('Reading TileFrame.tsx…')
    expect(statusWord({ ...base, tool: { name: 'Bash', input: { command: 'npm test' } } })).toBe('Running npm test…')
    expect(statusWord({ ...base, tool: { name: 'Grep', input: { pattern: 'rounded-' } } })).toBe('Searching rounded-…')
    expect(statusWord({ ...base, tool: { name: 'Agent', input: { description: 'Check every tile' } } })).toBe('Agent: Check every tile…')
    expect(statusWord({ ...base, pending: 2, tool: { name: 'Bash', input: {} } })).toBe('Waiting for you')
  })

  it('shows Compacting… from system/status and the compaction divider', () => {
    const m = mapper()
    m.noteUserMessage('/compact', [])
    m.feed({ type: 'system', subtype: 'status', status: 'compacting' })
    expect(m.state.turn.word).toBe('Compacting…')
    m.feed({ type: 'system', subtype: 'status', status: null })
    m.feed({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 412000, post_tokens: 38000 } })
    expect(of(m, 'notice')[0]).toMatchObject({ source: 'compaction', text: 'Conversation compacted · 412k → 38k' })
  })

  it('sums output tokens of main-thread messages and keeps the final count after the turn', () => {
    const m = mapper()
    m.noteUserMessage('go', [])
    const delta = (id: string, out: number) => ({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: out, input_tokens: 2, cache_read_input_tokens: 1000 } }, parent_tool_use_id: null, api_message_id: id })
    m.feed(delta('a', 120))
    m.feed(delta('b', 80))
    m.feed(delta('b', 100))
    expect(m.state.turn.outputTokens).toBe(220)
    expect(m.state.context?.usedTokens).toBe(1002)
    m.feed({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 4600, total_cost_usd: 0.01, modelUsage: { 'claude-opus-5-5': { contextWindow: 1000000 } } })
    expect(m.state.turn).toMatchObject({ phase: 'idle', outputTokens: 220, elapsedMs: 4600 })
    expect(m.state.context).toMatchObject({ windowTokens: 1_000_000 })
    expect(of(m, 'turn')[0]).toMatchObject({ durationMs: 4600, ok: true })
  })

  it('tileState names the header state', () => {
    const turn = (phase: 'idle' | 'working' | 'waiting' | 'stopped') => ({ ...emptyChatState(1).turn, phase })
    expect(tileState({ process: 'ready', turn: turn('working') })).toBe('Working')
    expect(tileState({ process: 'ready', turn: turn('waiting') })).toBe('Waiting for you')
    expect(tileState({ process: 'ready', turn: turn('idle') })).toBe('Idle')
    expect(tileState({ process: 'stopped', turn: turn('stopped') })).toBe('Stopped')
    expect(tileState({ process: 'crashed', turn: turn('stopped') })).toBe('Crashed')
  })

  it('queues messages sent during a turn until the next turn starts', () => {
    const m = mapper()
    m.noteUserMessage('first', [])
    m.noteUserMessage('second', [])
    expect(of(m, 'user').map((u) => u.queued)).toEqual([false, true])
    m.feed({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 10 })
    m.feed({ type: 'system', subtype: 'status', status: 'requesting' })
    expect(of(m, 'user').map((u) => u.queued)).toEqual([false, false])
  })

  it('reports errors and rate limits', () => {
    const m = mapper()
    m.noteUserMessage('go', [])
    m.feed({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 3, duration_ms: 10, result: '' })
    expect(of(m, 'notice')[0]).toMatchObject({ source: 'error', tone: 'error', text: 'Claude Code stopped: the turn limit was reached' })
    expect(of(m, 'turn')[0]!.ok).toBe(false)
    m.feed({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', utilization: 0.84, rateLimitType: 'seven_day', resetsAt: 5 } })
    expect(m.state.rateLimit).toBeNull()
    m.feed({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', utilization: 0.93, rateLimitType: 'seven_day', resetsAt: 5 } })
    expect(m.state.rateLimit).toMatchObject({ utilization: 0.93, type: 'seven_day' })
  })

  it('ignores unknown and malformed lines', () => {
    const m = mapper()
    expect(m.feed({ type: 'wat' })).toEqual([])
    expect(m.feed('garbage')).toEqual([])
    expect(m.feed({ type: 'stream_event' })).toEqual([])
    expect(m.feed({ type: 'assistant', message: 5 })).toEqual([])
  })
})

describe('sub-agents', () => {
  const agentLines = () => [
    { type: 'assistant', message: { id: 'p1', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'ag1', name: 'Agent', input: { description: 'Check every tile', subagent_type: 'Explore', prompt: 'Look at all tiles' } }] }, parent_tool_use_id: null },
    { type: 'assistant', message: { id: 's1', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'Looking now\nsecond line' }] }, parent_tool_use_id: 'ag1' },
    { type: 'assistant', message: { id: 's2', model: 'claude-haiku-5-5', content: [{ type: 'tool_use', id: 'rd1', name: 'Read', input: { file_path: 'C:\\x\\Tile.tsx' } }] }, parent_tool_use_id: 'ag1' },
  ]

  it('files forwarded sub-agent items under the Agent item and tracks its activity', () => {
    const m = mapper()
    run(m, agentLines())
    const a = of(m, 'subagent')[0] as SubagentItem
    expect(a).toMatchObject({ id: 'ag1', description: 'Check every tile', agentType: 'Explore', prompt: 'Look at all tiles', status: 'running', toolUses: 1, model: 'claude-haiku-5-5' })
    expect(a.latest).toBe('Reading Tile.tsx…')
    expect(itemsOf(m.state, 'ag1').map((i) => i.kind)).toEqual(['text', 'tool'])
    expect(itemsOf(m.state, null).map((i) => i.kind)).toEqual(['subagent'])
    expect(m.state.turn.word).toBe('Agent: Check every tile…')
  })

  it('shows a sub-agent prompt in the main chat and marks the agent waiting', () => {
    const m = mapper()
    run(m, agentLines())
    m.feed({ type: 'control_request', request_id: 'rq', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'npm run typecheck' }, tool_use_id: 'rd1' } })
    const perm = of(m, 'permission')[0]!
    expect(perm.parent).toBe('ag1')
    expect((of(m, 'subagent')[0] as SubagentItem).status).toBe('waiting')
    expect(m.state.turn.pendingLabel).toBe('agent: Bash: npm run typecheck')
    m.answer('rq', { kind: 'allow' })
    expect((of(m, 'subagent')[0] as SubagentItem).status).toBe('running')
  })

  it('finishes with the tool result: agent id, status and result text; background agents keep running', () => {
    const m = mapper()
    run(m, agentLines())
    m.feed({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ag1', content: [{ type: 'text', text: 'All tiles fine.' }] }] }, parent_tool_use_id: null, tool_use_result: { status: 'completed', agentId: 'a123', totalToolUseCount: 4 } })
    expect(of(m, 'subagent')[0]).toMatchObject({ status: 'done', agentId: 'a123', toolUses: 4, result: { text: 'All tiles fine.' } })
    const b = mapper()
    run(b, [{ type: 'assistant', message: { id: 'p', content: [{ type: 'tool_use', id: 'bg', name: 'Agent', input: { description: 'bg', run_in_background: true } }] }, parent_tool_use_id: null }])
    b.feed({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'bg', content: 'launched' }] }, tool_use_result: { status: 'async_launched', agentId: 'bgid', isAsync: true } })
    expect(of(b, 'subagent')[0]).toMatchObject({ status: 'running', background: true, agentId: 'bgid' })
    b.feed({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '<task-notification>\n<tool-use-id>bg</tool-use-id>\n<status>completed</status>\n<summary>Agent "bg" completed</summary>\n</task-notification>' }] } })
    expect(of(b, 'subagent')[0]!.status).toBe('done')
    expect(of(b, 'notice')[0]).toMatchObject({ source: 'background', text: 'Agent "bg" completed' })
  })
})

describe('tool results, diffs and rows', () => {
  it('builds a diff from structuredPatch and falls back to the input', () => {
    const m = mapper()
    m.feed({ type: 'assistant', message: { id: 'e1', model: 'x', content: [{ type: 'tool_use', id: 'ed', name: 'Edit', input: { file_path: 'C:\\a\\b.ts', old_string: 'a', new_string: 'b' } }] }, parent_tool_use_id: null })
    const t = of(m, 'tool')[0] as ToolItem
    expect(t.diff).toMatchObject({ added: 1, removed: 1, created: false })
    m.feed({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'ed', content: 'ok' }] }, tool_use_result: { filePath: 'C:\\a\\b.ts', structuredPatch: [{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 3, lines: [' x', '-a', '+b', '+c'] }] } })
    expect((of(m, 'tool')[0] as ToolItem).diff).toMatchObject({ added: 2, removed: 1, hunks: [{ oldStart: 3 }] })
    expect(diffFromInput('Write', { file_path: 'q.txt', content: 'one\ntwo' })).toMatchObject({ created: true, added: 2 })
    expect(diffFromInput('MultiEdit', { file_path: 'q', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] })).toMatchObject({ added: 2, removed: 2 })
    expect(diffFromInput('Read', { file_path: 'q' })).toBeNull()
  })

  it('marks failed results, truncates long text and keeps image results', () => {
    const m = mapper()
    m.feed({ type: 'assistant', message: { id: 'b1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'x' } }, { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'p.png' } }] }, parent_tool_use_id: null })
    m.feed({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'boom\n'.repeat(10_000) }] } })
    m.feed({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }] } })
    const [t1, t2] = of(m, 'tool') as ToolItem[]
    expect(t1).toMatchObject({ status: 'failed', result: { isError: true, truncated: true, summary: 'boom' } })
    expect(t1!.result!.text.length).toBe(20_000)
    expect(t2!.result!.images).toEqual(['data:image/png;base64,AAAA'])
  })

  it('keeps background shells running until their notification', () => {
    const m = mapper()
    m.feed({ type: 'assistant', message: { id: 'b1', content: [{ type: 'tool_use', id: 'sh', name: 'Bash', input: { command: 'npm run dev', run_in_background: true } }] }, parent_tool_use_id: null })
    m.feed({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'sh', content: 'Command running in background with ID: bx1' }] }, tool_use_result: { backgroundTaskId: 'bx1' } })
    expect(of(m, 'tool')[0]).toMatchObject({ status: 'running', background: true })
    m.feed({ type: 'system', subtype: 'task_notification', tool_use_id: 'sh', status: 'completed', summary: 'Background command completed' })
    expect(of(m, 'tool')[0]!.status).toBe('done')
  })

  it('groups consecutive finished read-only rows only', () => {
    const t = (id: string, name: string, status: ToolItem['status'] = 'done'): ToolItem => ({ kind: 'tool', id, parent: null, name, input: {}, partial: '', summary: '', status, result: null, diff: null, background: false, startedAt: 0, endedAt: 0 })
    const rows = buildRows([t('1', 'Read'), t('2', 'Read'), t('3', 'Grep'), t('4', 'Edit'), t('5', 'Read'), t('6', 'Read', 'running'), t('7', 'Glob')])
    expect(rows.map((r) => r.type)).toEqual(['toolGroup', 'item', 'item', 'item', 'item'])
    expect(rows[0]).toMatchObject({ summary: 'Read 2 files, searched 1 pattern' })
  })

  it('builds tool targets and reads streaming JSON', () => {
    expect(toolTarget('Read', { file_path: 'C:\\a\\b\\TileFrame.tsx' })).toBe('TileFrame.tsx')
    expect(toolTarget('Bash', { command: 'npm test\nsecond' })).toBe('npm test')
    expect(partialJsonString('{"file_path":"C:\\\\a\\\\b.t', 'file_path')).toBe('C:\\a\\b.t')
    expect(partialJsonString('{"fil', 'file_path')).toBeNull()
    expect(partialTarget('Read', '{"file_path":"C:\\\\a\\\\Til')).toBe('')
    expect(partialTarget('Read', '{"file_path":"C:\\\\a\\\\Tile.tsx","limit":5')).toBe('Tile.tsx')
    expect(partialTarget('Bash', '{"command":"npm te')).toBe('npm te')
    expect(permissionOptions([{ type: 'addDirectories', directories: ['x'] }, { type: 'setMode', mode: 'acceptEdits' }, { type: 'weird' }]).map((o) => o.kind)).toEqual(['directory', 'mode', 'other'])
  })
})

describe('context usage mapping (ctx.log)', () => {
  it('maps the recorded response to the eight legend rows and the compaction tick', () => {
    const resp = fixture('ctx').find((l) => l.type === 'control_response' && (l.response as { request_id?: string }).request_id === 'ctx-1')!
    const u = mapContextUsage((resp.response as { response: unknown }).response, 5)!
    expect(u.rows.map((r) => r.id)).toEqual(['system', 'tools', 'mcp', 'agents', 'memory', 'skills', 'messages', 'free'])
    expect(u).toMatchObject({ totalTokens: 27964, maxTokens: 1_000_000, percentage: 3, autoCompactAt: 967_000, model: 'claude-haiku-5-5' })
    expect(u.tickPct).toBeCloseTo(96.7)
    expect(u.rows.find((r) => r.id === 'tools')).toMatchObject({ tokens: 7356, note: '+15.6k deferred, not loaded' })
    expect(u.rows.find((r) => r.id === 'mcp')).toMatchObject({ tokens: 941, note: '+15.8k deferred, not loaded' })
    expect(u.rows.find((r) => r.id === 'free')!.tokens).toBe(939_036)
    const used = u.rows.filter((r) => r.id !== 'free').reduce((a, r) => a + r.tokens, 0)
    expect(used).toBe(u.totalTokens)
    expect(u.deferredTokens).toBe(15829 + 15589)
    expect(u.skills).toMatchObject({ total: 252 })
    expect(u.memoryFiles).toHaveLength(2)
  })

  it('adds unknown categories to other and drops the tick without auto-compaction', () => {
    const u = mapContextUsage({ categories: [{ name: 'Weird', tokens: 10, kind: 'used' }, { name: 'Free space', tokens: 90, kind: 'free' }], totalTokens: 10, maxTokens: 100, percentage: 10, isAutoCompactEnabled: false, autoCompactThreshold: 90 })!
    expect(u.rows.map((r) => r.id)).toEqual(['other', 'free'])
    expect(u.autoCompactAt).toBeNull()
    expect(u.tickPct).toBeNull()
    expect(mapContextUsage({ nope: 1 })).toBeNull()
  })
})

describe('transcripts (history, sidechains)', () => {
  const line = (o: unknown) => JSON.stringify(o)
  const transcript = [
    line({ type: 'permission-mode', permissionMode: 'default', sessionId: 's' }),
    line({ type: 'user', uuid: 'u1', timestamp: '2026-10-09T10:00:00Z', message: { role: 'user', content: 'Fix the bug' } }),
    line({ type: 'user', uuid: 'u0', isMeta: true, message: { role: 'user', content: 'hidden' } }),
    line({ type: 'assistant', uuid: 'a1', message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: '', signature: 'x' }] } }),
    line({ type: 'assistant', uuid: 'a2', message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'On it.' }] } }),
    line({ type: 'assistant', uuid: 'a3', message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: 'C:\\a\\b.ts', old_string: 'x', new_string: 'y' } }] } }),
    line({ type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'done' }] }, toolUseResult: { filePath: 'C:\\a\\b.ts', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-x', '+y'] }] } }),
    line({ type: 'assistant', uuid: 'a4', message: { id: 'm2', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'ag', name: 'Agent', input: { description: 'Explore', prompt: 'p' } }] } }),
    line({ type: 'user', uuid: 'u3', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ag', content: 'found' }] }, toolUseResult: { status: 'completed', agentId: 'abc' } }),
    line({ type: 'assistant', uuid: 'a5', isSidechain: true, message: { id: 'sc', model: 'x', content: [{ type: 'text', text: 'hidden sidechain' }] } }),
    line({ type: 'system', subtype: 'turn_duration', durationMs: 4200, uuid: 'td1' }),
    line({ type: 'user', uuid: 'u4', message: { role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] } }),
    line({ type: 'assistant', uuid: 'a6', message: { id: 'm3', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: { questions: [{ question: 'Red?', header: 'C', multiSelect: false, options: [{ label: 'Red', description: '' }] }] } }] } }),
    line({ type: 'user', uuid: 'u5', message: { role: 'user', content: '<command-name>/context</command-name>\n<command-message>context</command-message>' } }),
    line({ type: 'user', uuid: 'u6', message: { role: 'user', content: '<local-command-stdout>## Context Usage</local-command-stdout>' } }),
    'not json',
  ].join('\n')

  it('rebuilds the conversation in order, skipping meta lines and the main file sidechain lines', () => {
    const items = mapTranscript(transcript, { scratchId: 1 })
    expect(items.map((i) => i.kind)).toEqual(['user', 'thinking', 'text', 'tool', 'subagent', 'turn', 'user', 'question', 'command'])
    expect(items[0]).toMatchObject({ kind: 'user', text: 'Fix the bug' })
    expect((items[3] as ToolItem).status).toBe('done')
    expect((items[3] as ToolItem).diff).toMatchObject({ added: 1, removed: 1 })
    expect(items[4]).toMatchObject({ kind: 'subagent', status: 'done', agentId: 'abc' })
    expect(items[6]).toMatchObject({ kind: 'user', text: 'What is this?', images: [{ mediaType: 'image/png', dataUrl: 'data:image/png;base64,AAAA' }] })
    expect(items[7]).toMatchObject({ kind: 'question', requestId: null, expired: true })
    expect(items[8]).toMatchObject({ kind: 'command', command: '/context', md: '## Context Usage' })
  })

  it('maps a sub-agent sidechain file under its Agent item', () => {
    const side = [
      line({ type: 'user', uuid: 'su1', isSidechain: true, agentId: 'abc', message: { role: 'user', content: 'Explore the tiles' } }),
      line({ type: 'assistant', uuid: 'sa1', isSidechain: true, message: { id: 'sm1', model: 'claude-haiku-5-5', content: [{ type: 'tool_use', id: 'sr1', name: 'Read', input: { file_path: 'x.ts' } }] } }),
      line({ type: 'user', uuid: 'su2', isSidechain: true, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'sr1', content: 'src' }] }, toolUseResult: {} }),
      line({ type: 'assistant', uuid: 'sa2', isSidechain: true, message: { id: 'sm2', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'Done exploring' }] } }),
    ].join('\n')
    const items = mapTranscript(side, { scratchId: 1, forcedParent: 'ag' })
    expect(items.map((i) => [i.kind, 'parent' in i ? i.parent : null])).toEqual([['user', 'ag'], ['tool', 'ag'], ['text', 'ag']])
  })
})

describe('reduceChat', () => {
  it('upserts, appends, removes and merges meta', () => {
    const s0 = emptyChatState(1)
    const item = (id: string, md: string): ChatItem => ({ kind: 'text', id, parent: null, md, streaming: true })
    const s1 = reduceChat(s0, [{ op: 'upsert', item: item('a', 'He') }, { op: 'append', id: 'a', text: 'llo' }, { op: 'upsert', item: item('b', 'x') }, { op: 'meta', patch: { model: 'm' } }])
    expect(s1.items.map((i) => (i.kind === 'text' ? i.md : ''))).toEqual(['Hello', 'x'])
    expect(s1.model).toBe('m')
    const s2 = reduceChat(s1, [{ op: 'remove', id: 'a' }, { op: 'append', id: 'zzz', text: 'ignored' }])
    expect(s2.items.map((i) => i.id)).toEqual(['b'])
    expect(s0.items).toHaveLength(0)
    expect(reduceChat(s2, [])).toBe(s2)
  })
})

describe('keep-warm ping turn', () => {
  it('folds the turn into one row and keeps the reply out of the chat', () => {
    const m = mapper()
    const ops: ChatOp[] = [...m.notePing('Reply with the single word: warm')]
    ops.push(
      ...run(m, [
        { type: 'assistant', message: { id: 'm1', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'warm' }], usage: { input_tokens: 3, output_tokens: 4 } }, parent_tool_use_id: null },
        { type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'warm', duration_ms: 900, total_cost_usd: 0.02, usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 61000, cache_creation_input_tokens: 0 } },
      ]),
    )
    const state = reduceChat(emptyChatState(4), ops)
    expect(state.items.map((i) => i.kind)).toEqual(['notice'])
    const n = state.items[0] as NoticeItem
    expect(n.source).toBe('ping')
    expect(n.ping).toMatchObject({ reply: 'warm', ok: true, running: false, cacheRead: 61000 })
    expect(n.ping!.usd).toBeGreaterThan(0)
    expect(m.state.items.map((i) => i.kind)).toEqual(['notice'])
    expect(m.takePingResult()).toMatchObject({ ok: true, reply: 'warm', cacheRead: 61000 })
    expect(m.takePingResult()).toBeNull()
  })
})
