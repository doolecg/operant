import type { ScratchStatus, ScratchView } from './types'
import type { KeepWarmView } from './keepwarm'

export type { ScratchView }

// The Chat view of a Claude Code tile: the contract between core (core/claude-chat.ts runs `claude -p` with stream-json
// in and out and turns its lines into the items below) and the renderer (which draws them). Pure and dependency free so
// both sides share it. Everything here comes from Claude Code's own stream; nothing is invented (see statusWord).
//
// Data flow: main keeps one ChatState per Claude tile. The renderer asks for it with `chat:snapshot` when a tile mounts
// and then applies the ChatOp batches pushed on the `chat:ops` event with reduceChat (batched about every 30 ms;
// streamed text arrives as 'append' ops). Items are flat and keyed by id; a sub-agent's conversation is the items
// whose `parent` is the sub-agent item's id (see itemsOf).

// ---------------------------------------------------------------- items

export type ToolStatus = 'preparing' | 'running' | 'done' | 'failed' | 'denied' | 'interrupted'

export interface ChatImage {
  mediaType: string
  dataUrl: string
}

// One line of a unified diff hunk keeps its prefix: ' ' context, '+' added, '-' removed.
export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

export interface DiffFile {
  path: string
  created: boolean
  added: number
  removed: number
  hunks: DiffHunk[]
}

export interface ToolResult {
  // The result text, cut to 20 000 characters (`truncated` says so).
  text: string
  // First non-empty line, at most 140 characters: what a collapsed row can show.
  summary: string
  isError: boolean
  truncated: boolean
  // Image results as data URLs (at most 2, each under 500 KB).
  images: string[]
}

// A message the owner sent (live) or the transcript holds (history).
export interface UserItem {
  kind: 'user'
  id: string
  parent: string | null
  text: string
  images: ChatImage[]
  // Sent while a turn was running: shows a "Queued" tag until the next turn starts.
  queued: boolean
  at: number
}

// Assistant prose (Markdown). `streaming` is true while text deltas still arrive.
export interface TextItem {
  kind: 'text'
  id: string
  parent: string | null
  md: string
  streaming: boolean
}

// Claude Code sends thinking blocks with empty text in this version, so only the duration and Claude's own token
// estimate are known. `text` is filled only if a later version sends it.
export interface ThinkingItem {
  kind: 'thinking'
  id: string
  parent: string | null
  tokens: number | null
  text: string
  startedAt: number
  endedAt: number | null
}

// Any tool call except Agent/Task (those are SubagentItem). `summary` is the one-line target (file path, command,
// pattern, URL); `verb` the present participle ("Reading"); `label` the past form for finished rows ("Read").
export interface ToolItem {
  kind: 'tool'
  id: string // tool_use_id
  parent: string | null
  name: string
  input: unknown
  // The streamed partial JSON of the input while status is 'preparing'.
  partial: string
  summary: string
  status: ToolStatus
  result: ToolResult | null
  // Edit, MultiEdit, Write and NotebookEdit: the change (from the result's structuredPatch, or built from the input).
  diff: DiffFile | null
  // Started with run_in_background (shells, monitors): the later task notification updates the status.
  background: boolean
  // The tool ran without asking: a rule/config allowed it, or the permission mode did.
  autoAllowed?: 'rule' | 'mode'
  // A hook blocked the call: the reason.
  blockedByHook?: string
  startedAt: number
  endedAt: number | null
}

export type SubagentStatus = 'running' | 'waiting' | 'done' | 'failed' | 'interrupted'

// An Agent/Task call. Its conversation is itemsOf(state, id); `prompt` is what the agent was asked.
export interface SubagentItem {
  kind: 'subagent'
  id: string // tool_use_id of the Agent call
  parent: string | null
  description: string
  agentType: string | null
  prompt: string
  // The model its messages report (null until one arrives).
  model: string | null
  // Claude Code's id for the agent: names its transcript agent-<id>.jsonl (known once the call returns or launches).
  agentId: string | null
  background: boolean
  status: SubagentStatus
  // The newest activity: the running tool as "Reading TileFrame.tsx", else the first line of its latest text.
  latest: string
  toolUses: number
  outputTokens: number
  // Input tokens (input + cache) of its latest assistant message: its context use. Absent until one reports usage.
  contextTokens?: number
  // Summed input-side tokens over all its messages (for a cost estimate). Absent until one reports usage.
  usage?: { input: number; cacheRead: number; cacheWrite: number }
  // The effort the Agent call asked for, only when the call said so.
  effort?: string
  startedAt: number
  endedAt: number | null
  result: ToolResult | null
}

// One entry of Claude Code's permission_suggestions, with a label ready to show.
export interface PermissionOption {
  index: number
  kind: 'rule' | 'mode' | 'directory' | 'other'
  label: string
}

