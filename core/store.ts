import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  AgentKind,
  CacheTtl,
  CrewView,
  LaunchSettings,
  McpMode,
  OperantEvent,
  OperatorKind,
  Preset,
  ScratchSpend,
  ScratchTerminal,
  SpendArchive,
  UsageBreakdownRow,
  Squad,
  Crew,
  CrewTopology,
  Operator,
  OperatorStatus,
  Job,
  JobReview,
  JobState,
  Link,
  Message,
  MessageKind,
  MessageParty,
  NodePosition,
  Usage,
} from '../shared/types'

// Append-only: each entry runs once, in order, tracked by PRAGMA user_version.
export const MIGRATIONS: string[] = [
  `CREATE TABLE crews (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     folder TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE squads (
     id INTEGER PRIMARY KEY,
     crew_id INTEGER NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     UNIQUE (crew_id, name)
   );
   CREATE TABLE operators (
     id INTEGER PRIMARY KEY,
     squad_id INTEGER NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
     role TEXT NOT NULL,
     agent TEXT NOT NULL,
     model TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'stopped'
   );
   CREATE TABLE tasks (
     id INTEGER PRIMARY KEY,
     crew_id INTEGER NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
     operator_id INTEGER REFERENCES operators(id) ON DELETE SET NULL,
     title TEXT NOT NULL,
     state TEXT NOT NULL DEFAULT 'todo',
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE usage (
     id INTEGER PRIMARY KEY,
     operator_id INTEGER NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
     at INTEGER NOT NULL,
     input_tokens INTEGER NOT NULL DEFAULT 0,
     output_tokens INTEGER NOT NULL DEFAULT 0,
     cache_tokens INTEGER NOT NULL DEFAULT 0,
     cost_usd REAL NOT NULL DEFAULT 0
   );
   CREATE INDEX usage_operator_at ON usage (operator_id, at);
   CREATE TABLE events (
     id INTEGER PRIMARY KEY,
     crew_id INTEGER REFERENCES crews(id) ON DELETE CASCADE,
     operator_id INTEGER REFERENCES operators(id) ON DELETE SET NULL,
     kind TEXT NOT NULL,
     message TEXT NOT NULL,
     at INTEGER NOT NULL
   );
   CREATE INDEX events_at ON events (at);`,
  // Usage is recorded per API message so re-reading a transcript never double counts.
  `ALTER TABLE usage ADD COLUMN message_id TEXT;
   CREATE UNIQUE INDEX usage_operator_message ON usage (operator_id, message_id);`,
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  // Collaboration: tasks become jobs; migrated jobs predate review, so they get review='none'.
  `ALTER TABLE tasks RENAME TO jobs;
   ALTER TABLE jobs RENAME COLUMN operator_id TO assignee_id;
   ALTER TABLE jobs ADD COLUMN body TEXT NOT NULL DEFAULT '';
   ALTER TABLE jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE jobs ADD COLUMN created_by INTEGER REFERENCES operators(id) ON DELETE SET NULL;
   ALTER TABLE jobs ADD COLUMN reviewer_id INTEGER REFERENCES operators(id) ON DELETE SET NULL;
   ALTER TABLE jobs ADD COLUMN lease_until INTEGER;
   ALTER TABLE jobs ADD COLUMN rejects INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE jobs ADD COLUMN note TEXT NOT NULL DEFAULT '';
   ALTER TABLE jobs ADD COLUMN review TEXT NOT NULL DEFAULT 'pm';
   UPDATE jobs SET review = 'none';
   CREATE INDEX jobs_crew_state ON jobs (crew_id, state);
   CREATE INDEX jobs_assignee ON jobs (assignee_id);
   CREATE TABLE job_deps (
     job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
     depends_on_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
     PRIMARY KEY (job_id, depends_on_id),
     CHECK (job_id <> depends_on_id)
   );
   CREATE INDEX job_deps_on ON job_deps (depends_on_id);
   CREATE TABLE messages (
     id INTEGER PRIMARY KEY,
     crew_id INTEGER NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
     from_kind TEXT NOT NULL,
     from_id INTEGER REFERENCES operators(id) ON DELETE SET NULL,
     from_label TEXT NOT NULL DEFAULT '',
     to_kind TEXT NOT NULL,
     to_id INTEGER REFERENCES operators(id) ON DELETE SET NULL,
     to_label TEXT NOT NULL DEFAULT '',
     job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
     kind TEXT NOT NULL DEFAULT 'message',
     body TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     read_at INTEGER
   );
   CREATE INDEX messages_to ON messages (to_kind, to_id, read_at);
   CREATE INDEX messages_crew ON messages (crew_id, created_at);
   CREATE TABLE links (
     id INTEGER PRIMARY KEY,
     crew_id INTEGER NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
     from_id INTEGER NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
     to_id INTEGER NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
     label TEXT NOT NULL DEFAULT ''
   );
   CREATE INDEX links_crew ON links (crew_id);
   CREATE TABLE node_positions (
     crew_id INTEGER NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
     node_key TEXT NOT NULL,
     x REAL NOT NULL,
     y REAL NOT NULL,
     PRIMARY KEY (crew_id, node_key)
   );
   ALTER TABLE operators ADD COLUMN deleted_at INTEGER;`,
  // Presets, operator launch settings, Master slot, scratch terminals, crew views, usage rebuilt
  // (kind split, scratch rows, job attribution) and the spend archive kept after a purge.
  `CREATE TABLE presets (
     id INTEGER PRIMARY KEY,
     builtin TEXT UNIQUE,
     name TEXT NOT NULL UNIQUE,
     agent TEXT NOT NULL,
     model TEXT NOT NULL,
     effort TEXT NOT NULL DEFAULT '',
     permission_mode TEXT NOT NULL,
     tools TEXT NOT NULL DEFAULT '',
     allow TEXT NOT NULL DEFAULT '[]',
     deny TEXT NOT NULL DEFAULT '[]',
     cache_ttl TEXT NOT NULL DEFAULT 'auto',
     context_cap INTEGER NOT NULL DEFAULT 0,
     clear_between_jobs INTEGER NOT NULL DEFAULT 1,
     mcp TEXT NOT NULL DEFAULT 'codegraph',
     role_text TEXT,
     updated_at INTEGER NOT NULL
   );
   ALTER TABLE operators ADD COLUMN preset_id INTEGER REFERENCES presets(id) ON DELETE SET NULL;
   ALTER TABLE operators ADD COLUMN kind TEXT NOT NULL DEFAULT 'worker';
   ALTER TABLE operators ADD COLUMN effort TEXT NOT NULL DEFAULT '';
   ALTER TABLE operators ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'default';
   ALTER TABLE operators ADD COLUMN tools TEXT NOT NULL DEFAULT '';
   ALTER TABLE operators ADD COLUMN allow TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE operators ADD COLUMN deny TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE operators ADD COLUMN cache_ttl TEXT NOT NULL DEFAULT 'auto';
   ALTER TABLE operators ADD COLUMN context_cap INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE operators ADD COLUMN clear_between_jobs INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE operators ADD COLUMN mcp TEXT NOT NULL DEFAULT 'codegraph';
   ALTER TABLE operators ADD COLUMN role_text TEXT;
   ALTER TABLE operators ADD COLUMN daily_cap_usd REAL;
   ALTER TABLE operators ADD COLUMN session_id TEXT;
   ALTER TABLE squads ADD COLUMN system INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE squads ADD COLUMN deleted_at INTEGER;
   ALTER TABLE crews ADD COLUMN view TEXT NOT NULL DEFAULT 'cards';
   ALTER TABLE crews ADD COLUMN pm_id INTEGER REFERENCES operators(id) ON DELETE SET NULL;
   ALTER TABLE crews ADD COLUMN tile_layout TEXT NOT NULL DEFAULT '{}';
   ALTER TABLE jobs ADD COLUMN estimate_minutes INTEGER;
   ALTER TABLE jobs ADD COLUMN started_at INTEGER;
   ALTER TABLE jobs ADD COLUMN escalation TEXT NOT NULL DEFAULT '';
   CREATE TABLE scratch (
     id INTEGER PRIMARY KEY,
     crew_id INTEGER NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
     title TEXT NOT NULL,
     agent TEXT NOT NULL,
     model TEXT NOT NULL DEFAULT '',
     effort TEXT NOT NULL DEFAULT '',
     preset_id INTEGER REFERENCES presets(id) ON DELETE SET NULL,
     cwd TEXT NOT NULL,
     session_id TEXT,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE usage_new (
     id INTEGER PRIMARY KEY,
     operator_id INTEGER REFERENCES operators(id) ON DELETE CASCADE,
     scratch_id INTEGER REFERENCES scratch(id) ON DELETE SET NULL,
     message_id TEXT,
     session_id TEXT,
     model TEXT NOT NULL DEFAULT '',
     at INTEGER NOT NULL,
     job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
     input_tokens INTEGER NOT NULL DEFAULT 0,
     output_tokens INTEGER NOT NULL DEFAULT 0,
     cache_read INTEGER NOT NULL DEFAULT 0,
     cache_w5m INTEGER NOT NULL DEFAULT 0,
     cache_w1h INTEGER NOT NULL DEFAULT 0,
     cost_usd REAL NOT NULL DEFAULT 0,
     context_tokens INTEGER NOT NULL DEFAULT 0,
     cold INTEGER NOT NULL DEFAULT 0,
     tool_use INTEGER NOT NULL DEFAULT 0,
     legacy INTEGER NOT NULL DEFAULT 0
   );
   INSERT INTO usage_new (id, operator_id, message_id, at, input_tokens, output_tokens, cache_read, cost_usd, legacy)
     SELECT id, operator_id, message_id, at, input_tokens, output_tokens, cache_tokens, cost_usd, 1 FROM usage;
   DROP TABLE usage;
   ALTER TABLE usage_new RENAME TO usage;
   CREATE UNIQUE INDEX usage_operator_message ON usage (operator_id, message_id);
   CREATE UNIQUE INDEX usage_scratch_message ON usage (scratch_id, message_id);
   CREATE INDEX usage_operator_at ON usage (operator_id, at);
   CREATE INDEX usage_at ON usage (at);
   CREATE TABLE spend_archive (
     crew_id INTEGER NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
     day INTEGER NOT NULL,
     label TEXT NOT NULL,
     model TEXT NOT NULL,
     input_tokens INTEGER,
     output_tokens INTEGER,
     cache_read INTEGER,
     cache_w5m INTEGER,
     cache_w1h INTEGER,
     cost_usd REAL NOT NULL,
     PRIMARY KEY (crew_id, day, label, model)
   );`,
  // Pre-assignment becomes a column; the job engine used to keep it in a lazily created side table.
  `ALTER TABLE jobs ADD COLUMN preassigned_id INTEGER REFERENCES operators(id) ON DELETE SET NULL;
   CREATE TABLE IF NOT EXISTS job_preassigned (job_id INTEGER PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE);
   UPDATE jobs SET preassigned_id = assignee_id WHERE id IN (SELECT job_id FROM job_preassigned);
   DROP TABLE job_preassigned;`,
]

