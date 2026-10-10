import { claudeContextWindow, modelName } from '@shared/models'
import { isAgentTool, itemsOf, mcpParts, toolVerb, type ChatCommand, type ChatItem, type ChatModel, type ChatState, type SubagentItem, type ToolItem } from '@shared/claude-chat'

// Pure helpers of the Chat view (formatting, menus, suggestions, the agent list). No React here so they can be tested.

// "4.6s", "46s", "1m 4s", "1h 2m".
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s'
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

// Short clock for the agent list: "45s", "3:21".
export function clockTime(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// 1234 -> "1.2k", 950 -> "950", 1_250_000 -> "1.3M".
export function kTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return String(Math.round(n))
}

export const capitalize = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)

// ---- permission modes

const MODE_LABELS: Record<string, string> = {
  default: 'Ask',
  acceptEdits: 'Accept edits',
  plan: 'Plan',
  auto: 'Auto',
  bypassPermissions: 'Bypass',
  dontAsk: "Don't ask",
}

export const modeLabel = (mode: string): string => MODE_LABELS[mode] ?? capitalize(mode)

// Before Claude reports a model (no message sent yet) the tile's saved model is the pending one: "" is Claude's default.
export const currentModel = (state: Pick<ChatState, 'models' | 'model'>, tileModel?: string | null): ChatModel | null => {
  const id = state.model
  if (!id) {
    if (tileModel === undefined || state.models.length === 0) return null
    const want = tileModel ?? ''
    return (want ? state.models.find((m) => m.value === want || m.resolvedModel === want) : undefined) ?? state.models.find((m) => m.value === 'default') ?? null
  }
  return state.models.find((m) => m.resolvedModel === id && m.value !== 'default') ?? state.models.find((m) => m.value === id) ?? state.models.find((m) => m.resolvedModel === id) ?? null
}

// The modes Claude Code offers for this session: Auto only when the model supports it, Bypass only when allowed. The
// current mode is always listed.
export function modeOptions(state: Pick<ChatState, 'models' | 'model' | 'bypassAllowed' | 'permissionMode'>): string[] {
  const modes = ['default', 'acceptEdits', 'plan']
  if (currentModel(state)?.supportsAutoMode) modes.push('auto')
  if (state.bypassAllowed) modes.push('bypassPermissions')
  if (!modes.includes(state.permissionMode)) modes.push(state.permissionMode)
  return modes
}

// Shift+Tab: the next mode in the list.
export function nextMode(state: Pick<ChatState, 'models' | 'model' | 'bypassAllowed' | 'permissionMode'>): string {
  const modes = modeOptions(state)
  return modes[(modes.indexOf(state.permissionMode) + 1) % modes.length]!
}

// ---- effort

// The slider's stops: exactly the levels Claude Code lists for the model, none when it has no effort.
export const effortStops = (model: ChatModel | null): string[] => (model?.supportsEffort ? model.efforts : [])

export const effortDisabledReason = (model: ChatModel | null, name: string | null): string | null => {
  if (!model) return 'Waiting for Claude Code to report its models'
  return effortStops(model).length === 0 ? `${model.displayName || name || 'This model'} has no effort setting` : null
}

// ---- context

export type ContextTone = 'ok' | 'warn' | 'danger'
export const contextTone = (pct: number, warn: number, danger: number): ContextTone => (pct >= danger ? 'danger' : pct >= warn ? 'warn' : 'ok')

// "95k of 1M · compacts at 967k"
export function contextHeadline(totalTokens: number, maxTokens: number, autoCompactAt: number | null): string {
  const base = `${kTokens(totalTokens)} of ${kTokens(maxTokens)}`
  return autoCompactAt ? `${base} · compacts at ${kTokens(autoCompactAt)}` : base
}

// ---- composer suggestions

export interface Trigger {
  kind: '/' | '@'
  query: string
  // Index of the trigger character in the text.
  start: number
}

// A "/command" at the start of the text, or an "@file" word at the caret.
export function triggerAt(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret)
  const slash = /^\/([^\s/]*)$/.exec(before)
  if (slash) return { kind: '/', query: slash[1]!, start: 0 }
  const at = /(?:^|\s)@([^\s]*)$/.exec(before)
  if (at) return { kind: '@', query: at[1]!, start: caret - at[1]!.length - 1 }
  return null
}

