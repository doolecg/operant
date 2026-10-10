export type AgentKind = 'claude' | 'codex' | 'shell' | 'opencode'
export type CacheTtl = 'auto' | '5m' | '1h'
export type McpMode = 'codegraph' | 'none'

export interface Crew {
  id: number
  name: string
  folder: string
  createdAt: number
  // Stable PRJ# shown in the dashboard; never reused.
  prjNumber: number
  sortOrder: number
  // The project group it sits in; null is ungrouped.
  groupId: number | null
  // 'playground' is the built-in, project-less workspace (one row, cannot be deleted, no PRJ number, not in groups).
  kind: CrewKind
}

export type CrewKind = 'project' | 'playground'

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
  mcp: McpMode
}

export interface Preset extends LaunchSettings {
  id: number
  // 'explore' | 'implement' | ... for built-ins, null for user presets.
  builtin: string | null
  name: string
  // null = no guidance text.
  roleText: string | null
  updatedAt: number
  // Local skills the seat may use, hindsight and codegraph on/off for a job that runs this seat.
  skills: string[]
  hindsight: boolean
  codegraph: boolean
  mcpServers: string[]
  // Built-ins only: the lifecycle stage (1 to 8), a one-line summary and when to pick it (see shared/presets.ts).
  stage?: number
  description?: string
  whenToUse?: string
}

// How a Claude tile shows its session: the Chat view (stream-json, claude-chat.ts) or the Terminal view (the TUI in a PTY).
export type ScratchView = 'chat' | 'terminal'

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
  view: ScratchView
  createdAt: number
}

export interface Usage {
  id: number
  scratchId: number | null
  messageId: string | null
  sessionId: string | null
  model: string
  at: number
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

export interface OperantEvent {
  id: number
  crewId: number | null
  kind: string
  message: string
  at: number
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

export interface CrewPatch {
  name?: string
  // Refused while any operator of the crew runs.
  folder?: string
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

export interface Team {
  id: number
  name: string
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

export type TeamInput = Pick<Team, 'name'> & Partial<Pick<Team, 'rules' | 'description'>>
export type TeamPatch = Partial<TeamInput>

// What importing a team file would do, one row per team in it.
export interface TeamImportEntry {
  key: string
  name: string
  action: 'add' | 'skip' | 'invalid'
  reason: string
}

export interface TeamImportPreview {
  path: string
  entries: TeamImportEntry[]
}

export interface ScratchInput {
  crewId: number
  title: string
  agent: AgentKind
  model?: string
  effort?: string
  presetId?: number | null
  // Default: Chat for a Claude tile, Terminal for the others.
  view?: ScratchView
  // Default: the crew folder.
  cwd?: string
}

// Whether a scratch terminal's session is alive right now (a closed tile or an exited one is not).
export interface ScratchStatus {
  scratchId: number
  running: boolean
  sessionId: string | null
  view?: ScratchView
}

// What one scratch terminal spent in a window; terminals without spend are left out.
export interface ScratchSpend {
  scratchId: number
  costUsd: number
  turns: number
}

export type ScratchPatch = Partial<Omit<ScratchInput, 'crewId'>>

export type IpcErrorCode = 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN' | 'BAD_ARGS' | 'RATE_LIMITED' | 'INBOX_FULL' | 'INTERNAL'


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

// Optional integrations (Git MCP, Playwright MCP): never installed by Operant unless the user clicks Add.
export const OPTIONAL_MCP_IDS = ['git', 'playwright', 'codegraph'] as const
export type OptionalMcpId = (typeof OPTIONAL_MCP_IDS)[number]
export interface OptionalMcpTarget {
  cli: McpCli
  scope: McpScope
}
export interface OptionalMcpEntry {
  id: OptionalMcpId
  name: string
  description: string
  enables: string
  // The server name Operant writes into a CLI's config.
  server: string
  // not-added: nothing; added: Operant's own entries; found: the same server under another name or added by hand.
  status: 'not-added' | 'added' | 'found'
  added: OptionalMcpTarget[]
  foundAs?: string
  foundIn?: string
  // The found copy comes from a Claude plugin or connector: shown, never added or removed by Operant.
  provided: boolean
  runtime: { command: string; ok: boolean; error?: string }
  needsProject: boolean
  // Why Add cannot run right now (the runtime is missing, or no project is picked), or null.
  blocked: string | null
  // What a preset that names this server shows while it is not installed.
  hint: string
}

// A server a seat needs that is not working.
export interface McpDown {
  server: string
  state: McpState | 'missing'
  error?: string
  seats: string[]
}

// Usage page (R20): any grouping and filter of the usage rows, with totals that are the sum of the rows.

export type UsageGroupBy = 'day' | 'hour' | 'project' | 'model' | 'cli' | 'provider' | 'source'

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
  // Spend in each budget window ending now; the filter's project, model, CLI and provider apply, its dates do not.
  windows: Record<BudgetWindow, UsageTotals>
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

export type UsageView = { kind: 'report'; query: UsageQuery } | { kind: 'series'; query: UsageSeriesQuery }

export type ExportFormat = 'csv' | 'json'

export interface ExportText {
  filename: string
  mime: string
  text: string
}

// Budgets (R20): caps for the day (the existing daily budget in settings), each project and each job.

// The windows a spend is measured over: the last 5 hours, the local day, the last 7 days.
export type BudgetWindow = 'fiveHour' | 'day' | 'week'

export interface BudgetConfig {
  // Spend per project in each window, by crew id as text; missing or 0 = no budget.
  projectFiveHourUsd: Record<string, number>
  projectDailyUsd: Record<string, number>
  projectWeeklyUsd: Record<string, number>
}

export interface BudgetProgress {
  capUsd: number
  spentUsd: number
  pct: number
}

export interface BudgetStatus {
  config: BudgetConfig
  projects: Array<BudgetProgress & { crewId: number; window: BudgetWindow }>
  // The all-projects caps from settings, one per window that has a cap.
  global: Array<BudgetProgress & { window: BudgetWindow }>
}

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
