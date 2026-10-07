export type AgentKind = 'claude' | 'codex' | 'shell' | 'opencode'
// The CLIs a Master (and a seat) can run on; codex and shell stay for operators and tiles but are not offered.
export type MasterCli = 'claude' | 'opencode'
export type OperatorStatus = 'stopped' | 'starting' | 'running' | 'idle' | 'error'
export type JobState = 'todo' | 'doing' | 'review' | 'done' | 'held'
export type JobReview = 'none' | 'pm' | 'operator' | 'user'
export type MessageParty = 'user' | 'master' | 'operator'
export type MessageKind = 'message' | 'ask' | 'answer'
export type OperatorKind = 'worker' | 'master'
export type CacheTtl = 'auto' | '5m' | '1h'
export type McpMode = 'codegraph' | 'none'
export type CrewView = 'cards' | 'list' | 'graph' | 'tiles'

export interface Crew {
  id: number
  name: string
  folder: string
  createdAt: number
  view: CrewView
  pmId: number | null
  // Stable PRJ# shown in the dashboard; never reused.
  prjNumber: number
  sortOrder: number
  discordChannels: string[]
  // The project group it sits in; null is ungrouped.
  groupId: number | null
  // The project's tracker document, relative to the folder; empty = none.
  trackerFile: string
  // A finished job opens an "Update tracker" board job for the project manager.
  trackerJobs: boolean
}

export interface Squad {
  id: number
  crewId: number
  name: string
  // True for the hidden squad that holds the Master Terminal slot.
  system: boolean
}

// The launch settings a preset defines and an operator carries its own copy of.
export interface LaunchSettings {
  agent: AgentKind
  model: string
  // '' = the model's default.
  effort: string
  permissionMode: string
  // --tools list, '' = default set.
  tools: string
  allow: string[]
  deny: string[]
  cacheTtl: CacheTtl
  // Auto-compact window in tokens, 0 = default.
  contextCap: number
  clearBetweenJobs: boolean
  mcp: McpMode
}

export interface Preset extends LaunchSettings {
  id: number
  // 'pm' | 'researcher' | ... for built-ins, null for user presets.
  builtin: string | null
  name: string
  // null = the shipped file plugin/roles/<builtin>.md.
  roleText: string | null
  updatedAt: number
  // Local skills the seat may use, hindsight and codegraph on/off for a job that runs this seat.
  skills: string[]
  hindsight: boolean
  codegraph: boolean
  mcpServers: string[]
}

export interface Operator extends LaunchSettings {
  id: number
  squadId: number
  role: string
  status: OperatorStatus
  kind: OperatorKind
  presetId: number | null
  // null = the preset's role text.
  roleText: string | null
  // null = the Settings default.
  dailyCapUsd: number | null
  // Last Claude session, for resume-restart.
  sessionId: string | null
  // Derived: any launch field differs from its preset (never true without a preset or for a master).
  modified: boolean
}

export interface ScratchTerminal {
  id: number
  crewId: number
  title: string
  agent: AgentKind
  model: string
  effort: string
  presetId: number | null
  cwd: string
  sessionId: string | null
  createdAt: number
}

export interface Job {
  id: number
  crewId: number
  assigneeId: number | null
  title: string
  body: string
  state: JobState
  priority: number
  createdBy: number | null
  reviewerId: number | null
  review: JobReview
  leaseUntil: number | null
  rejects: number
  note: string
  estimateMinutes: number | null
  // First claim, for elapsed time.
  startedAt: number | null
  // Why it went to the user; '' when it did not.
  escalation: string
  // Set when assigned by its creator, the PM, the master, the user or a handoff (not by a claim): a lease
  // expiry or a session exit keeps that assignee.
  preassignedId: number | null
  // True while any job this one depends on is not done; derived, never stored.
  blocked: boolean
  createdAt: number
  updatedAt: number
}

export interface Message {
  id: number
  crewId: number
  fromKind: MessageParty
  fromId: number | null
  fromLabel: string
  toKind: MessageParty
  toId: number | null
  toLabel: string
  jobId: number | null
  kind: MessageKind
  body: string
  createdAt: number
  readAt: number | null
}

export interface Link {
  id: number
  crewId: number
  fromId: number
  toId: number
  label: string
}

export interface NodePosition {
  crewId: number
  nodeKey: string
  x: number
  y: number
}

