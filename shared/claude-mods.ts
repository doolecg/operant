import type { ContextUsage } from './claude-chat'

// What the renderer gets for Claude Code tiles and the CLI capability check. Values are only set when the
// evidence exists: an omitted field means Operant could not observe it, never a guess.

export type CapabilityTerminal = 'claude' | 'opencode'

// 'transcript': Claude Code's session transcripts. 'opencode-db': OpenCode's local database. 'none': no usage source.
export type UsageSource = 'transcript' | 'opencode-db' | 'none'

export interface TerminalCapabilities {
  id: CapabilityTerminal
  // The command probed on PATH.
  command: string
  installed: boolean
  // The version the command printed, null when it did not answer.
  version: string | null
  // Why the terminal is not usable (not on PATH, timed out, failed): set only when not installed.
  error?: string
  // Operant's Claude hooks (SessionStart, Stop, sub-agent events) can run.
  hooks: boolean
  // Operant's status line (model, context, cost) can run.
  statusLine: boolean
  // SubagentStart / SubagentStop and Agent tool events arrive.
  subagentEvents: boolean
  usageSource: UsageSource
}

export interface CapabilityReport {
  claude: TerminalCapabilities
  opencode: TerminalCapabilities
  // When the PATH probe ran (epoch ms).
  checkedAt: number
}

export type SubagentStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'unknown'

export interface SubagentTokens {
  input: number
  cacheCreate: number
  cacheRead: number
  output: number
}

export interface ClaudeSubagent {
  agentId: string
  // The agent type from SubagentStart (e.g. "Explore"); null when no event named it.
  agentType: string | null
  description?: string
  status: SubagentStatus
  model?: string
  startedAt?: number
  endedAt?: number
  // Summed from the sub-agent's transcript; omitted when the transcript is not readable.
  tokens?: SubagentTokens
  // Tokens in the sub-agent's latest request (input + cache read + cache write): its context size. Omitted when unknown.
  contextTokens?: number
  // Estimated from the price table in pricing.ts; omitted when the model or its tokens are unknown.
  costUsd?: number
  costEstimated?: true
}

// The Claude Code status line payload, reduced to what Operant shows. Each field is omitted when absent.
export interface ClaudeSessionStatus {
  model?: string
  contextWindowSize?: number
  usedPercentage?: number
  currentUsage?: {
    inputTokens?: number
    outputTokens?: number
    cacheCreationTokens?: number
    cacheReadTokens?: number
  }
  costUsd?: number
  durationMs?: number
  // The real per-category context breakdown (Chat view tiles only: from Claude Code's get_context_usage).
  breakdown?: ContextUsage
  updatedAt: number
}

export interface ClaudeTileState {
  tileId: number
  // The session the tile is running (or last ran); null before the first event.
  sessionId: string | null
  // False once the tile's process has exited: running sub-agents are then 'unknown'.
  ptyRunning: boolean
  subagents: ClaudeSubagent[]
  status: ClaudeSessionStatus | null
  session: ClaudeSessionState
  updatedAt: number
}

// The Claude mods. `subagents` is Operant's own panel (it reads Operant's hook events); every other mod is a native Claude
// Code mod, a plugin under plugin/mods/<id> that Operant passes to Claude Code with --plugin-dir while it is enabled.
export const MOD_IDS = ['subagents', 'promptEnhancer', 'designPicker', 'ideaShelf', 'folderTracker', 'plainEnglish'] as const
export type ModId = (typeof MOD_IDS)[number]
// The sub-agent panel is on for new installs.
export const MOD_DEFAULT_ENABLED: Record<ModId, boolean> = Object.fromEntries(MOD_IDS.map((id) => [id, id === 'subagents'])) as Record<ModId, boolean>
export const isModId = (v: unknown): v is ModId => typeof v === 'string' && (MOD_IDS as readonly string[]).includes(v)
// The mods switched on in a settings map, in registry order.
export const enabledMods = (mods: Record<ModId, boolean>): ModId[] => MOD_IDS.filter((id) => mods[id])

// The main session of a Claude tile, from the hook events the sub-agent panel gets. Derived only from events.
export type ClaudePhase = 'idle' | 'working' | 'waiting' | 'done' | 'unknown'

export interface ClaudeSessionState {
  // 'unknown' until an event says otherwise.
  phase: ClaudePhase
  lastActivityAt: number | null
  // Set by a Notification (permission or idle prompt) until the next prompt, tool use, or stop.
  waiting?: { type: string | null; message: string | null; at: number }
  cwd: string | null
  sessionId: string | null
}