export type PermissionAnswer = null | 'once' | 'always' | 'denied' | 'expired'

// Claude Code asks before using a tool. Answer it with `chat:permission`; main keeps the original tool input.
export interface PermissionItem {
  kind: 'permission'
  id: string
  // Pass this to chat:permission.
  requestId: string
  toolUseId: string
  // The conversation the call belongs to (a sub-agent's id, or null for the main thread).
  parent: string | null
  toolName: string
  displayName: string
  // The one-line target (command, path, URL) and the whole input.
  summary: string
  input: unknown
  description: string | null
  reason: string | null
  diff: DiffFile | null
  // Choices for "Always allow"; empty when Claude Code offered none.
  options: PermissionOption[]
  answer: PermissionAnswer
  denyMessage?: string
  at: number
}

export interface QuestionOption {
  label: string
  description: string
}

export interface Question {
  question: string
  header: string
  multiSelect: boolean
  options: QuestionOption[]
}

// AskUserQuestion. Answer with { kind: 'answer', answers: { [question text]: label } }; a multiSelect answer joins
// the chosen labels with ", ". Free text ("Other") is sent as the text itself.
export interface QuestionItem {
  kind: 'question'
  id: string
  // null for a question loaded from the transcript (it cannot be answered any more).
  requestId: string | null
  toolUseId: string
  parent: string | null
  questions: Question[]
  answers: Record<string, string> | null
  expired: boolean
  at: number
}

// ExitPlanMode in plan mode: the plan to approve.
export interface PlanItem {
  kind: 'plan'
  id: string
  requestId: string | null
  toolUseId: string
  parent: string | null
  plan: string
  answer: null | 'approved' | 'approved-edits' | 'kept' | 'expired'
  at: number
}

// Output of a local slash command (/context, /cost, /compact, /model, mod commands): Markdown.
export interface CommandItem {
  kind: 'command'
  id: string
  command: string
  md: string
  at: number
}

export type NoticeSource = 'interrupt' | 'compaction' | 'hook' | 'error' | 'background' | 'toast' | 'pane' | 'crash' | 'effort' | 'info' | 'mcp' | 'ping' | 'keepwarm'

export interface NoticeItem {
  kind: 'notice'
  id: string
  parent: string | null
  source: NoticeSource
  tone: 'info' | 'warn' | 'error'
  text: string
  // Extra text for a disclosure: stderr of a crash, a hook's stderr, the compaction summary.
  detail?: string
  // Buttons: 'restart' (resume the session) and 'terminal' (switch the tile to the Terminal view).
  actions?: Array<'restart' | 'terminal'>
  // Shown in the Agents panel's Status section instead of the chat: MCP connection and SessionStart hook notices.
  // 'skill': a hook's "Loading skill" line, left out of the chat because the Skill tool row already shows it.
  category?: 'mcp' | 'session' | 'skill'
  // The hook or plugin the notice came from (category 'session' and 'skill').
  origin?: string
  // A keep-warm ping turn folded into one row: `text` is the prompt, this the reply and what the call read.
  ping?: { reply: string; ok: boolean; running: boolean; cacheRead: number; usd: number | null }
  at: number
}

// "Done in 4.6s" after each model turn (not after local slash commands).
export interface TurnItem {
  kind: 'turn'
  id: string
  durationMs: number
  ok: boolean
  costUsd: number | null
  at: number
}

export type ChatItem =
  | UserItem
  | TextItem
  | ThinkingItem
  | ToolItem
  | SubagentItem
  | PermissionItem
  | QuestionItem
  | PlanItem
  | CommandItem
  | NoticeItem
  | TurnItem

// What the list draws: items in order, with runs of finished read-only tool rows folded into a group.
export type ChatRow = { type: 'item'; item: ChatItem } | { type: 'toolGroup'; id: string; items: ToolItem[]; summary: string }

// ---------------------------------------------------------------- state

// The Claude Code process of the tile. 'blocked': the CLI is missing or too old for Chat (use the Terminal view).
export type ChatProcessPhase = 'stopped' | 'starting' | 'ready' | 'crashed' | 'blocked'

export type TurnPhase = 'idle' | 'working' | 'waiting' | 'stopped'

// Live detail of the running turn (the status line above the composer, the tile header state).
export interface TurnStatus {
  phase: TurnPhase
  // Derived from real events, never invented: see statusWord.
  word: string
  // Epoch ms the turn started (null when idle). The renderer ticks the elapsed time itself; `elapsedMs` is the final
  // duration of the last finished turn.
  startedAt: number | null
  elapsedMs: number
  // Output tokens of the main thread so far, summed from message_delta usage.
  outputTokens: number
  // Pending prompts: how many, and "tool: target" of the oldest, for "Needs your answer above · agent: npm run typecheck".
  pendingCount: number
  pendingLabel: string | null
}

