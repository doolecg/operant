import {
  diffFromInput,
  diffFromResult,
  emptyChatState,
  isAgentTool,
  mapCommands,
  mapModels,
  modelDisplayName,
  partialTarget,
  permissionOptions,
  statusWord,
  stripAnsi,
  toolTarget,
  runningWord,
  type Activity,
  type ChatImage,
  type ChatItem,
  type ChatMeta,
  type ChatOp,
  type ChatState,
  type McpServerInfo,
  type NoticeItem,
  type NoticeSource,
  type PermissionItem,
  type PlanItem,
  type QuestionItem,
  type SubagentItem,
  type ToolItem,
  type ToolResult,
  type ChatDecision,
} from '../shared/claude-chat'
import { costUsd } from './pricing'

// Turns Claude Code's stream-json lines (live stdout) and transcript JSONL lines (history, sub-agent sidechains) into
// ChatItems. One mapper holds one conversation: feed() takes a parsed line and returns the ops it caused; `state` always
// equals the result of applying every returned op to an empty state (the tests check that).

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

const RESULT_TEXT_MAX = 20_000
const IMAGE_MAX = 500_000
const MAX_ITEMS = 2000
const TRIM_TO = 1800

const firstLine = (s: string): string => s.split(/\r?\n/).find((l) => l.trim())?.trim() ?? ''
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export interface MapperOptions {
  scratchId: number
  now?: () => number
  // Transcript mode: user prompts are in the lines, and nothing can be answered.
  history?: boolean
  // Parent given to every item (a sub-agent's sidechain file).
  forcedParent?: string | null
}

type PendingRequest = { id: string; toolUseId: string; toolName: string; input: Rec; suggestions: unknown[]; itemId: string }

interface BlockRef {
  type: 'text' | 'thinking' | 'tool_use'
  itemId: string
  final: boolean
}
interface MsgState {
  blocks: BlockRef[]
  parent: string | null
}

export type ControlKind = 'initialize' | 'context' | 'interrupt' | 'mode' | 'model' | 'other'

export class ChatMapper {
  readonly state: ChatState
  private readonly now: () => number
  private readonly history: boolean
  private readonly forced: string | null | undefined
  private out: ChatOp[] = []
  private readonly byId = new Map<string, ChatItem>()
  private readonly msgs = new Map<string, MsgState>()
  private readonly pending = new Map<string, PendingRequest>()
  private readonly expects = new Map<string, ControlKind>()
  private readonly seenHooks = new Set<string>()
  private readonly msgTokens = new Map<string, number>()
  private readonly agentTokens = new Map<string, Map<string, number>>()
  private readonly agentUsage = new Map<string, Map<string, { input: number; cacheRead: number; cacheWrite: number }>>()
  private seq = 0
  private turnActive = false
  private turnStartedAt: number | null = null
  private turnElapsed = 0
  private lastTurnOut = 0
  private terminalOnly: string[] = []
  private everRan = false
  private compacting = false
  private firstAssistant = false
  private queuedAwaitTurn = false
  private commandName = ''
  private lastPane = ''
  private costBase = 0
  private durationBase = 0
  private durationTotal = 0
  private lastUsage: { input: number; output: number; cacheCreation: number; cacheRead: number } | null = null
  private lastResultCost: number | null = null
  private statusDirty = false
  // A keep-warm ping turn in flight: its notice row, and the main-thread items of the turn that stay out of the chat.
  private ping: { id: string; hidden: Set<string> } | null = null
  private pingDone: { ok: boolean; reply: string; cacheRead: number; tokens: number; usd: number | null } | null = null

  constructor(opts: MapperOptions) {
    this.state = emptyChatState(opts.scratchId)
    this.now = opts.now ?? Date.now
    this.history = opts.history === true
    this.forced = opts.forcedParent
  }

  // ---------------------------------------------------------------- public API

  get items(): ChatItem[] {
    return this.state.items
  }

  // Registers what the next control_response with this request id answers.
  expect(requestId: string, kind: ControlKind): void {
    this.expects.set(requestId, kind)
  }

  // A new Claude Code process starts for this session: the cost and time of the earlier ones are the base its own
  // (per process) totals are added to.
  startProcess(costUsd: number, durationMs: number): ChatOp[] {
    this.costBase = costUsd
    this.durationBase = durationMs
    this.durationTotal = 0
    this.lastResultCost = null
    if (costUsd > 0) this.meta({ costUsd, durationMs })
    return this.drain()
  }

  // A local command typed without a bubble (/effort): its synthetic reply becomes a notice instead of a command card.
  noteCommand(name: string): void {
    this.commandName = name
  }

  // What the synthesised status file needs (null before any usage was seen).
  statusSnapshot(): { model: string | null; modelDisplayName: string | null; usage: { input: number; output: number; cacheCreation: number; cacheRead: number } | null; windowTokens: number | null; usedPercentage: number | null; costUsd: number | null; durationMs: number | null } {
    const c = this.state.context
    return {
      model: this.state.model,
      modelDisplayName: this.state.modelDisplayName,
      usage: this.lastUsage,
      windowTokens: c?.windowTokens ?? null,
      usedPercentage: c?.percentage ?? null,
      costUsd: this.lastResultCost === null ? (this.costBase > 0 ? this.costBase : null) : this.costBase + this.lastResultCost,
      durationMs: this.lastResultCost === null && this.durationBase === 0 ? null : this.durationBase + this.durationTotal,
    }
  }

  // True once after something the status file shows changed.
  takeStatusDirty(): boolean {
    const d = this.statusDirty
    this.statusDirty = false
    return d
  }

  // The tile's process state (set by ChatProcess).
  setProcess(process: ChatState['process']): ChatOp[] {
    if (process === 'starting' || process === 'ready') this.everRan = true
    this.meta({ process })
    this.refreshTurn()
    return this.drain()
  }

  setSession(sessionId: string): ChatOp[] {
    this.meta({ sessionId })
    return this.drain()
  }

  setEffort(effort: string | null): ChatOp[] {
    this.meta({ effort })
    return this.drain()
  }

  setBypassAllowed(v: boolean): ChatOp[] {
    this.meta({ bypassAllowed: v })
    return this.drain()
  }

  setContextUsage(c: ChatState['contextUsage']): ChatOp[] {
    this.meta({ contextUsage: c })
    return this.drain()
  }

  // Operant's keep-warm message: one compact row instead of a bubble, a reply and a "Done" line.
  notePing(prompt: string): ChatOp[] {
    const id = `ping:${this.now()}:${this.seq++}`
    this.addItem<NoticeItem>({ kind: 'notice', id, parent: null, source: 'ping', tone: 'info', text: prompt, ping: { reply: '', ok: true, running: true, cacheRead: 0, usd: null }, at: this.now() })
    this.ping = { id, hidden: new Set() }
    this.pingDone = null
    this.commandName = ''
    this.beginTurn()
    this.refreshTurn()
    return this.drain()
  }

  // The finished ping's numbers, once.
  takePingResult(): { ok: boolean; reply: string; cacheRead: number; tokens: number; usd: number | null } | null {
    const r = this.pingDone
    this.pingDone = null
    return r
  }

