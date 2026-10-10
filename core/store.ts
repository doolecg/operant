import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AgentKind, CacheTtl, Crew, LaunchSettings, McpMode, OperantEvent, Preset, ScratchSpend, ScratchTerminal, ScratchView, Team, TeamInput, TeamPatch, Usage } from '../shared/types'
import type { SeatFields } from '../shared/types'
import { LEARN_AI_MIGRATION, LESSONS_MIGRATION } from './lessons-store'
import { BUILTIN_TEAMS, RETIRED_TEAMS, TEAM_RENAMES } from './team-presets'
import { presetTextFor } from './preset-text'
import { buildBackup, writeBackup } from './backup'
import { presetInfo } from '../shared/presets'

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
  // The Master as project manager: a run's mode (rows that exist now ran headless, so they stay 'background'),
  // what it waits for, the open question, the review report, the owner's approval and the close-out, plus the
  // per-run conversation (run_events). All additive.
  `ALTER TABLE runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'background';
   ALTER TABLE runs ADD COLUMN waiting TEXT NOT NULL DEFAULT '';
   ALTER TABLE runs ADD COLUMN question TEXT NOT NULL DEFAULT '';
   ALTER TABLE runs ADD COLUMN question_options TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE runs ADD COLUMN review_summary TEXT NOT NULL DEFAULT '';
   ALTER TABLE runs ADD COLUMN sent_back_note TEXT NOT NULL DEFAULT '';
   ALTER TABLE runs ADD COLUMN sendbacks INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE runs ADD COLUMN acked_at INTEGER;
   ALTER TABLE runs ADD COLUMN approved_at INTEGER;
   ALTER TABLE runs ADD COLUMN approved_by TEXT;
   ALTER TABLE runs ADD COLUMN closeout_state TEXT NOT NULL DEFAULT '';
   CREATE TABLE run_events (
     id INTEGER PRIMARY KEY,
     run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
     at INTEGER NOT NULL,
     kind TEXT NOT NULL,
     source TEXT NOT NULL,
     body TEXT NOT NULL DEFAULT '',
     options TEXT NOT NULL DEFAULT '[]',
     read_at INTEGER
   );
   CREATE INDEX run_events_run ON run_events (run_id);`,
  // Discord as the Master's channel: what is mirrored into run threads and who may use the destructive commands.
  `ALTER TABLE discord_bots ADD COLUMN mirror TEXT NOT NULL DEFAULT 'progress';
   ALTER TABLE discord_bots ADD COLUMN admins TEXT NOT NULL DEFAULT '[]';`,
  // The built-in Playground is a project row of its own kind ('project' | 'playground').
  `ALTER TABLE crews ADD COLUMN kind TEXT NOT NULL DEFAULT 'project';`,
  // Orchestration is gone: its tables are dropped. Usage, events and projects keep their history: a tile-less
  // usage row keeps its project (crew_id), then the tables that pointed at the dropped ones are rebuilt without
  // those references (foreign keys are off while migrating).
  `UPDATE usage SET crew_id = (SELECT p.crew_id FROM operators o JOIN squads p ON p.id = o.squad_id WHERE o.id = usage.operator_id)
     WHERE crew_id IS NULL AND operator_id IS NOT NULL;
   CREATE TABLE crews_new (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     folder TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     tile_layout TEXT NOT NULL DEFAULT '{}',
     prj_number INTEGER,
     sort_order INTEGER NOT NULL DEFAULT 0,
     group_id INTEGER REFERENCES project_groups(id) ON DELETE SET NULL,
     kind TEXT NOT NULL DEFAULT 'project'
   );
   INSERT INTO crews_new (id, name, folder, created_at, tile_layout, prj_number, sort_order, group_id, kind)
     SELECT id, name, folder, created_at, tile_layout, prj_number, sort_order, group_id, kind FROM crews;
   DROP TABLE crews;
   ALTER TABLE crews_new RENAME TO crews;
   CREATE UNIQUE INDEX crews_prj_number ON crews (prj_number);
   CREATE TABLE events_new (
     id INTEGER PRIMARY KEY,
     crew_id INTEGER REFERENCES crews(id) ON DELETE CASCADE,
     kind TEXT NOT NULL,
     message TEXT NOT NULL,
     at INTEGER NOT NULL
   );
   INSERT INTO events_new (id, crew_id, kind, message, at) SELECT id, crew_id, kind, message, at FROM events;
   DROP TABLE events;
   ALTER TABLE events_new RENAME TO events;
   CREATE INDEX events_at ON events (at);
   CREATE TABLE usage_new (
     id INTEGER PRIMARY KEY,
     scratch_id INTEGER REFERENCES scratch(id) ON DELETE SET NULL,
     message_id TEXT,
     session_id TEXT,
     model TEXT NOT NULL DEFAULT '',
     at INTEGER NOT NULL,
     input_tokens INTEGER NOT NULL DEFAULT 0,
     output_tokens INTEGER NOT NULL DEFAULT 0,
     cache_read INTEGER NOT NULL DEFAULT 0,
     cache_w5m INTEGER NOT NULL DEFAULT 0,
     cache_w1h INTEGER NOT NULL DEFAULT 0,
     cost_usd REAL NOT NULL DEFAULT 0,
     context_tokens INTEGER NOT NULL DEFAULT 0,
     cold INTEGER NOT NULL DEFAULT 0,
     tool_use INTEGER NOT NULL DEFAULT 0,
     legacy INTEGER NOT NULL DEFAULT 0,
     run_id INTEGER,
     job_agent_id INTEGER,
     cli TEXT NOT NULL DEFAULT 'claude',
     provider TEXT NOT NULL DEFAULT '',
     source TEXT NOT NULL DEFAULT '',
     seat TEXT NOT NULL DEFAULT '',
     crew_id INTEGER REFERENCES crews(id) ON DELETE CASCADE,
     project_label TEXT NOT NULL DEFAULT '',
     ext_key TEXT
   );
   INSERT INTO usage_new (id, scratch_id, message_id, session_id, model, at, input_tokens, output_tokens, cache_read, cache_w5m, cache_w1h,
       cost_usd, context_tokens, cold, tool_use, legacy, run_id, job_agent_id, cli, provider, source, seat, crew_id, project_label, ext_key)
     SELECT id, scratch_id, message_id, session_id, model, at, input_tokens, output_tokens, cache_read, cache_w5m, cache_w1h,
       cost_usd, context_tokens, cold, tool_use, legacy, run_id, job_agent_id, cli, provider, source, seat, crew_id, project_label, ext_key FROM usage;
   DROP TABLE usage;
   ALTER TABLE usage_new RENAME TO usage;
   CREATE INDEX usage_at ON usage (at);
   CREATE INDEX usage_crew_at ON usage (crew_id, at);
   CREATE UNIQUE INDEX usage_ext_key ON usage (ext_key);
   CREATE UNIQUE INDEX usage_scratch_message ON usage (scratch_id, message_id);
   DROP TABLE IF EXISTS job_agents;
   DROP TABLE IF EXISTS job_deps;
   DROP TABLE IF EXISTS job_preassigned;
   DROP TABLE IF EXISTS run_events;
   DROP TABLE IF EXISTS runs;
   DROP TABLE IF EXISTS jobs;
   DROP TABLE IF EXISTS tasks;
   DROP TABLE IF EXISTS messages;
   DROP TABLE IF EXISTS links;
   DROP TABLE IF EXISTS node_positions;
   DROP TABLE IF EXISTS discord_threads;
   DROP TABLE IF EXISTS discord_pairings;
   DROP TABLE IF EXISTS discord_bots;
   DROP TABLE IF EXISTS operators;
   DROP TABLE IF EXISTS squads;`,
  // Claude tiles open in the Chat view or the Terminal view; existing tiles keep the Terminal.
  `ALTER TABLE scratch ADD COLUMN view TEXT NOT NULL DEFAULT 'terminal';`,
]