export interface ChatCommand {
  name: string
  description: string
  argumentHint: string
  source: 'built-in' | 'skill' | 'plugin'
  // Needs the interactive terminal (doctor, color, focus, reload-plugins...).
  terminalOnly: boolean
}

export interface ChatModel {
  // The id to send with chat:setModel.
  value: string
  displayName: string
  description: string
  resolvedModel: string | null
  supportsEffort: boolean
  // The effort levels Claude Code lists for this model (the slider's stops); empty when unsupported.
  efforts: string[]
  supportsAutoMode: boolean
}

// ---- context window (get_context_usage)

export type ContextRowId = 'system' | 'tools' | 'mcp' | 'agents' | 'memory' | 'skills' | 'messages' | 'other' | 'free'

export interface ContextRow {
  id: ContextRowId
  label: string
  tokens: number
  // Share of maxTokens, 0..100.
  pct: number
  // E.g. "+15.8k deferred, not loaded" for tools and mcp.
  note?: string
}

export interface ContextUsage {
  model: string
  totalTokens: number
  maxTokens: number
  // Claude Code's own percentage.
  percentage: number
  // Where auto-compaction starts, null when it is off.
  autoCompactAt: number | null
  // The tick position on the bar, 0..100 of maxTokens (null without auto-compaction).
  tickPct: number | null
  rows: ContextRow[]
  deferredTokens: number
  memoryFiles: Array<{ path: string; type: string; tokens: number }>
  mcpServers: Array<{ server: string; tokens: number; loaded: number; total: number }>
  skills: { total: number; included: number; tokens: number } | null
  updatedAt: number
}

// ---- session state

// One MCP server as Claude's init event reports it.
export interface McpServerInfo {
  name: string
  status: 'connected' | 'failed' | 'pending' | 'needs-auth' | 'disabled'
}

export interface ChatState {
  scratchId: number
  // Every MCP server Claude reported at start (absent before the init event).
  mcpServers?: McpServerInfo[]
  sessionId: string | null
  process: ChatProcessPhase
  turn: TurnStatus
  items: ChatItem[]
  // Older items exist in the transcript: chat:history(scratchId, historyStart) loads them.
  hasEarlier: boolean
  historyStart: number
  // The model as REPORTED by Claude's latest main-thread message (the requested one can differ), else the init value.
  model: string | null
  modelDisplayName: string | null
  permissionMode: string
  effort: string | null
  commands: ChatCommand[]
  models: ChatModel[]
  bypassAllowed: boolean
  // Names of MCP servers that failed to connect.
  mcpFailed: string[]
  claudeVersion: string | null
  // The header meter: tokens in the context now and the window size (null until a result reports it).
  context: { usedTokens: number; windowTokens: number | null; percentage: number | null } | null
  // Session cost, carried over from earlier runs of the same session (null before any result).
  costUsd: number | null
  durationMs: number | null
  contextUsage: ContextUsage | null
  rateLimit: { type: string; utilization: number; resetsAt: number; status: string } | null
  // /keepwarm (null: never turned on for this tile).
  keepWarm: KeepWarmView | null
}

export type ChatMeta = Omit<ChatState, 'items'>

export type ChatOp =
  // Adds the item at the end, or replaces the one with the same id.
  | { op: 'upsert'; item: ChatItem }
  // Appends streamed text: to `md` of a text or command item, `text` of a thinking item, `partial` of a tool item.
  | { op: 'append'; id: string; text: string }
  | { op: 'remove'; id: string }
  | { op: 'meta'; patch: Partial<ChatMeta> }

export function emptyTurn(): TurnStatus {
  return { phase: 'idle', word: '', startedAt: null, elapsedMs: 0, outputTokens: 0, pendingCount: 0, pendingLabel: null }
}

export function emptyChatState(scratchId: number): ChatState {
  return {
    scratchId,
    sessionId: null,
    process: 'stopped',
    turn: emptyTurn(),
    items: [],
    hasEarlier: false,
    historyStart: 0,
    model: null,
    modelDisplayName: null,
    permissionMode: 'default',
    effort: null,
    commands: [],
    models: [],
    bypassAllowed: false,
    mcpFailed: [],
    claudeVersion: null,
    context: null,
    costUsd: null,
    durationMs: null,
    contextUsage: null,
    rateLimit: null,
    keepWarm: null,
  }
}