// Replaces the trigger word by `insert` (and a trailing space) and returns the new text and caret.
export function applySuggestion(text: string, trigger: Trigger, caret: number, insert: string): { text: string; caret: number } {
  const head = text.slice(0, trigger.start)
  const tail = text.slice(caret)
  const word = `${trigger.kind}${insert} `
  return { text: head + word + tail, caret: head.length + word.length }
}

// Commands Operant handles itself (never sent to Claude), listed with Claude's own in the "/" suggestions.
export const LOCAL_COMMANDS: ChatCommand[] = [
  { name: 'keepwarm', description: 'Keep the prompt cache warm: bare for 6h, a window such as 90m, always, off, or status', argumentHint: '[6h|90m|always|off|status]', source: 'built-in', terminalOnly: false },
]

// Claude Code's own commands that its chat protocol does not list: they only run in its terminal screen, so choosing
// one moves the tile to the Terminal view and types it there.
const TERMINAL_COMMANDS: Array<[string, string]> = [
  ['permissions', 'Manage allow and deny rules for tools'],
  ['doctor', 'Check the health of your Claude Code install'],
  ['config', 'Open the settings screen'],
  ['status', 'Show version, model, account and connectivity'],
  ['login', 'Sign in to your Anthropic account'],
  ['logout', 'Sign out of your Anthropic account'],
  ['mcp', 'Manage MCP servers'],
  ['agents', 'Manage sub-agents'],
  ['hooks', 'Manage hook configurations'],
  ['memory', 'Edit Claude memory files'],
  ['ide', 'Manage IDE integrations'],
  ['vim', 'Switch between Vim and normal editing mode'],
  ['theme', 'Change the colour theme'],
  ['terminal-setup', 'Install the Shift+Enter key binding'],
  ['help', 'Show help and the available commands'],
  ['resume', 'Resume an earlier conversation'],
  ['rewind', 'Rewind the conversation or code to an earlier point'],
  ['export', 'Export the conversation'],
  ['statusline', 'Set up the status line'],
  ['output-style', 'Choose an output style'],
  ['add-dir', 'Add a working directory'],
  ['usage', 'Show plan usage and limits'],
  ['plugin', 'Manage plugins and marketplaces'],
  ['privacy-settings', 'View and update privacy settings'],
  ['release-notes', 'View the release notes'],
  ['todos', 'List the current todo items'],
  ['bug', 'Report a problem to Anthropic'],
]

// The terminal-only commands the Commands menu runs itself (the rest say they need Claude Code's own screen).
export const RUNS_IN_CHAT = new Set(['status', 'mcp', 'doctor'])

export function withLocalCommands(commands: ChatCommand[], keepWarm = true): ChatCommand[] {
  const have = new Set(commands.map((c) => c.name))
  const terminal = TERMINAL_COMMANDS.filter(([name]) => !have.has(name)).map(
    ([name, description]): ChatCommand => ({ name, description, argumentHint: '', source: 'built-in', terminalOnly: true }),
  )
  return [...commands, ...LOCAL_COMMANDS.filter((c) => !have.has(c.name) && (keepWarm || c.name !== 'keepwarm')), ...terminal].sort((a, b) => a.name.localeCompare(b.name))
}

// The description split into runs, the words that contain something the owner typed marked as hits.
export function highlightParts(text: string, query: string): Array<{ text: string; hit: boolean }> {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  const out: Array<{ text: string; hit: boolean }> = []
  const push = (t: string, hit: boolean) => {
    if (!t) return
    const last = out[out.length - 1]
    if (last && last.hit === hit) last.text += t
    else out.push({ text: t, hit })
  }
  let at = 0
  for (const m of text.matchAll(/[\p{L}\p{N}_-]+/gu)) {
    push(text.slice(at, m.index), false)
    push(m[0], tokens.some((t) => m[0].toLowerCase().includes(t)))
    at = m.index + m[0].length
  }
  push(text.slice(at), false)
  return out
}