export const PLAYGROUND_KEPT = 'The Playground cannot be deleted; you can rename it or change its folder'

type Row = Record<string, unknown>

const toCrew = (r: Row): Crew => ({
  id: Number(r.id),
  name: String(r.name),
  folder: String(r.folder),
  createdAt: Number(r.created_at),
  prjNumber: Number(r.prj_number),
  sortOrder: Number(r.sort_order),
  groupId: r.group_id == null ? null : Number(r.group_id),
  kind: r.kind === 'playground' ? 'playground' : 'project',
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
  mcp: r.mcp as McpMode,
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
  ...presetInfo(r.builtin == null ? null : String(r.builtin)),
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
  view: r.view === 'chat' ? 'chat' : 'terminal',
  createdAt: Number(r.created_at),
})


type PresetFields = Omit<Preset, 'id' | 'updatedAt'>
type BuiltinPreset = Omit<PresetFields, keyof SeatFields>
const SEAT_DEFAULTS: SeatFields = { skills: [], hindsight: true, codegraph: true, mcpServers: ['codegraph', 'hindsight'] }
// Stages that recommend an optional server (see mcp-optional.ts). It is named, not required: a launch leaves it out while
// the CLI does not have it.
const OPTIONAL_STAGE_MCP: Record<string, string[]> = { test: ['playwright'], review: ['git'], release: ['git'], implement: ['git'] }
const shippedSeat = (builtin: string): Pick<SeatFields, 'mcpServers'> => ({
  mcpServers: [...SEAT_DEFAULTS.mcpServers, ...(OPTIONAL_STAGE_MCP[builtin.replace(/-opencode$/, '')] ?? [])],
})

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