// Applies a batch of ops (immutable: the renderer's state hook calls this). Unknown ids in append/remove are ignored.
export function reduceChat(state: ChatState, ops: ChatOp[]): ChatState {
  let items = state.items
  let copied = false
  let meta: Partial<ChatMeta> | null = null
  const own = () => {
    if (!copied) {
      items = items.slice()
      copied = true
    }
  }
  for (const op of ops) {
    if (op.op === 'meta') meta = { ...(meta ?? {}), ...op.patch }
    else if (op.op === 'upsert') {
      own()
      const i = items.findIndex((x) => x.id === op.item.id)
      if (i >= 0) items[i] = op.item
      else items.push(op.item)
    } else if (op.op === 'append') {
      const i = items.findIndex((x) => x.id === op.id)
      const it = items[i]
      if (!it) continue
      own()
      if (it.kind === 'text' || it.kind === 'command') items[i] = { ...it, md: it.md + op.text }
      else if (it.kind === 'thinking') items[i] = { ...it, text: it.text + op.text }
      else if (it.kind === 'tool') items[i] = { ...it, partial: it.partial + op.text }
    } else if (op.op === 'remove') {
      own()
      items = items.filter((x) => x.id !== op.id)
    }
  }
  return meta || copied ? { ...state, ...(meta ?? {}), items } : state
}

// Items of one conversation: null is the main thread, a sub-agent id is that agent's conversation.
export const itemsOf = (state: Pick<ChatState, 'items'>, parent: string | null): ChatItem[] =>
  state.items.filter((it) => ('parent' in it ? it.parent : null) === parent)

// The prompts still waiting for an answer (any conversation), oldest first.
export function pendingPrompts(items: ChatItem[]): Array<PermissionItem | QuestionItem | PlanItem> {
  return items.filter(
    (it): it is PermissionItem | QuestionItem | PlanItem =>
      (it.kind === 'permission' && it.answer === null) ||
      (it.kind === 'question' && it.requestId !== null && it.answers === null && !it.expired) ||
      (it.kind === 'plan' && it.requestId !== null && it.answer === null),
  )
}

// ---------------------------------------------------------------- IPC

export interface ChatSendInput {
  text: string
  // Pasted or attached images (base64 without the data: prefix). Other files are inserted into the text as @paths.
  images?: Array<{ mediaType: string; base64: string }>
}

export type ChatDecision =
  | { kind: 'allow' }
  // Allow and remember: `index` is the PermissionOption chosen (rule written to the project's settings).
  | { kind: 'always'; index: number }
  | { kind: 'deny'; message?: string }
  | { kind: 'answer'; answers: Record<string, string> }
  // ExitPlanMode: approve (optionally switching to accept-edits) or keep planning.
  | { kind: 'plan'; approve: 'approve' | 'approve-edits' | 'keep'; message?: string }

export interface ChatHistoryPage {
  items: ChatItem[]
  // Index in the transcript's item list of the first item returned; 0 means nothing earlier.
  historyStart: number
}

// Request/response channels. Registered in shared/ipc.ts (IpcApi) and implemented in core/operant.ts.
export interface ChatApi {
  // Current state; for a tile whose process is not running, the transcript's newest items with process 'stopped'.
  'chat:snapshot': (scratchId: number) => ChatState
  // Writes a user message. While a turn runs Claude Code queues it (the bubble shows "Queued"). Restarts a stopped or
  // crashed process first (resume), unless it crashed three times within a minute.
  'chat:send': (scratchId: number, input: ChatSendInput) => void
  // Interrupt: the turn ends with an "Interrupted" notice; if Claude Code does not answer within 5 s the process is
  // killed and restarted with --resume on the next send.
  'chat:interrupt': (scratchId: number) => void
  'chat:permission': (scratchId: number, requestId: string, decision: ChatDecision) => void
  // set_permission_mode; state.permissionMode updates when Claude Code confirms.
  'chat:setMode': (scratchId: number, mode: string) => void
  // set_model with a full id from state.models[].value (saved on the tile too). Display state.model, not this value.
  'chat:setModel': (scratchId: number, model: string) => void
  // Sends `/effort <level>` (a local command, no model call); the level must be one of the model's efforts. Saved on the tile.
  'chat:setEffort': (scratchId: number, level: string) => void
  // get_context_usage (free). Throttled to once per 5 s unless `force`; during a turn returns the last result.
  'chat:requestContext': (scratchId: number, force?: boolean) => ContextUsage | null
  // Older items: pass state.historyStart.
  'chat:history': (scratchId: number, beforeIndex: number) => ChatHistoryPage
  // The items of a sub-agent read from its sidechain transcript (history, background agents). Same ids as live items.
  'chat:agentHistory': (scratchId: number, toolUseId: string) => ChatItem[]
  // Starts the process again with --resume (after a crash, a stop or an interrupt kill).
  'chat:restart': (scratchId: number) => ChatState
  // @file suggestions: git ls-files (or a bounded walk) in the tile's folder, fuzzy filtered, at most 20.
  'chat:files': (scratchId: number, query: string) => Promise<string[]>
  // Chat <-> Terminal on the same session. Refused (CONFLICT) while a turn runs or a prompt is pending.
  'scratch:setView': (scratchId: number, view: ScratchView) => Promise<ScratchStatus>
}