export interface Usage {
  id: number
  // null once the operator is purged; scratchId null for operator rows and after a tile is deleted.
  operatorId: number | null
  scratchId: number | null
  messageId: string | null
  sessionId: string | null
  model: string
  at: number
  jobId: number | null
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheW5m: number
  cacheW1h: number
  // Read + both write kinds.
  cacheTokens: number
  costUsd: number
  contextTokens: number
  cold: boolean
  toolUse: boolean
  // Migrated from before the kind split: counts toward spend, not toward hit ratios or cold detection.
  legacy: boolean
}

export interface UsageBreakdownRow {
  // 'scratch' = scratch terminals; 'operator' = everything else, purged operators' archive included.
  group: 'operator' | 'scratch'
  model: string
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheW5m: number
  cacheW1h: number
  costUsd: number
  turns: number
}

export interface SpendArchive {
  crewId: number
  day: number
  label: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheW5m: number
  cacheW1h: number
  costUsd: number
}

export interface OperantEvent {
  id: number
  crewId: number | null
  operatorId: number | null
  kind: string
  message: string
  at: number
}

export interface OperatorContext {
  model: string
  contextTokens: number
  at: number
}

export interface OperatorSpend {
  operatorId: number
  total: number
  buckets: number[]
}

export interface IndexStatus {
  initialized: boolean
  indexing: boolean
  files: number
  symbols: number
  edges: number
  error?: string
}

export interface HindsightStatus {
  // no-uv: the memory server runs through uvx and it is not installed.
  state: 'running' | 'stopped' | 'no-uv' | 'error'
  url: string
  detail: string
  // True when Operant starts and stops the server itself (no remote URL set).
  managed: boolean
  // How it is hosted: local, lan (shared from this PC) or remote.
  mode?: 'local' | 'lan' | 'remote'
  // Shared mode: the running daemon may not have the current bind settings; a restart applies them.
  pendingRestart?: boolean
}

export interface HindsightAdapter {
  // The address to bind: an adapter's IPv4, 127.0.0.1 or 0.0.0.0.
  address: string
  label: string
  tailscale: boolean
  // 0.0.0.0: every adapter, including ones Operant does not list.
  all: boolean
  loopback: boolean
}

export interface HindsightTestResult {
  ok: boolean
  reachable: boolean
  // ok: the key was accepted (or none is needed); denied: the server answered 401 or 403; unknown: not reachable.
  auth: 'ok' | 'denied' | 'unknown'
  url: string
  latencyMs: number | null
  // Bank count or the server version, whichever the server reported.
  info: string
  // The server answered without any key, so anyone who can reach it can use it.
  open: boolean
  error: string
}

export interface HindsightKeyState {
  shared: boolean
  remote: boolean
}

export interface ProjectHealth {
  crewId: number
  hindsight: HindsightStatus & { bank: string }
  codegraph: {
    // The `codegraph` CLI the brief explores with is on PATH.
    cliAvailable: boolean
    initialized: boolean
    indexing: boolean
    files: number
    symbols: number
    lastIndexedAt: number | null
    // Files changed after the last index.
    stale: boolean
    error?: string
  }
}

export interface SquadWithOperators extends Squad {
  operators: Operator[]
}

export interface CrewTopology extends Crew {
  squads: SquadWithOperators[]
}

export interface UpdateStatus {
  state: 'idle' | 'unsupported' | 'checking' | 'current' | 'downloading' | 'ready' | 'installing' | 'error'
  currentVersion: string
  version?: string
  latest?: string
  notes?: string
  url?: string
  message?: string
  checkedAt?: number
}

export interface AppInfo {
  version: string
  platform: NodeJS.Platform
}

// Dashboard calls (step 10b)

export type JobRecord = Job & { deps: number[] }

export interface CrewPatch {
  name?: string
  // Refused while any operator of the crew runs.
  folder?: string
  pmId?: number | null
  discordChannels?: string[]
  trackerFile?: string
  trackerJobs?: boolean
}

export interface CrewCounts {
  squads: number
  operators: number
  running: number
  jobs: number
  openJobs: number
  messages: number
  scratch: number
  // Lessons the learning loop saved for the project (deleted with it).
  lessons: number
  // Lifetime spend of the crew, scratch terminals and purged operators included.
  spendUsd: number
}

export interface SquadDelete {
  operators: number
}

export interface OperatorFromPreset {
  squadId: number
  role: string
  presetId: number
  agent?: AgentKind
  model?: string
}