type Row = Record<string, unknown>

const toCrew = (r: Row): Crew => ({
  id: Number(r.id),
  name: String(r.name),
  folder: String(r.folder),
  createdAt: Number(r.created_at),
  view: r.view as CrewView,
  pmId: r.pm_id == null ? null : Number(r.pm_id),
})
const toSquad = (r: Row): Squad => ({
  id: Number(r.id),
  crewId: Number(r.crew_id),
  name: String(r.name),
  system: Number(r.system) === 1,
})
const parseList = (v: unknown): string[] => {
  try {
    const a: unknown = JSON.parse(String(v))
    return Array.isArray(a) ? a.map(String) : []
  } catch {
    return []
  }
}
const toLaunch = (r: Row): LaunchSettings => ({
  agent: r.agent as AgentKind,
  model: String(r.model),
  effort: String(r.effort),
  permissionMode: String(r.permission_mode),
  tools: String(r.tools),
  allow: parseList(r.allow),
  deny: parseList(r.deny),
  cacheTtl: r.cache_ttl as CacheTtl,
  contextCap: Number(r.context_cap),
  clearBetweenJobs: Number(r.clear_between_jobs) === 1,
  mcp: r.mcp as McpMode,
})
const toOperator = (r: Row): Operator => ({
  ...toLaunch(r),
  id: Number(r.id),
  squadId: Number(r.squad_id),
  role: String(r.role),
  status: r.status as OperatorStatus,
  kind: r.kind as OperatorKind,
  presetId: r.preset_id == null ? null : Number(r.preset_id),
  roleText: r.role_text == null ? null : String(r.role_text),
  dailyCapUsd: r.daily_cap_usd == null ? null : Number(r.daily_cap_usd),
  sessionId: r.session_id == null ? null : String(r.session_id),
  modified: Number(r.modified) === 1,
})
const toPreset = (r: Row): Preset => ({
  ...toLaunch(r),
  id: Number(r.id),
  builtin: r.builtin == null ? null : String(r.builtin),
  name: String(r.name),
  roleText: r.role_text == null ? null : String(r.role_text),
  updatedAt: Number(r.updated_at),
})
const toScratch = (r: Row): ScratchTerminal => ({
  id: Number(r.id),
  crewId: Number(r.crew_id),
  title: String(r.title),
  agent: r.agent as AgentKind,
  model: String(r.model),
  effort: String(r.effort),
  presetId: r.preset_id == null ? null : Number(r.preset_id),
  cwd: String(r.cwd),
  sessionId: r.session_id == null ? null : String(r.session_id),
  createdAt: Number(r.created_at),
})

// 'modified' is derived: any launch field (or an own role text) differs from the operator's preset.
const OPERATOR_SELECT = `SELECT s.*, CASE
    WHEN pr.id IS NULL OR s.kind = 'master' THEN 0
    WHEN s.agent <> pr.agent OR s.model <> pr.model OR s.effort <> pr.effort OR s.permission_mode <> pr.permission_mode
      OR s.tools <> pr.tools OR s.allow <> pr.allow OR s.deny <> pr.deny OR s.cache_ttl <> pr.cache_ttl
      OR s.context_cap <> pr.context_cap OR s.clear_between_jobs <> pr.clear_between_jobs OR s.mcp <> pr.mcp
      OR (s.role_text IS NOT NULL AND s.role_text IS NOT pr.role_text) THEN 1
    ELSE 0 END AS modified
  FROM operators s LEFT JOIN presets pr ON pr.id = s.preset_id`

type PresetFields = Omit<Preset, 'id' | 'updatedAt'>

const toJob = (r: Row): Job => ({
  id: Number(r.id),
  crewId: Number(r.crew_id),
  assigneeId: r.assignee_id == null ? null : Number(r.assignee_id),
  title: String(r.title),
  body: String(r.body),
  state: r.state as JobState,
  priority: Number(r.priority),
  createdBy: r.created_by == null ? null : Number(r.created_by),
  reviewerId: r.reviewer_id == null ? null : Number(r.reviewer_id),
  review: r.review as JobReview,
  leaseUntil: r.lease_until == null ? null : Number(r.lease_until),
  rejects: Number(r.rejects),
  note: String(r.note),
  estimateMinutes: r.estimate_minutes == null ? null : Number(r.estimate_minutes),
  startedAt: r.started_at == null ? null : Number(r.started_at),
  escalation: String(r.escalation),
  preassignedId: r.preassigned_id == null ? null : Number(r.preassigned_id),
  blocked: Number(r.blocked) === 1,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
})
const toMessage = (r: Row): Message => ({
  id: Number(r.id),
  crewId: Number(r.crew_id),
  fromKind: r.from_kind as MessageParty,
  fromId: r.from_id == null ? null : Number(r.from_id),
  fromLabel: String(r.from_label),
  toKind: r.to_kind as MessageParty,
  toId: r.to_id == null ? null : Number(r.to_id),
  toLabel: String(r.to_label),
  jobId: r.job_id == null ? null : Number(r.job_id),
  kind: r.kind as MessageKind,
  body: String(r.body),
  createdAt: Number(r.created_at),
  readAt: r.read_at == null ? null : Number(r.read_at),
})
const toLink = (r: Row): Link => ({
  id: Number(r.id),
  crewId: Number(r.crew_id),
  fromId: Number(r.from_id),
  toId: Number(r.to_id),
  label: String(r.label),
})

const JOB_SELECT = `SELECT j.*, EXISTS (
    SELECT 1 FROM job_deps d JOIN jobs p ON p.id = d.depends_on_id WHERE d.job_id = j.id AND p.state <> 'done'
  ) AS blocked FROM jobs j`

export interface NewJob {
  crewId: number
  title: string
  body?: string
  assigneeId?: number | null
  priority?: number
  createdBy?: number | null
  reviewerId?: number | null
  review?: JobReview
}

export type JobPatch = Partial<
  Pick<Job, 'title' | 'body' | 'state' | 'priority' | 'assigneeId' | 'reviewerId' | 'review' | 'leaseUntil' | 'rejects' | 'note'>
>

const JOB_COLUMNS: Record<keyof JobPatch, string> = {
  title: 'title',
  body: 'body',
  state: 'state',
  priority: 'priority',
  assigneeId: 'assignee_id',
  reviewerId: 'reviewer_id',
  review: 'review',
  leaseUntil: 'lease_until',
  rejects: 'rejects',
  note: 'note',
}

