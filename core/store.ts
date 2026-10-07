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
  JobAgent,
  MasterCli,
  Run,
  RunStatus,
  SeatFields,
  DiscordBot,
  DiscordBotAi,
  DiscordBotInput,
  DiscordBotPatch,
  DiscordPairing,
  DiscordThread,
  DiscordThreadArchive,
  Team,
  TeamInput,
  TeamLimits,
  TeamPatch,
  TeamSeat,
} from '../shared/types'
import { DEFAULT_DISCORD_AI, RUN_TRANSITIONS } from '../shared/types'
import { LEARN_AI_MIGRATION, LESSONS_MIGRATION } from './lessons-store'
import { BUILTIN_TEAMS, shippedSeats } from './team-presets'

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
  // Seats, teams, dashboard runs (JOB# from 20001 via AUTOINCREMENT, so numbers are never reused),
  // run agents, and project ids, order and Discord channels. All additive.
  `ALTER TABLE presets ADD COLUMN skills TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE presets ADD COLUMN hindsight INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE presets ADD COLUMN codegraph INTEGER NOT NULL DEFAULT 1;
   CREATE TABLE teams (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     seats TEXT NOT NULL DEFAULT '[]',
     limits TEXT NOT NULL DEFAULT '{}',
     rules TEXT NOT NULL DEFAULT '',
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE runs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     crew_id INTEGER NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
     task TEXT NOT NULL,
     master_cli TEXT NOT NULL,
     team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
     seats TEXT NOT NULL DEFAULT '[]',
     limits TEXT NOT NULL DEFAULT '{}',
     rules TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'queued',
     outcome TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL,
     started_at INTEGER,
     finished_at INTEGER
   );
   INSERT INTO sqlite_sequence (name, seq) VALUES ('runs', 20000);
   CREATE INDEX runs_crew_status ON runs (crew_id, status);
   CREATE TABLE job_agents (
     id INTEGER PRIMARY KEY,
     run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
     seat TEXT NOT NULL,
     model TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'working',
     transcript_ref TEXT NOT NULL DEFAULT ''
   );
   CREATE INDEX job_agents_run ON job_agents (run_id);
   ALTER TABLE crews ADD COLUMN prj_number INTEGER;
   ALTER TABLE crews ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE crews ADD COLUMN discord_channels TEXT NOT NULL DEFAULT '[]';
   UPDATE crews SET prj_number = 1000 + (SELECT COUNT(*) FROM crews c WHERE c.id <= crews.id), sort_order = id;
   CREATE UNIQUE INDEX crews_prj_number ON crews (prj_number);
   INSERT OR REPLACE INTO settings (key, value) VALUES ('prj.next', CAST(1001 + (SELECT COUNT(*) FROM crews) AS TEXT));`,
  // Discord bots. The token itself is never stored here: token_ref only names its entry in the secret store.
  `CREATE TABLE discord_bots (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     rules TEXT NOT NULL DEFAULT '',
     allowlist TEXT NOT NULL DEFAULT '[]',
     home_channel TEXT NOT NULL DEFAULT '',
     general_channel TEXT NOT NULL DEFAULT '',
     token_ref TEXT NOT NULL DEFAULT '',
     mention_only INTEGER NOT NULL DEFAULT 1,
     confirm_start INTEGER NOT NULL DEFAULT 1,
     enabled INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL
   );`,
  // Run-level Master model and effort (empty = the project Master's own), and pending Discord pairing codes
  // (codes only, never tokens) so a restart does not lose them.
  `ALTER TABLE runs ADD COLUMN master_model TEXT NOT NULL DEFAULT '';
   ALTER TABLE runs ADD COLUMN master_effort TEXT NOT NULL DEFAULT '';
   CREATE TABLE discord_pairings (
     bot_id INTEGER NOT NULL REFERENCES discord_bots(id) ON DELETE CASCADE,
     code TEXT NOT NULL,
     user_id TEXT NOT NULL,
     username TEXT NOT NULL,
     channel_id TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (bot_id, code)
   );`,
  // The CLI jobs started from a Discord bot run on.
  `ALTER TABLE discord_bots ADD COLUMN master_cli TEXT NOT NULL DEFAULT 'claude';`,
  // Seats choose MCP servers by name. The older mcp, codegraph and hindsight fields migrate into the list.
  `ALTER TABLE presets ADD COLUMN mcp_servers TEXT NOT NULL DEFAULT '[]';
   UPDATE presets SET mcp_servers = '[' ||
     CASE WHEN codegraph = 1 AND mcp = 'codegraph' THEN '"codegraph"' ELSE '' END ||
     CASE WHEN codegraph = 1 AND mcp = 'codegraph' AND hindsight = 1 THEN ',' ELSE '' END ||
     CASE WHEN hindsight = 1 THEN '"hindsight"' ELSE '' END || ']';`,
  // Usage per run, agent, seat, CLI and provider (all additive). run_id and job_agent_id are plain numbers so a
  // deleted job's spend keeps its JOB#. crew_id carries the project for rows with no operator or scratch terminal
  // (job agents, front desk, imports). ext_key is the stable key that makes ingest and import idempotent.
  `ALTER TABLE usage ADD COLUMN run_id INTEGER;
   ALTER TABLE usage ADD COLUMN job_agent_id INTEGER;
   ALTER TABLE usage ADD COLUMN cli TEXT NOT NULL DEFAULT 'claude';
   ALTER TABLE usage ADD COLUMN provider TEXT NOT NULL DEFAULT '';
   ALTER TABLE usage ADD COLUMN source TEXT NOT NULL DEFAULT '';
   ALTER TABLE usage ADD COLUMN seat TEXT NOT NULL DEFAULT '';
   ALTER TABLE usage ADD COLUMN crew_id INTEGER REFERENCES crews(id) ON DELETE CASCADE;
   ALTER TABLE usage ADD COLUMN project_label TEXT NOT NULL DEFAULT '';
   ALTER TABLE usage ADD COLUMN ext_key TEXT;
   UPDATE usage SET cli = 'claude', provider = 'anthropic', source = CASE WHEN scratch_id IS NOT NULL THEN 'scratch' ELSE 'operator' END;
   CREATE UNIQUE INDEX usage_ext_key ON usage (ext_key);
   CREATE INDEX usage_run ON usage (run_id);
   CREATE INDEX usage_crew_at ON usage (crew_id, at);`,
  // The learning loop: lessons, skill drafts and learn-run records (all additive).
  LESSONS_MIGRATION,
  // Project groups: named, ordered, collapsible; a project is in at most one (deleting a group ungroups its projects).
  `CREATE TABLE project_groups (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     sort_order INTEGER NOT NULL DEFAULT 0,
     collapsed INTEGER NOT NULL DEFAULT 0
   );
   CREATE UNIQUE INDEX project_groups_name ON project_groups (name COLLATE NOCASE);
   ALTER TABLE crews ADD COLUMN group_id INTEGER REFERENCES project_groups(id) ON DELETE SET NULL;`,
  // The project's tracker document (a path inside the project folder, empty = none) and whether a finished job
  // opens an "Update tracker" board job for the project manager.
  `ALTER TABLE crews ADD COLUMN tracker_file TEXT NOT NULL DEFAULT '';
   ALTER TABLE crews ADD COLUMN tracker_jobs INTEGER NOT NULL DEFAULT 1;`,
  // Which AI each learn run asked.
  LEARN_AI_MIGRATION,
  // Discord threads: a thread per request, named and routed. crew_id and run_id are plain numbers.
  `ALTER TABLE discord_bots ADD COLUMN thread_per_request INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE discord_bots ADD COLUMN thread_names TEXT NOT NULL DEFAULT 'auto';
   ALTER TABLE discord_bots ADD COLUMN thread_archive INTEGER NOT NULL DEFAULT 1440;
   ALTER TABLE discord_bots ADD COLUMN ai TEXT NOT NULL DEFAULT '{}';
   CREATE TABLE discord_threads (
     bot_id INTEGER NOT NULL REFERENCES discord_bots(id) ON DELETE CASCADE,
     thread_id TEXT NOT NULL,
     parent_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     crew_id INTEGER,
     run_id INTEGER,
     title TEXT NOT NULL,
     name TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (bot_id, thread_id)
   );`,
  // Teams that ship with Operant: a stable key, a description, and whether the user edited it.
  `ALTER TABLE teams ADD COLUMN builtin TEXT;
   ALTER TABLE teams ADD COLUMN description TEXT;
   ALTER TABLE teams ADD COLUMN modified INTEGER NOT NULL DEFAULT 0;
   CREATE UNIQUE INDEX teams_builtin ON teams (builtin) WHERE builtin IS NOT NULL;`,
]