  setKeepWarm(v: ChatState['keepWarm']): ChatOp[] {
    this.meta({ keepWarm: v })
    return this.drain()
  }

  // Ids of items that never reach the renderer (the reply and the end line of a ping).
  hiddenIds(): Set<string> {
    return this.ping?.hidden ?? new Set()
  }

  // The owner sent a message: shows the bubble at once (queued when a turn is running).
  // `read`: Claude reads it right away (a plan denial's comment), so it never shows the Queued tag.
  noteUserMessage(text: string, images: ChatImage[], read = false): ChatOp[] {
    const queued = this.turnActive && !read
    const id = `u:${this.now()}:${this.seq++}`
    this.addItem({ kind: 'user', id, parent: null, text, images, queued, at: this.now() })
    if (queued) this.queuedAwaitTurn = false
    this.commandName = text.startsWith('/') ? text.split(/\s+/)[0]! : ''
    this.beginTurn()
    this.refreshTurn()
    return this.drain()
  }

  private beginTurn(): void {
    if (this.turnActive) return
    this.turnActive = true
    this.turnStartedAt = this.now()
    this.msgTokens.clear()
    this.lastTurnOut = 0
  }

  // A notice raised by the process layer (crash, restart limits, refused requests).
  noteNotice(n: Omit<NoticeItem, 'kind' | 'id' | 'parent' | 'at'>): ChatOp[] {
    this.notice(n.source, n.tone, n.text, n.detail, n.actions)
    return this.drain()
  }

  // The process ended or was stopped: nothing can be answered, running tools did not finish.
  noteProcessGone(): ChatOp[] {
    if (this.ping) {
      this.finishPing({}, false)
      this.pingDone = null
    }
    this.expireAll()
    this.markInterrupted()
    this.turnActive = false
    this.turnStartedAt = null
    this.compacting = false
    this.refreshTurn()
    return this.drain()
  }

  // The owner pressed Stop and Claude Code did not answer in time: end the turn locally.
  noteInterruptForced(): ChatOp[] {
    this.markInterrupted()
    this.expireAll()
    this.turnActive = false
    this.turnStartedAt = null
    this.notice('interrupt', 'warn', 'Interrupted')
    this.refreshTurn()
    return this.drain()
  }