export const CHAT_CHANNELS = [
  'chat:snapshot',
  'chat:send',
  'chat:interrupt',
  'chat:permission',
  'chat:setMode',
  'chat:setModel',
  'chat:setEffort',
  'chat:requestContext',
  'chat:history',
  'chat:agentHistory',
  'chat:restart',
  'chat:files',
  'scratch:setView',
] as const satisfies ReadonlyArray<keyof ChatApi>

// Push event (main -> renderer): the batched ops of one tile.
export interface ChatEvents {
  'chat:ops': { scratchId: number; ops: ChatOp[] }
}

// ---------------------------------------------------------------- helpers

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
export const stripAnsi = (s: string): string => s.replace(ANSI_RE, '')

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const firstLine = (s: string): string => s.split(/\r?\n/).find((l) => l.trim()) ?? ''
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

export const isAgentTool = (name: string): boolean => name === 'Agent' || name === 'Task'

export const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p

// Tools that only look: consecutive finished rows of these fold into one group.
const READ_ONLY = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'NotebookRead', 'ListMcpResourcesTool', 'ReadMcpResourceTool'])
export const isReadOnlyTool = (name: string): boolean => READ_ONLY.has(name) || (name.startsWith('mcp__') && /__(get|list|read|search|find|query|describe|fetch)/.test(name))

// The main argument of a tool call as a short line: "TileFrame.tsx", "npm test", "rounded-2xl", a URL...
export function toolTarget(name: string, input: unknown): string {
  const i = rec(input)
  const pick = (...keys: string[]): string => {
    for (const k of keys) if (typeof i[k] === 'string' && i[k]) return i[k] as string
    return ''
  }
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return pick('file_path') ? baseName(pick('file_path')) : ''
    case 'NotebookEdit':
      return pick('notebook_path') ? baseName(pick('notebook_path')) : ''
    case 'Bash':
    case 'PowerShell':
      return clip(firstLine(pick('command')), 120)
    case 'Grep':
    case 'Glob':
      return clip(pick('pattern'), 80)
    case 'LS':
      return pick('path') ? baseName(pick('path')) : ''
    case 'WebFetch':
      return clip(pick('url'), 100)
    case 'WebSearch':
      return clip(pick('query'), 100)
    case 'Agent':
    case 'Task':
      return clip(pick('description', 'prompt'), 100)
    case 'Skill':
      return pick('skill', 'name')
    case 'TodoWrite':
      return Array.isArray(i.todos) ? `${i.todos.length} items` : ''
    default:
      return clip(firstLine(pick('description', 'command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt', 'name', 'text')), 100)
  }
}

const VERBS: Record<string, [string, string]> = {
  Read: ['Reading', 'Read'],
  Edit: ['Editing', 'Edited'],
  MultiEdit: ['Editing', 'Edited'],
  Write: ['Writing', 'Wrote'],
  NotebookEdit: ['Editing', 'Edited'],
  Bash: ['Running', 'Ran'],
  PowerShell: ['Running', 'Ran'],
  Grep: ['Searching', 'Searched'],
  Glob: ['Searching', 'Searched'],
  LS: ['Listing', 'Listed'],
  WebFetch: ['Fetching', 'Fetched'],
  WebSearch: ['Searching the web for', 'Searched the web for'],
  Skill: ['Using skill', 'Used skill'],
  TodoWrite: ['Updating', 'Updated'],
}

// "Reading" / "Read" for a tool; other tools use their name.
export const toolVerb = (name: string, done: boolean): string => VERBS[name]?.[done ? 1 : 0] ?? (isAgentTool(name) ? 'Agent:' : name)

// What the status line shows while a tool runs: "Reading TileFrame.tsx…".
export function runningWord(name: string, input: unknown): string {
  const t = toolTarget(name, input)
  return `${toolVerb(name, false)}${t ? ` ${t}` : ''}…`
}

// The word of the status line, derived only from real events: a pending prompt, compaction, the running tool (verb +
// target), an open thinking or text block, else "Working…". No whimsical words.
export interface Activity {
  pending: number
  compacting: boolean
  tool: { name: string; input: unknown } | null
  thinking: boolean
  writing: boolean
}

