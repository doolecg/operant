import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  mapContextUsage,
  type ChatDecision,
  type ChatHistoryPage,
  type ChatItem,
  type ChatOp,
  type ChatSendInput,
  type ChatState,
  type ContextUsage,
  type SubagentItem,
} from '../shared/claude-chat'
import { LineBuffer } from './console'
import { ChatMapper, mapTranscript } from './claude-chat-map'
import { assertFakeClaude } from './model-run'
import { KeepWarm, type KeepWarmPersisted } from './keepwarm'
import { PING_PROMPT, parseKeepWarm } from '../shared/keepwarm'
import { killTree, spawnHidden } from './proc'

// One Claude Code process per Chat tile: `claude -p --input-format stream-json --output-format stream-json ...` (flags
// from buildChatLaunch). Operant writes user and control messages to its stdin and maps the JSON lines on its stdout
// into ChatItems (claude-chat-map.ts). ChatSession is everything for one tile; ChatHub batches the ops to the renderer.

const HISTORY_PAGE = 300
const INTERRUPT_GRACE_MS = 5000
const STOP_GRACE_MS = 3000
const CONTEXT_THROTTLE_MS = 5000
const STATUS_DEBOUNCE_MS = 250
const CRASH_WINDOW_MS = 60_000
const CRASH_LIMIT = 3
const STDERR_LINES = 20
const IN_USE_RETRIES = 8
const IN_USE_RETRY_MS = 1000

// ---------------------------------------------------------------- spawning

// The part of a child process the session uses (tests pass a fake).
export interface ChatChild {
  pid?: number
  stdin: { write(chunk: string): unknown; end(): void; on?(event: string, cb: (e: unknown) => void): unknown } | null
  stdout: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown } | null
  stderr: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown } | null
  on(event: 'close', cb: (code: number | null, signal: string | null) => void): unknown
  on(event: 'error', cb: (err: Error) => void): unknown
  kill(): void
}

export interface ChatSpawnSpec {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
  // A .cmd/.bat launcher: runs through the shell with every argument quoted.
  shell: boolean
}

export type ChatSpawn = (spec: ChatSpawnSpec) => ChatChild