const toTeam = (r: Row, hidden: string[] = []): Team => ({
  id: Number(r.id),
  name: String(r.name),
  rules: String(r.rules),
  builtin: r.builtin == null ? null : String(r.builtin),
  description: r.description == null ? '' : String(r.description),
  modified: Number(r.modified) === 1,
  hidden: r.builtin != null && hidden.includes(String(r.builtin)),
  updatedAt: Number(r.updated_at),
})










const EDIT_TOOLS = 'Read,Grep,Glob,Edit,Write,Bash'
const READ_TOOLS = 'Read,Grep,Glob,Bash'
const READ_WEB_TOOLS = 'Read,Grep,Glob,Bash,WebFetch'
// Bash is limited to git reads and CodeGraph; under "Don't ask" anything else is refused.
const GIT_READS = ['Bash(git diff*)', 'Bash(git status*)', 'Bash(git log*)', 'Bash(git show*)', 'Bash(codegraph *)']
const EDIT_ALLOW = [...GIT_READS, 'Bash(npm test*)', 'Bash(npm run *)']
const EDIT_DENY = ['Bash(git commit*)', 'Bash(git push*)']
// Read-only seats: no edit tool in the list, Edit and Write denied as well, so no permission setting can let them write.
const READ_ALLOW = [...GIT_READS]
const READ_DENY = ['Edit', 'Write', 'NotebookEdit', 'Bash(git commit*)', 'Bash(git push*)']
const TEST_PATHS = ['**/test/**', '**/tests/**', '**/*.test.*', '**/*.spec.*', 'e2e/**']

// One Claude seat. Guidance text comes from preset-text.ts (applied in BUILTIN_PRESETS).
const seat = (s: Pick<BuiltinPreset, 'builtin' | 'name' | 'model' | 'effort' | 'permissionMode' | 'tools' | 'allow' | 'deny' | 'cacheTtl' | 'contextCap'>): BuiltinPreset => ({
  agent: 'claude',
  mcp: 'codegraph',
  roleText: null,
  ...s,
})

// Release may edit the release notes and the version files, and nothing else.
const RELEASE_PATHS = ['RELEASE_NOTES.md', 'CHANGELOG.md', 'package.json', 'package-lock.json', '**/package.json', '**/gradle.properties', '**/pom.xml', '**/Cargo.toml']
const editAll = (globs: string[]) => globs.flatMap((g) => [`Edit(${g})`, `Write(${g})`])