// What the card, list and graph edit forms send. Launch fields restart a running Claude operator (ruling R1);
// role, squad, cap and clearBetweenJobs apply live.
export type OperatorPatch = Partial<LaunchSettings> & {
  role?: string
  squadId?: number
  dailyCapUsd?: number | null
  roleText?: string | null
}

export interface ChangePlan {
  requiresRestart: boolean
  // Present only when effort changes. 'conversation-lost': a fresh relaunch. 'cache-kept': nothing is running.
  effort?: 'cache-kept' | 'conversation-lost'
  model?: 'cache-lost'
  canResume: boolean
  restartFields: string[]
  liveFields: string[]
  estimateColdCostUsd?: number
}

export interface OperatorChange {
  operator: Operator
  plan: ChangePlan
}

export interface SeatFields {
  skills: string[]
  hindsight: boolean
  codegraph: boolean
  // The MCP servers the seat gets, by name; 'codegraph' and 'hindsight' are built-in entries. Kept in step with
  // the older `mcp`, `codegraph` and `hindsight` fields.
  mcpServers: string[]
}

export type PresetInput = Pick<Preset, 'name' | 'agent' | 'model' | 'permissionMode'> &
  Partial<LaunchSettings> &
  Partial<SeatFields> & { roleText?: string | null }

export type PresetPatch = Partial<LaunchSettings> & Partial<SeatFields> & { name?: string; roleText?: string | null }

export type ModelTier = 'haiku' | 'sonnet' | 'opus'

export interface TeamSeat {
  presetId: number
  count: number
  model: string
  // Claude --effort or OpenCode --variant; absent or '' = the CLI's default.
  effort?: string
}

export interface TeamLimits {
  // 0 = no limit.
  maxWorkers: number
  // Highest model tier a seat may use; '' = any.
  topTier: ModelTier | ''
  // Tokens a run may spend; 0 = no limit. Carried on the run for the runner and the brief.
  tokenBudget: number
}

export interface Team {
  id: number
  name: string
  seats: TeamSeat[]
  limits: TeamLimits
  rules: string
  // Stable key of a team shipped with Operant; null for a team the user made.
  builtin: string | null
  description: string
  // A built-in the user has edited; Reset restores it.
  modified: boolean
  // A built-in the user hid from the lists.
  hidden: boolean
  updatedAt: number
}

export type TeamInput = Pick<Team, 'name'> & Partial<Pick<Team, 'seats' | 'limits' | 'rules' | 'description'>>
export type TeamPatch = Partial<TeamInput>

// What importing a team file would do, one row per team in it.
export interface TeamImportEntry {
  key: string
  name: string
  seats: number
  action: 'add' | 'skip' | 'invalid'
  reason: string
}

export interface TeamImportPreview {
  path: string
  entries: TeamImportEntry[]
}

export type RunStatus = 'queued' | 'working' | 'needs-you' | 'done' | 'failed'

// The only moves a run may make; done and failed are final.
export const RUN_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  queued: ['working', 'failed'],
  working: ['needs-you', 'done', 'failed'],
  'needs-you': ['working', 'done', 'failed'],
  done: [],
  failed: [],
}