  // Answers a pending prompt: marks the item and returns the body of the control_response (null: unknown request).
  answer(requestId: string, decision: ChatDecision): { body: Rec } | null {
    const p = this.pending.get(requestId)
    if (!p) return null
    const item = this.byId.get(p.itemId)
    let body: Rec | null = null
    if (item?.kind === 'permission') {
      if (decision.kind === 'allow') {
        body = { behavior: 'allow', updatedInput: p.input }
        this.patch(item, { answer: 'once' })
      } else if (decision.kind === 'always') {
        const s = p.suggestions[decision.index]
        body = s ? { behavior: 'allow', updatedInput: p.input, updatedPermissions: [s] } : { behavior: 'allow', updatedInput: p.input }
        this.patch(item, { answer: 'always' })
      } else if (decision.kind === 'deny') {
        const message = decision.message?.trim() || 'The user denied this.'
        body = { behavior: 'deny', message }
        this.patch(item, { answer: 'denied', denyMessage: message })
      }
    } else if (item?.kind === 'question' && decision.kind === 'answer') {
      body = { behavior: 'allow', updatedInput: { ...p.input, answers: decision.answers } }
      this.patch(item, { answers: { ...decision.answers } })
    } else if (item?.kind === 'plan' && decision.kind === 'plan') {
      if (decision.approve === 'keep') {
        body = { behavior: 'deny', message: decision.message?.trim() || 'The user wants to keep planning.' }
        this.patch(item, { answer: 'kept' })
      } else {
        body = { behavior: 'allow', updatedInput: p.input, ...(decision.approve === 'approve-edits' ? { updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] } : {}) }
        this.patch(item, { answer: decision.approve === 'approve-edits' ? 'approved-edits' : 'approved' })
      }
    }
    if (!body) return null
    this.pending.delete(requestId)
    this.refreshAgents()
    this.refreshTurn()
    return { body }
  }

  // The request id of a plan waiting for the owner's answer, if any.
  pendingPlanRequest(): string | null {
    for (const it of this.state.items) if (it.kind === 'plan' && it.requestId !== null && it.answer === null && this.pending.has(it.requestId)) return it.requestId
    return null
  }

  hasPending(requestId?: string): boolean {
    return requestId === undefined ? this.pending.size > 0 : this.pending.has(requestId)
  }

  // Replaces the conversation (history load).
  load(items: ChatItem[], historyStart: number, hasEarlier: boolean): ChatOp[] {
    this.byId.clear()
    this.state.items.length = 0
    for (const it of items) {
      this.state.items.push(it)
      this.byId.set(it.id, it)
    }
    this.meta({ historyStart, hasEarlier })
    return this.drain()
  }

  prepend(items: ChatItem[], historyStart: number): void {
    const fresh = items.filter((it) => !this.byId.has(it.id))
    this.state.items.unshift(...fresh)
    for (const it of fresh) this.byId.set(it.id, it)
    this.state.historyStart = historyStart
    this.state.hasEarlier = historyStart > 0
  }

  // Marks unanswered prompts of a loaded transcript as expired (nobody is listening) and ends running rows.
  finishHistory(): void {
    this.expireAll()
    for (const it of this.state.items) {
      if (it.kind === 'tool' && (it.status === 'running' || it.status === 'preparing')) it.status = it.background ? 'done' : 'interrupted'
      if (it.kind === 'subagent' && it.status === 'running') it.status = it.background ? 'done' : 'interrupted'
      if (it.kind === 'text') it.streaming = false
      if (it.kind === 'question' && it.answers === null) it.expired = true
      if (it.kind === 'plan' && it.answer === null) it.answer = 'expired'
    }
    this.out = []
  }

  // One parsed line (stream-json or transcript). Never throws on unknown shapes.
  feed(line: unknown): ChatOp[] {
    const o = rec(line)
    try {
      switch (o.type) {
        case 'stream_event':
          this.onStream(o)
          break
        case 'assistant':
          this.onAssistant(o)
          break
        case 'user':
          this.onUser(o)
          break
        case 'system':
          this.onSystem(o)
          break
        case 'result':
          this.onResult(o)
          break
        case 'control_request':
          this.onControlRequest(o)
          break
        case 'control_cancel_request':
          this.onCancel(str(o.request_id))
          break
        case 'control_response':
          this.onControlResponse(o)
          break
        case 'rate_limit_event':
          this.onRateLimit(rec(o.rate_limit_info))
          break
        default:
          break
      }
    } catch {
      // A line of an unexpected shape never breaks the conversation.
    }
    this.refreshTurn()
    this.trim()
    return this.drain()
  }

  // ---------------------------------------------------------------- ops plumbing

  private drain(): ChatOp[] {
    const o = this.out
    this.out = []
    return o
  }

  private meta(patch: Partial<ChatMeta>): void {
    const changed: Partial<ChatMeta> = {}
    for (const k of Object.keys(patch) as Array<keyof ChatMeta>) {
      if (JSON.stringify(this.state[k]) !== JSON.stringify(patch[k])) (changed as Record<string, unknown>)[k] = patch[k]
    }
    if (!Object.keys(changed).length) return
    Object.assign(this.state, changed)
    this.out.push({ op: 'meta', patch: changed })
  }

  private addItem<T extends ChatItem>(item: T): T {
    this.state.items.push(item)
    this.byId.set(item.id, item)
    if (this.ping && item.id !== this.ping.id && (item.kind === 'text' || item.kind === 'thinking' || item.kind === 'turn') && ('parent' in item ? item.parent : null) === null) this.ping.hidden.add(item.id)
    else this.out.push({ op: 'upsert', item: { ...item } })
    return item
  }

  private emit(item: ChatItem): void {
    if (this.ping?.hidden.has(item.id)) return
    this.out.push({ op: 'upsert', item: { ...item } })
  }

  private patch<T extends ChatItem>(item: T, p: Partial<T>): void {
    Object.assign(item, p)
    this.emit(item)
  }

  private append(item: ChatItem, text: string): void {
    if (!text) return
    if (item.kind === 'text' || item.kind === 'command') item.md += text
    else if (item.kind === 'thinking') item.text += text
    else if (item.kind === 'tool') item.partial += text
    if (this.ping?.hidden.has(item.id)) return
    this.out.push({ op: 'append', id: item.id, text })
  }

  private notice(source: NoticeSource, tone: NoticeItem['tone'], text: string, detail?: string, actions?: NoticeItem['actions'], parent: string | null = null, tag?: Pick<NoticeItem, 'category' | 'origin'>): void {
    this.addItem<NoticeItem>({ kind: 'notice', id: `n:${this.now()}:${this.seq++}`, parent, source, tone, text, ...(tag?.category ? tag : {}), ...(detail ? { detail } : {}), ...(actions?.length ? { actions } : {}), at: this.now() })
  }

  private trim(): void {
    const items = this.state.items
    if (items.length <= MAX_ITEMS) return
    const drop = items.splice(0, items.length - TRIM_TO)
    for (const it of drop) {
      this.byId.delete(it.id)
      this.out.push({ op: 'remove', id: it.id })
    }
    this.meta({ hasEarlier: true })
  }

  // ---------------------------------------------------------------- turn status

  private parentOf(o: Rec): string | null {
    if (this.forced !== undefined) return this.forced
    const p = o.parent_tool_use_id
    return typeof p === 'string' && p ? p : null
  }

  private activity(): Activity {
    let tool: Activity['tool'] = null
    let thinking = false
    let writing = false
    for (let i = this.state.items.length - 1; i >= 0 && i > this.state.items.length - 60; i--) {
      const it = this.state.items[i]!
      if ('parent' in it && it.parent !== null) continue
      if (it.kind === 'tool' && (it.status === 'running' || it.status === 'preparing') && !tool) tool = { name: it.name, input: it.status === 'preparing' ? { description: it.summary, file_path: it.summary, command: it.summary, pattern: it.summary, url: it.summary, query: it.summary } : it.input }
      else if (it.kind === 'subagent' && (it.status === 'running' || it.status === 'waiting') && !it.background && !tool) tool = { name: 'Agent', input: { description: it.description } }
      else if (it.kind === 'thinking' && it.endedAt === null) thinking = true
      else if (it.kind === 'text' && it.streaming) writing = true
    }
    return { pending: this.pendingCount(), compacting: this.compacting, tool, thinking, writing }
  }

  private sumTokens(): number {
    let sum = 0
    for (const v of this.msgTokens.values()) sum += v
    return sum
  }

  private pendingCount(): number {
    return this.pending.size
  }

  private pendingLabel(): string | null {
    const first = this.pending.values().next().value as PendingRequest | undefined
    if (!first) return null
    const item = this.byId.get(first.itemId)
    if (item?.kind === 'question') return 'question'
    if (item?.kind === 'plan') return 'plan approval'
    const agent = item?.kind === 'permission' && item.parent ? this.byId.get(item.parent) : null
    const t = item?.kind === 'permission' ? `${item.displayName}${item.summary ? `: ${item.summary}` : ''}` : first.toolName
    return `${agent?.kind === 'subagent' ? 'agent: ' : ''}${clip(t, 80)}`
  }

  private refreshTurn(): void {
    const a = this.activity()
    let phase: ChatState['turn']['phase'] = this.turnActive ? 'working' : 'idle'
    if (a.pending > 0) phase = 'waiting'
    const down = this.state.process === 'crashed' || this.state.process === 'blocked' || (this.state.process === 'stopped' && this.everRan)
    if (down) phase = a.pending > 0 ? 'waiting' : 'stopped'
    const word = phase === 'working' || phase === 'waiting' ? statusWord(a) : ''
    this.meta({
      turn: {
        phase,
        word,
        startedAt: phase === 'working' || phase === 'waiting' ? (this.turnStartedAt ?? this.now()) : null,
        elapsedMs: this.turnElapsed,
        outputTokens: this.turnActive ? this.sumTokens() : this.lastTurnOut,
        pendingCount: a.pending,
        pendingLabel: this.pendingLabel(),
      },
    })
  }

  // ---------------------------------------------------------------- blocks

  private msg(parent: string | null, id: string): MsgState {
    const key = `${parent ?? ''}|${id}`
    let m = this.msgs.get(key)
    if (!m) {
      m = { blocks: [], parent }
      this.msgs.set(key, m)
    }
    return m
  }

  private newToolItem(id: string, parent: string | null, name: string, input: unknown, status: ToolItem['status']): ToolItem | SubagentItem {
    const t = this.now()
    const inp = rec(input)
    if (isAgentTool(name)) {
      return {
        kind: 'subagent',
        id,
        parent,
        description: str(inp.description) || firstLine(str(inp.prompt)) || 'Agent',
        agentType: str(inp.subagent_type) || null,
        prompt: str(inp.prompt),
        model: null,
        ...(str(inp.effort) || str(inp.reasoning_effort) ? { effort: str(inp.effort) || str(inp.reasoning_effort) } : {}),
        agentId: null,
        background: inp.run_in_background === true,
        status: 'running',
        latest: '',
        toolUses: 0,
        outputTokens: 0,
        startedAt: t,
        endedAt: null,
        result: null,
      }
    }
    return {
      kind: 'tool',
      id,
      parent,
      name,
      input,
      partial: '',
      summary: toolTarget(name, input),
      status,
      result: null,
      diff: name === 'Edit' || name === 'MultiEdit' || name === 'Write' || name === 'NotebookEdit' ? diffFromInput(name, input) : null,
      background: inp.run_in_background === true,
      startedAt: t,
      endedAt: null,
    }
  }

  private agentOf(parent: string | null): SubagentItem | null {
    const a = parent ? this.byId.get(parent) : null
    return a?.kind === 'subagent' ? a : null
  }

  private touchAgent(parent: string | null, p: { latest?: string; tool?: boolean; model?: string }): void {
    const a = this.agentOf(parent)
    if (!a) return
    const next: Partial<SubagentItem> = {}
    if (p.latest && p.latest !== a.latest) next.latest = p.latest
    if (p.tool) next.toolUses = a.toolUses + 1
    if (p.model && !a.model) next.model = p.model
    if (Object.keys(next).length) this.patch(a, next)
  }

  private refreshAgents(): void {
    const waiting = new Set<string>()
    for (const p of this.pending.values()) {
      const it = this.byId.get(p.itemId)
      if (it && 'parent' in it && it.parent) waiting.add(it.parent)
    }
    for (const it of this.state.items) {
      if (it.kind !== 'subagent') continue
      if (waiting.has(it.id) && it.status === 'running') this.patch(it, { status: 'waiting' })
      else if (!waiting.has(it.id) && it.status === 'waiting') this.patch(it, { status: 'running' })
    }
  }

  private startTool(id: string, parent: string | null, name: string, input: unknown, status: ToolItem['status']): ChatItem | null {
    if (name === 'AskUserQuestion' || name === 'ExitPlanMode') return this.ensurePrompt(id, parent, name, rec(input))
    const existing = this.byId.get(id)
    if (existing) return existing
    const item = this.addItem(this.newToolItem(id, parent, name, input, status))
    if (item.kind === 'tool') {
      this.touchAgent(parent, { latest: runningWord(name, input), tool: true })
    }
    return item
  }

  private ensurePrompt(toolUseId: string, parent: string | null, name: string, input: Rec): QuestionItem | PlanItem {
    const id = name === 'AskUserQuestion' ? `ask:${toolUseId}` : `plan:${toolUseId}`
    const have = this.byId.get(id)
    if (have && (have.kind === 'question' || have.kind === 'plan')) return have
    if (name === 'AskUserQuestion') {
      return this.addItem<QuestionItem>({
        kind: 'question',
        id,
        requestId: null,
        toolUseId,
        parent,
        questions: arr(input.questions).map((q) => {
          const x = rec(q)
          return {
            question: str(x.question),
            header: str(x.header),
            multiSelect: x.multiSelect === true,
            options: arr(x.options).map((op) => ({ label: str(rec(op).label), description: str(rec(op).description) })),
          }
        }),
        answers: null,
        expired: false,
        at: this.now(),
      })
    }
    return this.addItem<PlanItem>({ kind: 'plan', id, requestId: null, toolUseId, parent, plan: str(input.plan), answer: null, at: this.now() })
  }

  // ---------------------------------------------------------------- stream events

  private noteMainMessage(parent: string | null, model: string, synthetic: boolean): void {
    if (synthetic) return
    if (parent === null) {
      this.firstAssistant = true
      if (model) this.meta({ model, modelDisplayName: modelDisplayName(this.state.models, model) })
    } else this.touchAgent(parent, { model })
  }

  private noteUsage(parent: string | null, msgId: string, usage: Rec, final: boolean): void {
    const out = num(usage.output_tokens)
    if (out !== undefined) {
      if (parent === null) {
        this.msgTokens.set(msgId, out)
      } else {
        let m = this.agentTokens.get(parent)
        if (!m) this.agentTokens.set(parent, (m = new Map()))
        m.set(msgId, out)
        let sum = 0
        for (const v of m.values()) sum += v
        const a = this.agentOf(parent)
        if (a && a.outputTokens !== sum) this.patch(a, { outputTokens: sum })
      }
    }
    const input = num(usage.input_tokens) ?? 0
    const cc = num(usage.cache_creation_input_tokens) ?? 0
    const cr = num(usage.cache_read_input_tokens) ?? 0
    if (parent !== null) {
      const ctx = input + cc + cr
      const a = this.agentOf(parent)
      if (a && ctx > 0 && a.contextTokens !== ctx) this.patch(a, { contextTokens: ctx })
      if (a && ctx > 0) {
        let m = this.agentUsage.get(parent)
        if (!m) this.agentUsage.set(parent, (m = new Map()))
        m.set(msgId, { input, cacheRead: cr, cacheWrite: cc })
        const sum = { input: 0, cacheRead: 0, cacheWrite: 0 }
        for (const v of m.values()) {
          sum.input += v.input
          sum.cacheRead += v.cacheRead
          sum.cacheWrite += v.cacheWrite
        }
        this.patch(a, { usage: sum })
      }
      return
    }
    if (input + cc + cr === 0 && !final) return
    if (input + cc + cr === 0) return
    this.lastUsage = { input, output: out ?? 0, cacheCreation: cc, cacheRead: cr }
    const used = input + cc + cr
    const window = this.state.context?.windowTokens ?? null
    this.meta({ context: { usedTokens: used, windowTokens: window, percentage: window ? Math.min(100, (used / window) * 100) : null } })
    this.statusDirty = true
  }

  private onStream(o: Rec): void {
    const parent = this.parentOf(o)
    const e = rec(o.event)
    const apiId = str(o.api_message_id)
    switch (e.type) {
      case 'message_start': {
        const m = rec(e.message)
        const id = str(m.id) || apiId
        this.msg(parent, id)
        if (parent === null) this.beginTurn()
        this.noteMainMessage(parent, str(m.model), str(m.model) === '<synthetic>')
        this.noteUsage(parent, id, rec(m.usage), false)
        break
      }
      case 'content_block_start': {
        const id = apiId
        const ms = this.msg(parent, id)
        const cb = rec(e.content_block)
        const index = num(e.index) ?? ms.blocks.length
        const itemId = `${id}:${index}`
        if (cb.type === 'text') {
          this.addItem({ kind: 'text', id: itemId, parent, md: '', streaming: true })
          ms.blocks[index] = { type: 'text', itemId, final: false }
          this.touchAgent(parent, {})
        } else if (cb.type === 'thinking') {
          this.addItem({ kind: 'thinking', id: itemId, parent, tokens: null, text: '', startedAt: this.now(), endedAt: null })
          ms.blocks[index] = { type: 'thinking', itemId, final: false }
        } else if (cb.type === 'tool_use') {
          const tid = str(cb.id)
          this.startTool(tid, parent, str(cb.name), rec(cb.input), 'preparing')
          ms.blocks[index] = { type: 'tool_use', itemId: tid, final: false }
        }
        break
      }
      case 'content_block_delta': {
        const ms = this.msg(parent, apiId)
        const ref = ms.blocks[num(e.index) ?? -1]
        const item = ref ? this.byId.get(ref.itemId) : undefined
        const d = rec(e.delta)
        if (!item) break
        if (d.type === 'text_delta' && item.kind === 'text') this.append(item, str(d.text))
        else if (d.type === 'thinking_delta' && item.kind === 'thinking') this.append(item, str(d.thinking))
        else if (d.type === 'input_json_delta' && item.kind === 'tool') {
          this.append(item, str(d.partial_json))
          const target = partialTarget(item.name, item.partial)
          if (target && target !== item.summary) this.patch(item, { summary: target })
        }
        break
      }
      case 'content_block_stop': {
        const ms = this.msg(parent, apiId)
        const ref = ms.blocks[num(e.index) ?? -1]
        const item = ref ? this.byId.get(ref.itemId) : undefined
        if (item?.kind === 'text' && item.streaming) this.patch(item, { streaming: false })
        else if (item?.kind === 'thinking' && item.endedAt === null) this.patch(item, { endedAt: this.now() })
        break
      }
      case 'message_delta':
        this.noteUsage(parent, apiId, rec(e.usage), true)
        break
      default:
        break
    }
  }

  private onAssistant(o: Rec): void {
    if (!o.message || typeof o.message !== 'object') return
    const parent = this.parentOf(o)
    const m = rec(o.message)
    const model = str(m.model)
    const content = arr(m.content)
    const synthetic = model === '<synthetic>'
    const msgId = str(m.id) || `a:${this.seq++}`
    if (synthetic) {
      const text = content
        .map((c) => (rec(c).type === 'text' ? str(rec(c).text) : ''))
        .join('')
        .trim()
      if (o.error || o.isApiErrorMessage === true) {
        this.notice('error', 'error', text || str(o.error) || 'Claude Code reported an error', undefined, undefined, parent)
        return
      }
      this.onLocalOutput(msgId, text, o)
      return
    }
    this.noteMainMessage(parent, model, false)
    if (parent === null && !this.history) this.beginTurn()
    const ms = this.msg(parent, msgId)
    for (const b of content) {
      const c = rec(b)
      const type = c.type === 'text' || c.type === 'thinking' || c.type === 'tool_use' ? (c.type as BlockRef['type']) : null
      if (!type) continue
      let ref: BlockRef | undefined
      if (type === 'tool_use') ref = ms.blocks.find((r) => r && r.type === type && r.itemId === str(c.id))
      else ref = ms.blocks.find((r) => r && r.type === type && !r.final)
      if (type === 'text') {
        const text = str(c.text)
        if (!ref && !text.trim()) continue
        if (!ref) {
          const id = `${msgId}:${ms.blocks.length}`
          this.addItem({ kind: 'text', id, parent, md: text, streaming: false })
          ms.blocks.push({ type, itemId: id, final: true })
          this.touchAgent(parent, { latest: firstLine(text) })
        } else {
          const item = this.byId.get(ref.itemId)
          if (item?.kind === 'text') this.patch(item, { md: text, streaming: false })
          ref.final = true
          this.touchAgent(parent, { latest: firstLine(text) })
        }
      } else if (type === 'thinking') {
        if (!ref) {
          const id = `${msgId}:${ms.blocks.length}`
          const think = str(c.thinking)
          const ms0 = this.now()
          this.addItem({ kind: 'thinking', id, parent, tokens: null, text: think, startedAt: ms0, endedAt: ms0 })
          ms.blocks.push({ type, itemId: id, final: true })
        } else {
          const item = this.byId.get(ref.itemId)
          if (item?.kind === 'thinking') this.patch(item, { text: str(c.thinking) || item.text, endedAt: item.endedAt ?? this.now() })
          ref.final = true
        }
      } else {
        const id = str(c.id)
        const input = rec(c.input)
        const item = this.startTool(id, parent, str(c.name), input, 'running')
        if (!ref) ms.blocks.push({ type, itemId: id, final: true })
        else ref.final = true
        if (item?.kind === 'tool') {
          const next: Partial<ToolItem> = { input, summary: toolTarget(item.name, input) || item.summary, partial: '' }
          if (item.status === 'preparing') next.status = 'running'
          if (!item.diff && (item.name === 'Edit' || item.name === 'MultiEdit' || item.name === 'Write')) next.diff = diffFromInput(item.name, input)
          if (rec(input).run_in_background === true) next.background = true
          this.patch(item, next)
          this.touchAgent(parent, { latest: runningWord(item.name, input) })
        } else if (item?.kind === 'subagent') {
          this.patch(item, {
            description: str(input.description) || firstLine(str(input.prompt)) || item.description,
            agentType: str(input.subagent_type) || item.agentType,
            prompt: str(input.prompt) || item.prompt,
            background: input.run_in_background === true,
          })
        } else if (item?.kind === 'question') {
          this.patch(item, { questions: this.ensureQuestions(input, item) })
        } else if (item?.kind === 'plan') {
          this.patch(item, { plan: str(input.plan) || item.plan })
        }
      }
    }
    if (m.usage) this.noteUsage(parent, msgId, rec(m.usage), false)
  }

  private ensureQuestions(input: Rec, item: QuestionItem): QuestionItem['questions'] {
    if (!arr(input.questions).length) return item.questions
    return arr(input.questions).map((q) => {
      const x = rec(q)
      return {
        question: str(x.question),
        header: str(x.header),
        multiSelect: x.multiSelect === true,
        options: arr(x.options).map((op) => ({ label: str(rec(op).label), description: str(rec(op).description) })),
      }
    })
  }

  // Output of a local slash command (a synthetic assistant message).
  private onLocalOutput(msgId: string, text: string, o: Rec): void {
    const raw = str(o.local_command_source)
    const body = (/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(raw)?.[1] ?? text).trim()
    if (!body) return
    this.localOutput(msgId, this.commandName || '', body)
  }

  private localOutput(id: string, command: string, body: string): void {
    if (command.startsWith('/effort')) {
      const m = /effort level to (\w+)/i.exec(body)
      if (m) {
        const level = m[1]!.toLowerCase()
        this.meta({ effort: level })
        this.notice('effort', 'info', `Effort set to ${level.charAt(0).toUpperCase()}${level.slice(1)} (this session)`)
        return
      }
    }
    if (this.byId.has(`cmd:${id}`)) return
    this.addItem({ kind: 'command', id: `cmd:${id}`, command, md: body, at: this.now() })
  }

  // ---------------------------------------------------------------- user lines

  private resultOf(content: unknown, toolUseResult: unknown): ToolResult {
    let text = ''
    const images: string[] = []
    if (typeof content === 'string') text = content
    else {
      const parts: string[] = []
      for (const c of arr(content)) {
        const x = rec(c)
        if (x.type === 'text') parts.push(str(x.text))
        else if (x.type === 'image') {
          const src = rec(x.source)
          const data = str(src.data)
          if (data && data.length <= IMAGE_MAX && images.length < 2) images.push(`data:${str(src.media_type) || 'image/png'};base64,${data}`)
        }
      }
      text = parts.join('\n')
    }
    void toolUseResult
    const truncated = text.length > RESULT_TEXT_MAX
    return { text: truncated ? text.slice(0, RESULT_TEXT_MAX) : text, summary: clip(firstLine(text), 140), isError: false, truncated, images }
  }

  private finishTool(c: Rec, o: Rec): void {
    const id = str(c.tool_use_id)
    const item = this.byId.get(id)
    const tur = o.tool_use_result ?? o.toolUseResult
    const meta0 = arr(o.tool_result_meta).find((x) => str(rec(x).id) === id) as Rec | undefined
    const decision = rec(rec(meta0).permission_decision)
    const rejected = decision.decision === 'reject'
    const isError = c.is_error === true
    const result = this.resultOf(c.content, tur)
    result.isError = isError
    if (item?.kind === 'question') {
      const answers = rec(rec(tur).answers)
      const given = Object.keys(answers).length ? Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, String(v)])) : (item.answers ?? {})
      this.patch(item, rejected || isError ? { expired: item.answers === null } : { answers: given })
      return
    }
    if (item?.kind === 'plan') {
      this.patch(item, { answer: item.answer ?? (rejected || isError ? 'kept' : 'approved') })
      return
    }
    if (item?.kind === 'subagent') {
      const r = rec(tur)
      const status = str(r.status)
      const launched = status === 'async_launched' || r.isAsync === true
      const next: Partial<SubagentItem> = { result, agentId: str(r.agentId) || str(r.agent_id) || item.agentId }
      if (str(r.resolvedModel) && !item.model) next.model = str(r.resolvedModel)
      if (num(r.totalToolUseCount) !== undefined) next.toolUses = num(r.totalToolUseCount)!
      if (launched) {
        next.background = true
        next.status = 'running'
      } else {
        next.status = rejected || isError || status === 'failed' ? 'failed' : 'done'
        next.endedAt = this.now()
        next.latest = ''
      }
      this.patch(item, next)
      this.refreshAgents()
      return
    }
    if (item?.kind !== 'tool') return
    const next: Partial<ToolItem> = { result, endedAt: this.now() }
    next.status = rejected ? 'denied' : isError ? 'failed' : 'done'
    if (item.background && !isError && !rejected && (rec(tur).backgroundTaskId !== undefined || /background/i.test(result.summary))) {
      next.status = 'running'
      next.endedAt = null
    }
    const diff = diffFromResult(item.input, tur)
    if (diff) next.diff = diff
    if (decision.decision === 'accept') {
      const src = str(decision.source)
      const reason = str(decision.reason_type)
      if (reason === 'rule' || src === 'user_permanent' || src === 'config') next.autoAllowed = 'rule'
      else if (reason === 'mode' || src === 'mode') next.autoAllowed = 'mode'
    }
    const hookBlock = str(rec(tur).blockedByHook) || (str(rec(meta0).non_execution_kind) === 'hook' ? result.summary : '')
    if (hookBlock) next.blockedByHook = hookBlock
    this.patch(item, next)
  }

  private markInterrupted(): void {
    for (const it of this.state.items) {
      if (it.kind === 'tool' && (it.status === 'running' || it.status === 'preparing') && !it.background) this.patch(it, { status: 'interrupted', endedAt: this.now() })
      else if (it.kind === 'subagent' && (it.status === 'running' || it.status === 'waiting') && !it.background) this.patch(it, { status: 'interrupted', endedAt: this.now() })
      else if (it.kind === 'text' && it.streaming) this.patch(it, { streaming: false })
      else if (it.kind === 'thinking' && it.endedAt === null) this.patch(it, { endedAt: this.now() })
    }
  }

  private expireAll(): void {
    for (const p of this.pending.values()) {
      const it = this.byId.get(p.itemId)
      if (it?.kind === 'permission') this.patch(it, { answer: 'expired' })
      else if (it?.kind === 'question') this.patch(it, { expired: true })
      else if (it?.kind === 'plan') this.patch(it, { answer: 'expired' })
    }
    this.pending.clear()
    this.refreshAgents()
  }

  private userImages(content: unknown[]): ChatImage[] {
    const out: ChatImage[] = []
    for (const c of content) {
      const x = rec(c)
      if (x.type !== 'image') continue
      const s = rec(x.source)
      if (s.type === 'base64' && str(s.data)) out.push({ mediaType: str(s.media_type) || 'image/png', dataUrl: `data:${str(s.media_type) || 'image/png'};base64,${str(s.data)}` })
    }
    return out
  }

  private onUser(o: Rec): void {
    const parent = this.parentOf(o)
    const m = rec(o.message)
    const at = Date.parse(str(o.timestamp)) || this.now()
    if (o.isMeta === true) return
    const content = m.content
    if (typeof content === 'string') {
      this.userText(o, parent, content, [], at)
      return
    }
    const blocks = arr(content)
    for (const b of blocks) if (rec(b).type === 'tool_result') this.finishTool(rec(b), o)
    const texts = blocks.filter((b) => rec(b).type === 'text').map((b) => str(rec(b).text))
    const images = this.userImages(blocks)
    if (blocks.some((b) => rec(b).type === 'tool_result') && !texts.length) return
    if (texts.length || images.length) this.userText(o, parent, texts.join('\n'), images, at)
  }

  private userText(o: Rec, parent: string | null, text: string, images: ChatImage[], at: number): void {
    const t = text.trim()
    if (t.startsWith('[Request interrupted by user')) {
      this.markInterrupted()
      this.notice('interrupt', 'info', 'Interrupted')
      return
    }
    if (o.isCompactSummary === true) {
      const last = [...this.state.items].reverse().find((i) => i.kind === 'notice' && i.source === 'compaction') as NoticeItem | undefined
      if (last) this.patch(last, { detail: t })
      return
    }
    if (t.startsWith('<task-notification>')) {
      this.taskNotification(t)
      return
    }
    if (t.startsWith('<local-command-caveat>') || t.startsWith('<system-reminder>')) return
    const cmd = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(t)
    if (cmd) {
      this.commandName = cmd[1]!.startsWith('/') ? cmd[1]! : `/${cmd[1]}`
      return
    }
    const out = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(t)
    if (out) {
      if (out[1]!.trim()) this.localOutput(str(o.uuid) || `l:${this.seq++}`, this.commandName, out[1]!.trim())
      return
    }
    if (!this.history && parent === null) return // live bubbles are added by noteUserMessage
    const id = str(o.uuid) || `u:${at}:${this.seq++}`
    if (this.byId.has(id)) return
    this.addItem({ kind: 'user', id, parent, text: t, images, queued: false, at })
  }

  private taskNotification(raw: string): void {
    const tag = (n: string): string => new RegExp(`<${n}>([\\s\\S]*?)</${n}>`).exec(raw)?.[1]?.trim() ?? ''
    const status = tag('status')
    const summary = tag('summary')
    const toolUseId = tag('tool-use-id')
    const item = toolUseId ? this.byId.get(toolUseId) : undefined
    if (item?.kind === 'tool') this.patch(item, { status: status === 'failed' ? 'failed' : status === 'killed' || status === 'stopped' ? 'interrupted' : 'done', endedAt: this.now() })
    else if (item?.kind === 'subagent') this.patch(item, { status: status === 'failed' ? 'failed' : 'done', endedAt: this.now(), latest: '' })
    this.notice('background', status === 'failed' ? 'warn' : 'info', summary || (status ? `Background task ${status}` : raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()))
  }

  // ---------------------------------------------------------------- system

  private onSystem(o: Rec): void {
    switch (o.subtype) {
      case 'init': {
        const mcp = arr(o.mcp_servers).filter((s) => rec(s).status === 'failed').map((s) => str(rec(s).name))
        const servers: McpServerInfo[] = arr(o.mcp_servers).map((s) => ({ name: str(rec(s).name), status: mcpStatus(str(rec(s).status)) })).filter((s) => s.name)
        const p: Partial<ChatMeta> = { mcpServers: servers, permissionMode: str(o.permissionMode) || this.state.permissionMode, mcpFailed: mcp, claudeVersion: str(o.claude_code_version) || null }
        if (str(o.session_id)) p.sessionId = str(o.session_id)
        if (!this.firstAssistant && str(o.model)) {
          p.model = str(o.model)
          p.modelDisplayName = modelDisplayName(this.state.models, str(o.model))
        }
        this.terminalOnly = arr(o.terminal_slash_commands).map(String)
        if (this.state.commands.length) p.commands = this.state.commands.map((c) => ({ ...c, terminalOnly: this.terminalOnly.includes(c.name) }))
        this.meta(p)
        const prev = this.state.mcpFailed
        if (mcp.length && !this.history && !this.noticedMcp(prev)) this.notice('mcp', 'warn', `${mcp.length === 1 ? '1 MCP server' : `${mcp.length} MCP servers`} failed to connect: ${mcp.join(', ')}`, undefined, undefined, null, { category: 'mcp' })
        break
      }
      case 'status': {
        const status = o.status
        this.compacting = status === 'compacting'
        if (str(o.permissionMode)) this.meta({ permissionMode: str(o.permissionMode) })
        if (status === 'requesting') {
          this.beginTurn()
          if (this.queuedAwaitTurn) {
            this.queuedAwaitTurn = false
            for (const it of this.state.items) if (it.kind === 'user' && it.queued) this.patch(it, { queued: false })
          }
        }
        break
      }
      case 'thinking_tokens': {
        const n = num(o.estimated_tokens)
        if (n === undefined) break
        const parent = this.parentOf(o)
        for (let i = this.state.items.length - 1; i >= 0; i--) {
          const it = this.state.items[i]!
          if (it.kind === 'thinking' && it.endedAt === null && it.parent === parent) {
            this.patch(it, { tokens: n })
            break
          }
        }
        break
      }
      case 'hook_response':
        this.onHook(o)
        break
      case 'ui_toast':
        this.notice('toast', 'info', `${prettyPlugin(str(o.plugin))}${str(o.text)}`)
        break
      case 'ui_panes': {
        const shown = str(o.shown_id)
        if (!shown || shown === this.lastPane) {
          if (!shown) this.lastPane = ''
          break
        }
        this.lastPane = shown
        const pane = arr(o.panes).map(rec).find((p) => str(p.id) === shown)
        this.notice('pane', 'info', `${str(pane?.title) || prettyPlugin(str(pane?.plugin)) || 'A mod'} opened a pane. Panes show in the Terminal view.`, undefined, ['terminal'])
        break
      }
      case 'compact_boundary': {
        const cm = rec(o.compact_metadata)
        const pre = num(cm.pre_tokens)
        const post = num(cm.post_tokens)
        const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
        this.compacting = false
        this.notice('compaction', 'info', `Conversation compacted${pre !== undefined ? ` · ${k(pre)}${post !== undefined ? ` → ${k(post)}` : ''}` : ''}`)
        this.statusDirty = true
        break
      }
      case 'task_notification': {
        const status = str(o.status)
        const id = str(o.tool_use_id)
        const item = id ? this.byId.get(id) : undefined
        if (item?.kind === 'tool') this.patch(item, { status: status === 'failed' ? 'failed' : status === 'stopped' || status === 'killed' ? 'interrupted' : 'done', endedAt: this.now() })
        else if (item?.kind === 'subagent') this.patch(item, { status: status === 'failed' ? 'failed' : 'done', endedAt: this.now(), latest: '' })
        this.notice('background', status === 'failed' ? 'warn' : 'info', str(o.summary) || `Background task ${status || 'finished'}`)
        break
      }
      case 'turn_duration': {
        if (!this.history) break
        const ms = num(o.durationMs)
        if (ms !== undefined) this.addItem({ kind: 'turn', id: `turn:${str(o.uuid) || this.seq++}`, durationMs: ms, ok: true, costUsd: null, at: Date.parse(str(o.timestamp)) || this.now() })
        break
      }
      case 'api_retry':
        this.notice('error', 'warn', `API error, retrying (${num(o.attempt) ?? '?'}/${num(o.max_retries) ?? '?'})`, str(o.error) || undefined)
        break
      default:
        break
    }
  }

  private noticedMcp(prev: string[]): boolean {
    return prev.length > 0 && this.state.items.some((i) => i.kind === 'notice' && i.source === 'mcp')
  }

  private onHook(o: Rec): void {
    const hookId = str(o.hook_id)
    if (hookId) {
      if (this.seenHooks.has(hookId)) return
      this.seenHooks.add(hookId)
    }
    const name = str(o.hook_name) || str(o.hook_event) || 'hook'
    const outcome = str(o.outcome)
    if (outcome && outcome !== 'success') {
      this.notice('hook', 'warn', `Hook ${name} ${outcome === 'cancelled' ? 'was cancelled' : `failed (exit ${num(o.exit_code) ?? '?'})`}`, stripAnsi(str(o.stderr)).trim() || undefined)
      return
    }
    let json: Rec = {}
    try {
      json = rec(JSON.parse(str(o.output)))
    } catch {
      return
    }
    const sys = stripAnsi(str(json.systemMessage)).trim()
    const skillLoad = /\bloading skill\b/i.test(sys)
    if (sys) this.notice('hook', 'info', `${str(o.hook_event) || name} hook · ${clip(sys.replace(/\s*\n\s*/g, ' '), 300)}`, undefined, undefined, null, str(o.hook_event) === 'SessionStart' ? { category: 'session', origin: name } : skillLoad ? { category: 'skill', origin: name } : undefined)
    const hso = rec(json.hookSpecificOutput)
    if (str(hso.permissionDecision) === 'deny' || json.decision === 'block') {
      const reason = str(hso.permissionDecisionReason) || str(json.reason)
      this.notice('hook', 'warn', `Blocked by hook${reason ? `: ${clip(reason, 200)}` : ''}`)
    }
  }

  // ---------------------------------------------------------------- result, control, rate limit

  private onResult(o: Rec): void {
    const subtype = str(o.subtype)
    const aborted = str(o.terminal_reason) === 'aborted_streaming'
    const isError = o.is_error === true
    const startedAt = this.turnStartedAt
    const local = num(o.num_turns) === 0
    const duration = num(o.duration_ms) ?? (startedAt ? this.now() - startedAt : 0)
    const cost = num(o.total_cost_usd)
    if (cost !== undefined) {
      this.lastResultCost = cost
      this.durationTotal += duration
    }
    const mu = rec(o.modelUsage)
    const keys = Object.keys(mu)
    const win = num(rec(mu[this.state.model ?? ''] ?? mu[keys[0] ?? '']).contextWindow)
    if (win) {
      const used = this.state.context?.usedTokens ?? 0
      this.meta({ context: { usedTokens: used, windowTokens: win, percentage: used ? Math.min(100, (used / win) * 100) : null } })
    }
    if (cost !== undefined) this.meta({ costUsd: this.costBase + cost, durationMs: this.durationBase + this.durationTotal })
    this.statusDirty = true
    this.lastTurnOut = this.sumTokens()
    this.msgTokens.clear()
    const hadQueued = this.state.items.some((i) => i.kind === 'user' && i.queued)
    if (hadQueued) this.queuedAwaitTurn = true
    this.turnActive = false
    this.compacting = false
    if (aborted) this.markInterrupted()
    if (!local) {
      this.addItem({ kind: 'turn', id: `turn:${str(o.uuid) || this.seq++}`, durationMs: duration, ok: !isError && subtype === 'success' && !aborted, costUsd: cost ?? null, at: this.now() })
      if ((isError || subtype !== 'success') && !aborted) {
        const detail = arr(o.errors).map(String).join('\n')
        this.notice('error', 'error', str(o.result) || errorText(subtype), detail || undefined)
      }
    } else if (isError && str(o.result)) this.notice('error', 'error', str(o.result))
    this.turnElapsed = duration
    this.turnStartedAt = null
    this.commandName = ''
    if (this.ping) this.finishPing(o, !isError && subtype === 'success' && !aborted)
  }

  private finishPing(o: Rec, ok: boolean): void {
    const ping = this.ping!
    this.ping = null
    const hidden = this.state.items.filter((i) => ping.hidden.has(i.id))
    if (hidden.length) {
      this.state.items = this.state.items.filter((i) => !ping.hidden.has(i.id))
      for (const i of hidden) this.byId.delete(i.id)
    }
    const u = rec(o.usage)
    const cacheRead = num(u.cache_read_input_tokens) ?? 0
    const input = num(u.input_tokens) ?? 0
    const output = num(u.output_tokens) ?? 0
    const cacheWrite = num(u.cache_creation_input_tokens) ?? 0
    const usd = Object.keys(u).length === 0 ? null : costUsd(this.state.model ?? '', { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWrite5mTokens: cacheWrite, cacheWrite1hTokens: 0 })
    const reply = str(o.result).trim()
    const item = this.byId.get(ping.id)
    if (item?.kind === 'notice') this.patch(item, { ping: { reply, ok, running: false, cacheRead, usd }, tone: ok ? 'info' : 'warn' })
    this.pingDone = { ok, reply, cacheRead, tokens: input + output + cacheRead + cacheWrite, usd }
  }

  private onControlRequest(o: Rec): void {
    const req = rec(o.request)
    if (req.subtype !== 'can_use_tool') return
    const requestId = str(o.request_id)
    const toolName = str(req.tool_name)
    const toolUseId = str(req.tool_use_id)
    const input = rec(req.input)
    const toolItem = this.byId.get(toolUseId)
    const parent = toolItem && 'parent' in toolItem ? toolItem.parent : null
    const suggestions = arr(req.permission_suggestions)
    let itemId: string
    if (toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode') {
      const prompt = this.ensurePrompt(toolUseId, parent, toolName, input)
      itemId = prompt.id
      if (prompt.kind === 'question') this.patch(prompt, { requestId, questions: this.ensureQuestions(input, prompt) })
      else this.patch(prompt, { requestId, plan: str(input.plan) || prompt.plan })
    } else {
      itemId = `perm:${requestId}`
      this.addItem<PermissionItem>({
        kind: 'permission',
        id: itemId,
        requestId,
        toolUseId,
        parent,
        toolName,
        displayName: str(req.display_name) || toolName,
        summary: toolTarget(toolName, input),
        input,
        description: str(req.description) || null,
        reason: str(req.decision_reason) || null,
        diff: toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'Write' || toolName === 'NotebookEdit' ? diffFromInput(toolName, input) : null,
        options: permissionOptions(suggestions),
        answer: null,
        at: this.now(),
      })
    }
    this.pending.set(requestId, { id: requestId, toolUseId, toolName, input, suggestions, itemId })
    this.refreshAgents()
  }

  private onCancel(requestId: string): void {
    const p = this.pending.get(requestId)
    if (!p) return
    const it = this.byId.get(p.itemId)
    if (it?.kind === 'permission') this.patch(it, { answer: 'expired' })
    else if (it?.kind === 'question') this.patch(it, { expired: true })
    else if (it?.kind === 'plan') this.patch(it, { answer: 'expired' })
    this.pending.delete(requestId)
    this.refreshAgents()
  }

  private onControlResponse(o: Rec): void {
    const r = rec(o.response)
    const id = str(r.request_id)
    const kind = this.expects.get(id)
    this.expects.delete(id)
    if (r.subtype === 'error') {
      if (kind === 'context') return
      this.notice('error', 'warn', `Claude Code refused a request: ${str(r.error) || 'unknown error'}`)
      return
    }
    const body = rec(r.response)
    if (kind === 'initialize') {
      const models = mapModels(body.models)
      const commands = mapCommands(body.commands, this.terminalOnly)
      const mode = str(body.current_permission_mode)
      this.meta({
        models,
        commands,
        ...(mode ? { permissionMode: mode } : {}),
        modelDisplayName: modelDisplayName(models, this.state.model),
        claudeVersion: str(body.claude_code_version) || this.state.claudeVersion,
      })
    }
  }

  private onRateLimit(info: Rec): void {
    const status = str(info.status)
    const utilization = num(info.utilization) ?? 0
    const show = (status && status !== 'allowed' && status !== 'allowed_warning') || utilization >= 0.9
    this.meta({ rateLimit: show ? { type: str(info.rateLimitType), utilization, resetsAt: num(info.resetsAt) ?? 0, status } : null })
  }
}