// eslint-disable-next-line no-control-regex
const SAFE = /^[A-Za-z0-9_./:+=@\\-]+$/
const UNQUOTABLE = /["%^&|<>!\r\n\0]|\\$/

// Quotes one argument for cmd.exe; refuses what cannot be quoted safely.
export function cmdArg(arg: string): string {
  if (UNQUOTABLE.test(arg)) throw new Error(`argument cannot be passed through the shell: ${arg.slice(0, 40)}`)
  if (arg !== '' && SAFE.test(arg)) return arg
  return `"${arg}"`
}

export const realChatSpawn: ChatSpawn = (spec) => {
  assertFakeClaude()
  const args = spec.shell ? spec.args.map(cmdArg) : spec.args
  const file = spec.shell ? cmdArg(spec.file) : spec.file
  const child = spawnHidden(file, args, { cwd: spec.cwd, env: spec.env, shell: spec.shell, stdio: 'pipe', source: 'claude-run', logStdout: false })
  return child as unknown as ChatChild
}

// ---------------------------------------------------------------- batching

// Folds a batch of ops: one meta patch, one op per item (the newest snapshot, in the position of its first op), appends
// merged into the item or the previous append. Order of new items is kept.
export function coalesceOps(ops: ChatOp[]): ChatOp[] {
  const out: ChatOp[] = []
  const last = new Map<string, number>()
  let metaAt = -1
  for (const op of ops) {
    if (op.op === 'meta') {
      if (metaAt >= 0) out[metaAt] = { op: 'meta', patch: { ...(out[metaAt] as Extract<ChatOp, { op: 'meta' }>).patch, ...op.patch } }
      else {
        metaAt = out.length
        out.push({ op: 'meta', patch: { ...op.patch } })
      }
    } else if (op.op === 'upsert') {
      const i = last.get(op.item.id)
      if (i !== undefined) out[i] = op
      else {
        last.set(op.item.id, out.length)
        out.push(op)
      }
    } else if (op.op === 'append') {
      const i = last.get(op.id)
      const prev = i === undefined ? undefined : out[i]
      if (prev?.op === 'append') out[i!] = { op: 'append', id: op.id, text: prev.text + op.text }
      else if (prev?.op === 'upsert') {
        const it = prev.item
        if (it.kind === 'text' || it.kind === 'command') out[i!] = { op: 'upsert', item: { ...it, md: it.md + op.text } }
        else if (it.kind === 'thinking') out[i!] = { op: 'upsert', item: { ...it, text: it.text + op.text } }
        else if (it.kind === 'tool') out[i!] = { op: 'upsert', item: { ...it, partial: it.partial + op.text } }
      } else {
        last.set(op.id, out.length)
        out.push(op)
      }
    } else {
      last.delete(op.id)
      out.push(op)
    }
  }
  return out
}

// ---------------------------------------------------------------- the session

export interface ChatLaunchSpec extends ChatSpawnSpec {
  // Claude Code is not installed or too old: the tile shows a notice and the Terminal view.
  blocked?: string
}

export interface ChatSessionDeps {
  scratchId: number
  sessionId: string
  cwd: string
  // The main transcript (~/.claude/projects/<slug>/<session>.jsonl): history and sub-agent sidechains live next to it.
  transcriptFile: string
  // status-<session>.json in the events folder: what the status line writes for the TUI.
  statusFile?: string
  // Builds the spawn spec; resume is true when the session already has a transcript or a process ran before.
  launch: (resume: boolean) => ChatLaunchSpec
  emit: (ops: ChatOp[]) => void
  // The tile waits for a prompt (null: no longer).
  onWaiting?: (w: { type: string; message: string } | null) => void
  // The process ended. `expected` is false for a crash.
  onExit?: (info: { code: number | null; expected: boolean }) => void
  spawn?: ChatSpawn
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
  log?: (line: string) => void
  // Called after each successful spawn (Operant attaches the usage feed and the Agents panel here).
  onStart?: () => void
  // Initial values for the pickers (the tile's saved settings).
  effort?: string | null
  bypassAllowed?: boolean
  // /keepwarm: the tile's cache lifetime, the aux budget and where the setting is saved (Operant passes these).
  keepWarm?: {
    ttlMs: () => number
    // Settings > Claude Mods > Keep warm: off hides /keepwarm and stops it.
    enabled?: () => boolean
    budgetBlocked: () => string | null
    recordUsage: (u: { tokens: number; usd: number }) => void
    load: () => KeepWarmPersisted | null
    save: (p: KeepWarmPersisted | null) => void
  }
}

const hasFile = (p: string): boolean => {
  try {
    return existsSync(p)
  } catch {
    return false
  }
}

export class ChatSession {
  readonly mapper: ChatMapper
  readonly keepWarm: KeepWarm
  private child: ChatChild | null = null
  private history: ChatItem[] | null = null
  private readonly lines = new LineBuffer()
  private readonly errLines: string[] = []
  private expectedExit = false
  private crashes: number[] = []
  private inUseRetries = 0
  private nextId = 1
  private interruptTimer: unknown = null
  private stopTimer: unknown = null
  private statusTimer: unknown = null
  private lastContextAt = 0
  private waitingKey: string | null = null
  private disposed = false
  private stopWaiters: Array<() => void> = []
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (h: unknown) => void
  private readonly spawn: ChatSpawn

  constructor(private readonly deps: ChatSessionDeps) {
    this.now = deps.now ?? Date.now
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout))
    this.spawn = deps.spawn ?? realChatSpawn
    this.mapper = new ChatMapper({ scratchId: deps.scratchId, now: this.now })
    this.mapper.setSession(deps.sessionId)
    if (deps.effort !== undefined) this.mapper.setEffort(deps.effort)
    if (deps.bypassAllowed) this.mapper.setBypassAllowed(true)
    const kw = deps.keepWarm
    this.keepWarm = new KeepWarm({
      now: this.now,
      setTimer: this.setTimer,
      clearTimer: this.clearTimer,
      ttlMs: kw?.ttlMs ?? (() => 300_000),
      isBusy: () => this.busy,
      isRunning: () => this.child !== null,
      sendPing: () => this.sendPing(),
      budgetBlocked: kw?.budgetBlocked ?? (() => null),
      recordUsage: kw?.recordUsage ?? (() => {}),
      emit: (v) => this.push(this.mapper.setKeepWarm(v)),
      notice: (text, tone) => this.push(this.mapper.noteNotice({ source: 'keepwarm', tone, text })),
      load: kw?.load ?? (() => null),
      save: kw?.save ?? (() => {}),
    })
    this.mapper.setKeepWarm(this.keepWarm.view())
  }

  get running(): boolean {
    return this.child !== null
  }

  get state(): ChatState {
    return this.mapper.state
  }

  // True while a turn runs or a prompt waits: the view cannot be switched.
  get busy(): boolean {
    const t = this.mapper.state.turn
    return t.phase === 'working' || t.phase === 'waiting' || this.mapper.hasPending()
  }

  private push(ops: ChatOp[]): void {
    if (ops.length && !this.disposed) this.deps.emit(ops)
  }

  private log(line: string): void {
    this.deps.log?.(line)
  }

  // ---------------------------------------------------------------- history

  // Loads the transcript's newest items once (before the first process line).
  loadHistory(): void {
    if (this.history) return
    let text = ''
    try {
      text = hasFile(this.deps.transcriptFile) ? readFileSync(this.deps.transcriptFile, 'utf8') : ''
    } catch {
      text = ''
    }
    this.history = text ? mapTranscript(text, { scratchId: this.deps.scratchId, now: this.now }) : []
    const start = Math.max(0, this.history.length - HISTORY_PAGE)
    const live = this.mapper.state.items.slice()
    const ops = this.mapper.load([...this.history.slice(start), ...live], start, start > 0)
    this.push(ops)
  }

  snapshot(): ChatState {
    this.loadHistory()
    const s = this.mapper.state
    const hidden = this.mapper.hiddenIds()
    return { ...s, items: hidden.size ? s.items.filter((i) => !hidden.has(i.id)) : s.items.slice() }
  }

  historyPage(beforeIndex: number): ChatHistoryPage {
    this.loadHistory()
    const all = this.history ?? []
    const end = Math.max(0, Math.min(beforeIndex, this.mapper.state.historyStart, all.length))
    const start = Math.max(0, end - HISTORY_PAGE)
    const items = all.slice(start, end)
    this.mapper.prepend(items, start)
    return { items, historyStart: start }
  }

  // A sub-agent's conversation from its sidechain file <session>/subagents/agent-<id>.jsonl.
  agentHistory(toolUseId: string): ChatItem[] {
    const dir = join(dirname(this.deps.transcriptFile), this.deps.sessionId, 'subagents')
    const item = this.mapper.state.items.find((i): i is SubagentItem => i.kind === 'subagent' && i.id === toolUseId)
    let file = item?.agentId ? join(dir, `agent-${item.agentId}.jsonl`) : ''
    if (!file || !hasFile(file)) {
      file = ''
      try {
        for (const name of readdirSync(dir)) {
          if (!name.endsWith('.meta.json')) continue
          const meta = JSON.parse(readFileSync(join(dir, name), 'utf8')) as { toolUseId?: string }
          if (meta.toolUseId === toolUseId) {
            file = join(dir, name.replace(/\.meta\.json$/, '.jsonl'))
            break
          }
        }
      } catch {
        return []
      }
    }
    if (!file || !hasFile(file)) return []
    try {
      return mapTranscript(readFileSync(file, 'utf8'), { scratchId: this.deps.scratchId, forcedParent: toolUseId, now: this.now })
    } catch {
      return []
    }
  }

  // ---------------------------------------------------------------- process

  // Starts the process (resume when the session already ran). A no-op while one runs.
  start(resume?: boolean): void {
    if (this.child || this.disposed) return
    this.loadHistory()
    const useResume = resume ?? hasFile(this.deps.transcriptFile)
    let spec: ChatLaunchSpec
    try {
      spec = this.deps.launch(useResume)
    } catch (e) {
      this.push(this.mapper.setProcess('blocked'))
      this.push(this.mapper.noteNotice({ source: 'error', tone: 'error', text: e instanceof Error ? e.message : String(e), actions: ['terminal'] }))
      return
    }
    if (spec.blocked) {
      this.push(this.mapper.setProcess('blocked'))
      this.push(this.mapper.noteNotice({ source: 'error', tone: 'error', text: spec.blocked, actions: ['terminal'] }))
      return
    }
    const prior = this.priorStatus()
    this.push(this.mapper.startProcess(this.mapper.state.costUsd ?? prior.costUsd, this.mapper.state.durationMs ?? prior.durationMs))
    this.expectedExit = false
    this.errLines.length = 0
    this.lines.flush()
    this.push(this.mapper.setProcess('starting'))
    let child: ChatChild
    try {
      child = this.spawn(spec)
    } catch (e) {
      this.push(this.mapper.setProcess('crashed'))
      this.push(this.mapper.noteNotice({ source: 'crash', tone: 'error', text: `Claude Code could not start: ${e instanceof Error ? e.message : String(e)}`, actions: ['restart', 'terminal'] }))
      return
    }
    this.child = child
    this.deps.onStart?.()
    child.stdin?.on?.('error', () => {})
    child.stdout?.on('data', (b) => this.onStdout(String(b)))
    child.stderr?.on('data', (b) => {
      for (const l of String(b).split(/\r?\n/)) if (l.trim()) this.errLines.push(l)
      if (this.errLines.length > 200) this.errLines.splice(0, this.errLines.length - 200)
    })
    child.on('error', (e) => {
      this.errLines.push(e.message)
      this.onClosed(child, null)
    })
    child.on('close', (code) => this.onClosed(child, code))
    const id = 'init'
    this.mapper.expect(id, 'initialize')
    this.write({ type: 'control_request', request_id: id, request: { subtype: 'initialize' } })
  }

  private write(obj: unknown): boolean {
    const stdin = this.child?.stdin
    if (!stdin) return false
    try {
      stdin.write(`${JSON.stringify(obj)}\n`)
      return true
    } catch {
      return false
    }
  }

  private onStdout(chunk: string): void {
    for (const line of this.lines.push(chunk)) this.onLine(line)
  }

  private onLine(line: string): void {
    const t = line.trim()
    if (!t) return
    let o: Record<string, unknown>
    try {
      o = JSON.parse(t) as Record<string, unknown>
    } catch {
      this.log(`unparseable line: ${t.slice(0, 120)}`)
      return
    }
    const type = o.type
    if (type === 'control_response') {
      const r = (o.response ?? {}) as { request_id?: string; subtype?: string; response?: unknown }
      if (typeof r.request_id === 'string' && r.request_id.startsWith('ctx-') && r.subtype === 'success') {
        const usage = mapContextUsage(r.response, this.now())
        if (usage) {
          this.push(this.mapper.setContextUsage(usage))
          this.scheduleStatus()
        }
      }
      const ops = this.mapper.feed(o)
      if (r.request_id === 'init' && r.subtype === 'success' && this.mapper.state.process === 'starting') { this.inUseRetries = 0; ops.push(...this.mapper.setProcess('ready')) }
      this.push(ops)
      if (r.request_id === 'init') this.requestContext(true)
      return
    }
    const ops = this.mapper.feed(o)
    if (this.mapper.state.process === 'starting' && type === 'system') { this.inUseRetries = 0; ops.push(...this.mapper.setProcess('ready')) }
    this.push(ops)
    if (type === 'result') {
      const ping = this.mapper.takePingResult()
      if (ping) this.keepWarm.onPingResult(ping)
      else if (o.num_turns !== 0) this.keepWarm.noteActivity(this.now())
    }
    if (type === 'result' || (type === 'system' && o.subtype === 'compact_boundary')) {
      if (type === 'result' && this.interruptTimer !== null) {
        this.clearTimer(this.interruptTimer)
        this.interruptTimer = null
      }
      this.requestContext(true)
    }
    this.syncWaiting()
    if (this.mapper.takeStatusDirty()) this.scheduleStatus()
  }

  private onClosed(child: ChatChild, code: number | null): void {
    if (this.child !== child) return
    this.child = null
    for (const l of this.lines.flush()) this.onLine(l)
    for (const h of [this.interruptTimer, this.stopTimer]) if (h !== null) this.clearTimer(h)
    this.interruptTimer = null
    this.stopTimer = null
    const expected = this.expectedExit
    this.push(this.mapper.noteProcessGone())
    // The Terminal view's Claude may still be letting go of this session id (a view switch): try again shortly.
    if (!expected && !this.disposed && this.inUseRetries < IN_USE_RETRIES && this.errLines.some((l) => /already in use/i.test(l))) {
      this.inUseRetries++
      this.push(this.mapper.setProcess('starting'))
      this.setTimer(() => {
        if (!this.child && !this.disposed) this.start()
      }, IN_USE_RETRY_MS)
      for (const w of this.stopWaiters.splice(0)) w()
      return
    }
    if (expected) this.push(this.mapper.setProcess('stopped'))
    else {
      const t = this.now()
      this.crashes = this.crashes.filter((x) => t - x < CRASH_WINDOW_MS)
      this.crashes.push(t)
      this.push(this.mapper.setProcess('crashed'))
      const detail = this.errLines.slice(-STDERR_LINES).join('\n')
      const loop = this.crashes.length >= CRASH_LIMIT
      this.push(
        this.mapper.noteNotice({
          source: 'crash',
          tone: 'error',
          text: loop ? `Claude Code stopped (exit ${code ?? '?'}) three times within a minute: not restarting by itself. Use Restart or the Terminal view.` : `Claude Code stopped (exit ${code ?? '?'})`,
          ...(detail ? { detail } : {}),
          actions: ['restart', 'terminal'],
        }),
      )
    }
    this.syncWaiting()
    this.flushStatusNow()
    this.keepWarm.halt(expected ? 'The tile is closed' : 'Claude Code stopped')
    this.deps.onExit?.({ code, expected })
    for (const w of this.stopWaiters.splice(0)) w()
  }

  // True when three crashes happened within a minute: sends do not restart the process by themselves.
  get crashLoop(): boolean {
    const t = this.now()
    return this.crashes.filter((x) => t - x < CRASH_WINDOW_MS).length >= CRASH_LIMIT
  }

  restart(): void {
    if (this.child) return
    this.crashes = []
    this.start()
  }

  // Ends the process: closes stdin, kills the tree if it does not exit in 3 s. Resolves when it is gone.
  stop(): Promise<void> {
    const child = this.child
    if (!child) return Promise.resolve()
    this.expectedExit = true
    return new Promise<void>((resolve) => {
      this.stopWaiters.push(resolve)
      try {
        child.stdin?.end()
      } catch {
        // already closed
      }
      this.stopTimer = this.setTimer(() => {
        if (this.child === child) killTree(child as never)
      }, STOP_GRACE_MS)
    })
  }

  // Stops everything and drops the timers; the session is not used again.
  async dispose(): Promise<void> {
    await this.stop()
    this.keepWarm.dispose()
    this.disposed = true
    for (const h of [this.interruptTimer, this.stopTimer, this.statusTimer]) if (h !== null) this.clearTimer(h)
  }

  // ---------------------------------------------------------------- commands from the renderer

  private ensureRunning(): boolean {
    if (this.child) return true
    if (this.crashLoop) {
      this.push(this.mapper.noteNotice({ source: 'crash', tone: 'warn', text: 'Claude Code keeps stopping. Restart it from the notice above or use the Terminal view.', actions: ['restart', 'terminal'] }))
      return false
    }
    this.start()
    return this.child !== null
  }

  send(input: ChatSendInput): void {
    const text = (input.text ?? '').trim()
    const images = (input.images ?? []).filter((i) => i && typeof i.base64 === 'string' && /^image\/[a-z0-9.+-]+$/i.test(i.mediaType))
    if (!text && !images.length) return
    // Operant's own command: handled here, never sent to Claude as text.
    const kw = images.length ? null : parseKeepWarm(text)
    if (kw) {
      if (this.deps.keepWarm?.enabled && !this.deps.keepWarm.enabled()) {
        this.push(this.mapper.noteNotice({ source: 'keepwarm', tone: 'info', text: 'Keep warm is turned off in Settings > Claude Mods' }))
        return
      }
      return this.keepWarm.command(kw)
    }
    if (!this.ensureRunning()) return
    // A message sent while a plan waits is the comment on it: the plan is denied with that text, which Claude reads first.
    const planRequest = images.length ? null : this.mapper.pendingPlanRequest()
    this.push(
      this.mapper.noteUserMessage(
        text,
        images.map((i) => ({ mediaType: i.mediaType, dataUrl: `data:${i.mediaType};base64,${i.base64}` })),
        planRequest !== null,
      ),
    )
    if (planRequest && this.answer(planRequest, { kind: 'plan', approve: 'keep', message: text })) return
    const content: unknown[] = [...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.base64 } }))]
    if (text) content.push({ type: 'text', text })
    this.write({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: this.deps.sessionId })
  }

  // Keep-warm's message, through the same process and session as the owner's messages (so the same cache is read).
  private sendPing(): boolean {
    if (!this.child) return false
    this.push(this.mapper.notePing(PING_PROMPT))
    return this.write({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: PING_PROMPT }] }, parent_tool_use_id: null, session_id: this.deps.sessionId })
  }

  interrupt(): void {
    if (!this.child) return
    const id = `int-${this.nextId++}`
    this.mapper.expect(id, 'interrupt')
    this.write({ type: 'control_request', request_id: id, request: { subtype: 'interrupt' } })
    if (this.interruptTimer !== null) this.clearTimer(this.interruptTimer)
    const child = this.child
    this.interruptTimer = this.setTimer(() => {
      this.interruptTimer = null
      if (this.child !== child) return
      this.expectedExit = true
      this.push(this.mapper.noteInterruptForced())
      killTree(child as never)
    }, INTERRUPT_GRACE_MS)
  }

  // Answers a pending prompt. Returns false for an unknown or already answered request.
  answer(requestId: string, decision: ChatDecision): boolean {
    if (!this.child) return false
    const r = this.mapper.answer(requestId, decision)
    if (!r) return false
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: r.body } })
    this.push(this.mapper.setProcess(this.mapper.state.process))
    this.syncWaiting()
    return true
  }

  private control(kind: 'mode' | 'model' | 'context', request: Record<string, unknown>): void {
    const id = `${kind === 'context' ? 'ctx' : kind}-${this.nextId++}`
    this.mapper.expect(id, kind)
    this.write({ type: 'control_request', request_id: id, request })
  }

  setMode(mode: string): void {
    if (!this.child || !/^[A-Za-z]{1,30}$/.test(mode)) return
    this.control('mode', { subtype: 'set_permission_mode', mode })
  }

  // The full model id from the initialize list. state.model keeps showing what Claude's messages report.
  setModel(model: string): void {
    if (!this.child || !/^[A-Za-z0-9][A-Za-z0-9.\-[\]]{0,63}$/.test(model)) return
    this.control('model', { subtype: 'set_model', model })
  }

  // /effort <level> is a local command (no model call); its reply becomes the "Effort set to ..." notice.
  setEffort(level: string): void {
    const s = this.mapper.state
    const model = s.models.find((m) => m.resolvedModel === s.model && m.value !== 'default') ?? s.models.find((m) => m.value === s.model)
    if (model && model.efforts.length && !model.efforts.includes(level)) return
    if (!/^[a-z]{2,10}$/.test(level)) return
    // No process yet or any more: the tile keeps the level and the next launch passes --effort.
    if (!this.child) {
      this.push(this.mapper.setEffort(level))
      return
    }
    this.mapper.noteCommand('/effort')
    this.write({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: `/effort ${level}` }] }, parent_tool_use_id: null, session_id: this.deps.sessionId })
    this.push(this.mapper.setEffort(level))
  }

  // get_context_usage; returns what is known now (the new numbers arrive as a meta op).
  requestContext(force = false): ContextUsage | null {
    const cached = this.mapper.state.contextUsage
    if (!this.child) return cached
    const t = this.now()
    if (!force && t - this.lastContextAt < CONTEXT_THROTTLE_MS) return cached
    if (this.mapper.state.turn.phase !== 'idle' && !force) return cached
    this.lastContextAt = t
    this.control('context', { subtype: 'get_context_usage' })
    return cached
  }

  // ---------------------------------------------------------------- waiting, status file

  private syncWaiting(): void {
    const t = this.mapper.state.turn
    const key = t.pendingCount > 0 ? `${t.pendingCount}:${t.pendingLabel ?? ''}` : null
    if (key === this.waitingKey) return
    this.waitingKey = key
    this.deps.onWaiting?.(key === null ? null : { type: 'permission_prompt', message: t.pendingLabel ? `Claude needs your answer: ${t.pendingLabel}` : 'Claude needs your answer' })
  }

  private priorStatus(): { costUsd: number; durationMs: number } {
    const f = this.deps.statusFile
    if (!f || !hasFile(f)) return { costUsd: 0, durationMs: 0 }
    try {
      const j = JSON.parse(readFileSync(f, 'utf8')) as { cost?: { total_cost_usd?: number; total_duration_ms?: number } }
      return { costUsd: Number(j.cost?.total_cost_usd) || 0, durationMs: Number(j.cost?.total_duration_ms) || 0 }
    } catch {
      return { costUsd: 0, durationMs: 0 }
    }
  }

  private scheduleStatus(): void {
    if (!this.deps.statusFile || this.statusTimer !== null) return
    this.statusTimer = this.setTimer(() => {
      this.statusTimer = null
      this.writeStatus()
    }, STATUS_DEBOUNCE_MS)
  }

  private flushStatusNow(): void {
    if (this.statusTimer !== null) {
      this.clearTimer(this.statusTimer)
      this.statusTimer = null
    }
    this.writeStatus()
  }

  // The same JSON the TUI's status line writes (parseStatusFile reads it), plus the context breakdown.
  statusPayload(): Record<string, unknown> | null {
    const s = this.mapper.statusSnapshot()
    if (!s.model && !s.usage && s.costUsd === null) return null
    return {
      ts: this.now(),
      session_id: this.deps.sessionId,
      ...(s.model ? { model: { id: s.model, display_name: s.modelDisplayName ?? s.model } } : {}),
      context_window: {
        ...(s.windowTokens ? { context_window_size: s.windowTokens } : {}),
        ...(s.usedPercentage !== null ? { used_percentage: s.usedPercentage } : {}),
        ...(s.usage
          ? { current_usage: { input_tokens: s.usage.input, output_tokens: s.usage.output, cache_creation_input_tokens: s.usage.cacheCreation, cache_read_input_tokens: s.usage.cacheRead } }
          : {}),
      },
      cost: { ...(s.costUsd !== null ? { total_cost_usd: s.costUsd } : {}), ...(s.durationMs !== null ? { total_duration_ms: s.durationMs } : {}) },
      ...(this.mapper.state.contextUsage ? { breakdown: this.mapper.state.contextUsage } : {}),
    }
  }

  private writeStatus(): void {
    const f = this.deps.statusFile
    if (!f) return
    const payload = this.statusPayload()
    if (!payload) return
    try {
      mkdirSync(dirname(f), { recursive: true })
      const tmp = `${f}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(payload))
      renameSync(tmp, f)
    } catch (e) {
      this.log(`status file not written: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

// ---------------------------------------------------------------- the hub

export interface ChatHubOptions {
  // Pushes a tile's batched ops to the renderer.
  push: (scratchId: number, ops: ChatOp[]) => void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
  batchMs?: number
}

// Sessions by tile id and the per-tile op batching (about every 30 ms, text deltas merged; no polling timer: a one-shot
// timer is armed only while ops wait).
export class ChatHub {
  private readonly sessions = new Map<number, ChatSession>()
  private readonly queued = new Map<number, ChatOp[]>()
  private timer: unknown = null
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (h: unknown) => void

  constructor(private readonly opts: ChatHubOptions) {
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout))
  }

  get(scratchId: number): ChatSession | undefined {
    return this.sessions.get(scratchId)
  }

  has(scratchId: number): boolean {
    return this.sessions.has(scratchId)
  }

  isRunning(scratchId: number): boolean {
    return this.sessions.get(scratchId)?.running === true
  }

  // The session of a tile, created by `make` the first time.
  ensure(scratchId: number, make: (emit: (ops: ChatOp[]) => void) => ChatSession): ChatSession {
    let s = this.sessions.get(scratchId)
    if (!s) {
      s = make((ops) => this.enqueue(scratchId, ops))
      this.sessions.set(scratchId, s)
    }
    return s
  }

  private enqueue(scratchId: number, ops: ChatOp[]): void {
    const q = this.queued.get(scratchId)
    if (q) q.push(...ops)
    else this.queued.set(scratchId, [...ops])
    if (this.timer === null) this.timer = this.setTimer(() => this.flush(), this.opts.batchMs ?? 33)
  }

  flush(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer)
      this.timer = null
    }
    for (const [id, ops] of [...this.queued]) {
      this.queued.delete(id)
      const merged = coalesceOps(ops)
      if (merged.length) this.opts.push(id, merged)
    }
  }

  // Forgets a session whose process is not running (a new conversation takes the tile's place).
  forget(scratchId: number): void {
    this.sessions.delete(scratchId)
    this.queued.delete(scratchId)
  }

  // Stops the tile's process and forgets its session.
  async drop(scratchId: number): Promise<void> {
    const s = this.sessions.get(scratchId)
    if (!s) return
    await s.dispose()
    this.flush()
    this.sessions.delete(scratchId)
    this.queued.delete(scratchId)
  }

  // Keep warm was turned off in settings: every active keep-warm stops.
  stopAllKeepWarm(): void {
    for (const s of this.sessions.values()) if (s.keepWarm.view()?.active) s.keepWarm.stop('turned off in Settings > Claude Mods')
  }

  // Stops the process but keeps the items (a closed tile reopens with its conversation).
  async stop(scratchId: number): Promise<void> {
    await this.sessions.get(scratchId)?.stop()
    this.flush()
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.stop()))
    this.flush()
  }
}