export function statusWord(a: Activity): string {
  if (a.pending > 0) return 'Waiting for you'
  if (a.compacting) return 'Compacting…'
  if (a.tool) return runningWord(a.tool.name, a.tool.input)
  if (a.thinking) return 'Thinking…'
  if (a.writing) return 'Writing…'
  return 'Working…'
}

// The tile header state: dot + word.
export function tileState(s: Pick<ChatState, 'process' | 'turn'>): 'Working' | 'Waiting for you' | 'Idle' | 'Stopped' | 'Crashed' {
  if (s.process === 'crashed') return 'Crashed'
  if (s.process === 'stopped' || s.process === 'blocked') return 'Stopped'
  if (s.turn.phase === 'waiting') return 'Waiting for you'
  if (s.turn.phase === 'working') return 'Working'
  return 'Idle'
}

// Reads the string value of a top-level key from a JSON object that may be cut off mid-way ("{\"file_path\":\"C:\\\\a\\\\b.t").
// Returns null when the key has not started yet. Used to show a tool's argument while its input still streams.
export function partialJsonString(partial: string, key: string, complete = false): string | null {
  const m = new RegExp(`"${key}"\\s*:\\s*"`).exec(partial)
  if (!m) return null
  let out = ''
  for (let i = m.index + m[0].length; i < partial.length; i++) {
    const c = partial[i]!
    if (c === '"') return out
    if (c === '\\') {
      const n = partial[i + 1]
      if (n === undefined) return complete ? null : out
      if (n === 'u') {
        const hex = partial.slice(i + 2, i + 6)
        if (hex.length < 4) return complete ? null : out
        out += String.fromCharCode(parseInt(hex, 16))
        i += 5
      } else {
        out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n
        i++
      }
    } else out += c
  }
  return complete ? null : out
}

const TARGET_KEYS = ['file_path', 'notebook_path', 'command', 'pattern', 'url', 'query', 'description', 'prompt', 'path', 'skill']

// toolTarget for an input that is still streaming.
export function partialTarget(name: string, partial: string): string {
  const input: Record<string, string> = {}
  for (const k of TARGET_KEYS) {
    // A path is shown once it is complete (half a path reads as nonsense); other arguments grow as they stream.
    const v = partialJsonString(partial, k, k === 'file_path' || k === 'notebook_path' || k === 'path')
    if (v !== null) input[k] = v
  }
  return toolTarget(name, input)
}

// ---- diffs

const splitLines = (s: string): string[] => (s === '' ? [] : s.replace(/\r\n/g, '\n').split('\n'))

function countDiff(hunks: DiffHunk[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const h of hunks) for (const l of h.lines) (l[0] === '+' ? added++ : l[0] === '-' ? removed++ : 0)
  return { added, removed }
}

// The diff of an Edit/MultiEdit/Write call from its input alone (a preview for a permission card, or when the result
// carries no structuredPatch). Old and new text are shown whole, not line-aligned.
export function diffFromInput(name: string, input: unknown): DiffFile | null {
  const i = rec(input)
  const path = str(i.file_path) || str(i.notebook_path)
  if (!path) return null
  const hunkOf = (oldText: string, newText: string): DiffHunk => {
    const o = splitLines(oldText)
    const n = splitLines(newText)
    return { oldStart: 1, oldLines: o.length, newStart: 1, newLines: n.length, lines: [...o.map((l) => `-${l}`), ...n.map((l) => `+${l}`)] }
  }
  let hunks: DiffHunk[] = []
  let created = false
  if (name === 'Write' && typeof i.content === 'string') {
    created = true
    hunks = [hunkOf('', i.content)]
  } else if (name === 'Edit' && typeof i.new_string === 'string') hunks = [hunkOf(str(i.old_string), i.new_string)]
  else if (name === 'MultiEdit' && Array.isArray(i.edits)) hunks = i.edits.map((e) => hunkOf(str(rec(e).old_string), str(rec(e).new_string)))
  else if (name === 'NotebookEdit' && typeof i.new_source === 'string') hunks = [hunkOf('', i.new_source)]
  else return null
  return { path, created, ...countDiff(hunks), hunks }
}

// The diff from a tool result's structuredPatch (Edit/MultiEdit) or a create (Write: every line added).
export function diffFromResult(input: unknown, toolUseResult: unknown): DiffFile | null {
  const r = rec(toolUseResult)
  const path = str(r.filePath) || str(rec(input).file_path)
  if (!path) return null
  const patch = r.structuredPatch
  if (r.type === 'create' && typeof r.content === 'string') {
    const lines = splitLines(r.content)
    const hunks = lines.length ? [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((l) => `+${l}`) }] : []
    return { path, created: true, ...countDiff(hunks), hunks }
  }
  if (Array.isArray(patch) && patch.length) {
    const hunks: DiffHunk[] = patch.map((h) => {
      const x = rec(h)
      return {
        oldStart: Number(x.oldStart) || 0,
        oldLines: Number(x.oldLines) || 0,
        newStart: Number(x.newStart) || 0,
        newLines: Number(x.newLines) || 0,
        lines: Array.isArray(x.lines) ? x.lines.map(String) : [],
      }
    })
    return { path, created: false, ...countDiff(hunks), hunks }
  }
  return null
}