const IMPLEMENTOR_TOOLS = 'Read,Grep,Glob,Edit,Write,Bash'
const IMPLEMENTOR_ALLOW = ['Bash(operant *)', 'Bash(npm run *)', 'Bash(npm test*)', 'Bash(git diff*)', 'Bash(git status*)']
const IMPLEMENTOR_DENY = ['Bash(git push*)', 'Bash(git commit*)']
const TESTER_PATHS = ['**/test/**', '**/*.test.*', 'e2e/**']

// The shipped presets. Role text is null: the text lives in plugin/roles/<builtin>.md.
export const BUILTIN_PRESETS: PresetFields[] = [
  {
    builtin: 'pm',
    name: 'project manager',
    agent: 'claude',
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    permissionMode: 'dontAsk',
    tools: 'Read,Grep,Glob,Bash',
    allow: ['Bash(operant *)', 'Bash(git log*)', 'Bash(git diff*)'],
    deny: [],
    cacheTtl: '1h',
    contextCap: 150_000,
    clearBetweenJobs: false,
    mcp: 'codegraph',
    roleText: null,
  },
  {
    builtin: 'researcher',
    name: 'researcher',
    agent: 'claude',
    model: 'claude-haiku-4-5',
    effort: '',
    permissionMode: 'dontAsk',
    tools: 'Read,Grep,Glob,Bash,WebFetch,WebSearch',
    allow: ['Bash(operant *)', 'Bash(codegraph *)', 'WebFetch', 'WebSearch'],
    deny: [],
    cacheTtl: '5m',
    contextCap: 100_000,
    clearBetweenJobs: true,
    mcp: 'codegraph',
    roleText: null,
  },
  {
    builtin: 'designer',
    name: 'designer',
    agent: 'claude',
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    permissionMode: 'dontAsk',
    tools: IMPLEMENTOR_TOOLS,
    allow: ['Edit(docs/design/**)', 'Write(docs/design/**)', 'Bash(operant *)'],
    deny: [],
    cacheTtl: 'auto',
    contextCap: 150_000,
    clearBetweenJobs: true,
    mcp: 'codegraph',
    roleText: null,
  },
  {
    builtin: 'implementor',
    name: 'implementor',
    agent: 'claude',
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    permissionMode: 'acceptEdits',
    tools: IMPLEMENTOR_TOOLS,
    allow: IMPLEMENTOR_ALLOW,
    deny: IMPLEMENTOR_DENY,
    cacheTtl: 'auto',
    contextCap: 200_000,
    clearBetweenJobs: true,
    mcp: 'codegraph',
    roleText: null,
  },
  {
    builtin: 'senior',
    name: 'senior implementor',
    agent: 'claude',
    model: 'claude-opus-5-5',
    effort: 'medium',
    permissionMode: 'acceptEdits',
    tools: IMPLEMENTOR_TOOLS,
    allow: IMPLEMENTOR_ALLOW,
    deny: IMPLEMENTOR_DENY,
    cacheTtl: '1h',
    contextCap: 300_000,
    clearBetweenJobs: true,
    mcp: 'codegraph',
    roleText: null,
  },
  {
    builtin: 'tester',
    name: 'tester',
    agent: 'claude',
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    permissionMode: 'dontAsk',
    tools: IMPLEMENTOR_TOOLS,
    allow: [
      'Bash(operant *)',
      'Bash(npm *)',
      'Bash(npx *)',
      'Bash(node *)',
      'Bash(git diff*)',
      ...TESTER_PATHS.map((g) => `Edit(${g})`),
      ...TESTER_PATHS.map((g) => `Write(${g})`),
    ],
    deny: [],
    cacheTtl: 'auto',
    contextCap: 120_000,
    clearBetweenJobs: true,
    mcp: 'codegraph',
    roleText: null,
  },
  {
    builtin: 'reviewer',
    name: 'reviewer',
    agent: 'claude',
    model: 'claude-sonnet-5-5',
    effort: 'high',
    permissionMode: 'dontAsk',
    tools: 'Read,Grep,Glob,Bash',
    allow: ['Bash(operant *)', 'Bash(git diff*)', 'Bash(git log*)', 'Bash(git show*)'],
    deny: [],
    cacheTtl: '1h',
    contextCap: 150_000,
    clearBetweenJobs: true,
    mcp: 'codegraph',
    roleText: null,
  },
]

export type NewPreset = Pick<PresetFields, 'name' | 'agent' | 'model' | 'permissionMode'> &
  Partial<Omit<PresetFields, 'builtin'>>

export type PresetPatch = Partial<Omit<PresetFields, 'builtin'>>

const LAUNCH_COLUMNS = {
  agent: 'agent',
  model: 'model',
  effort: 'effort',
  permissionMode: 'permission_mode',
  tools: 'tools',
  allow: 'allow',
  deny: 'deny',
  cacheTtl: 'cache_ttl',
  contextCap: 'context_cap',
  clearBetweenJobs: 'clear_between_jobs',
  mcp: 'mcp',
}
const OPERATOR_COLUMNS: Record<string, string> = {
  ...LAUNCH_COLUMNS,
  roleText: 'role_text',
  dailyCapUsd: 'daily_cap_usd',
  presetId: 'preset_id',
}
const PRESET_COLUMNS: Record<string, string> = { ...LAUNCH_COLUMNS, name: 'name', roleText: 'role_text', updatedAt: 'updated_at' }
const SCRATCH_COLUMNS: Record<string, string> = {
  title: 'title',
  agent: 'agent',
  model: 'model',
  effort: 'effort',
  presetId: 'preset_id',
  cwd: 'cwd',
  sessionId: 'session_id',
}

export type OperatorLaunchPatch = Partial<LaunchSettings> & {
  roleText?: string | null
  dailyCapUsd?: number | null
  presetId?: number | null
}

export interface ScratchInput {
  crewId: number
  title: string
  agent: AgentKind
  model?: string
  effort?: string
  presetId?: number | null
  cwd: string
}

export type ScratchPatch = Partial<Omit<ScratchInput, 'crewId'>> & { sessionId?: string | null }

// One assistant message's usage. `cacheTokens` is the pre-split total, kept for callers that
// cannot tell the kinds apart: it is recorded as cache reads when no kind is given.
export interface UsageInput {
  operatorId?: number | null
  scratchId?: number | null
  messageId?: string | null
  sessionId?: string | null
  model?: string
  at: number
  jobId?: number | null
  inputTokens: number
  outputTokens: number
  cacheRead?: number
  cacheW5m?: number
  cacheW1h?: number
  cacheTokens?: number
  costUsd: number
  contextTokens?: number
  cold?: boolean
  toolUse?: boolean
}

export type UsageTarget = { crewId: number } | { operatorId: number }