// Which icon a notice chip gets (the renderer maps the key to an icon).
export type ChipIcon = 'cube' | 'hook' | 'gauge' | 'compact' | 'stop' | 'alert' | 'plug' | 'info'
export function noticeChipIcon(source: string, tone: string): ChipIcon {
  if (tone === 'error' || source === 'crash' || source === 'error') return 'alert'
  switch (source) {
    case 'ping':
    case 'keepwarm':
      return 'cube'
    case 'hook':
    case 'pane':
    case 'toast':
      return 'hook'
    case 'effort':
      return 'gauge'
    case 'compaction':
      return 'compact'
    case 'interrupt':
      return 'stop'
    case 'mcp':
      return 'plug'
    default:
      return 'info'
  }
}

export function filterCommands(commands: ChatCommand[], query: string, limit = 200): ChatCommand[] {
  const q = query.toLowerCase()
  const starts: ChatCommand[] = []
  const has: ChatCommand[] = []
  for (const c of commands) {
    const n = c.name.toLowerCase()
    if (n.startsWith(q)) starts.push(c)
    else if (q && (n.includes(q) || c.description.toLowerCase().includes(q))) has.push(c)
  }
  return [...starts, ...has].slice(0, limit)
}

// ---- rows

export interface ToolRowParts {
  verb: string
  target: string
  // "+3 −1" for an edit.
  stat: string | null
  tone: 'normal' | 'failed' | 'denied'
}

export function toolRowParts(t: ToolItem): ToolRowParts {
  const finished = t.status !== 'preparing' && t.status !== 'running'
  const stat = t.diff ? `+${t.diff.added} −${t.diff.removed}` : null
  const tone = t.status === 'failed' ? 'failed' : t.status === 'denied' ? 'denied' : 'normal'
  return { verb: toolVerb(t.name, finished), target: t.summary, stat, tone }
}

export type ToolIconKey = 'memory' | 'code' | 'web' | 'file' | 'edit' | 'terminal' | 'search' | 'skill' | 'agent' | 'todo' | 'plug' | 'tool'

// Which icon a tool call gets in its row.
export function toolIconKey(name: string): ToolIconKey {
  const mcp = mcpParts(name)
  if (mcp) {
    const s = mcp.server.toLowerCase()
    if (s === 'hindsight' || s.includes('mem')) return 'memory'
    if (s === 'codegraph') return 'code'
    if (s === 'playwright') return 'web'
    return 'plug'
  }
  switch (name) {
    case 'Read':
    case 'LS':
      return 'file'
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return 'edit'
    case 'Bash':
    case 'PowerShell':
      return 'terminal'
    case 'Grep':
    case 'Glob':
      return 'search'
    case 'WebFetch':
    case 'WebSearch':
      return 'web'
    case 'Skill':
      return 'skill'
    case 'TodoWrite':
      return 'todo'
    default:
      return isAgentTool(name) ? 'agent' : 'tool'
  }
}

export const isToolRunning = (t: ToolItem): boolean => t.status === 'preparing' || t.status === 'running'

// The first `lines` lines of a text and whether more exist.
export function firstLines(text: string, lines = 40): { text: string; more: boolean } {
  const all = text.split('\n')
  return all.length > lines ? { text: all.slice(0, lines).join('\n'), more: true } : { text, more: false }
}

// The items of the main thread: its own items, plus the unanswered prompts of sub-agents (they need an answer here).
export function mainThread(items: ChatItem[]): ChatItem[] {
  return items.filter((it) => {
    const parent = 'parent' in it ? it.parent : null
    if (parent === null) return true
    if (it.kind === 'permission') return it.answer === null
    if (it.kind === 'question') return it.requestId !== null && it.answers === null && !it.expired
    if (it.kind === 'plan') return it.requestId !== null && it.answer === null
    return false
  })
}

// Keeps the newest `limit` items; `hidden` is how many were left out.
export function capItems<T>(items: T[], limit: number): { items: T[]; hidden: number } {
  return items.length > limit ? { items: items.slice(items.length - limit), hidden: items.length - limit } : { items, hidden: 0 }
}

// ---- agents

export type AgentDot = 'running' | 'waiting' | 'done' | 'failed' | 'unknown'

export interface AgentRowModel {
  id: string
  description: string
  dot: AgentDot
  // "Reading TileFrame.tsx", the first line of the latest text, or "Done · <result>".
  now: string
  startedAt: number | null
  endedAt: number | null
  agentType: string | null
  model: string | null
  // The small line under the title (see agentTldr).
  tldr: string
  context: { used: number; window: number; pct: number } | null
}