// ---- tool groups

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

// "Read 2 files, searched 1 pattern"
export function groupSummary(tools: ToolItem[]): string {
  const c = { read: 0, search: 0, list: 0, web: 0, other: 0 }
  for (const t of tools) {
    if (t.name === 'Read' || t.name === 'NotebookRead') c.read++
    else if (t.name === 'Grep' || t.name === 'Glob') c.search++
    else if (t.name === 'LS') c.list++
    else if (t.name === 'WebFetch' || t.name === 'WebSearch') c.web++
    else c.other++
  }
  const parts: string[] = []
  if (c.read) parts.push(`read ${plural(c.read, 'file', 'files')}`)
  if (c.search) parts.push(`searched ${plural(c.search, 'pattern', 'patterns')}`)
  if (c.list) parts.push(`listed ${plural(c.list, 'folder', 'folders')}`)
  if (c.web) parts.push(`fetched ${plural(c.web, 'page', 'pages')}`)
  if (c.other) parts.push(`used ${plural(c.other, 'tool', 'tools')}`)
  const s = parts.join(', ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// Turns one conversation's items (see itemsOf) into rows: two or more consecutive finished read-only tool rows fold into
// a group. Failed, denied, running and non-read tools stay single rows.
export function buildRows(items: ChatItem[]): ChatRow[] {
  const rows: ChatRow[] = []
  let run: ToolItem[] = []
  const flush = () => {
    if (run.length >= 2) rows.push({ type: 'toolGroup', id: `group:${run[0]!.id}`, items: run, summary: groupSummary(run) })
    else for (const t of run) rows.push({ type: 'item', item: t })
    run = []
  }
  for (const it of items) {
    if (it.kind === 'tool' && it.status === 'done' && isReadOnlyTool(it.name)) {
      run.push(it)
      continue
    }
    flush()
    if (it.kind === 'notice' && it.category) continue
    rows.push({ type: 'item', item: it })
  }
  flush()
  return rows
}

// ---- permission options

export interface PermissionSuggestionLike {
  type?: string
  rules?: Array<{ toolName?: string; ruleContent?: string }>
  mode?: string
  directories?: string[]
  destination?: string
}

// Labels for permission_suggestions, in the order Claude Code sent them (the index is what chat:permission takes).
export function permissionOptions(suggestions: unknown): PermissionOption[] {
  if (!Array.isArray(suggestions)) return []
  return suggestions.map((s, index): PermissionOption => {
    const x = rec(s) as PermissionSuggestionLike
    if (x.type === 'addRules') {
      const r = x.rules?.[0]
      const what = r?.ruleContent ? clip(r.ruleContent, 60) : (r?.toolName ?? 'this')
      return { index, kind: 'rule', label: `Always allow ${what} in this project` }
    }
    if (x.type === 'setMode') return { index, kind: 'mode', label: x.mode === 'acceptEdits' ? 'Allow all edits this session' : `Switch to ${x.mode ?? 'another'} mode` }
    if (x.type === 'addDirectories') return { index, kind: 'directory', label: 'Always allow in this folder' }
    return { index, kind: 'other', label: 'Always allow' }
  })
}

// ---- commands and models from `initialize`

export function mapCommands(raw: unknown, terminalOnly: string[]): ChatCommand[] {
  if (!Array.isArray(raw)) return []
  const only = new Set(terminalOnly)
  return raw.map((c) => {
    const x = rec(c)
    const description = str(x.description)
    const user = /\(user\)\s*$/.test(description)
    const name = str(x.name)
    return {
      name,
      description: description.replace(/\s*\((user|plugin[^)]*)\)\s*$/, ''),
      argumentHint: str(x.argumentHint),
      source: x.builtin === true ? 'built-in' : user ? 'skill' : 'plugin',
      terminalOnly: only.has(name),
    }
  })
}

export function mapModels(raw: unknown): ChatModel[] {
  if (!Array.isArray(raw)) return []
  return raw.map((m) => {
    const x = rec(m)
    const efforts = Array.isArray(x.supportedEffortLevels) ? x.supportedEffortLevels.map(String) : []
    return {
      value: str(x.value),
      displayName: str(x.displayName) || str(x.value),
      description: str(x.description),
      resolvedModel: str(x.resolvedModel) || null,
      supportsEffort: x.supportsEffort === true,
      efforts: x.supportsEffort === true ? efforts : [],
      supportsAutoMode: x.supportsAutoMode === true,
    }
  })
}

// The display name for a model id Claude reports ("claude-opus-5-5" -> "Opus 5.5") using the initialize list; the id when unknown.
export function modelDisplayName(models: ChatModel[], id: string | null): string | null {
  if (!id) return null
  const hit = models.find((m) => m.resolvedModel === id && m.value !== 'default') ?? models.find((m) => m.value === id) ?? models.find((m) => m.resolvedModel === id)
  return hit ? hit.displayName : id
}

// ---- get_context_usage

const CATEGORY_ROW: Record<string, ContextRowId> = {
  'System prompt': 'system',
  'System tools': 'tools',
  'MCP tools': 'mcp',
  'MCP server instructions': 'mcp',
  'Custom agents': 'agents',
  'Memory files': 'memory',
  Skills: 'skills',
  Messages: 'messages',
  'Free space': 'free',
}
const ROW_LABEL: Record<ContextRowId, string> = {
  system: 'System prompt',
  tools: 'System tools',
  mcp: 'MCP tools',
  agents: 'Custom agents',
  memory: 'Memory files',
  skills: 'Skills',
  messages: 'Messages',
  other: 'Other',
  free: 'Free space',
}
const ROW_ORDER: ContextRowId[] = ['system', 'tools', 'mcp', 'agents', 'memory', 'skills', 'messages', 'other', 'free']

const kTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n))