const SYSTEM_SQUAD = '__system__'
const MASTER_ROLE = 'master'
const startOfDay = (t: number) => {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export interface NewMessage {
  crewId: number
  fromKind: MessageParty
  fromId?: number | null
  fromLabel?: string
  toKind: MessageParty
  toId?: number | null
  toLabel?: string
  jobId?: number | null
  kind?: MessageKind
  body: string
}

export interface MessageFilter {
  toKind?: MessageParty
  toId?: number | null
  unreadOnly?: boolean
  limit?: number
}

const nullable = (v: unknown): number | null => (v == null ? null : Number(v))
const toUsage = (r: Row): Usage => ({
  id: Number(r.id),
  operatorId: nullable(r.operator_id),
  scratchId: nullable(r.scratch_id),
  messageId: r.message_id == null ? null : String(r.message_id),
  sessionId: r.session_id == null ? null : String(r.session_id),
  model: String(r.model),
  at: Number(r.at),
  jobId: nullable(r.job_id),
  inputTokens: Number(r.input_tokens),
  outputTokens: Number(r.output_tokens),
  cacheRead: Number(r.cache_read),
  cacheW5m: Number(r.cache_w5m),
  cacheW1h: Number(r.cache_w1h),
  cacheTokens: Number(r.cache_read) + Number(r.cache_w5m) + Number(r.cache_w1h),
  costUsd: Number(r.cost_usd),
  contextTokens: Number(r.context_tokens),
  cold: Number(r.cold) === 1,
  toolUse: Number(r.tool_use) === 1,
  legacy: Number(r.legacy) === 1,
})
const toEvent = (r: Row): OperantEvent => ({
  id: Number(r.id),
  crewId: r.crew_id == null ? null : Number(r.crew_id),
  operatorId: r.operator_id == null ? null : Number(r.operator_id),
  kind: String(r.kind),
  message: String(r.message),
  at: Number(r.at),
})

export class Store {
  readonly db: DatabaseSync

  constructor(file: string, private readonly now: () => number = Date.now) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA foreign_keys = ON')
    if (file !== ':memory:') {
      this.db.exec('PRAGMA busy_timeout = 5000')
      this.db.exec('PRAGMA journal_mode = WAL')
    }
    this.migrate()
    this.seedBuiltinPresets()
  }

  get schemaVersion(): number {
    return Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version)
  }

  private migrate(): void {
    for (let v = this.schemaVersion; v < MIGRATIONS.length; v++) {
      this.db.exec('BEGIN')
      try {
        this.db.exec(MIGRATIONS[v]!)
        this.db.exec(`PRAGMA user_version = ${v + 1}`)
        this.db.exec('COMMIT')
      } catch (err) {
        this.db.exec('ROLLBACK')
        throw err
      }
    }
  }

  close(): void {
    this.db.close()
  }

  // Crews

  createCrew(name: string, folder: string): Crew {
    const row = this.db
      .prepare('INSERT INTO crews (name, folder, created_at) VALUES (?, ?, ?) RETURNING *')
      .get(name, folder, this.now()) as Row
    return toCrew(row)
  }

  listCrews(): Crew[] {
    return (this.db.prepare('SELECT * FROM crews ORDER BY name').all() as Row[]).map(toCrew)
  }

  getCrew(id: number): Crew | null {
    const row = this.db.prepare('SELECT * FROM crews WHERE id = ?').get(id) as Row | undefined
    return row ? toCrew(row) : null
  }

  updateCrew(id: number, patch: { name?: string; folder?: string; view?: CrewView; pmId?: number | null }): Crew {
    const cur = this.getCrew(id)
    if (!cur) throw new Error(`Crew ${id} not found`)
    const pmId = patch.pmId === undefined ? cur.pmId : patch.pmId
    if (pmId != null && this.crewIdOfOperator(pmId) !== id) throw new Error('The PM must be a live operator of this crew')
    const row = this.db
      .prepare('UPDATE crews SET name = ?, folder = ?, view = ?, pm_id = ? WHERE id = ? RETURNING *')
      .get(patch.name ?? cur.name, patch.folder ?? cur.folder, patch.view ?? cur.view, pmId, id) as Row
    return toCrew(row)
  }

  getCrewView(id: number): CrewView {
    const crew = this.getCrew(id)
    if (!crew) throw new Error(`Crew ${id} not found`)
    return crew.view
  }

  setCrewView(id: number, view: CrewView): Crew {
    return this.updateCrew(id, { view })
  }

  // The tiles view's split tree, stored as JSON; its shape belongs to the renderer.
  getTileLayout(crewId: number): unknown {
    const row = this.db.prepare('SELECT tile_layout FROM crews WHERE id = ?').get(crewId) as Row | undefined
    if (!row) throw new Error(`Crew ${crewId} not found`)
    try {
      return JSON.parse(String(row.tile_layout))
    } catch {
      return {}
    }
  }

  setTileLayout(crewId: number, layout: unknown): void {
    if (!this.getCrew(crewId)) throw new Error(`Crew ${crewId} not found`)
    this.db.prepare('UPDATE crews SET tile_layout = ? WHERE id = ?').run(JSON.stringify(layout ?? {}), crewId)
  }

  deleteCrew(id: number): void {
    this.db.prepare('DELETE FROM crews WHERE id = ?').run(id)
  }

  topology(crewId: number): CrewTopology | null {
    const crew = this.getCrew(crewId)
    if (!crew) return null
    const squads = (
      this.db.prepare('SELECT * FROM squads WHERE crew_id = ? AND system = 0 AND deleted_at IS NULL ORDER BY id').all(crewId) as Row[]
    ).map(toSquad)
    const operators = (
      this.db
        .prepare(
          `${OPERATOR_SELECT} JOIN squads p ON p.id = s.squad_id
           WHERE p.crew_id = ? AND p.system = 0 AND s.deleted_at IS NULL ORDER BY s.id`,
        )
        .all(crewId) as Row[]
    ).map(toOperator)
    return { ...crew, squads: squads.map((p) => ({ ...p, operators: operators.filter((s) => s.squadId === p.id) })) }
  }

  private txDepth = 0

  private tx<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn()
    this.db.exec('BEGIN')
    this.txDepth++
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    } finally {
      this.txDepth--
    }
  }

  // Squads and operators

  // A squad name is unique per crew, deleted squads included, so creating one under the name of a
  // deleted squad revives that row (its operators stay deleted).
  createSquad(crewId: number, name: string): Squad {
    if (name === SYSTEM_SQUAD) throw new Error(`"${name}" is a reserved squad name`)
    const dead = this.db
      .prepare('SELECT id FROM squads WHERE crew_id = ? AND name = ? AND deleted_at IS NOT NULL')
      .get(crewId, name) as Row | undefined
    if (dead) return toSquad(this.db.prepare('UPDATE squads SET deleted_at = NULL WHERE id = ? RETURNING *').get(Number(dead.id)) as Row)
    return toSquad(this.db.prepare('INSERT INTO squads (crew_id, name) VALUES (?, ?) RETURNING *').get(crewId, name) as Row)
  }

  getSquad(id: number): Squad | null {
    const row = this.db.prepare('SELECT * FROM squads WHERE id = ? AND deleted_at IS NULL').get(id) as Row | undefined
    return row ? toSquad(row) : null
  }

  renameSquad(id: number, name: string): Squad {
    if (this.getSquad(id)?.system) throw new Error('The system squad cannot be renamed')
    const row = this.db
      .prepare('UPDATE squads SET name = ? WHERE id = ? AND deleted_at IS NULL RETURNING *')
      .get(name, id) as Row | undefined
    if (!row) throw new Error(`Squad ${id} not found`)
    return toSquad(row)
  }

  // Soft delete: the squad and its live operators are hidden but keep their history. Returns false when
  // the squad is already gone. `purgeSquadIfEmpty` removes the row once no operator references it.
  deleteSquad(id: number): boolean {
    const squad = this.getSquad(id)
    if (!squad) return false
    if (squad.system) throw new Error('The system squad cannot be deleted')
    const t = this.now()
    this.tx(() => {
      this.db
        .prepare('UPDATE crews SET pm_id = NULL WHERE pm_id IN (SELECT id FROM operators WHERE squad_id = ? AND deleted_at IS NULL)')
        .run(id)
      this.db
        .prepare('DELETE FROM links WHERE from_id IN (SELECT id FROM operators WHERE squad_id = ?) OR to_id IN (SELECT id FROM operators WHERE squad_id = ?)')
        .run(id, id)
      this.db.prepare('UPDATE operators SET deleted_at = ? WHERE squad_id = ? AND deleted_at IS NULL').run(t, id)
      this.db.prepare('UPDATE squads SET deleted_at = ? WHERE id = ?').run(t, id)
    })
    return true
  }

  // Hard-deletes the squad row only when no operator row, live or soft-deleted, references it.
  purgeSquadIfEmpty(id: number): boolean {
    const res = this.db
      .prepare('DELETE FROM squads WHERE id = ? AND system = 0 AND NOT EXISTS (SELECT 1 FROM operators WHERE squad_id = ?)')
      .run(id, id)
    return Number(res.changes) > 0
  }

  private assertRoleFree(crewId: number, role: string, exceptOperatorId: number | null): void {
    if (role === MASTER_ROLE) throw new Error(`Role "${role}" is reserved for the Master Terminal`)
    const taken = this.db
      .prepare(
        `SELECT 1 FROM operators s JOIN squads p ON p.id = s.squad_id
         WHERE p.crew_id = ? AND s.role = ? AND s.deleted_at IS NULL AND s.id <> ?`,
      )
      .get(crewId, role, exceptOperatorId ?? -1)
    if (taken) throw new Error(`Role "${role}" is already used by another operator in this crew`)
  }

  createOperator(squadId: number, role: string, agent: AgentKind, model: string): Operator {
    const squad = this.getSquad(squadId)
    if (!squad) throw new Error(`Squad ${squadId} not found`)
    if (squad.system) throw new Error('Operators cannot be added to the system squad')
    this.assertRoleFree(squad.crewId, role, null)
    const row = this.db
      .prepare('INSERT INTO operators (squad_id, role, agent, model) VALUES (?, ?, ?, ?) RETURNING id')
      .get(squadId, role, agent, model) as Row
    return this.getOperator(Number(row.id))!
  }

  // Copies the preset's launch settings into a new operator; `agent` and `model` may be overridden.
  createOperatorFromPreset(squadId: number, role: string, presetId: number, override: { agent?: AgentKind; model?: string } = {}): Operator {
    const preset = this.getPreset(presetId)
    if (!preset) throw new Error(`Preset ${presetId} not found`)
    const op = this.createOperator(squadId, role, override.agent ?? preset.agent, override.model ?? preset.model)
    return this.applyPresetToOperator(op.id, presetId, override)
  }

  getOperator(id: number): Operator | null {
    const row = this.db.prepare(`${OPERATOR_SELECT} WHERE s.id = ? AND s.deleted_at IS NULL`).get(id) as Row | undefined
    return row ? toOperator(row) : null
  }

  updateOperator(id: number, patch: { role?: string; agent?: AgentKind; model?: string; squadId?: number }): Operator {
    const cur = this.getOperator(id)
    if (!cur) throw new Error(`Operator ${id} not found`)
    const crewId = this.crewIdOfOperator(id)!
    const squadId = patch.squadId ?? cur.squadId
    if (squadId !== cur.squadId) {
      const target = this.getSquad(squadId)
      if (target?.crewId !== crewId) throw new Error('An operator can only move to a squad in its own crew')
      if (target.system || cur.kind === 'master') throw new Error('The Master Terminal stays in the system squad')
    }
    const role = patch.role ?? cur.role
    if (cur.kind === 'master' && role !== cur.role) throw new Error('The Master Terminal role cannot change')
    if (role !== cur.role) this.assertRoleFree(crewId, role, id)
    this.db
      .prepare('UPDATE operators SET squad_id = ?, role = ?, agent = ?, model = ? WHERE id = ?')
      .run(squadId, role, patch.agent ?? cur.agent, patch.model ?? cur.model, id)
    return this.getOperator(id)!
  }

  // Sets launch settings, the role text, the daily cap or the preset link.
  setOperatorLaunch(id: number, patch: OperatorLaunchPatch): Operator {
    if (!this.getOperator(id)) throw new Error(`Operator ${id} not found`)
    if (patch.presetId != null && !this.getPreset(patch.presetId)) throw new Error(`Preset ${patch.presetId} not found`)
    this.writeColumns('operators', id, patch as Record<string, unknown>, OPERATOR_COLUMNS)
    return this.getOperator(id)!
  }

  // Copies a preset's launch settings over the operator ("Revert to preset"); defaults to its own preset.
  applyPresetToOperator(id: number, presetId?: number, override: { agent?: AgentKind; model?: string } = {}): Operator {
    const op = this.getOperator(id)
    if (!op) throw new Error(`Operator ${id} not found`)
    const pid = presetId ?? op.presetId
    const preset = pid == null ? null : this.getPreset(pid)
    if (!preset) throw new Error('Operator has no preset to apply')
    const { id: _id, builtin: _b, name: _n, roleText: _r, updatedAt: _u, ...launch } = preset
    return this.setOperatorLaunch(id, { ...launch, ...override, roleText: null, presetId: preset.id })
  }

  // "Save as new preset": the operator's current settings become a user preset it is then linked to.
  presetFromOperator(id: number, name: string): Preset {
    const op = this.getOperator(id)
    if (!op) throw new Error(`Operator ${id} not found`)
    const preset = this.createPreset({
      name,
      agent: op.agent,
      model: op.model,
      effort: op.effort,
      permissionMode: op.permissionMode,
      tools: op.tools,
      allow: op.allow,
      deny: op.deny,
      cacheTtl: op.cacheTtl,
      contextCap: op.contextCap,
      clearBetweenJobs: op.clearBetweenJobs,
      mcp: op.mcp,
      roleText: op.roleText ?? this.getPreset(op.presetId ?? -1)?.roleText ?? null,
    })
    this.writeColumns('operators', id, { presetId: preset.id, roleText: null }, OPERATOR_COLUMNS)
    return preset
  }

  operatorsOfPreset(presetId: number): Operator[] {
    return (this.db.prepare(`${OPERATOR_SELECT} WHERE s.preset_id = ? AND s.deleted_at IS NULL ORDER BY s.id`).all(presetId) as Row[]).map(
      toOperator,
    )
  }

  setOperatorSession(id: number, sessionId: string | null): void {
    this.db.prepare('UPDATE operators SET session_id = ? WHERE id = ?').run(sessionId, id)
  }

  // Soft delete: the row stays for history (usage, messages, jobs) until a purge. The Master slot is
  // stopped, never deleted.
  deleteOperator(id: number): void {
    if (this.getOperator(id)?.kind === 'master') throw new Error('The Master Terminal cannot be deleted')
    this.tx(() => {
      this.db.prepare('UPDATE crews SET pm_id = NULL WHERE pm_id = ?').run(id)
      this.db.prepare('DELETE FROM links WHERE from_id = ? OR to_id = ?').run(id, id)
      this.db.prepare('UPDATE operators SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(this.now(), id)
    })
  }

  // The crew's Master Terminal slot, living in its hidden system squad.
  getMaster(crewId: number): Operator | null {
    const row = this.db
      .prepare(`${OPERATOR_SELECT} JOIN squads p ON p.id = s.squad_id WHERE p.crew_id = ? AND s.kind = 'master' AND s.deleted_at IS NULL`)
      .get(crewId) as Row | undefined
    return row ? toOperator(row) : null
  }

  // Created lazily, and recreated if missing. It has no preset: it runs the user's own Claude Code.
  ensureMaster(crewId: number): Operator {
    const existing = this.getMaster(crewId)
    if (existing) return existing
    if (!this.getCrew(crewId)) throw new Error(`Crew ${crewId} not found`)
    return this.tx(() => {
      let squad = this.db.prepare('SELECT id FROM squads WHERE crew_id = ? AND system = 1').get(crewId) as Row | undefined
      squad ??= this.db.prepare('INSERT INTO squads (crew_id, name, system) VALUES (?, ?, 1) RETURNING id').get(crewId, SYSTEM_SQUAD) as Row
      const row = this.db
        .prepare("INSERT INTO operators (squad_id, role, agent, model, kind) VALUES (?, ?, 'claude', '', 'master') RETURNING id")
        .get(Number(squad.id), MASTER_ROLE) as Row
      return this.getOperator(Number(row.id))!
    })
  }

  setOperatorStatus(id: number, status: OperatorStatus): void {
    this.db.prepare('UPDATE operators SET status = ? WHERE id = ? AND deleted_at IS NULL').run(status, id)
  }

  // Dynamic UPDATE of the columns named in `patch`; undefined values are skipped.
  private writeColumns(table: string, id: number, patch: Record<string, unknown>, columns: Record<string, string>): void {
    const keys = Object.keys(patch).filter((k) => k in columns && patch[k] !== undefined)
    if (keys.length === 0) return
    const values = keys.map((k) => {
      const v = patch[k]
      if (Array.isArray(v)) return JSON.stringify(v)
      if (typeof v === 'boolean') return v ? 1 : 0
      return (v ?? null) as string | number | null
    })
    this.db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${columns[k]} = ?`).join(', ')} WHERE id = ?`).run(...values, id)
  }

  // Presets

  private presetNameFree(name: string, exceptId: number | null): string {
    let candidate = name
    for (let n = 2; this.db.prepare('SELECT 1 FROM presets WHERE name = ? AND id <> ?').get(candidate, exceptId ?? -1); n++) {
      candidate = `${name} (${n})`
    }
    return candidate
  }

  private insertPreset(f: PresetFields): Preset {
    const row = this.db
      .prepare(
        `INSERT INTO presets (builtin, name, agent, model, effort, permission_mode, tools, allow, deny, cache_ttl,
           context_cap, clear_between_jobs, mcp, role_text, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        f.builtin,
        f.name,
        f.agent,
        f.model,
        f.effort,
        f.permissionMode,
        f.tools,
        JSON.stringify(f.allow),
        JSON.stringify(f.deny),
        f.cacheTtl,
        f.contextCap,
        f.clearBetweenJobs ? 1 : 0,
        f.mcp,
        f.roleText,
        this.now(),
      ) as Row
    return toPreset(row)
  }

  // Built-ins are inserted by core, once, so a preset the user deleted stays deleted until
  // `restoreBuiltins`.
  seedBuiltinPresets(): void {
    if (this.getJson('presets.seeded') === true) return
    this.tx(() => {
      this.restoreBuiltins()
      this.setJson('presets.seeded', true)
    })
  }

  // Re-adds any built-in preset that is missing; returns the ones added.
  restoreBuiltins(): Preset[] {
    return this.tx(() =>
      BUILTIN_PRESETS.filter((b) => !this.getPresetByBuiltin(b.builtin!)).map((b) =>
        this.insertPreset({ ...b, name: this.presetNameFree(b.name, null) }),
      ),
    )
  }

  listPresets(): Preset[] {
    return (this.db.prepare('SELECT * FROM presets ORDER BY builtin IS NULL, id').all() as Row[]).map(toPreset)
  }

  getPreset(id: number): Preset | null {
    const row = this.db.prepare('SELECT * FROM presets WHERE id = ?').get(id) as Row | undefined
    return row ? toPreset(row) : null
  }

  getPresetByBuiltin(builtin: string): Preset | null {
    const row = this.db.prepare('SELECT * FROM presets WHERE builtin = ?').get(builtin) as Row | undefined
    return row ? toPreset(row) : null
  }

  createPreset(input: NewPreset): Preset {
    return this.insertPreset({
      effort: '',
      tools: '',
      allow: [],
      deny: [],
      cacheTtl: 'auto',
      contextCap: 0,
      clearBetweenJobs: true,
      mcp: 'codegraph',
      roleText: null,
      ...input,
      builtin: null,
    })
  }

  updatePreset(id: number, patch: PresetPatch): Preset {
    if (!this.getPreset(id)) throw new Error(`Preset ${id} not found`)
    this.writeColumns('presets', id, { ...patch, updatedAt: this.now() }, PRESET_COLUMNS)
    return this.getPreset(id)!
  }

  // A copy is always a user preset. A built-in's role text is a shipped file the store cannot read, so
  // the caller passes it as `shippedRoleText` when duplicating one.
  duplicatePreset(id: number, name?: string, shippedRoleText?: string): Preset {
    const src = this.getPreset(id)
    if (!src) throw new Error(`Preset ${id} not found`)
    const { id: _id, updatedAt: _u, ...fields } = src
    return this.insertPreset({
      ...fields,
      builtin: null,
      name: this.presetNameFree(name ?? `${src.name} copy`, null),
      roleText: src.roleText ?? shippedRoleText ?? null,
    })
  }

  // Operators keep their copy; one that used the preset's own text keeps that text.
  deletePreset(id: number): void {
    const preset = this.getPreset(id)
    if (!preset) return
    this.tx(() => {
      if (preset.roleText != null) {
        this.db.prepare('UPDATE operators SET role_text = ? WHERE preset_id = ? AND role_text IS NULL').run(preset.roleText, id)
      }
      this.db.prepare('DELETE FROM presets WHERE id = ?').run(id)
    })
  }

  // A built-in goes back to its shipped values and role text (the shipped file).
  resetPreset(id: number): Preset {
    const preset = this.getPreset(id)
    if (!preset) throw new Error(`Preset ${id} not found`)
    const shipped = BUILTIN_PRESETS.find((b) => b.builtin === preset.builtin)
    if (!shipped) throw new Error('Only built-in presets can be reset')
    const { builtin: _b, ...values } = shipped
    return this.updatePreset(id, { ...values, name: this.presetNameFree(shipped.name, id) })
  }

  // Scratch terminals

  createScratch(input: ScratchInput): ScratchTerminal {
    const row = this.db
      .prepare(
        'INSERT INTO scratch (crew_id, title, agent, model, effort, preset_id, cwd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *',
      )
      .get(input.crewId, input.title, input.agent, input.model ?? '', input.effort ?? '', input.presetId ?? null, input.cwd, this.now()) as Row
    return toScratch(row)
  }

  getScratch(id: number): ScratchTerminal | null {
    const row = this.db.prepare('SELECT * FROM scratch WHERE id = ?').get(id) as Row | undefined
    return row ? toScratch(row) : null
  }

  listScratch(crewId: number): ScratchTerminal[] {
    return (this.db.prepare('SELECT * FROM scratch WHERE crew_id = ? ORDER BY id').all(crewId) as Row[]).map(toScratch)
  }

  updateScratch(id: number, patch: ScratchPatch): ScratchTerminal {
    if (!this.getScratch(id)) throw new Error(`Scratch terminal ${id} not found`)
    this.writeColumns('scratch', id, patch as Record<string, unknown>, SCRATCH_COLUMNS)
    return this.getScratch(id)!
  }

  // Its usage rows keep their spend (scratch_id becomes NULL).
  deleteScratch(id: number): void {
    this.db.prepare('DELETE FROM scratch WHERE id = ?').run(id)
  }

  crewIdOfOperator(operatorId: number, includeDeleted = false): number | null {
    const row = this.db
      .prepare(
        `SELECT p.crew_id FROM operators s JOIN squads p ON p.id = s.squad_id WHERE s.id = ?${includeDeleted ? '' : ' AND s.deleted_at IS NULL'}`,
      )
      .get(operatorId) as Row | undefined
    return row ? Number(row.crew_id) : null
  }

  // Stable address in the form role@crew, as OpenCrew uses.
  operatorAddress(operatorId: number, includeDeleted = false): string | null {
    const row = this.db
      .prepare(
        `SELECT s.role, r.name FROM operators s JOIN squads p ON p.id = s.squad_id JOIN crews r ON r.id = p.crew_id WHERE s.id = ?${includeDeleted ? '' : ' AND s.deleted_at IS NULL'}`,
      )
      .get(operatorId) as Row | undefined
    return row ? `${row.role}@${row.name}` : null
  }

  // Jobs

  createJob(input: NewJob): Job {
    const t = this.now()
    const row = this.db
      .prepare(
        `INSERT INTO jobs (crew_id, assignee_id, title, body, priority, created_by, reviewer_id, review, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        input.crewId,
        input.assigneeId ?? null,
        input.title,
        input.body ?? '',
        input.priority ?? 0,
        input.createdBy ?? null,
        input.reviewerId ?? null,
        input.review ?? 'pm',
        t,
        t,
      ) as Row
    return this.getJob(Number(row.id))!
  }

  getJob(id: number): Job | null {
    const row = this.db.prepare(`${JOB_SELECT} WHERE j.id = ?`).get(id) as Row | undefined
    return row ? toJob(row) : null
  }

  listJobs(crewId: number): Job[] {
    return (this.db.prepare(`${JOB_SELECT} WHERE j.crew_id = ? ORDER BY j.id`).all(crewId) as Row[]).map(toJob)
  }

  updateJob(id: number, patch: JobPatch): Job {
    if (!this.getJob(id)) throw new Error(`Job ${id} not found`)
    const keys = (Object.keys(patch) as Array<keyof JobPatch>).filter((k) => k in JOB_COLUMNS && patch[k] !== undefined)
    const sets = [...keys.map((k) => `${JOB_COLUMNS[k]} = ?`), 'updated_at = ?']
    const values = [...keys.map((k) => patch[k] ?? null), this.now()] as Array<string | number | null>
    this.db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
    return this.getJob(id)!
  }

  deleteJob(id: number): void {
    this.db.prepare('DELETE FROM jobs WHERE id = ?').run(id)
  }

  jobDeps(id: number): number[] {
    return (this.db.prepare('SELECT depends_on_id FROM job_deps WHERE job_id = ? ORDER BY depends_on_id').all(id) as Row[]).map(
      (r) => Number(r.depends_on_id),
    )
  }

  // `jobId` waits for `dependsOnId`. Rejects self, cross-crew and cyclic dependencies.
  addJobDep(jobId: number, dependsOnId: number): void {
    const job = this.getJob(jobId)
    const dep = this.getJob(dependsOnId)
    if (!job || !dep) throw new Error('Job not found')
    if (jobId === dependsOnId) throw new Error('A job cannot depend on itself')
    if (job.crewId !== dep.crewId) throw new Error('Jobs can only depend on jobs in the same crew')
    const cycle = this.db
      .prepare(
        `WITH RECURSIVE up(id) AS (
           SELECT depends_on_id FROM job_deps WHERE job_id = ?
           UNION SELECT d.depends_on_id FROM job_deps d JOIN up ON d.job_id = up.id
         ) SELECT 1 FROM up WHERE id = ?`,
      )
      .get(dependsOnId, jobId)
    if (cycle) throw new Error('That dependency would create a cycle')
    this.db.prepare('INSERT OR IGNORE INTO job_deps (job_id, depends_on_id) VALUES (?, ?)').run(jobId, dependsOnId)
  }

  removeJobDep(jobId: number, dependsOnId: number): void {
    this.db.prepare('DELETE FROM job_deps WHERE job_id = ? AND depends_on_id = ?').run(jobId, dependsOnId)
  }

  // Messages

  createMessage(input: NewMessage): Message {
    const row = this.db
      .prepare(
        `INSERT INTO messages (crew_id, from_kind, from_id, from_label, to_kind, to_id, to_label, job_id, kind, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        input.crewId,
        input.fromKind,
        input.fromId ?? null,
        input.fromLabel ?? '',
        input.toKind,
        input.toId ?? null,
        input.toLabel ?? '',
        input.jobId ?? null,
        input.kind ?? 'message',
        input.body,
        this.now(),
      ) as Row
    return toMessage(row)
  }

  getMessage(id: number): Message | null {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Row | undefined
    return row ? toMessage(row) : null
  }

  // Oldest first. `toId: null` matches messages with no operator recipient (for example to the user).
  listMessages(crewId: number, filter: MessageFilter = {}): Message[] {
    const where = ['crew_id = ?']
    const args: Array<string | number> = [crewId]
    if (filter.toKind) {
      where.push('to_kind = ?')
      args.push(filter.toKind)
    }
    if (filter.toId === null) where.push('to_id IS NULL')
    else if (filter.toId !== undefined) {
      where.push('to_id = ?')
      args.push(filter.toId)
    }
    if (filter.unreadOnly) where.push('read_at IS NULL')
    let limit = ''
    if (filter.limit != null) {
      limit = ' LIMIT ?'
      args.push(filter.limit)
    }
    return (this.db.prepare(`SELECT * FROM messages WHERE ${where.join(' AND ')} ORDER BY id${limit}`).all(...args) as Row[]).map(
      toMessage,
    )
  }

  markMessageRead(id: number): void {
    this.db.prepare('UPDATE messages SET read_at = ? WHERE id = ? AND read_at IS NULL').run(this.now(), id)
  }

  deleteMessage(id: number): void {
    this.db.prepare('DELETE FROM messages WHERE id = ?').run(id)
  }

  // Links

  private assertLinkEnds(crewId: number, fromId: number, toId: number): void {
    for (const id of [fromId, toId]) {
      if (this.crewIdOfOperator(id) !== crewId) throw new Error('A link needs two live operators of the same crew')
    }
    if (fromId === toId) throw new Error('A link needs two different operators')
  }

  createLink(crewId: number, fromId: number, toId: number, label = ''): Link {
    this.assertLinkEnds(crewId, fromId, toId)
    const row = this.db
      .prepare('INSERT INTO links (crew_id, from_id, to_id, label) VALUES (?, ?, ?, ?) RETURNING *')
      .get(crewId, fromId, toId, label) as Row
    return toLink(row)
  }

  getLink(id: number): Link | null {
    const row = this.db.prepare('SELECT * FROM links WHERE id = ?').get(id) as Row | undefined
    return row ? toLink(row) : null
  }

  listLinks(crewId: number): Link[] {
    return (
      this.db
        .prepare(
          `SELECT l.* FROM links l
           JOIN operators a ON a.id = l.from_id AND a.deleted_at IS NULL
           JOIN operators b ON b.id = l.to_id AND b.deleted_at IS NULL
           WHERE l.crew_id = ? ORDER BY l.id`,
        )
        .all(crewId) as Row[]
    ).map(toLink)
  }

  updateLink(id: number, patch: { label?: string; fromId?: number; toId?: number }): Link {
    const cur = this.getLink(id)
    if (!cur) throw new Error(`Link ${id} not found`)
    const fromId = patch.fromId ?? cur.fromId
    const toId = patch.toId ?? cur.toId
    this.assertLinkEnds(cur.crewId, fromId, toId)
    const row = this.db
      .prepare('UPDATE links SET from_id = ?, to_id = ?, label = ? WHERE id = ? RETURNING *')
      .get(fromId, toId, patch.label ?? cur.label, id) as Row
    return toLink(row)
  }

  deleteLink(id: number): void {
    this.db.prepare('DELETE FROM links WHERE id = ?').run(id)
  }

  // Graph node positions, keyed by a node key the graph view chooses (for example "op:12").

  getNodePositions(crewId: number): NodePosition[] {
    return (this.db.prepare('SELECT * FROM node_positions WHERE crew_id = ? ORDER BY node_key').all(crewId) as Row[]).map((r) => ({
      crewId: Number(r.crew_id),
      nodeKey: String(r.node_key),
      x: Number(r.x),
      y: Number(r.y),
    }))
  }

  saveNodePositions(crewId: number, positions: Array<Pick<NodePosition, 'nodeKey' | 'x' | 'y'>>): void {
    const stmt = this.db.prepare(
      'INSERT INTO node_positions (crew_id, node_key, x, y) VALUES (?, ?, ?, ?) ON CONFLICT (crew_id, node_key) DO UPDATE SET x = excluded.x, y = excluded.y',
    )
    this.tx(() => {
      for (const p of positions) stmt.run(crewId, p.nodeKey, p.x, p.y)
    })
  }

  clearNodePositions(crewId: number): void {
    this.db.prepare('DELETE FROM node_positions WHERE crew_id = ?').run(crewId)
  }

  // Usage

  addUsage(u: UsageInput): Usage {
    if ((u.operatorId == null) === (u.scratchId == null)) throw new Error('Usage belongs to exactly one operator or scratch terminal')
    return toUsage(this.insertUsage(u, '') as Row)
  }

  // One row per assistant message: re-reading a transcript updates the row instead of adding one. A row
  // migrated from before the kind split is replaced by the exact figures and stops being `legacy`.
  upsertMessageUsage(messageId: string, u: UsageInput): void {
    if ((u.operatorId == null) === (u.scratchId == null)) throw new Error('Usage belongs to exactly one operator or scratch terminal')
    const target = u.operatorId != null ? 'operator_id' : 'scratch_id'
    this.insertUsage(
      { ...u, messageId },
      `ON CONFLICT (${target}, message_id) DO UPDATE SET
         model = excluded.model, session_id = excluded.session_id, job_id = excluded.job_id,
         input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
         cache_read = excluded.cache_read, cache_w5m = excluded.cache_w5m, cache_w1h = excluded.cache_w1h,
         cost_usd = excluded.cost_usd, context_tokens = excluded.context_tokens,
         cold = excluded.cold, tool_use = excluded.tool_use, legacy = 0`,
    )
  }

  private insertUsage(u: UsageInput, onConflict: string): Row | undefined {
    const kinds = u.cacheRead != null || u.cacheW5m != null || u.cacheW1h != null
    return this.db
      .prepare(
        `INSERT INTO usage (operator_id, scratch_id, message_id, session_id, model, at, job_id, input_tokens, output_tokens,
           cache_read, cache_w5m, cache_w1h, cost_usd, context_tokens, cold, tool_use)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ${onConflict} RETURNING *`,
      )
      .get(
        u.operatorId ?? null,
        u.scratchId ?? null,
        u.messageId ?? null,
        u.sessionId ?? null,
        u.model ?? '',
        u.at,
        u.jobId ?? null,
        u.inputTokens,
        u.outputTokens,
        kinds ? (u.cacheRead ?? 0) : (u.cacheTokens ?? 0),
        u.cacheW5m ?? 0,
        u.cacheW1h ?? 0,
        u.costUsd,
        u.contextTokens ?? 0,
        u.cold ? 1 : 0,
        u.toolUse ? 1 : 0,
      ) as Row | undefined
  }

  // Spend per operator of a crew in fixed-width time buckets from `since`, for sparklines.
  spendSeries(crewId: number, since: number, bucketMs: number, buckets: number): Array<{ operatorId: number; buckets: number[]; total: number }> {
    const rows = this.db
      .prepare(
        `SELECT u.operator_id, CAST((u.at - ?) / ? AS INTEGER) AS b, SUM(u.cost_usd) AS cost
         FROM usage u JOIN operators s ON s.id = u.operator_id JOIN squads p ON p.id = s.squad_id
         WHERE p.crew_id = ? AND u.at >= ? AND s.deleted_at IS NULL
         GROUP BY u.operator_id, b`,
      )
      .all(since, bucketMs, crewId, since) as Row[]
    const byOperator = new Map<number, number[]>()
    for (const r of rows) {
      const operatorId = Number(r.operator_id)
      const b = Number(r.b)
      if (b < 0 || b >= buckets) continue
      const arr = byOperator.get(operatorId) ?? Array<number>(buckets).fill(0)
      arr[b] = (arr[b] ?? 0) + Number(r.cost)
      byOperator.set(operatorId, arr)
    }
    return [...byOperator].map(([operatorId, arr]) => ({ operatorId, buckets: arr, total: arr.reduce((a, c) => a + c, 0) }))
  }

  // Spend is `usage` plus `spend_archive`. Archived days count when the day starts at or after `since`,
  // and `retentionDays` keeps purges older than any window the budget or Cost tab asks about.
  // Per crew it covers the crew's operators (Master slot included) and its scratch terminals.
  spendSince(since: number, crewId?: number): number {
    const sum = (sql: string, ...args: number[]): number => Number((this.db.prepare(sql).get(...args) as Row).total)
    if (crewId == null) {
      return (
        sum('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage WHERE at >= ?', since) +
        sum('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM spend_archive WHERE day >= ?', since)
      )
    }
    return (
      sum(
        `SELECT COALESCE(SUM(u.cost_usd), 0) AS total FROM usage u
         JOIN operators s ON s.id = u.operator_id JOIN squads p ON p.id = s.squad_id
         WHERE u.at >= ? AND p.crew_id = ?`,
        since,
        crewId,
      ) +
      sum(
        `SELECT COALESCE(SUM(u.cost_usd), 0) AS total FROM usage u
         JOIN scratch c ON c.id = u.scratch_id WHERE u.at >= ? AND c.crew_id = ?`,
        since,
        crewId,
      ) +
      sum('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM spend_archive WHERE day >= ? AND crew_id = ?', since, crewId)
    )
  }

  // Tokens and cost since `since`, per model, for one operator or a whole crew. Scratch terminals are
  // their own group; purged operators' archive rows fold into 'operator'. The kinds are columns because
  // `cost_usd` is stored per turn, not per kind.
  usageBreakdown(target: UsageTarget, since: number): UsageBreakdownRow[] {
    const cols = (p: string) => `${p}model AS model, COALESCE(SUM(${p}input_tokens), 0) AS i, COALESCE(SUM(${p}output_tokens), 0) AS o,
      COALESCE(SUM(${p}cache_read), 0) AS r, COALESCE(SUM(${p}cache_w5m), 0) AS w5, COALESCE(SUM(${p}cache_w1h), 0) AS w1,
      COALESCE(SUM(${p}cost_usd), 0) AS c`
    const out = new Map<string, UsageBreakdownRow>()
    const add = (group: UsageBreakdownRow['group'], rows: Row[], turns: boolean) => {
      for (const r of rows) {
        const key = `${group}\u0000${r.model}`
        const row = out.get(key) ?? {
          group,
          model: String(r.model),
          inputTokens: 0,
          outputTokens: 0,
          cacheRead: 0,
          cacheW5m: 0,
          cacheW1h: 0,
          costUsd: 0,
          turns: 0,
        }
        row.inputTokens += Number(r.i)
        row.outputTokens += Number(r.o)
        row.cacheRead += Number(r.r)
        row.cacheW5m += Number(r.w5)
        row.cacheW1h += Number(r.w1)
        row.costUsd += Number(r.c)
        if (turns) row.turns += Number(r.n)
        out.set(key, row)
      }
    }
    if ('operatorId' in target) {
      add(
        'operator',
        this.db
          .prepare(`SELECT ${cols('')}, COUNT(*) AS n FROM usage WHERE operator_id = ? AND at >= ? GROUP BY model`)
          .all(target.operatorId, since) as Row[],
        true,
      )
    } else {
      add(
        'operator',
        this.db
          .prepare(
            `SELECT ${cols('u.')}, COUNT(*) AS n FROM usage u
             JOIN operators s ON s.id = u.operator_id JOIN squads p ON p.id = s.squad_id
             WHERE p.crew_id = ? AND u.at >= ? GROUP BY u.model`,
          )
          .all(target.crewId, since) as Row[],
        true,
      )
      add(
        'scratch',
        this.db
          .prepare(
            `SELECT ${cols('u.')}, COUNT(*) AS n FROM usage u
             JOIN scratch c ON c.id = u.scratch_id WHERE c.crew_id = ? AND u.at >= ? GROUP BY u.model`,
          )
          .all(target.crewId, since) as Row[],
        true,
      )
      add(
        'operator',
        this.db
          .prepare(
            `SELECT ${cols('')} FROM spend_archive WHERE crew_id = ? AND day >= ? GROUP BY model`,
          )
          .all(target.crewId, since) as Row[],
        false,
      )
    }
    return [...out.values()].sort((x, y) => y.costUsd - x.costUsd)
  }

  // Spend since `since` per scratch terminal of the crew.
  scratchSpend(crewId: number, since: number): ScratchSpend[] {
    return (
      this.db
        .prepare(
          `SELECT u.scratch_id AS id, COALESCE(SUM(u.cost_usd), 0) AS c, COUNT(*) AS n FROM usage u
           JOIN scratch s ON s.id = u.scratch_id WHERE s.crew_id = ? AND u.at >= ? GROUP BY u.scratch_id ORDER BY u.scratch_id`,
        )
        .all(crewId, since) as Row[]
    ).map((r) => ({ scratchId: Number(r.id), costUsd: Number(r.c), turns: Number(r.n) }))
  }

  // Moves the operator's usage into `spend_archive` (per local day and model, labelled with its last
  // address) so totals stay the same once the operator row goes. The folded usage rows are removed, which
  // makes the call safe to repeat. Throws unless the operator is soft-deleted. Used by `purgeOperator`.
  foldOperatorSpend(operatorId: number): void {
    const gone = this.db.prepare('SELECT deleted_at FROM operators WHERE id = ?').get(operatorId) as Row | undefined
    if (gone && gone.deleted_at == null) throw new Error('Only a deleted operator can be folded into the archive')
    const crewId = this.crewIdOfOperator(operatorId, true)
    const label = this.operatorAddress(operatorId, true)
    if (crewId == null || label == null) throw new Error(`Operator ${operatorId} not found`)
    const rows = this.db.prepare('SELECT * FROM usage WHERE operator_id = ?').all(operatorId) as Row[]
    const days = new Map<string, { day: number; model: string; i: number; o: number; r: number; w5: number; w1: number; c: number }>()
    for (const r of rows) {
      const day = startOfDay(Number(r.at))
      const key = `${day}\u0000${r.model}`
      const d = days.get(key) ?? { day, model: String(r.model), i: 0, o: 0, r: 0, w5: 0, w1: 0, c: 0 }
      d.i += Number(r.input_tokens)
      d.o += Number(r.output_tokens)
      d.r += Number(r.cache_read)
      d.w5 += Number(r.cache_w5m)
      d.w1 += Number(r.cache_w1h)
      d.c += Number(r.cost_usd)
      days.set(key, d)
    }
    const upsert = this.db.prepare(
      `INSERT INTO spend_archive (crew_id, day, label, model, input_tokens, output_tokens, cache_read, cache_w5m, cache_w1h, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (crew_id, day, label, model) DO UPDATE SET
         input_tokens = COALESCE(input_tokens, 0) + excluded.input_tokens,
         output_tokens = COALESCE(output_tokens, 0) + excluded.output_tokens,
         cache_read = COALESCE(cache_read, 0) + excluded.cache_read,
         cache_w5m = COALESCE(cache_w5m, 0) + excluded.cache_w5m,
         cache_w1h = COALESCE(cache_w1h, 0) + excluded.cache_w1h,
         cost_usd = cost_usd + excluded.cost_usd`,
    )
    this.tx(() => {
      for (const d of days.values()) upsert.run(crewId, d.day, label, d.model, d.i, d.o, d.r, d.w5, d.w1, d.c)
      this.db.prepare('DELETE FROM usage WHERE operator_id = ?').run(operatorId)
    })
  }

  listSpendArchive(crewId: number): SpendArchive[] {
    return (this.db.prepare('SELECT * FROM spend_archive WHERE crew_id = ? ORDER BY day, label, model').all(crewId) as Row[]).map((r) => ({
      crewId: Number(r.crew_id),
      day: Number(r.day),
      label: String(r.label),
      model: String(r.model),
      inputTokens: Number(r.input_tokens ?? 0),
      outputTokens: Number(r.output_tokens ?? 0),
      cacheRead: Number(r.cache_read ?? 0),
      cacheW5m: Number(r.cache_w5m ?? 0),
      cacheW1h: Number(r.cache_w1h ?? 0),
      costUsd: Number(r.cost_usd),
    }))
  }

  // Hard-deletes a soft-deleted operator, in one transaction: spend folded into the archive first, then
  // its graph position and the row. Messages, jobs and events keep their text and lose the id (FK SET
  // NULL); links go with it. Whether it is eligible (the purge rule) is the caller's decision.
  purgeOperator(id: number): void {
    const row = this.db.prepare('SELECT deleted_at FROM operators WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new Error(`Operator ${id} not found`)
    if (row.deleted_at == null) throw new Error('Only a deleted operator can be purged')
    const crewId = this.crewIdOfOperator(id, true)
    this.tx(() => {
      this.foldOperatorSpend(id)
      if (crewId != null) this.db.prepare('DELETE FROM node_positions WHERE crew_id = ? AND node_key = ?').run(crewId, `op:${id}`)
      this.db.prepare('DELETE FROM operators WHERE id = ?').run(id)
    })
  }

  // Settings: one JSON document under a key.

  getJson(key: string): unknown {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined
    if (!row) return undefined
    try {
      return JSON.parse(String(row.value))
    } catch {
      return undefined
    }
  }

  setJson(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value))
  }

  // Events

  addEvent(kind: string, message: string, crewId: number | null = null, operatorId: number | null = null): OperantEvent {
    const row = this.db
      .prepare('INSERT INTO events (crew_id, operator_id, kind, message, at) VALUES (?, ?, ?, ?, ?) RETURNING *')
      .get(crewId, operatorId, kind, message, this.now()) as Row
    return toEvent(row)
  }

  recentEvents(limit: number): OperantEvent[] {
    return (this.db.prepare('SELECT * FROM events ORDER BY at DESC, id DESC LIMIT ?').all(limit) as Row[]).map(
      toEvent,
    )
  }
}