// A dashboard job (JOB#): a task handed to a project's Master. Separate from the board jobs above.
export interface Run {
  // The JOB# number: from 20001, never reused.
  id: number
  crewId: number
  task: string
  masterCli: MasterCli
  // The Master's model and effort (OpenCode: --variant) for this run; empty = the project Master's own.
  masterModel: string
  masterEffort: string
  teamId: number | null
  // The seats and limits this run was sent with (a copy, so editing the team later changes nothing).
  seats: TeamSeat[]
  limits: TeamLimits
  rules: string
  status: RunStatus
  outcome: string
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

export interface RunInput {
  crewId: number
  task: string
  masterCli: MasterCli
  masterModel?: string
  masterEffort?: string
  // A saved team supplies seats, limits and rules; `seats` overrides its seats. Neither = a solo run.
  teamId?: number | null
  seats?: TeamSeat[]
}

export interface JobAgent {
  id: number
  runId: number
  seat: string
  model: string
  status: string
  transcriptRef: string
}

export interface JobInput {
  crewId: number
  title: string
  body?: string
  priority?: number
  // Assign to this operator.
  for?: number | null
  deps?: number[]
  estimateMinutes?: number | null
  review?: JobReview
  reviewerId?: number | null
}

// The user may change every field. `state` and `assigneeId` are overrides (any state, any assignee);
// `deps` replaces the dependency list.
export interface JobUpdate {
  title?: string
  body?: string
  priority?: number
  estimateMinutes?: number | null
  review?: JobReview
  reviewerId?: number | null
  note?: string
  state?: JobState
  assigneeId?: number | null
  deps?: number[]
}

export interface MessageFilter {
  toKind?: MessageParty
  toId?: number | null
  involving?: number
  // Only messages the user sent or received (the Messages panel's conversations).
  involvesUser?: boolean
  kind?: MessageKind
  unreadOnly?: boolean
  limit?: number
}

// `to`: an operator id, or 'master', 'pm', 'squad:<name>', '<role>'.
export interface MessageSend {
  crewId: number
  to: string | number
  body: string
  jobId?: number | null
}

export interface UnreadCounts {
  user: number
  master: number
  operators: Record<number, number>
}

export interface ScratchInput {
  crewId: number
  title: string
  agent: AgentKind
  model?: string
  effort?: string
  presetId?: number | null
  // Default: the crew folder.
  cwd?: string
}

// Whether a scratch terminal's session is alive right now (a closed tile or an exited one is not).
export interface ScratchStatus {
  scratchId: number
  running: boolean
  sessionId: string | null
}

// What one scratch terminal spent in a window; terminals without spend are left out.
export interface ScratchSpend {
  scratchId: number
  costUsd: number
  turns: number
}

export type ScratchPatch = Partial<Omit<ScratchInput, 'crewId'>>

export type UsagePeriod = '24h' | '7d' | '30d'

export interface KindCost {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface UsageCell extends UsageBreakdownRow {
  // cost_usd split by token kind, from list prices (an estimate: the stored total is the truth).
  kindCostUsd: KindCost
}

export interface CapProgress {
  capUsd: number
  spentUsd: number
  pct: number
  paused: boolean
}

// Why a turn rebuilt the prompt cache, inferred from the turn before it: a gap past the cache lifetime,
// a different model, or neither (the prompt itself changed).
export type ColdCause = 'idle' | 'model' | 'prompt'

export interface OperatorUsage {
  operatorId: number
  address: string
  kind: OperatorKind
  model: string
  costUsd: number
  turns: number
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheWrite: number
  kindCostUsd: KindCost
  // read / (read + writes + input); null when there is no exact turn.
  hitRatio: number | null
  coldCount: number
  // The cause of the latest cold turn in the period; null when there was none.
  lastColdCause: ColdCause | null
  // Output tokens' cost over total cost, 0..1.
  outputShare: number
  medianContext: number
  avgCostPerJobUsd: number | null
  // Today's spend against the operator's daily cap; null when no cap applies.
  cap: CapProgress | null
  unpriced: boolean
}

export interface JobUsage {
  jobId: number
  title: string
  costUsd: number
  turns: number
  operators: number[]
}

export type WasteKind = 'cold-repeated' | 'output-share' | 'no-tool-streak' | 'context-high' | 'job-cost'

export interface WasteSignal {
  kind: WasteKind
  operatorId: number | null
  jobId: number | null
  text: string
  value: number
  threshold: number
}

export interface UsageBreakdownResult {
  crewId: number
  period: UsagePeriod
  since: number
  totalUsd: number
  // This crew's exact spend since local midnight, whatever the period.
  today: number
  // Operators (purged ones' archive included) plus scratch terminals, split by kind and model.
  rows: UsageCell[]
  byKind: KindCost
  byModel: Array<{ model: string; costUsd: number }>
  scratch: { costUsd: number; turns: number }
  operators: OperatorUsage[]
  // Top 10 by cost, and the median cost of all jobs with spend.
  jobs: JobUsage[]
  medianJobCostUsd: number
  waste: WasteSignal[]
}

export interface CapStatus {
  daily: CapProgress | null
  operators: Record<number, CapProgress>
}

export interface PurgeCandidate {
  operatorId: number
  label: string
  crewId: number | null
  deletedAt: number
  // Past retention with no job or unread message holding it back.
  eligible: boolean
  blockers: string[]
}

export interface PurgeStatus {
  enabled: boolean
  retentionDays: number
  candidates: PurgeCandidate[]
}

export interface PurgeOutcome {
  operatorId: number
  label: string
  purged: boolean
  blockers: string[]
}

export type GraphNodeType = 'crew' | 'squad' | 'operator' | 'master' | 'user'
export type GraphWindow = '1h' | '24h' | 'all'

export interface GraphNode {
  // 'crew', 'user', `squad:<id>`, `op:<id>` (the Master slot too): the key node positions are saved under.
  key: string
  type: GraphNodeType
  label: string
  status?: OperatorStatus
  operatorId?: number
  squadId?: number
}

export interface GraphEdge {
  id: string
  from: string
  to: string
  // 'member': crew > squad > operator; 'message': aggregated messages in the window; 'link': a user-drawn
  // link; 'job': jobs one operator created for another.
  kind: 'member' | 'message' | 'link' | 'job'
  label: string
  count: number
  linkId?: number
}

export interface GraphData {
  crewId: number
  window: GraphWindow
  nodes: GraphNode[]
  edges: GraphEdge[]
  positions: NodePosition[]
}

export type IpcErrorCode = 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN' | 'BAD_ARGS' | 'RATE_LIMITED' | 'INBOX_FULL' | 'INTERNAL'

export interface CapEvent {
  action: 'warn' | 'pause'
  scope: 'operator' | 'daily' | 'project' | 'job'
  operatorId: number | null
  // Set for a project or job cap.
  crewId?: number
  runId?: number
  spentUsd: number
  capUsd: number
  pct: number
}

// Discord

export interface DiscordBot {
  id: number
  name: string
  // The bot's own instructions for the front desk, applied to every reply.
  rules: string
  // Discord user ids allowed to start jobs. Anyone else gets chat-only replies.
  allowlist: string[]
  homeChannel: string
  generalChannel: string
  // The key of the token in the secret store. The token itself is never held here.
  tokenRef: string
  // Answer only when mentioned (direct messages always count), or every message.
  mentionOnly: boolean
  // The front desk starts a job only after the user reacts to confirm it.
  confirmStart: boolean
  enabled: boolean
  // The CLI jobs started from this bot run on; unset = claude.
  masterCli?: MasterCli
  // Each request from an allowlisted user in a server channel gets its own named thread, and every reply goes there.
  threadPerRequest: boolean
  // 'auto' names the thread by code; 'ai' asks the front desk model for a title (a few tokens), falling back to code.
  threadNames: DiscordThreadNames
  // Minutes of quiet before Discord archives the thread: 60, 1440, 4320 or 10080.
  threadArchive: DiscordThreadArchive
  // Which AI answers in Discord (the front desk and thread titles). Claude and OpenCode cost tokens; a local
  // OpenAI-compatible server (LM Studio, Ollama, llama.cpp) is free.
  ai: DiscordBotAi
}

export type DiscordAiCli = 'claude' | 'opencode' | 'local'
export interface DiscordBotAi {
  cli: DiscordAiCli
  // Empty = the cheap default (Claude Haiku) or, for a local server, whatever it has loaded.
  model: string
  effort: string
  localUrl: string
}
export const DEFAULT_DISCORD_AI: DiscordBotAi = { cli: 'claude', model: '', effort: '', localUrl: 'http://127.0.0.1:1234' }

export interface DiscordAiTestResult {
  ok: boolean
  answer: string
  error: string
  ms: number
}

export type DiscordThreadNames = 'auto' | 'ai'
export type DiscordThreadArchive = 60 | 1440 | 4320 | 10080
export const DISCORD_THREAD_ARCHIVES: readonly DiscordThreadArchive[] = [60, 1440, 4320, 10080]

// A thread the bot made for a request; kept so a restart still routes replies in it.
export interface DiscordThread {
  botId: number
  threadId: string
  parentId: string
  userId: string
  crewId: number | null
  runId: number | null
  // The title without the JOB# prefix, and the name the thread has now.
  title: string
  name: string
  createdAt: number
}

export interface DiscordBotView extends DiscordBot {
  hasToken: boolean
  health: DiscordHealth
}

export interface DiscordBotInput {
  name: string
  rules?: string
  allowlist?: string[]
  homeChannel?: string
  generalChannel?: string
  mentionOnly?: boolean
  confirmStart?: boolean
  enabled?: boolean
  masterCli?: MasterCli
  threadPerRequest?: boolean
  threadNames?: DiscordThreadNames
  threadArchive?: DiscordThreadArchive
  ai?: Partial<DiscordBotAi>
  // Stored in the secret store, never in the database.
  token?: string
}

export type DiscordBotPatch = Partial<Omit<DiscordBotInput, 'token'>>

export type DiscordState = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface DiscordHealth {
  botId: number
  state: DiscordState
  username: string
  guilds: number
  error: string
  // The most recent error, kept after the bot disconnects or reconnects. Plain language, never a token.
  lastError: string
  // Epoch ms of the last state change.
  since: number
}

// One configured channel as the bot sees it; `missing` lists the permissions it lacks there.
export interface DiscordChannelCheck {
  id: string
  found: boolean
  name: string
  guild: string
  missing: string[]
}

export interface DiscordTestResult {
  tokenValid: boolean
  username: string
  guilds: Array<{ id: string; name: string }>
  // 'missing' when Discord refused the privileged Message Content intent (switch it on in the developer portal).
  intents: 'ok' | 'missing' | 'unknown'
  channels: DiscordChannelCheck[]
  // Why the token failed, or why nothing could be checked (no token saved).
  error: string
}

export interface DiscordPairing {
  code: string
  userId: string
  username: string
  // The direct-message channel the request came from (used to tell the user they were approved).
  channelId: string
  createdAt: number
}

// MCP servers (R19). A server is read from the CLI's own config; values of env and headers never leave core.
export type McpCli = 'claude' | 'opencode'
export type McpScope = 'user' | 'project' | 'local' | 'global' | 'plugin' | 'connector' | 'builtin' | 'other'
export type McpState = 'connected' | 'failed' | 'needs-auth' | 'disabled' | 'pending' | 'unknown'
export type McpTransport = 'stdio' | 'http' | 'sse'

// What replaces a secret value in everything core returns or logs; sending it back on an edit keeps the old value.
export const MCP_MASK = '***'

export interface McpServer {
  id: string
  name: string
  cli: McpCli
  scope: McpScope
  transport: McpTransport
  // Command line or URL, with secrets masked.
  target: string
  // Names only paired with the mask.
  env: Record<string, string>
  headers: Record<string, string>
  state: McpState
  error?: string
  // Add, edit, enable, disable and remove are offered only for servers in the CLI's own config.
  editable: boolean
  builtin: boolean
}

export interface McpServerInput {
  name: string
  cli: McpCli
  scope: McpScope
  transport: McpTransport
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  headers?: Record<string, string>
}

export interface McpOverview {
  folder: string | null
  servers: McpServer[]
  installed: Record<McpCli, boolean>
  checkedAt: number
}

// A server a seat needs that is not working.
export interface McpDown {
  server: string
  state: McpState | 'missing'
  error?: string
  seats: string[]
}

// Usage page (R20): any grouping and filter of the usage rows, with totals that are the sum of the rows.

export type UsageGroupBy = 'day' | 'hour' | 'project' | 'run' | 'seat' | 'agent' | 'model' | 'cli' | 'provider' | 'source'

export interface UsageFilter {
  // Local milliseconds; `from` is inclusive, `to` exclusive.
  from?: number
  to?: number
  crewId?: number
  model?: string
  cli?: string
  provider?: string
  // The JOB# (a run id).
  runId?: number
  seat?: string
  // A job agent row id.
  agentId?: number
  // 'operator' | 'scratch' | 'master' | 'agent' | 'frontdesk' | 'import'.
  source?: string
  // Rows imported from Operant 2.8.2 are flagged legacy: 'include' (default), 'exclude' or 'only'.
  legacy?: 'include' | 'exclude' | 'only'
}

export interface UsageQuery {
  filter?: UsageFilter
  // One key per entry, in order; empty = a single total row.
  groupBy?: UsageGroupBy[]
  // Adds the previous period of the same length (needs `from`).
  trend?: boolean
}

export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheWrite: number
  costUsd: number
  turns: number
  // Turns without exact token kinds (imported from 2.8.2): counted in the totals, flagged here.
  legacyTurns: number
}

export interface UsageRowOut extends UsageTotals {
  keys: string[]
  labels: string[]
  firstAt: number | null
  lastAt: number | null
}

export interface UsageTrend {
  previousFrom: number
  previousTo: number
  previous: UsageTotals
  deltaUsd: number
  // null when the previous period spent nothing.
  deltaPct: number | null
}

export interface UsageReport {
  query: UsageQuery
  rows: UsageRowOut[]
  // Always the sum of `rows`.
  totals: UsageTotals
  trend: UsageTrend | null
}

export interface UsageSeriesQuery {
  filter?: UsageFilter
  bucket: 'hour' | 'day'
  // Splits every bucket (a line per model, project, ...).
  split?: UsageGroupBy
}

export interface UsageSeriesPoint {
  bucket: string
  split: string
  splitLabel: string
  costUsd: number
  tokens: number
  turns: number
}

export interface UsageSeries {
  query: UsageSeriesQuery
  points: UsageSeriesPoint[]
  totals: UsageTotals
}

export interface JobAgentUsage extends UsageTotals {
  // null for the Master (and for usage the reader could not tie to an agent).
  agentId: number | null
  seat: string
  model: string
  status: string
}

export interface RunUsage {
  runId: number
  crewId: number | null
  task: string
  totals: UsageTotals
  // The Master first, then every agent of the job, with the usage each one spent.
  agents: JobAgentUsage[]
}

export type UsageView = { kind: 'report'; query: UsageQuery } | { kind: 'series'; query: UsageSeriesQuery } | { kind: 'job'; runId: number }

export type ExportFormat = 'csv' | 'json'

export interface ExportText {
  filename: string
  mime: string
  text: string
}

// Budgets (R20): caps for the day (the existing daily budget in settings), each project and each job.

export interface BudgetConfig {
  // Daily spend per project, by crew id as text; missing or 0 = no cap.
  projectDailyUsd: Record<string, number>
  // Default cap for one job's whole run; 0 = none. `jobUsd` per JOB# overrides it.
  jobDefaultUsd: number
  jobUsd: Record<string, number>
  // At the cap, hold queued jobs (the project's for a project or job cap, all for the day budget).
  pauseQueue: boolean
  // A job over its own cap is stopped (ends as failed).
  stopJobAtCap: boolean
}

export interface BudgetProgress {
  capUsd: number
  spentUsd: number
  pct: number
  paused: boolean
}

export interface BudgetStatus {
  config: BudgetConfig
  day: BudgetProgress | null
  projects: Array<BudgetProgress & { crewId: number }>
  jobs: Array<BudgetProgress & { runId: number; crewId: number }>
  // Why queued jobs are held right now ('' when none are).
  held: Array<{ crewId: number | null; reason: string }>
}

export type BudgetTarget = { scope: 'day' } | { scope: 'project'; crewId: number } | { scope: 'job'; runId: number }

// Import and move (R21)

export type ImportSource = { kind: 'legacy'; dir?: string; rolesDir?: string } | { kind: 'file'; path: string }

export interface ImportCounts {
  add: number
  existing: number
  skipped: number
}

export interface SkippedRow {
  kind: 'project' | 'usage' | 'preset' | 'setting'
  ref: string
  reason: string
}

export interface ImportPreview {
  format: 'operant-2.8.2' | 'operant-export'
  found: boolean
  location: string
  projects: ImportCounts
  usage: ImportCounts
  presets: ImportCounts
  settings: ImportCounts
  usageCostUsd: number
  usageFrom: number | null
  usageTo: number | null
  skipped: SkippedRow[]
  notes: string[]
}

export interface ImportResult extends ImportPreview {
  applied: boolean
}

// Provider usage (R22)

export interface ProviderWindow {
  id: string
  label: string
  // 0..100 where the provider reports it, else null.
  usedPct: number | null
  used: number | null
  limit: number | null
  remaining: number | null
  unit: string
  resetsAt: number | null
}

export interface ProviderUsageRow {
  provider: string
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheWrite: number
  costUsd: number
  turns: number
  // The cost is figured from tokens, not reported by the provider.
  estimate: boolean
}

export type ProviderState = 'ok' | 'estimate' | 'error' | 'off' | 'rate-limited' | 'signed-out'

export interface ProviderStatus {
  id: string
  name: string
  state: ProviderState
  windows: ProviderWindow[]
  balance: { amount: number; currency: string } | null
  rows: ProviderUsageRow[]
  // True when the figures are an estimate from tokens (the provider has no usage endpoint).
  estimate: boolean
  note: string
  fetchedAt: number | null
  nextPollAt: number | null
}

export interface ProviderAlert {
  providerId: string
  windowId: string
  thresholdPct: number
  usedPct: number
  resetsAt: number | null
  at: number
}

export interface ProvidersStatus {
  providers: ProviderStatus[]
  alerts: ProviderAlert[]
}