// Maps the get_context_usage response to the card's rows. Deferred categories (loaded on demand) and the auto-compact
// buffer are not rows; unknown categories go to "other" so the rows always add up to the total.
export function mapContextUsage(resp: unknown, now = Date.now()): ContextUsage | null {
  const r = rec(resp)
  const max = Number(r.maxTokens)
  const total = Number(r.totalTokens)
  if (!Array.isArray(r.categories) || !Number.isFinite(max) || max <= 0 || !Number.isFinite(total)) return null
  const tokens = new Map<ContextRowId, number>()
  const deferred = { tools: 0, mcp: 0 }
  let deferredTokens = 0
  for (const c of r.categories) {
    const x = rec(c)
    const name = str(x.name)
    const n = Number(x.tokens) || 0
    const kind = str(x.kind)
    if (kind === 'buffer') continue
    if (kind === 'deferred') {
      deferredTokens += n
      if (/^MCP/.test(name)) deferred.mcp += n
      else deferred.tools += n
      continue
    }
    const id = CATEGORY_ROW[name] ?? 'other'
    tokens.set(id, (tokens.get(id) ?? 0) + n)
  }
  const rows: ContextRow[] = []
  for (const id of ROW_ORDER) {
    const n = tokens.get(id)
    if (n === undefined || (n === 0 && id === 'other')) continue
    const note = id === 'tools' && deferred.tools ? `+${kTokens(deferred.tools)} deferred, not loaded` : id === 'mcp' && deferred.mcp ? `+${kTokens(deferred.mcp)} deferred, not loaded` : undefined
    rows.push({ id, label: ROW_LABEL[id], tokens: n, pct: (n / max) * 100, ...(note ? { note } : {}) })
  }
  const auto = r.isAutoCompactEnabled === true && Number(r.autoCompactThreshold) > 0 ? Number(r.autoCompactThreshold) : null
  const servers = new Map<string, { tokens: number; loaded: number; total: number }>()
  for (const t of Array.isArray(r.mcpTools) ? r.mcpTools : []) {
    const x = rec(t)
    const s = servers.get(str(x.serverName)) ?? { tokens: 0, loaded: 0, total: 0 }
    s.total++
    if (x.isLoaded === true) {
      s.loaded++
      s.tokens += Number(x.tokens) || 0
    }
    servers.set(str(x.serverName), s)
  }
  const sk = rec(r.skills)
  return {
    model: str(r.model),
    totalTokens: total,
    maxTokens: max,
    percentage: Number(r.percentage) || 0,
    autoCompactAt: auto,
    tickPct: auto === null ? null : (auto / max) * 100,
    rows,
    deferredTokens,
    memoryFiles: (Array.isArray(r.memoryFiles) ? r.memoryFiles : []).map((m) => ({ path: str(rec(m).path), type: str(rec(m).type), tokens: Number(rec(m).tokens) || 0 })),
    mcpServers: [...servers].map(([server, v]) => ({ server, ...v })),
    skills: sk.totalSkills !== undefined ? { total: Number(sk.totalSkills) || 0, included: Number(sk.includedSkills) || 0, tokens: Number(sk.tokens) || 0 } : null,
    updatedAt: now,
  }
}