// The eight stage presets, one Claude Code copy each. Models are the Claude Code aliases (haiku, sonnet, opus), so the
// CLI's current model of each class is used.
const CLAUDE_PRESETS: BuiltinPreset[] = [
  seat({ builtin: 'research', name: 'Research', model: 'claude-haiku-5-5', effort: '', permissionMode: 'dontAsk', tools: READ_WEB_TOOLS, allow: [...READ_ALLOW, 'WebFetch'], deny: READ_DENY, cacheTtl: '5m', contextCap: 100_000 }),
  seat({ builtin: 'plan', name: 'Plan', model: 'claude-sonnet-5-5', effort: 'medium', permissionMode: 'dontAsk', tools: READ_TOOLS, allow: READ_ALLOW, deny: READ_DENY, cacheTtl: '1h', contextCap: 150_000 }),
  seat({ builtin: 'design', name: 'Design', model: 'claude-opus-5-5', effort: 'high', permissionMode: 'dontAsk', tools: READ_WEB_TOOLS, allow: [...READ_ALLOW, 'WebFetch'], deny: READ_DENY, cacheTtl: '1h', contextCap: 300_000 }),
  seat({ builtin: 'implement', name: 'Implement', model: 'claude-sonnet-5-5', effort: 'medium', permissionMode: 'acceptEdits', tools: EDIT_TOOLS, allow: EDIT_ALLOW, deny: EDIT_DENY, cacheTtl: 'auto', contextCap: 200_000 }),
  seat({
    builtin: 'test',
    name: 'Test',
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    permissionMode: 'dontAsk',
    tools: EDIT_TOOLS,
    allow: [...GIT_READS, 'Bash(npm *)', 'Bash(npx *)', 'Bash(node *)', ...editAll(TEST_PATHS)],
    deny: EDIT_DENY,
    cacheTtl: 'auto',
    contextCap: 120_000,
  }),
  seat({ builtin: 'review', name: 'Review', model: 'claude-sonnet-5-5', effort: 'high', permissionMode: 'dontAsk', tools: READ_TOOLS, allow: [...READ_ALLOW, 'Bash(npm test*)'], deny: READ_DENY, cacheTtl: '1h', contextCap: 150_000 }),
  seat({
    builtin: 'release',
    name: 'Release',
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    permissionMode: 'dontAsk',
    tools: EDIT_TOOLS,
    allow: [...GIT_READS, 'Bash(npm run *)', 'Bash(npm test*)', 'Bash(npx *)', 'Bash(node *)', ...editAll(RELEASE_PATHS)],
    deny: [...EDIT_DENY, 'Bash(npm publish*)', 'Bash(git tag*)', 'Bash(gh *)'],
    cacheTtl: 'auto',
    contextCap: 150_000,
  }),
  seat({ builtin: 'learn', name: 'Learn', model: 'claude-haiku-5-5', effort: '', permissionMode: 'dontAsk', tools: READ_TOOLS, allow: [...READ_ALLOW, 'Bash(operant memory retain*)'], deny: READ_DENY, cacheTtl: '5m', contextCap: 100_000 }),
]

// The same stages for OpenCode: the role text and tools carry over, but the model is empty. OpenCode's model ids are
// provider/model and come from its own catalogue, so a stage takes the model OpenCode is set to.
const OPENCODE_PRESETS: BuiltinPreset[] = CLAUDE_PRESETS.map((p) => ({
  ...p,
  builtin: `${p.builtin}-opencode`,
  name: `${p.name} (OpenCode)`,
  agent: 'opencode' as const,
  model: '',
  effort: '',
}))

export const BUILTIN_PRESETS: BuiltinPreset[] = [...CLAUDE_PRESETS, ...OPENCODE_PRESETS].map((p) => ({ ...p, roleText: p.roleText ?? presetTextFor(p.builtin!) }))