const firstLine = (s: string): string => s.split(/\r?\n/).find((l) => l.trim())?.trim() ?? ''

export function agentRowFor(a: SubagentItem): AgentRowModel {
  const dot: AgentDot = a.status === 'running' ? 'running' : a.status === 'waiting' ? 'waiting' : a.status === 'done' ? 'done' : a.status === 'failed' ? 'failed' : 'unknown'
  const result = a.result ? firstLine(a.result.summary || a.result.text) : ''
  const now = a.status === 'running' || a.status === 'waiting' ? a.latest : dot === 'done' ? `Done${result ? ` · ${result}` : ''}` : dot === 'failed' ? `Failed${result ? ` · ${result}` : ''}` : 'Stopped'
  return { id: a.id, description: a.description || a.agentType || 'Agent', dot, now, startedAt: a.startedAt, endedAt: a.endedAt, agentType: a.agentType, model: a.model, tldr: agentTldr(a), context: agentContext(a) }
}

// "Explore – Haiku 5.5": the agent's name, then the model it reported (omitted while unknown).
export function agentTitle(a: Pick<AgentRowModel, 'description' | 'agentType' | 'model'>): string {
  const name = a.agentType || a.description || 'Agent'
  return a.model ? `${name} – ${modelName(a.model).replace(/^Claude /, '').replace(/(\d+) (\d+)$/, '$1.$2')}` : name
}

const CLAUSE_END = /^(.{12,}?[.!?])(?:\s|$)/
const ellipsize = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s)

// The small line under an agent: running = what it does now; done = the first sentence of its result; failed = the error.
export function agentTldr(a: SubagentItem, max = 140): string {
  const text = (a.result?.summary || a.result?.text || '').replace(/\s+/g, ' ').trim()
  if (a.status === 'running' || a.status === 'waiting') return ellipsize(a.latest.trim(), max)
  if (a.status === 'interrupted') return 'Stopped'
  const sentence = CLAUSE_END.exec(text)?.[1] ?? text
  if (a.status === 'failed') return ellipsize(sentence || 'Failed', max)
  return ellipsize(sentence, max)
}

// Context use of an agent: tokens of its latest message vs the model's window; null when either is unknown.
export function agentContext(a: Pick<SubagentItem, 'model' | 'contextTokens'>): { used: number; window: number; pct: number } | null {
  if (!a.model || !a.contextTokens) return null
  const window = claudeContextWindow(a.model)
  if (!window) return null
  return { used: a.contextTokens, window, pct: Math.min(100, (a.contextTokens / window) * 100) }
}

// How long an agent ran (or has been running), null when unknown.
export function agentElapsed(a: Pick<AgentRowModel, 'startedAt' | 'endedAt' | 'dot'>, now: number): number | null {
  if (a.startedAt === null) return null
  const end = a.endedAt ?? (a.dot === 'running' || a.dot === 'waiting' ? now : null)
  return end === null ? null : Math.max(0, end - a.startedAt)
}

const RECENT_MS = 30 * 60_000

// Open and recent agents, newest first. Recent = finished within 30 minutes; the rest are "earlier".
export function agentList(items: ChatItem[], now: number): { shown: AgentRowModel[]; earlier: AgentRowModel[] } {
  const agents = items.filter((it): it is SubagentItem => it.kind === 'subagent').sort((a, b) => b.startedAt - a.startedAt)
  const shown: AgentRowModel[] = []
  const earlier: AgentRowModel[] = []
  for (const a of agents) {
    const open = a.status === 'running' || a.status === 'waiting'
    ;(open || (a.endedAt ?? a.startedAt) >= now - RECENT_MS ? shown : earlier).push(agentRowFor(a))
  }
  return { shown, earlier }
}

// An agent's own conversation.
export const agentConversation = (state: Pick<ChatState, 'items'>, agentId: string): ChatItem[] => itemsOf(state, agentId)

// Plain Markdown copy of a conversation (user and assistant text only).
export function conversationMarkdown(items: ChatItem[]): string {
  const out: string[] = []
  for (const it of items) {
    if (it.kind === 'user') out.push(`**You:** ${it.text}`)
    else if (it.kind === 'text') out.push(it.md)
  }
  return out.join('\n\n')
}