const mcpStatus = (s: string): McpServerInfo['status'] => (s === 'connected' || s === 'failed' || s === 'pending' || s === 'needs-auth' || s === 'disabled' ? s : 'pending')

const prettyPlugin = (name: string): string =>
  name ? `${name.split(/[-_]/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}: ` : ''

function errorText(subtype: string): string {
  switch (subtype) {
    case 'error_max_turns':
      return 'Claude Code stopped: the turn limit was reached'
    case 'error_during_execution':
      return 'Claude Code stopped because of an error'
    case 'error_max_budget_usd':
      return 'Claude Code stopped: the budget limit was reached'
    default:
      return `Claude Code ended the turn (${subtype || 'error'})`
  }
}

// Maps whole transcript JSONL text to items (history load, sub-agent sidechains). Lines that do not parse are skipped.
export function mapTranscript(text: string, opts: { scratchId: number; forcedParent?: string | null; now?: () => number }): ChatItem[] {
  const m = new ChatMapper({ scratchId: opts.scratchId, history: true, ...(opts.forcedParent !== undefined ? { forcedParent: opts.forcedParent } : {}), ...(opts.now ? { now: opts.now } : {}) })
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let o: unknown
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    const r = rec(o)
    // Sub-agent sidechain files nest under their agent; the main file's own sidechain lines are not repeated there.
    if (opts.forcedParent === undefined && r.isSidechain === true) continue
    if (r.type === 'system' && r.subtype === 'compact_boundary') m.feed(r)
    else if (r.type === 'user' || r.type === 'assistant') m.feed(r)
    else if (r.type === 'system' && r.subtype === 'turn_duration') m.feed(r)
  }
  m.finishHistory()
  return [...m.items]
}