// Which shipped set the database has. Bump when BUILTIN_PRESETS or the shipped teams change.
const SEED_VERSION = 5

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
  mcp: 'mcp',
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
  view: 'view',
}


export interface ScratchInput {
  crewId: number
  title: string
  agent: AgentKind
  model?: string
  effort?: string
  presetId?: number | null
  view?: ScratchView
  cwd: string
}

export type ScratchPatch = Partial<Omit<ScratchInput, 'crewId'>> & { sessionId?: string | null }

// One assistant message's usage. `cacheTokens` is the pre-split total, kept for callers that
// cannot tell the kinds apart: it is recorded as cache reads when no kind is given.
export interface UsageInput {
  scratchId?: number | null
  messageId?: string | null
  sessionId?: string | null
  model?: string
  at: number
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
  cli?: string
  provider?: string
  source?: string
  crewId?: number | null
  projectLabel?: string
  extKey?: string | null
}





const nullable = (v: unknown): number | null => (v == null ? null : Number(v))
const toUsage = (r: Row): Usage => ({
  id: Number(r.id),
  scratchId: nullable(r.scratch_id),
  messageId: r.message_id == null ? null : String(r.message_id),
  sessionId: r.session_id == null ? null : String(r.session_id),
  model: String(r.model),
  at: Number(r.at),
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
  kind: String(r.kind),
  message: String(r.message),
  at: Number(r.at),
})

export class Store {
  readonly db: DatabaseSync
  private txDepth = 0

