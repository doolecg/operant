export type AgentKind = 'claude' | 'codex' | 'shell'
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
}

export interface CrewCounts {
  squads: number
  operators: number
  running: number
  jobs: number
  openJobs: number
  messages: number
  scratch: number
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

export type PresetInput = Pick<Preset, 'name' | 'agent' | 'model' | 'permissionMode'> &
  Partial<LaunchSettings> & { roleText?: string | null }

export type PresetPatch = Partial<LaunchSettings> & { name?: string; roleText?: string | null }

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
  scope: 'operator' | 'daily'
  operatorId: number | null
  spentUsd: number
  capUsd: number
  pct: number
}