type Row = Record<string, unknown>

const toCrew = (r: Row): Crew => ({
  id: Number(r.id),
  name: String(r.name),
  folder: String(r.folder),
  createdAt: Number(r.created_at),
  view: r.view as CrewView,
  pmId: r.pm_id == null ? null : Number(r.pm_id),
  prjNumber: Number(r.prj_number),
  sortOrder: Number(r.sort_order),
  discordChannels: parseList(r.discord_channels),
  groupId: r.group_id == null ? null : Number(r.group_id),
  trackerFile: String(r.tracker_file ?? ''),
  trackerJobs: Number(r.tracker_jobs ?? 1) === 1,
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
  skills: parseList(r.skills),
  hindsight: Number(r.hindsight) === 1,
  codegraph: Number(r.codegraph) === 1,
  mcpServers: parseList(r.mcp_servers),
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
type BuiltinPreset = Omit<PresetFields, keyof SeatFields>
const SEAT_DEFAULTS: SeatFields = { skills: [], hindsight: true, codegraph: true, mcpServers: ['codegraph', 'hindsight'] }

// `mcpServers` and the older mcp, codegraph and hindsight fields describe the same choice. Whichever the change
// names wins, and the others follow it.
function syncSeatMcp<T extends Partial<LaunchSettings & SeatFields>>(prev: Partial<LaunchSettings & SeatFields>, patch: T): T {
  const touched = patch.mcpServers !== undefined || patch.mcp !== undefined || patch.codegraph !== undefined || patch.hindsight !== undefined
  if (!touched) return patch
  const list = new Set(patch.mcpServers ?? prev.mcpServers ?? [])
  const toggle = (name: string, on: boolean) => (on ? list.add(name) : list.delete(name))
  if (patch.mcpServers === undefined) {
    if (patch.mcp !== undefined) toggle('codegraph', patch.mcp === 'codegraph')
    else if (patch.codegraph !== undefined) toggle('codegraph', patch.codegraph)
    if (patch.hindsight !== undefined) toggle('hindsight', patch.hindsight)
  }
  return { ...patch, mcpServers: [...list], codegraph: list.has('codegraph'), hindsight: list.has('hindsight'), mcp: list.has('codegraph') ? 'codegraph' : 'none' }
}

const parseJson = <T>(v: unknown, fallback: T): T => {
  try {
    return JSON.parse(String(v)) as T
  } catch {
    return fallback
  }
}
const toBotAi = (v: unknown): DiscordBotAi => {
  const o = parseJson<Partial<DiscordBotAi>>(v, {})
  return {
    cli: o.cli === 'opencode' || o.cli === 'local' ? o.cli : 'claude',
    model: typeof o.model === 'string' ? o.model : '',
    effort: typeof o.effort === 'string' ? o.effort : '',
    localUrl: typeof o.localUrl === 'string' && o.localUrl ? o.localUrl : DEFAULT_DISCORD_AI.localUrl,
  }
}
const toDiscordBot = (r: Row): DiscordBot => ({
  id: Number(r.id),
  name: String(r.name),
  rules: String(r.rules),
  allowlist: parseList(r.allowlist),
  homeChannel: String(r.home_channel),
  generalChannel: String(r.general_channel),
  tokenRef: String(r.token_ref),
  mentionOnly: Number(r.mention_only) === 1,
  confirmStart: Number(r.confirm_start) === 1,
  enabled: Number(r.enabled) === 1,
  masterCli: r.master_cli === 'opencode' ? 'opencode' : 'claude',
  threadPerRequest: Number(r.thread_per_request) !== 0,
  threadNames: r.thread_names === 'ai' ? 'ai' : 'auto',
  ai: toBotAi(r.ai),
  threadArchive: [60, 4320, 10080].includes(Number(r.thread_archive)) ? (Number(r.thread_archive) as DiscordThreadArchive) : 1440,
})
const toDiscordThread = (r: Row): DiscordThread => ({
  botId: Number(r.bot_id),
  threadId: String(r.thread_id),
  parentId: String(r.parent_id),
  userId: String(r.user_id),
  crewId: r.crew_id == null ? null : Number(r.crew_id),
  runId: r.run_id == null ? null : Number(r.run_id),
  title: String(r.title),
  name: String(r.name),
  createdAt: Number(r.created_at),
})
const DEFAULT_LIMITS: TeamLimits = { maxWorkers: 0, topTier: '', tokenBudget: 0 }
const toLimits = (v: unknown): TeamLimits => ({ ...DEFAULT_LIMITS, ...parseJson<Partial<TeamLimits>>(v, {}) })
const toSeats = (v: unknown): TeamSeat[] => {
  const a = parseJson<unknown>(v, [])
  return Array.isArray(a) ? (a as TeamSeat[]) : []
}
const toTeam = (r: Row, hidden: string[] = []): Team => ({
  id: Number(r.id),
  name: String(r.name),
  seats: toSeats(r.seats),
  limits: toLimits(r.limits),
  rules: String(r.rules),
  builtin: r.builtin == null ? null : String(r.builtin),
  description: r.description == null ? '' : String(r.description),
  modified: Number(r.modified) === 1,
  hidden: r.builtin != null && hidden.includes(String(r.builtin)),
  updatedAt: Number(r.updated_at),
})
const toRun = (r: Row): Run => ({
  id: Number(r.id),
  crewId: Number(r.crew_id),
  task: String(r.task),
  masterCli: r.master_cli as MasterCli,
  masterModel: String(r.master_model ?? ''),
  masterEffort: String(r.master_effort ?? ''),
  teamId: r.team_id == null ? null : Number(r.team_id),
  seats: toSeats(r.seats),
  limits: toLimits(r.limits),
  rules: String(r.rules),
  status: r.status as RunStatus,
  outcome: String(r.outcome),
  createdAt: Number(r.created_at),
  startedAt: r.started_at == null ? null : Number(r.started_at),
  finishedAt: r.finished_at == null ? null : Number(r.finished_at),
})
const toJobAgent = (r: Row): JobAgent => ({
  id: Number(r.id),
  runId: Number(r.run_id),
  seat: String(r.seat),
  model: String(r.model),
  status: String(r.status),
  transcriptRef: String(r.transcript_ref),
})

export interface NewRun {
  crewId: number
  task: string
  masterCli: MasterCli
  masterModel?: string
  masterEffort?: string
  teamId?: number | null
  seats?: TeamSeat[]
  limits?: TeamLimits
  rules?: string
}

export class RunTransitionError extends Error {
  constructor(from: RunStatus, to: RunStatus) {
    super(`A job cannot go from ${from} to ${to}`)
    this.name = 'RunTransitionError'
  }
}

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
export const BUILTIN_PRESETS: BuiltinPreset[] = [
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
const PRESET_COLUMNS: Record<string, string> = {
  ...LAUNCH_COLUMNS,
  name: 'name',
  roleText: 'role_text',
  updatedAt: 'updated_at',
  skills: 'skills',
  hindsight: 'hindsight',
  codegraph: 'codegraph',
  mcpServers: 'mcp_servers',
}
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
  legacy?: boolean
  runId?: number | null
  jobAgentId?: number | null
  cli?: string
  provider?: string
  source?: string
  seat?: string
  crewId?: number | null
  projectLabel?: string
  extKey?: string | null
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
    this.seedBuiltinTeams()
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
    return this.tx(() => {
      const prj = Number(this.getJson('prj.next') ?? 1001)
      this.setJson('prj.next', prj + 1)
      const order = Number((this.db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM crews').get() as Row).n)
      const row = this.db
        .prepare('INSERT INTO crews (name, folder, created_at, prj_number, sort_order) VALUES (?, ?, ?, ?, ?) RETURNING *')
        .get(name, folder, this.now(), prj, order) as Row
      return toCrew(row)
    })
  }

  listCrews(): Crew[] {
    return (this.db.prepare('SELECT * FROM crews ORDER BY sort_order, id').all() as Row[]).map(toCrew)
  }

  getCrew(id: number): Crew | null {
    const row = this.db.prepare('SELECT * FROM crews WHERE id = ?').get(id) as Row | undefined
    return row ? toCrew(row) : null
  }

  updateCrew(id: number, patch: { name?: string; folder?: string; view?: CrewView; pmId?: number | null; discordChannels?: string[]; trackerFile?: string; trackerJobs?: boolean }): Crew {
    const cur = this.getCrew(id)
    if (!cur) throw new Error(`Project ${id} not found`)
    const pmId = patch.pmId === undefined ? cur.pmId : patch.pmId
    if (pmId != null && this.crewIdOfOperator(pmId) !== id) throw new Error('The PM must be a live operator of this project')
    const row = this.db
      .prepare('UPDATE crews SET name = ?, folder = ?, view = ?, pm_id = ?, discord_channels = ?, tracker_file = ?, tracker_jobs = ? WHERE id = ? RETURNING *')
      .get(
        patch.name ?? cur.name,
        patch.folder ?? cur.folder,
        patch.view ?? cur.view,
        pmId,
        JSON.stringify(patch.discordChannels ?? cur.discordChannels),
        patch.trackerFile ?? cur.trackerFile,
        (patch.trackerJobs ?? cur.trackerJobs) ? 1 : 0,
        id,
      ) as Row
    return toCrew(row)
  }

  // Saved order of the project list: the given crews take positions 1..n, any other crew follows.
  reorderCrews(ids: number[]): Crew[] {
    this.tx(() => {
      const current = (this.db.prepare('SELECT id FROM crews ORDER BY sort_order, id').all() as Row[]).map((r) => Number(r.id))
      const first = ids.filter((id, i) => current.includes(id) && ids.indexOf(id) === i)
      const order = [...first, ...current.filter((id) => !first.includes(id))]
      const set = this.db.prepare('UPDATE crews SET sort_order = ? WHERE id = ?')
      order.forEach((id, i) => set.run(i + 1, id))
    })
    return this.listCrews()
  }

  getCrewView(id: number): CrewView {
    const crew = this.getCrew(id)
    if (!crew) throw new Error(`Project ${id} not found`)
    return crew.view
  }

  setCrewView(id: number, view: CrewView): Crew {
    return this.updateCrew(id, { view })
  }

  // The tiles view's split tree, stored as JSON; its shape belongs to the renderer.
  getTileLayout(crewId: number): unknown {
    const row = this.db.prepare('SELECT tile_layout FROM crews WHERE id = ?').get(crewId) as Row | undefined
    if (!row) throw new Error(`Project ${crewId} not found`)
    try {
      return JSON.parse(String(row.tile_layout))
    } catch {
      return {}
    }
  }

  setTileLayout(crewId: number, layout: unknown): void {
    if (!this.getCrew(crewId)) throw new Error(`Project ${crewId} not found`)
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

  // One transaction around several store calls (they join it); rolled back when `fn` throws.
  transaction<T>(fn: () => T): T {
    return this.tx(fn)
  }

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
    if (taken) throw new Error(`Role "${role}" is already used by another operator in this project`)
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
      if (target?.crewId !== crewId) throw new Error('An operator can only move to a squad in its own project')
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
    if (!this.getCrew(crewId)) throw new Error(`Project ${crewId} not found`)
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
           context_cap, clear_between_jobs, mcp, role_text, updated_at, skills, hindsight, codegraph, mcp_servers)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
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
        JSON.stringify(f.skills),
        f.hindsight ? 1 : 0,
        f.codegraph ? 1 : 0,
        JSON.stringify(f.mcpServers),
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
    return this.tx(() => {
      const added = BUILTIN_PRESETS.filter((b) => !this.getPresetByBuiltin(b.builtin!)).map((b) =>
        this.insertPreset({ ...SEAT_DEFAULTS, ...b, name: this.presetNameFree(b.name, null) }),
      )
      this.seedBuiltinTeams()
      return added
    })
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
    // A preset made from the older fields alone (no list) takes its servers from them.
    const fromFields = [...((input.mcp ?? 'codegraph') === 'codegraph' && (input.codegraph ?? true) ? ['codegraph'] : []), ...((input.hindsight ?? true) ? ['hindsight'] : [])]
    const seat = syncSeatMcp({}, { mcpServers: input.mcpServers ?? fromFields })
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
      ...SEAT_DEFAULTS,
      ...input,
      ...seat,
      builtin: null,
    })
  }

  updatePreset(id: number, patch: PresetPatch): Preset {
    if (!this.getPreset(id)) throw new Error(`Preset ${id} not found`)
    this.writeColumns('presets', id, { ...syncSeatMcp(this.getPreset(id)!, patch), updatedAt: this.now() }, PRESET_COLUMNS)
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
    if (job.crewId !== dep.crewId) throw new Error('Jobs can only depend on jobs in the same project')
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

  // Discord bots

  createDiscordBot(input: DiscordBotInput): DiscordBot {
    const row = this.db
      .prepare(
        `INSERT INTO discord_bots (name, rules, allowlist, home_channel, general_channel, mention_only, confirm_start, enabled, master_cli, thread_per_request, thread_names, thread_archive, ai, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        input.name,
        input.rules ?? '',
        JSON.stringify(input.allowlist ?? []),
        input.homeChannel ?? '',
        input.generalChannel ?? '',
        input.mentionOnly === false ? 0 : 1,
        input.confirmStart === false ? 0 : 1,
        input.enabled ? 1 : 0,
        input.masterCli ?? 'claude',
        input.threadPerRequest === false ? 0 : 1,
        input.threadNames ?? 'auto',
        input.threadArchive ?? 1440,
        JSON.stringify({ ...DEFAULT_DISCORD_AI, ...input.ai }),
        this.now(),
      ) as Row
    return toDiscordBot(row)
  }

  listDiscordBots(): DiscordBot[] {
    return (this.db.prepare('SELECT * FROM discord_bots ORDER BY name').all() as Row[]).map(toDiscordBot)
  }

  getDiscordBot(id: number): DiscordBot | null {
    const row = this.db.prepare('SELECT * FROM discord_bots WHERE id = ?').get(id) as Row | undefined
    return row ? toDiscordBot(row) : null
  }

  updateDiscordBot(id: number, patch: DiscordBotPatch & { tokenRef?: string }): DiscordBot {
    const cur = this.getDiscordBot(id)
    if (!cur) throw new Error(`Discord bot ${id} not found`)
    const row = this.db
      .prepare(
        `UPDATE discord_bots SET name = ?, rules = ?, allowlist = ?, home_channel = ?, general_channel = ?, token_ref = ?,
           mention_only = ?, confirm_start = ?, enabled = ?, master_cli = ?,
           thread_per_request = ?, thread_names = ?, thread_archive = ?, ai = ?, updated_at = ? WHERE id = ? RETURNING *`,
      )
      .get(
        patch.name ?? cur.name,
        patch.rules ?? cur.rules,
        JSON.stringify(patch.allowlist ?? cur.allowlist),
        patch.homeChannel ?? cur.homeChannel,
        patch.generalChannel ?? cur.generalChannel,
        patch.tokenRef ?? cur.tokenRef,
        (patch.mentionOnly ?? cur.mentionOnly) ? 1 : 0,
        (patch.confirmStart ?? cur.confirmStart) ? 1 : 0,
        (patch.enabled ?? cur.enabled) ? 1 : 0,
        patch.masterCli ?? cur.masterCli ?? 'claude',
        (patch.threadPerRequest ?? cur.threadPerRequest) ? 1 : 0,
        patch.threadNames ?? cur.threadNames,
        patch.threadArchive ?? cur.threadArchive,
        JSON.stringify({ ...cur.ai, ...patch.ai }),
        this.now(),
        id,
      ) as Row
    return toDiscordBot(row)
  }

  listDiscordPairings(botId: number): DiscordPairing[] {
    return (this.db.prepare('SELECT * FROM discord_pairings WHERE bot_id = ? ORDER BY created_at, code').all(botId) as Row[]).map((r) => ({
      code: String(r.code),
      userId: String(r.user_id),
      username: String(r.username),
      channelId: String(r.channel_id),
      createdAt: Number(r.created_at),
    }))
  }

  addDiscordPairing(botId: number, p: DiscordPairing): void {
    this.db
      .prepare('INSERT OR REPLACE INTO discord_pairings (bot_id, code, user_id, username, channel_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(botId, p.code, p.userId, p.username, p.channelId, p.createdAt)
  }

  // True when the code existed.
  deleteDiscordPairing(botId: number, code: string): boolean {
    return Number(this.db.prepare('DELETE FROM discord_pairings WHERE bot_id = ? AND code = ?').run(botId, code).changes) > 0
  }

  purgeDiscordPairings(botId: number, olderThan: number): void {
    this.db.prepare('DELETE FROM discord_pairings WHERE bot_id = ? AND created_at < ?').run(botId, olderThan)
  }

  getDiscordThread(botId: number, threadId: string): DiscordThread | null {
    const r = this.db.prepare('SELECT * FROM discord_threads WHERE bot_id = ? AND thread_id = ?').get(botId, threadId) as Row | undefined
    return r ? toDiscordThread(r) : null
  }

  listDiscordThreads(botId: number): DiscordThread[] {
    return (this.db.prepare('SELECT * FROM discord_threads WHERE bot_id = ? ORDER BY created_at, thread_id').all(botId) as Row[]).map(toDiscordThread)
  }

  addDiscordThread(t: DiscordThread): void {
    this.db
      .prepare('INSERT OR REPLACE INTO discord_threads (bot_id, thread_id, parent_id, user_id, crew_id, run_id, title, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(t.botId, t.threadId, t.parentId, t.userId, t.crewId, t.runId, t.title, t.name, t.createdAt)
  }

  updateDiscordThread(botId: number, threadId: string, patch: Partial<Pick<DiscordThread, 'crewId' | 'runId' | 'name'>>): void {
    const cur = this.getDiscordThread(botId, threadId)
    if (!cur) return
    this.db
      .prepare('UPDATE discord_threads SET crew_id = ?, run_id = ?, name = ? WHERE bot_id = ? AND thread_id = ?')
      .run(patch.crewId === undefined ? cur.crewId : patch.crewId, patch.runId === undefined ? cur.runId : patch.runId, patch.name ?? cur.name, botId, threadId)
  }

  deleteDiscordBot(id: number): void {
    this.db.prepare('DELETE FROM discord_bots WHERE id = ?').run(id)
  }

  // Teams

  createTeam(input: TeamInput, builtin: string | null = null): Team {
    const row = this.db
      .prepare('INSERT INTO teams (name, seats, limits, rules, description, builtin, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *')
      .get(
        input.name,
        JSON.stringify(input.seats ?? []),
        JSON.stringify({ ...DEFAULT_LIMITS, ...input.limits }),
        input.rules ?? '',
        input.description ?? '',
        builtin,
        this.now(),
      ) as Row
    return toTeam(row, this.hiddenTeams())
  }

  private hiddenTeams(): string[] {
    const v = this.getJson('teams.hidden')
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : []
  }

  // Built-in teams first, in the order they ship, then the user's by name.
  listTeams(): Team[] {
    const hidden = this.hiddenTeams()
    return (this.db.prepare('SELECT * FROM teams ORDER BY builtin IS NULL, CASE WHEN builtin IS NULL THEN 0 ELSE id END, name').all() as Row[]).map((r) =>
      toTeam(r, hidden),
    )
  }

  getTeam(id: number): Team | null {
    const row = this.db.prepare('SELECT * FROM teams WHERE id = ?').get(id) as Row | undefined
    return row ? toTeam(row, this.hiddenTeams()) : null
  }

  updateTeam(id: number, patch: TeamPatch): Team {
    const cur = this.getTeam(id)
    if (!cur) throw new Error(`Team ${id} not found`)
    const row = this.db
      .prepare('UPDATE teams SET name = ?, seats = ?, limits = ?, rules = ?, description = ?, modified = ?, updated_at = ? WHERE id = ? RETURNING *')
      .get(
        patch.name ?? cur.name,
        JSON.stringify(patch.seats ?? cur.seats),
        JSON.stringify({ ...cur.limits, ...patch.limits }),
        patch.rules ?? cur.rules,
        patch.description ?? cur.description,
        cur.builtin != null || cur.modified ? 1 : 0,
        this.now(),
        id,
      ) as Row
    return toTeam(row, this.hiddenTeams())
  }

  // Runs sent with it keep their own copy of its seats and limits. Built-ins stay (hide them instead).
  deleteTeam(id: number): void {
    if (this.getTeam(id)?.builtin != null) throw new Error('Built-in teams cannot be deleted: hide it instead')
    this.db.prepare('DELETE FROM teams WHERE id = ?').run(id)
  }

  teamNameFree(name: string, exceptId: number | null): string {
    let candidate = name
    for (let n = 2; this.db.prepare('SELECT 1 FROM teams WHERE name = ? AND id <> ?').get(candidate, exceptId ?? -1); n++) {
      candidate = `${name} (${n})`
    }
    return candidate
  }

  // A user team with the same seats, limits and rules.
  duplicateTeam(id: number, name?: string): Team {
    const src = this.getTeam(id)
    if (!src) throw new Error(`Team ${id} not found`)
    return this.createTeam({ ...src, name: this.teamNameFree(name ?? `${src.name} copy`, null) })
  }

  // Inserts any shipped team that is missing. One the user edited or hid is left as it is, and a team whose
  // seat presets were deleted waits until they are restored.
  seedBuiltinTeams(): void {
    this.tx(() => {
      for (const def of BUILTIN_TEAMS) {
        if (this.db.prepare('SELECT 1 FROM teams WHERE builtin = ?').get(def.builtin)) continue
        const seats = shippedSeats(def, (k) => this.getPresetByBuiltin(k))
        if (seats) this.createTeam({ name: this.teamNameFree(def.name, null), description: def.description, seats, limits: def.limits, rules: def.rules }, def.builtin)
      }
    })
  }

  resetTeam(id: number): Team {
    const cur = this.getTeam(id)
    const def = BUILTIN_TEAMS.find((b) => b.builtin === cur?.builtin)
    if (!cur || !def) throw new Error('Only built-in teams can be reset')
    const seats = shippedSeats(def, (k) => this.getPresetByBuiltin(k))
    if (!seats) throw new Error('A seat preset this team uses was deleted: restore the built-in presets first')
    const row = this.db
      .prepare('UPDATE teams SET name = ?, seats = ?, limits = ?, rules = ?, description = ?, modified = 0, updated_at = ? WHERE id = ? RETURNING *')
      .get(this.teamNameFree(def.name, id), JSON.stringify(seats), JSON.stringify(def.limits), def.rules, def.description, this.now(), id) as Row
    return toTeam(row, this.hiddenTeams())
  }

  setTeamHidden(id: number, hidden: boolean): Team {
    const cur = this.getTeam(id)
    if (!cur) throw new Error(`Team ${id} not found`)
    if (cur.builtin == null) throw new Error('Only built-in teams can be hidden')
    const rest = this.hiddenTeams().filter((k) => k !== cur.builtin)
    this.setJson('teams.hidden', hidden ? [...rest, cur.builtin] : rest)
    return { ...cur, hidden }
  }

  // Runs (dashboard jobs, JOB#)

  createRun(input: NewRun): Run {
    const row = this.db
      .prepare(
        `INSERT INTO runs (crew_id, task, master_cli, master_model, master_effort, team_id, seats, limits, rules, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?) RETURNING *`,
      )
      .get(
        input.crewId,
        input.task,
        input.masterCli,
        input.masterModel ?? '',
        input.masterEffort ?? '',
        input.teamId ?? null,
        JSON.stringify(input.seats ?? []),
        JSON.stringify({ ...DEFAULT_LIMITS, ...input.limits }),
        input.rules ?? '',
        this.now(),
      ) as Row
    return toRun(row)
  }

  getRun(id: number): Run | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined
    return row ? toRun(row) : null
  }

  listRuns(crewId?: number): Run[] {
    const rows = (
      crewId === undefined
        ? this.db.prepare('SELECT * FROM runs ORDER BY id').all()
        : this.db.prepare('SELECT * FROM runs WHERE crew_id = ? ORDER BY id').all(crewId)
    ) as Row[]
    return rows.map(toRun)
  }

  // Moves a run along RUN_TRANSITIONS only; the outcome (when given) replaces the stored text.
  setRunStatus(id: number, status: RunStatus, outcome?: string): Run {
    const cur = this.getRun(id)
    if (!cur) throw new Error(`Job ${id} not found`)
    if (!RUN_TRANSITIONS[cur.status].includes(status)) throw new RunTransitionError(cur.status, status)
    const now = this.now()
    const started = status === 'working' && cur.startedAt == null ? now : cur.startedAt
    const finished = status === 'done' || status === 'failed' ? now : cur.finishedAt
    const row = this.db
      .prepare('UPDATE runs SET status = ?, outcome = ?, started_at = ?, finished_at = ? WHERE id = ? RETURNING *')
      .get(status, outcome ?? cur.outcome, started, finished, id) as Row
    return toRun(row)
  }

  // Only a queued run's task can change; any other status is the caller's to refuse first.
  setRunTask(id: number, task: string): Run {
    const row = this.db.prepare('UPDATE runs SET task = ? WHERE id = ? RETURNING *').get(task, id) as Row | undefined
    if (!row) throw new Error(`Job ${id} not found`)
    return toRun(row)
  }

  // Its job_agents go with it (ON DELETE CASCADE).
  deleteRun(id: number): void {
    this.db.prepare('DELETE FROM runs WHERE id = ?').run(id)
  }

  addJobAgent(runId: number, a: { seat: string; model?: string; status?: string; transcriptRef?: string }): JobAgent {
    if (!this.getRun(runId)) throw new Error(`Job ${runId} not found`)
    const row = this.db
      .prepare('INSERT INTO job_agents (run_id, seat, model, status, transcript_ref) VALUES (?, ?, ?, ?, ?) RETURNING *')
      .get(runId, a.seat, a.model ?? '', a.status ?? 'working', a.transcriptRef ?? '') as Row
    return toJobAgent(row)
  }

  listJobAgents(runId: number): JobAgent[] {
    return (this.db.prepare('SELECT * FROM job_agents WHERE run_id = ? ORDER BY id').all(runId) as Row[]).map(toJobAgent)
  }

  getJobAgent(id: number): JobAgent | null {
    const row = this.db.prepare('SELECT * FROM job_agents WHERE id = ?').get(id) as Row | undefined
    return row ? toJobAgent(row) : null
  }

  setJobAgentModel(id: number, model: string): void {
    this.db.prepare('UPDATE job_agents SET model = ? WHERE id = ?').run(model, id)
  }

  setJobAgentStatus(id: number, status: string): void {
    this.db.prepare('UPDATE job_agents SET status = ? WHERE id = ?').run(status, id)
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
      if (this.crewIdOfOperator(id) !== crewId) throw new Error('A link needs two live operators of the same project')
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
    const cli = u.cli ?? 'claude'
    return this.db
      .prepare(
        `INSERT INTO usage (operator_id, scratch_id, message_id, session_id, model, at, job_id, input_tokens, output_tokens,
           cache_read, cache_w5m, cache_w1h, cost_usd, context_tokens, cold, tool_use, legacy,
           run_id, job_agent_id, cli, provider, source, seat, crew_id, project_label, ext_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ${onConflict} RETURNING *`,
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
        u.legacy ? 1 : 0,
        u.runId ?? null,
        u.jobAgentId ?? null,
        cli,
        u.provider ?? (cli === 'claude' ? 'anthropic' : ''),
        u.source ?? (u.scratchId != null ? 'scratch' : u.operatorId != null ? 'operator' : ''),
        u.seat ?? '',
        u.crewId ?? null,
        u.projectLabel ?? '',
        u.extKey ?? null,
      ) as Row | undefined
  }

  // A usage row that belongs to no operator or scratch terminal (a job's Master or agent, the Discord front desk,
  // an import), keyed by `extKey`. `update` re-writes the figures of a row seen before (a transcript still growing);
  // otherwise a known key is left alone. Returns what happened.
  upsertKeyedUsage(u: UsageInput & { extKey: string }, update: boolean): 'added' | 'updated' | 'unchanged' {
    if (u.operatorId != null || u.scratchId != null) throw new Error('Keyed usage belongs to no operator or scratch terminal')
    const have = this.db.prepare('SELECT id FROM usage WHERE ext_key = ?').get(u.extKey) as Row | undefined
    if (!have) {
      this.insertUsage(u, '')
      return 'added'
    }
    if (!update) return 'unchanged'
    const kinds = u.cacheRead != null || u.cacheW5m != null || u.cacheW1h != null
    this.db
      .prepare(
        `UPDATE usage SET model = ?, at = ?, input_tokens = ?, output_tokens = ?, cache_read = ?, cache_w5m = ?, cache_w1h = ?,
           cost_usd = ?, context_tokens = ?, tool_use = ?, job_agent_id = ?, seat = ? WHERE id = ?`,
      )
      .run(
        u.model ?? '',
        u.at,
        u.inputTokens,
        u.outputTokens,
        kinds ? (u.cacheRead ?? 0) : (u.cacheTokens ?? 0),
        u.cacheW5m ?? 0,
        u.cacheW1h ?? 0,
        u.costUsd,
        u.contextTokens ?? 0,
        u.toolUse ? 1 : 0,
        u.jobAgentId ?? null,
        u.seat ?? '',
        have.id as number,
      )
    return 'updated'
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
  // Per crew it covers the project's operators (Master slot included) and its scratch terminals.
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
      // Job agents, the front desk and imports carry their project on the row.
      sum('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage WHERE at >= ? AND crew_id = ? AND operator_id IS NULL AND scratch_id IS NULL', since, crewId) +
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