  constructor(file: string, private readonly now: () => number = Date.now, private readonly backupDir?: string) {
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
    // Foreign keys are off while the schema changes: the orchestration tables are dropped, and the kept tables
    // that pointed at them keep their (now unused) columns.
    this.db.exec('PRAGMA foreign_keys = OFF')
    try {
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
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON')
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

  // Exactly one Playground row: created once with the given folder, left alone (name, folder) after.
  ensurePlayground(folder: string): Crew {
    const row = this.db.prepare("SELECT * FROM crews WHERE kind = 'playground' ORDER BY id LIMIT 1").get() as Row | undefined
    if (row) return toCrew(row)
    return toCrew(
      this.db
        .prepare("INSERT INTO crews (name, folder, created_at, prj_number, sort_order, kind) VALUES ('Playground', ?, ?, 0, 0, 'playground') RETURNING *")
        .get(folder, this.now()) as Row,
    )
  }

  getPlayground(): Crew | null {
    const row = this.db.prepare("SELECT * FROM crews WHERE kind = 'playground' ORDER BY id LIMIT 1").get() as Row | undefined
    return row ? toCrew(row) : null
  }

  listCrews(): Crew[] {
    return (this.db.prepare('SELECT * FROM crews ORDER BY sort_order, id').all() as Row[]).map(toCrew)
  }

  getCrew(id: number): Crew | null {
    const row = this.db.prepare('SELECT * FROM crews WHERE id = ?').get(id) as Row | undefined
    return row ? toCrew(row) : null
  }

  updateCrew(id: number, patch: { name?: string; folder?: string }): Crew {
    const cur = this.getCrew(id)
    if (!cur) throw new Error(`Project ${id} not found`)
    const row = this.db.prepare('UPDATE crews SET name = ?, folder = ? WHERE id = ? RETURNING *').get(patch.name ?? cur.name, patch.folder ?? cur.folder, id) as Row
    return toCrew(row)
  }

  // Saved order of the project list: the given crews take positions 1..n, any other crew follows.
  reorderCrews(ids: number[]): Crew[] {
    this.tx(() => {
      const current = (this.db.prepare("SELECT id FROM crews WHERE kind != 'playground' ORDER BY sort_order, id").all() as Row[]).map((r) => Number(r.id))
      const first = ids.filter((id, i) => current.includes(id) && ids.indexOf(id) === i)
      const order = [...first, ...current.filter((id) => !first.includes(id))]
      const set = this.db.prepare('UPDATE crews SET sort_order = ? WHERE id = ?')
      order.forEach((id, i) => set.run(i + 1, id))
    })
    return this.listCrews()
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
    if (this.getCrew(id)?.kind === 'playground') throw new Error(PLAYGROUND_KEPT)
    this.db.prepare('DELETE FROM crews WHERE id = ?').run(id)
  }

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

  // Presets (plain launch settings and guidance text for tiles)

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
           context_cap, mcp, role_text, updated_at, skills, hindsight, codegraph, mcp_servers)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
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

  // Built-ins are inserted by core, once per shipped set, so a preset the user deleted stays deleted until
  // `restoreBuiltins`. A bumped SEED_VERSION re-runs restoreBuiltins once on existing databases.
  seedBuiltinPresets(): void {
    this.addOptionalMcpOnce()
    if (this.getJson('presets.seededVersion') === SEED_VERSION) return
    this.tx(() => {
      this.migrateBuiltins()
      this.migrateBuiltinTeams()
      this.restoreBuiltins()
      // Existing built-ins that were shipped without guidance text get the shipped text; text the user wrote stays.
      for (const b of BUILTIN_PRESETS) if (b.roleText) this.db.prepare('UPDATE presets SET role_text = ? WHERE builtin = ? AND role_text IS NULL').run(b.roleText, b.builtin!)
      this.setJson('presets.seeded', true)
      this.setJson('presets.seededVersion', SEED_VERSION)
    })
  }

  // Existing built-in stages gain their optional servers once. A stage whose server list the user changed keeps it.
  private addOptionalMcpOnce(): void {
    if (this.getJson('presets.optionalMcp') === true) return
    this.tx(() => {
      const shipped = [...SEAT_DEFAULTS.mcpServers].sort().join()
      for (const p of this.listPresets()) {
        if (!p.builtin || !(p.builtin.replace(/-opencode$/, '') in OPTIONAL_STAGE_MCP)) continue
        if ([...p.mcpServers].sort().join() === shipped) this.updatePreset(p.id, shippedSeat(p.builtin))
      }
      this.setJson('presets.optionalMcp', true)
    })
  }

  // The one-time cleanup for the stage set. Each stage keeps one built-in copy for Claude Code and one for OpenCode, reset
  // to the shipped values. Every other built-in preset is deleted: the earlier sets' keys, their "-opencode" rows and any
  // duplicate. Before anything is deleted or reset, all built-ins are copied to a pre-presets-cleanup backup. User presets
  // (no built-in key) are not touched.
  private migrateBuiltins(): void {
    const builtins = this.listPresets().filter((p) => p.builtin != null)
    if (builtins.length === 0) return
    if (this.backupDir) {
      writeBackup(this.backupDir, buildBackup({ 'presets.json': builtins, 'teams.json': this.listTeams() }, 'Before the presets cleanup', this.now()), 'pre-presets-cleanup-')
    }
    const current = new Set(BUILTIN_PRESETS.map((b) => b.builtin!))
    const first = new Map<string, Preset>()
    for (const p of builtins) if (current.has(p.builtin!) && !first.has(p.builtin!)) first.set(p.builtin!, p)
    for (const p of builtins) if (first.get(p.builtin!) !== p) this.db.prepare('DELETE FROM presets WHERE id = ?').run(p.id)
    for (const [key, p] of first) {
      const shipped = BUILTIN_PRESETS.find((b) => b.builtin === key)!
      const { builtin: _b, roleText, ...values } = shipped
      this.updatePreset(p.id, { ...values, name: this.presetNameFree(shipped.name, p.id), roleText })
    }
  }

  // Teams: a renamed shipped team takes its new key, and its text when it was never edited. A retired one is hidden
  // (under its current key); an edited one becomes the user's own team.
  private migrateBuiltinTeams(): void {
    const hidden = this.hiddenTeams()
    for (const r of this.db.prepare('SELECT * FROM teams WHERE builtin IS NOT NULL').all() as Row[]) {
      const id = Number(r.id)
      const from = String(r.builtin)
      const to = TEAM_RENAMES[from] ?? from
      const def = BUILTIN_TEAMS.find((d) => d.builtin === to)
      const edited = Number(r.modified) === 1
      if (def && (to === from || !this.db.prepare('SELECT 1 FROM teams WHERE builtin = ?').get(to))) {
        this.db.prepare('UPDATE teams SET builtin = ? WHERE id = ?').run(to, id)
        if (!edited) this.db.prepare('UPDATE teams SET name = ?, description = ?, rules = ?, updated_at = ? WHERE id = ?').run(this.teamNameFree(def.name, id), def.description, def.rules, this.now(), id)
        if (hidden.includes(from) && from !== to) hidden[hidden.indexOf(from)] = to
      } else if (!edited && RETIRED_TEAMS.includes(to)) {
        this.db.prepare('UPDATE teams SET builtin = ? WHERE id = ?').run(to, id)
        if (!hidden.includes(to)) hidden.push(to)
      } else {
        this.db.prepare('UPDATE teams SET builtin = NULL, name = ? WHERE id = ?').run(this.teamNameFree(String(r.name), id), id)
      }
    }
    this.setJson('teams.hidden', hidden)
  }

  // Re-adds any built-in preset that is missing; returns the ones added.
  restoreBuiltins(): Preset[] {
    return this.tx(() => {
      const added = BUILTIN_PRESETS.filter((b) => !this.getPresetByBuiltin(b.builtin!)).map((b) =>
        this.insertPreset({ ...SEAT_DEFAULTS, ...shippedSeat(b.builtin!), ...b, name: this.presetNameFree(b.name, null) }),
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

  // A copy is always a user preset.
  duplicatePreset(id: number, name?: string): Preset {
    const src = this.getPreset(id)
    if (!src) throw new Error(`Preset ${id} not found`)
    const { id: _id, updatedAt: _u, ...fields } = src
    return this.insertPreset({
      ...fields,
      builtin: null,
      name: this.presetNameFree(name ?? `${src.name} copy`, null),
    })
  }

  deletePreset(id: number): void {
    this.db.prepare('DELETE FROM presets WHERE id = ?').run(id)
  }

  // A built-in goes back to its shipped values.
  resetPreset(id: number): Preset {
    const preset = this.getPreset(id)
    if (!preset) throw new Error(`Preset ${id} not found`)
    const shipped = BUILTIN_PRESETS.find((b) => b.builtin === preset.builtin)
    if (!shipped) throw new Error('Only built-in presets can be reset')
    const { builtin: _b, ...values } = shipped
    return this.updatePreset(id, { ...values, ...shippedSeat(shipped.builtin!), name: this.presetNameFree(shipped.name, id) })
  }

  // Scratch terminals

  createScratch(input: ScratchInput): ScratchTerminal {
    const row = this.db
      .prepare('INSERT INTO scratch (crew_id, title, agent, model, effort, preset_id, cwd, view, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *')
      .get(input.crewId, input.title, input.agent, input.model ?? '', input.effort ?? '', input.presetId ?? null, input.cwd, input.view ?? 'terminal', this.now()) as Row
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

  // Teams (plain guidance: a name, a description and rules text)

  createTeam(input: TeamInput, builtin: string | null = null): Team {
    const row = this.db
      .prepare('INSERT INTO teams (name, seats, limits, rules, description, builtin, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *')
      .get(input.name, '[]', '{}', input.rules ?? '', input.description ?? '', builtin, this.now()) as Row
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
      .prepare('UPDATE teams SET name = ?, rules = ?, description = ?, modified = ?, updated_at = ? WHERE id = ? RETURNING *')
      .get(
        patch.name ?? cur.name,
        patch.rules ?? cur.rules,
        patch.description ?? cur.description,
        cur.builtin != null || cur.modified ? 1 : 0,
        this.now(),
        id,
      ) as Row
    return toTeam(row, this.hiddenTeams())
  }

  // Built-ins stay (hide them instead).
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

  // A user team with the same text.
  duplicateTeam(id: number, name?: string): Team {
    const src = this.getTeam(id)
    if (!src) throw new Error(`Team ${id} not found`)
    return this.createTeam({ name: this.teamNameFree(name ?? `${src.name} copy`, null), rules: src.rules, description: src.description })
  }

  // Inserts any shipped team that is missing. One the user edited or hid is left as it is.
  seedBuiltinTeams(): void {
    this.tx(() => {
      for (const def of BUILTIN_TEAMS) {
        if (this.db.prepare('SELECT 1 FROM teams WHERE builtin = ?').get(def.builtin)) continue
        this.createTeam({ name: this.teamNameFree(def.name, null), description: def.description, rules: def.rules }, def.builtin)
      }
    })
  }

  resetTeam(id: number): Team {
    const cur = this.getTeam(id)
    const def = BUILTIN_TEAMS.find((b) => b.builtin === cur?.builtin)
    if (!cur || !def) throw new Error('Only built-in teams can be reset')
    const row = this.db
      .prepare('UPDATE teams SET name = ?, rules = ?, description = ?, modified = 0, updated_at = ? WHERE id = ? RETURNING *')
      .get(this.teamNameFree(def.name, id), def.rules, def.description, this.now(), id) as Row
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

  // Usage

  addUsage(u: UsageInput): Usage {
    return toUsage(this.insertUsage(u, '') as Row)
  }

  // One row per assistant message: re-reading a transcript updates the row instead of adding one.
  upsertMessageUsage(messageId: string, u: UsageInput): void {
    if (u.scratchId == null) throw new Error('Message usage belongs to a scratch terminal')
    this.insertUsage(
      { ...u, messageId },
      `ON CONFLICT (scratch_id, message_id) DO UPDATE SET
         model = excluded.model, session_id = excluded.session_id,
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
        `INSERT INTO usage (scratch_id, message_id, session_id, model, at, input_tokens, output_tokens,
           cache_read, cache_w5m, cache_w1h, cost_usd, context_tokens, cold, tool_use, legacy,
           cli, provider, source, crew_id, project_label, ext_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ${onConflict} RETURNING *`,
      )
      .get(
        u.scratchId ?? null,
        u.messageId ?? null,
        u.sessionId ?? null,
        u.model ?? '',
        u.at,
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
        cli,
        u.provider ?? (cli === 'claude' ? 'anthropic' : ''),
        u.source ?? (u.scratchId != null ? 'scratch' : ''),
        u.crewId ?? null,
        u.projectLabel ?? '',
        u.extKey ?? null,
      ) as Row | undefined
  }

  // A usage row that belongs to no tile (a provider's own figures), keyed by `extKey`. `update` re-writes the
  // figures of a row seen before; otherwise a known key is left alone. Returns what happened.
  upsertKeyedUsage(u: UsageInput & { extKey: string }, update: boolean): 'added' | 'updated' | 'unchanged' {
    if (u.scratchId != null) throw new Error('Keyed usage belongs to no scratch terminal')
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
           cost_usd = ?, context_tokens = ?, tool_use = ? WHERE id = ?`,
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
        have.id as number,
      )
    return 'updated'
  }

  // Spend is `usage` plus `spend_archive`. A project's spend is its tiles' and its own imported rows.
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
         LEFT JOIN scratch c ON c.id = u.scratch_id
         WHERE u.at >= ? AND COALESCE(c.crew_id, u.crew_id) = ?`,
        since,
        crewId,
      ) + sum('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM spend_archive WHERE day >= ? AND crew_id = ?', since, crewId)
    )
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
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value))
  }

  // Events
  addEvent(kind: string, message: string, crewId: number | null = null): OperantEvent {
    const row = this.db.prepare('INSERT INTO events (crew_id, kind, message, at) VALUES (?, ?, ?, ?) RETURNING *').get(crewId, kind, message, this.now()) as Row
    return toEvent(row)
  }

  recentEvents(limit: number): OperantEvent[] {
    return (this.db.prepare('SELECT * FROM events ORDER BY at DESC, id DESC LIMIT ?').all(limit) as Row[]).map(toEvent)
  }
}
