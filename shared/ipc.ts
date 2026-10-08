import type { ModelList } from './models'
import type { ConsoleLine, ConsoleProcess, ConsoleSource } from './console'
import type { DraftStatus, LearnAi, LearnRunInfo, LearnStatus, LearnTestResult, LearnStore, Lesson, LessonFilter, LessonPatch, LessonStatus, MemoryFile, SkillDraft } from './learn'
import type {
  AgentKind,
  AppInfo,
  BudgetConfig,
  BudgetStatus,
  BudgetTarget,
  ExportFormat,
  ExportText,
  ImportPreview,
  ImportResult,
  ImportSource,
  RunUsage,
  ProvidersStatus,
  UsageQuery,
  UsageReport,
  UsageSeries,
  UsageSeriesQuery,
  UsageView,
  CapEvent,
  CapStatus,
  ChangePlan,
  Crew,
  CrewCounts,
  DiscordAiTestResult,
  DiscordBotAi,
  DiscordBotInput,
  DiscordBotPatch,
  DiscordBotView,
  DiscordHealth,
  DiscordPairing,
  DiscordTestResult,
  CrewPatch,
  CrewTopology,
  CrewView,
  GraphData,
  GraphWindow,
  IndexStatus,
  HindsightAdapter,
  HindsightKeyState,
  HindsightStatus,
  HindsightTestResult,
  ProjectHealth,
  JobAgent,
  IpcErrorCode,
  JobState,
  JobInput,
  JobRecord,
  JobUpdate,
  Link,
  Message,
  MessageFilter,
  MessageSend,
  NodePosition,
  OperantEvent,
  Operator,
  OperatorChange,
  OperatorContext,
  McpDown,
  McpOverview,
  McpServerInput,
  OperatorFromPreset,
  OperatorPatch,
  OperatorSpend,
  OperatorStatus,
  Preset,
  PresetInput,
  PresetPatch,
  PurgeOutcome,
  PurgeStatus,
  Run,
  RunEvent,
  MasterState,
  RunInput,
  RunStatus,
  ScratchInput,
  ScratchPatch,
  ScratchSpend,
  ScratchStatus,
  ScratchTerminal,
  Squad,
  SquadDelete,
  Team,
  TeamImportPreview,
  TeamInput,
  TeamPatch,
  UnreadCounts,
  UpdateStatus,
  UsageBreakdownResult,
  UsagePeriod,
} from './types'
import type { GitChanges, GitInfo, IdeId, IdeInfo, ProjectGroup } from './projects'
import type { GitBranches, GitCommit, GitCommitDetails, GitCommitResult, GitDiff, GitDiffRequest, GitHunkRef, GitResult, GitStatus } from './git'
import type { Settings, SettingsPatch } from './settings'
import type { MediaState, MediaTimeline } from './media'

export interface DashboardSummary {
  operatorsRunning: number
  operatorsTotal: number
  tasksOpen: number
  spendToday: number
  dailyBudgetUsd: number
}

// Request/response calls: renderer -> main via ipcRenderer.invoke. Every one is validated in core; a
// refusal rejects with an `IpcError` (code + message the dashboard can show).
export interface IpcApi {
  // Crews
  'crews:list': () => Crew[]
  'crews:topology': (crewId: number) => CrewTopology | null
  'crews:create': (input: { name: string; folder: string }) => Crew
  'crews:update': (crewId: number, patch: CrewPatch) => Crew
  // Saves the project list order: these crews first, in this order.
  // Opens (or extends) the project's "Update tracker" board job by hand.
  'crews:trackerNow': (crewId: number) => JobRecord
  'crews:reorder': (crewIds: number[]) => Crew[]
  // What a delete would remove, for the confirm dialog.
  'crews:counts': (crewId: number) => CrewCounts
  // Stops every session, then removes the crew with its jobs, messages, spend history and tiles.
  'crews:delete': (crewId: number) => CrewCounts
  // Deletes a project's runs, messages and lessons (the Playground's "Clear history"); no file on disk is touched.
  'crews:clearHistory': (crewId: number) => CrewCounts

  // Project groups. Removing a group puts its projects back in the list; no folder is touched.
  'groups:list': () => ProjectGroup[]
  // A blank name takes the next free "New group", "New group 2", ...
  'groups:create': (name?: string) => ProjectGroup
  'groups:rename': (groupId: number, name: string) => ProjectGroup
  'groups:delete': (groupId: number) => void
  'groups:collapse': (groupId: number, collapsed: boolean) => ProjectGroup
  // Saved order of the groups.
  'groups:reorder': (groupIds: number[]) => ProjectGroup[]
  // Puts the project in a group (null = ungrouped), before another project when given.
  'groups:move': (crewId: number, groupId: number | null, beforeCrewId?: number) => Crew[]

  // IDEs and git for the project menu
  'ide:list': () => IdeInfo[]
  // Launches the IDE (default: the one in settings) on the project folder; a failure rejects with the reason.
  'ide:open': (crewId: number, ide?: IdeId) => void
  'git:changes': (crewId: number) => GitChanges
  // Branch, ahead/behind and changed-file count for the top bar and project rows; null when the folder is not a git repository.
  'git:info': (crewId: number) => GitInfo | null
  // The Git page. Nothing here commits or pushes by itself: each runs when the person clicks it. Paths are relative to the repository folder.
  'git:status': (crewId: number) => GitStatus | null
  'git:diff': (crewId: number, req: GitDiffRequest) => GitDiff
  'git:stage': (crewId: number, paths: string[]) => GitResult
  'git:unstage': (crewId: number, paths: string[]) => GitResult
  // Throws the files' changes away (a new file is deleted); the page asks first.
  'git:discard': (crewId: number, paths: string[]) => GitResult
  // Stages one hunk of a tracked file (stage = true), or unstages one.
  'git:stageHunk': (crewId: number, ref: GitHunkRef, stage: boolean) => GitResult
  'git:commit': (crewId: number, message: string, amend?: boolean) => GitCommitResult
  'git:lastMessage': (crewId: number) => string
  'git:log': (crewId: number, limit?: number, skip?: number) => GitCommit[]
  'git:commitDetails': (crewId: number, hash: string) => GitCommitDetails
  'git:branches': (crewId: number) => GitBranches
  'git:checkout': (crewId: number, branch: string) => GitResult
  'git:createBranch': (crewId: number, name: string) => GitResult
  'git:fetch': (crewId: number) => GitResult
  'git:pull': (crewId: number) => GitResult
  'git:push': (crewId: number) => GitResult

  // Squads
  'squads:create': (input: { crewId: number; name: string }) => Squad
  'squads:update': (squadId: number, patch: { name: string }) => Squad
  // Soft-deletes the squad's operators (the full operator flow), then the squad.
  'squads:delete': (squadId: number) => SquadDelete

  // Operators
  'operators:create': (input: { squadId: number; role: string; agent: AgentKind; model: string }) => Operator
  'operators:createFromPreset': (input: OperatorFromPreset) => Operator
  // Role, squad and daily cap only; applies live.
  'operators:update': (operatorId: number, patch: { role?: string; squadId?: number; dailyCapUsd?: number | null }) => Operator
  // What a change would do (restart? cache or conversation lost? cold-cache cost), without saving.
  'operators:previewChange': (operatorId: number, patch: OperatorPatch) => ChangePlan
  // Saves the change; a running Claude operator is relaunched fresh when the plan says so (ruling R1).
  'operators:applyChange': (operatorId: number, patch: OperatorPatch) => OperatorChange
  'operators:start': (operatorId: number) => void
  'operators:stop': (operatorId: number) => void
  'operators:restart': (operatorId: number) => void
  // Soft delete: stops it, releases its jobs, moves its reviews, drops its unread messages and links.
  'operators:delete': (operatorId: number) => void
  'operators:write': (operatorId: number, data: string) => void
  'operators:resize': (operatorId: number, cols: number, rows: number) => void
  'operators:buffer': (operatorId: number) => string
  'operators:context': () => Record<number, OperatorContext>

  // Master Terminal (one per crew; use operators:write/resize/buffer with its id)
  'master:get': (crewId: number) => Operator | null
  'master:start': (crewId: number) => Operator
  'master:stop': (crewId: number) => void
  // Where the project's Master Terminal is (fed by the plugin hooks, or OpenCode's service events).
  'master:state': (crewId: number) => MasterState

  // Presets
  'presets:list': () => Preset[]
  'presets:create': (input: PresetInput) => Preset
  // `apply` copies the new values to the operators that were unmodified before this edit (running ones take
  // them on their next restart).
  'presets:update': (presetId: number, patch: PresetPatch, apply?: boolean) => Preset
  'presets:duplicate': (presetId: number, name?: string) => Preset
  'presets:delete': (presetId: number) => void
  // Built-ins go back to their shipped values and role text.
  'presets:reset': (presetId: number) => Preset
  'presets:restoreBuiltins': () => Preset[]
  // The shipped role text of a built-in ('' for a user preset), to show next to an edit.
  'presets:shippedRole': (presetId: number) => string
  // Copies the preset over the given operators (default: every operator that uses it).
  'presets:applyToOperators': (presetId: number, operatorIds?: number[]) => Operator[]
  // "Save as new preset": the operator's settings become a user preset it is linked to.
  'presets:saveFromOperator': (operatorId: number, name: string) => Preset
  // "Revert to preset".
  'presets:revertOperator': (operatorId: number) => Operator

  // Jobs (the user actor)
  'jobs:list': (crewId: number, open?: boolean) => JobRecord[]
  'jobs:get': (jobId: number) => JobRecord
  'jobs:create': (input: JobInput) => JobRecord
  'jobs:update': (jobId: number, patch: JobUpdate) => JobRecord
  'jobs:delete': (jobId: number) => void
  'jobs:approve': (jobId: number, note?: string) => JobRecord
  'jobs:reject': (jobId: number, reason: string) => JobRecord
  // Approve-to-start for a held job.
  'jobs:approveStart': (jobId: number) => JobRecord
  'jobs:escalate': (jobId: number, reason: string) => JobRecord
  // Any state and/or assignee.
  'jobs:move': (jobId: number, patch: { state?: JobState; assigneeId?: number | null }) => JobRecord
  // Aliases of the jobs calls until the renderer moves over (removed in step 13).

  // Model ids the given CLI offers (OpenCode asks the CLI; an error explains an empty list).
  // Also groups them by provider; `refresh` skips the 5-minute cache (the Refresh button).
  'models:list': (agent: 'claude' | 'opencode', refresh?: boolean) => ModelList

  // Teams
  'teams:list': () => Team[]
  'teams:create': (input: TeamInput) => Team
  'teams:update': (teamId: number, patch: TeamPatch) => Team
  'teams:delete': (teamId: number) => void
  'teams:duplicate': (teamId: number, name?: string) => Team
  'teams:reset': (teamId: number) => Team
  'teams:setHidden': (teamId: number, hidden: boolean) => Team
  // Writes one team (or all when no id) to a file the user picks; null path when they cancel.
  'teams:export': (teamId?: number) => { saved: string | null }
  // Picks a team file and says what importing it would do; null when they cancel.
  'teams:importPreview': () => TeamImportPreview | null
  'teams:import': (path: string) => Team[]

  // Dashboard jobs (JOB#). A run over its team's limits is refused.
  'runs:list': (crewId: number) => Run[]
  'runs:get': (runId: number) => Run
  'runs:create': (input: RunInput) => Run
  // Cancels a queued job or stops a running one; either ends as failed.
  'runs:stop': (runId: number) => Run
  'runs:agents': (runId: number) => JobAgent[]
  // Edits the task of a queued job; refused once it has started.
  'runs:update': (runId: number, patch: { task?: string }) => Run
  // Deletes a finished job (done or failed) and its agents; a queued or working one is refused.
  'runs:delete': (runId: number) => void
  // The tail of one job agent's transcript as plain text lines (secrets removed, size-capped).
  'runs:agentLog': (runId: number, agentId: number) => string[]
  // The images pasted into a job's task as data URLs (only files inside the project's .operant-attachments folder; at most 8, 8 MB each). Missing files are skipped.
  'runs:images': (runId: number) => string[]
  // Jobs that may run at once per project (default 1).
  // Approves a job in review: it is done and its close-out is pending.
  'runs:approve': (runId: number, note?: string) => Run
  // Sends a job in review back to the front of its queue with the owner's note (required).
  'runs:sendBack': (runId: number, note: string) => Run
  // The owner's reply to the Master's question (or a note while it works); the Master reads it with `operant run answer`.
  'runs:answer': (runId: number, text: string) => RunEvent
  // The job's conversation: progress, questions, replies, review, approval.
  'runs:events': (runId: number) => RunEvent[]
  // Retry or Resume for a master-mode job waiting on the Master (did not start, did not pick up the task, stopped, or
  // Operant was closed): starts the Master when it is not running (Claude --resume, OpenCode --continue), then types
  // the job's pointer line at the next idle. Also restarts the Master for a queued job whose automatic start was used.
  'runs:resumeMaster': (runId: number) => Run
  // Starts the close-out of an approved master-mode job (write-back, CodeGraph, learn) or retries a partial / failed
  // one; a running or finished one is left alone. Does not wait: closeoutState and the 'closeout' run events show progress.
  'runs:closeout': (runId: number) => Run
  'runs:getLimit': () => number
  'runs:setLimit': (limit: number) => number

  // Discord bots. Tokens go in through create/setToken and never come back out.
  'discord:list': () => DiscordBotView[]
  'discord:create': (input: DiscordBotInput) => DiscordBotView
  'discord:update': (botId: number, patch: DiscordBotPatch) => DiscordBotView
  'discord:delete': (botId: number) => void
  'discord:setToken': (botId: number, token: string) => DiscordBotView
  'discord:clearToken': (botId: number) => DiscordBotView
  'discord:connect': (botId: number) => DiscordBotView
  'discord:disconnect': (botId: number) => DiscordBotView
  'discord:health': () => DiscordHealth[]
  'discord:test': (botId: number) => DiscordTestResult
  'discord:testAi': (botId: number, ai?: Partial<DiscordBotAi>) => DiscordAiTestResult
  'discord:localModels': (url: string) => string[]
  'discord:pairings': (botId: number) => DiscordPairing[]
  'discord:approvePairing': (botId: number, code: string) => DiscordBotView
  'discord:denyPairing': (botId: number, code: string) => void

  // Links
  'links:list': (crewId: number) => Link[]
  'links:create': (input: { crewId: number; fromId: number; toId: number; label?: string }) => Link
  'links:update': (linkId: number, patch: { label?: string; fromId?: number; toId?: number }) => Link
  'links:delete': (linkId: number) => void

  // Messages (the user's side)
  'messages:list': (crewId: number, filter?: MessageFilter) => Message[]
  'messages:send': (input: MessageSend) => Message[]
  // Own message, while nobody has read it.
  'messages:edit': (messageId: number, body: string) => Message
  'messages:delete': (messageId: number) => void
  // Marks the user's unread messages read (all, or the ids); consent requests stay until answered.
  'messages:markRead': (crewId: number, ids?: number[]) => number
  'messages:unread': (crewId: number) => UnreadCounts
  // Consent card: Approve / Decline a `operant ask user` request.
  'messages:answer': (askId: number, approved: boolean, note?: string) => Message[]

  // Views and tiles
  'views:get': (crewId: number) => CrewView
  'views:set': (crewId: number, view: CrewView) => Crew
  'tiles:getLayout': (crewId: number) => unknown
  'tiles:saveLayout': (crewId: number, layout: unknown) => void

  // Scratch terminals (tiles)
  'scratch:list': (crewId: number) => ScratchTerminal[]
  'scratch:create': (input: ScratchInput) => ScratchTerminal
  // Applies on the next open.
  'scratch:update': (scratchId: number, patch: ScratchPatch) => ScratchTerminal
  // Stops the session; its spend stays in the Cost tab.
  'scratch:delete': (scratchId: number) => void
  // Idempotent: a running session is left alone and its state returned. A launch failure rejects.
  'scratch:start': (scratchId: number, resume?: boolean) => ScratchStatus
  'scratch:status': (scratchId: number) => ScratchStatus
  // Spend over the last 24 hours per scratch terminal of the crew.
  'scratch:spend': (crewId: number) => ScratchSpend[]
  // Closing a tile kills its process; the row stays so it can be reopened.
  'scratch:stop': (scratchId: number) => void
  'scratch:write': (scratchId: number, data: string) => void
  'scratch:resize': (scratchId: number, cols: number, rows: number) => void
  'scratch:buffer': (scratchId: number) => string

  // Usage, caps, purge
  'usage:series': (crewId: number) => OperatorSpend[]
  'usage:breakdown': (crewId: number, period: UsagePeriod) => UsageBreakdownResult
  // Any grouping and filter of the usage rows (day, project, job, seat, agent, model, CLI, provider): totals are the sum of the rows.
  'usage:report': (query: UsageQuery) => UsageReport
  // Cost and tokens per hour or day, optionally split (a line per model, project, ...).
  'usage:timeseries': (query: UsageSeriesQuery) => UsageSeries
  // What one JOB# spent per agent (Master first).
  'usage:job': (runId: number) => RunUsage
  // CSV or JSON text of any view, for the renderer to save.
  'usage:exportText': (view: UsageView, format: ExportFormat) => ExportText
  // The same, written to a file the user picks (null when they cancel).
  'usage:export': (view: UsageView, format: ExportFormat) => { saved: string | null }
  // Budgets: the daily budget lives in settings; project and job caps and what a cap does live here.
  'budgets:get': () => BudgetStatus
  'budgets:set': (patch: Partial<BudgetConfig>) => BudgetStatus
  // "Resume" after a cap: count spend from now on and let held jobs start.
  'budgets:resume': (target: BudgetTarget) => BudgetStatus
  // Import from Operant 2.8.2 (its data folder) or from an export file: preview what would be added, then apply.
  'import:preview': (source: ImportSource) => ImportPreview
  'import:apply': (source: ImportSource) => ImportResult
  // Asks for an export file to import (null when cancelled).
  'import:pickFile': () => string | null
  // This version's projects, presets and usage as one JSON document, to move to another machine.
  'data:export': () => ExportText
  'data:exportFile': () => { saved: string | null }
  // Plan limits and usage of the services behind the CLIs (Claude, OpenCode providers, z.ai).
  'providers:status': () => ProvidersStatus
  'providers:refresh': () => ProvidersStatus
  'caps:status': () => CapStatus
  // "Resume" after a pause: count spend from now on.
  'caps:reset': (target: number | 'daily') => CapStatus
  'purge:status': () => PurgeStatus
  // One deleted operator or all; the data-safety blockers (open jobs, unread messages) always apply.
  'purge:now': (target: number | 'all') => PurgeOutcome[]

  // Graph
  'graph:get': (crewId: number, window?: GraphWindow) => GraphData
  'graph:savePositions': (crewId: number, positions: Array<Pick<NodePosition, 'nodeKey' | 'x' | 'y'>>) => void
  'graph:clear': (crewId: number) => void

  'index:status': (crewId: number) => IndexStatus | null
  'index:run': (crewId: number) => IndexStatus | null
  'health:project': (crewId: number) => ProjectHealth
  'hindsight:status': () => HindsightStatus
  'hindsight:act': (action: 'start' | 'stop' | 'restart') => HindsightStatus
  // Network addresses a shared server can bind, Tailscale marked.
  'hindsight:adapters': () => HindsightAdapter[]
  // Test connection: reachability, key accepted or refused, bank count, latency, the server's own error.
  'hindsight:test': () => HindsightTestResult
  // API keys are write-only: only whether one is saved comes back (slot: shared = this PC's server, remote = another server).
  'hindsight:keyState': () => HindsightKeyState
  'hindsight:setKey': (slot: 'shared' | 'remote', key: string) => HindsightKeyState
  'hindsight:clearKey': (slot: 'shared' | 'remote') => HindsightKeyState
  // Makes and saves a random shared key; returned once so it can be copied to the other machines.
  'hindsight:generateKey': () => string

  // Learning loop and Memory Manager. Lessons come from finished jobs and Master conversations.
  'learn:status': (crewId?: number) => LearnStatus
  // "Learn now": runs the learn step on a finished job; null when learning is off.
  'learn:run': (runId: number) => LearnRunInfo | null
  // The AI the learn step asks now (an empty model resolved to the cheap default) and a one-call test of it.
  'learn:ai': () => LearnAi
  'learn:test': () => LearnTestResult
  // The models the local server offers (from /v1/models, else Ollama's /api/tags) and its API key (write-only: only whether one is saved comes back; an empty key clears it).
  'learn:localModels': () => { models: string[]; error?: string }
  'learn:localKey': () => boolean
  'learn:setLocalKey': (key: string) => boolean
  'learn:lessons': (filter?: LessonFilter) => Lesson[]
  'learn:editLesson': (id: number, patch: LessonPatch) => Lesson
  // Folds the lessons in `mergeIds` into `keepId`.
  'learn:mergeLessons': (keepId: number, mergeIds: number[]) => Lesson
  // active (also approves a queued one), stale or deleted.
  'learn:setLessonStatus': (id: number, status: LessonStatus) => Lesson
  'learn:moveLesson': (id: number, from: LearnStore, to: LearnStore) => Lesson
  'learn:hindsightEntries': (crewId: number, query?: string) => { ok: true; items: string[] } | { ok: false; error: string }
  'learn:memoryFiles': (crewId: number) => MemoryFile[]
  'learn:drafts': (crewId?: number, status?: DraftStatus) => SkillDraft[]
  'learn:editDraft': (id: number, patch: { name?: string; body?: string }) => SkillDraft
  // Installs the skill as a project skill file: only ever on this explicit call.
  'learn:approveDraft': (id: number) => SkillDraft
  'learn:rejectDraft': (id: number) => SkillDraft
  'learn:deleteDraft': (id: number) => void
  // MCP servers for the project's folder (null = user-level only); `refresh` re-runs the status checks.
  'mcp:list': (crewId: number | null, refresh?: boolean) => McpOverview
  'mcp:add': (crewId: number | null, input: McpServerInput) => McpOverview
  'mcp:update': (crewId: number | null, serverId: string, input: McpServerInput) => McpOverview
  'mcp:setEnabled': (crewId: number | null, serverId: string, enabled: boolean) => McpOverview
  'mcp:remove': (crewId: number | null, serverId: string) => McpOverview
  // Servers the team seats need that are down, for the header badge.
  'mcp:health': () => McpDown[]
  'events:recent': (limit: number) => OperantEvent[]
  'dashboard:summary': () => DashboardSummary
  'settings:get': () => Settings
  'settings:set': (patch: SettingsPatch) => Settings
  // "Reset section to defaults".
  'settings:reset': (section: keyof Settings) => Settings
  // Handled by main (needs Electron), not by core.
  'app:pickFolder': () => string | null
  // Shows the project folder in the file manager.
  'shell:openFolder': (crewId: number) => void
  // Opens a file with the OS; refuses paths outside the project folder and the OS temp folder.
  'shell:openPath': (crewId: number, path: string) => void
  // True when the clipboard holds an image.
  'clipboard:hasImage': () => boolean
  'app:info': () => AppInfo
  'app:openExternal': (url: string) => void
  'update:status': () => UpdateStatus
  'update:check': () => UpdateStatus
  'update:install': () => boolean
  // The background-process console: kept lines (optionally one source), clear (all or one source), running processes, stop one of ours by pid.
  'console:list': (source?: ConsoleSource) => ConsoleLine[]
  'console:clear': (source?: ConsoleSource) => void
  'console:processes': () => ConsoleProcess[]
  'console:stop': (pid: number) => boolean
  // The Windows media session now playing (inactive off Windows or when the controls are off), and one of its
  // buttons: toggle | next | prev | shuffle | focus | vol <0..1>; any other command is refused (false).
  'media:state': () => MediaState
  'media:command': (cmd: string) => boolean
}

export type IpcChannel = keyof IpcApi
export type MainChannel =
  | 'app:pickFolder'
  | 'shell:openFolder'
  | 'shell:openPath'
  | 'clipboard:hasImage'
  | 'app:info'
  | 'app:openExternal'
  | 'update:status'
  | 'update:check'
  | 'update:install'
  | 'console:list'
  | 'console:clear'
  | 'console:processes'
  | 'console:stop'
  | 'media:state'
  | 'media:command'
export type CoreChannel = Exclude<IpcChannel, MainChannel>

// Push messages: main -> renderer.
export interface IpcEvents {
  event: OperantEvent
  'operator:data': { operatorId: number; data: string }
  'operator:status': { operatorId: number; status: OperatorStatus }
  // An operator was added, edited, restarted with new settings, or deleted (`removed`).
  'operator:config': { operatorId: number; crewId: number | null; removed: boolean }
  'scratch:data': { scratchId: number; data: string }
  'scratch:exit': { scratchId: number; exitCode: number }
  'index:status': { crewId: number; status: IndexStatus }
  usage: { operatorId: number; context: OperatorContext }
  // A warning or a pause from the spending caps.
  caps: CapEvent
  message: { crewId: number; messageId: number; change: 'created' | 'edited' | 'deleted' | 'read' }
  // The unread count of the user inbox ('user') or of an operator (the Master slot included).
  unread: { crewId: number; to: 'user' | number; count: number }
  job: { crewId: number; jobId: number; kind: string }
  // A dashboard job (JOB#) was created or changed status.
  run: { crewId: number; runId: number; status: RunStatus }
  // A job's agent list changed (an agent appeared, finished or got a model).
  'run:agents': { crewId: number; runId: number }
  // The owner clicked an OS notification: open that run's task modal.
  'run:open': { runId: number }
  // A Discord bot connected, dropped or failed.
  'discord:status': DiscordHealth
  // A bot got a new pairing request.
  'discord:pairing': { botId: number }
  purge: { kind: 'operator-purged' | 'squad-purged'; crewId: number | null; operatorId: number | null; squadId: number | null; label: string }
  settings: Settings
  update: UpdateStatus
  'console:line': ConsoleLine
  'media:state': MediaState
  'media:timeline': MediaTimeline | null
  'media:art': string | null
}

export type IpcEventName = keyof IpcEvents

export interface OperantBridge {
  invoke<C extends IpcChannel>(channel: C, ...args: Parameters<IpcApi[C]>): Promise<Awaited<ReturnType<IpcApi[C]>>>
  on<E extends IpcEventName>(name: E, listener: (payload: IpcEvents[E]) => void): () => void
  platform: NodeJS.Platform
  // The page zoom of this window (1 = 100%).
  setZoom(factor: number): void
  // The disk path of a File dropped on the window ('' when it has none).
  filePath(file: File): string
}

export const CORE_CHANNELS: CoreChannel[] = [
  'crews:list',
  'crews:topology',
  'crews:create',
  'crews:update',
  'crews:trackerNow',
  'crews:reorder',
  'crews:counts',
  'crews:delete',
  'crews:clearHistory',
  'groups:list',
  'groups:create',
  'groups:rename',
  'groups:delete',
  'groups:collapse',
  'groups:reorder',
  'groups:move',
  'ide:list',
  'ide:open',
  'git:changes',
  'git:info',
  'git:status',
  'git:diff',
  'git:stage',
  'git:unstage',
  'git:discard',
  'git:stageHunk',
  'git:commit',
  'git:lastMessage',
  'git:log',
  'git:commitDetails',
  'git:branches',
  'git:checkout',
  'git:createBranch',
  'git:fetch',
  'git:pull',
  'git:push',
  'squads:create',
  'squads:update',
  'squads:delete',
  'operators:create',
  'operators:createFromPreset',
  'operators:update',
  'operators:previewChange',
  'operators:applyChange',
  'operators:start',
  'operators:stop',
  'operators:restart',
  'operators:delete',
  'operators:write',
  'operators:resize',
  'operators:buffer',
  'operators:context',
  'master:get',
  'master:start',
  'master:stop',
  'master:state',
  'presets:list',
  'presets:create',
  'presets:update',
  'presets:duplicate',
  'presets:delete',
  'presets:reset',
  'presets:restoreBuiltins',
  'presets:shippedRole',
  'presets:applyToOperators',
  'presets:saveFromOperator',
  'presets:revertOperator',
  'jobs:list',
  'jobs:get',
  'jobs:create',
  'jobs:update',
  'jobs:delete',
  'jobs:approve',
  'jobs:reject',
  'jobs:approveStart',
  'jobs:escalate',
  'jobs:move',
  'models:list',
  'teams:list',
  'teams:create',
  'teams:update',
  'teams:delete',
  'teams:duplicate',
  'teams:reset',
  'teams:setHidden',
  'teams:export',
  'teams:importPreview',
  'teams:import',
  'runs:list',
  'runs:get',
  'runs:create',
  'runs:stop',
  'runs:agents',
  'runs:update',
  'runs:delete',
  'runs:agentLog',
  'runs:images',
  'runs:approve',
  'runs:sendBack',
  'runs:answer',
  'runs:events',
  'runs:resumeMaster',
  'runs:closeout',
  'runs:getLimit',
  'runs:setLimit',
  'discord:list',
  'discord:create',
  'discord:update',
  'discord:delete',
  'discord:setToken',
  'discord:clearToken',
  'discord:connect',
  'discord:disconnect',
  'discord:health',
  'discord:test',
  'discord:testAi',
  'discord:localModels',
  'discord:pairings',
  'discord:approvePairing',
  'discord:denyPairing',
  'health:project',
  'hindsight:status',
  'mcp:list',
  'mcp:add',
  'mcp:update',
  'mcp:setEnabled',
  'mcp:remove',
  'mcp:health',
  'hindsight:act',
  'hindsight:adapters',
  'hindsight:test',
  'hindsight:keyState',
  'hindsight:setKey',
  'hindsight:clearKey',
  'hindsight:generateKey',
  'learn:status',
  'learn:run',
  'learn:ai',
  'learn:test',
  'learn:localModels',
  'learn:localKey',
  'learn:setLocalKey',
  'learn:lessons',
  'learn:editLesson',
  'learn:mergeLessons',
  'learn:setLessonStatus',
  'learn:moveLesson',
  'learn:hindsightEntries',
  'learn:memoryFiles',
  'learn:drafts',
  'learn:editDraft',
  'learn:approveDraft',
  'learn:rejectDraft',
  'learn:deleteDraft',
  'links:list',
  'links:create',
  'links:update',
  'links:delete',
  'messages:list',
  'messages:send',
  'messages:edit',
  'messages:delete',
  'messages:markRead',
  'messages:unread',
  'messages:answer',
  'views:get',
  'views:set',
  'tiles:getLayout',
  'tiles:saveLayout',
  'scratch:list',
  'scratch:create',
  'scratch:update',
  'scratch:delete',
  'scratch:start',
  'scratch:status',
  'scratch:spend',
  'scratch:stop',
  'scratch:write',
  'scratch:resize',
  'scratch:buffer',
  'usage:series',
  'usage:breakdown',
  'usage:report',
  'usage:timeseries',
  'usage:job',
  'usage:exportText',
  'usage:export',
  'budgets:get',
  'budgets:set',
  'budgets:resume',
  'import:preview',
  'import:apply',
  'import:pickFile',
  'data:export',
  'data:exportFile',
  'providers:status',
  'providers:refresh',
  'caps:status',
  'caps:reset',
  'purge:status',
  'purge:now',
  'graph:get',
  'graph:savePositions',
  'graph:clear',
  'index:status',
  'index:run',
  'events:recent',
  'dashboard:summary',
  'settings:get',
  'settings:set',
  'settings:reset',
]

export const MAIN_CHANNELS: MainChannel[] = [
  'app:pickFolder',
  'shell:openFolder',
  'shell:openPath',
  'clipboard:hasImage',
  'app:info',
  'app:openExternal',
  'update:status',
  'update:check',
  'update:install',
  'console:list',
  'console:clear',
  'console:processes',
  'console:stop',
  'media:state',
  'media:command',
]

// What a rejected call carries. Electron only passes an error's message across the bridge, so main encodes
// the code into it and the preload decodes it again.
export class IpcError extends Error {
  constructor(
    readonly code: IpcErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'IpcError'
  }
}

const WIRE = 'OPERANT_ERR:'
const WIRE_RE = /OPERANT_ERR:([A-Z_]+):([\s\S]*)$/

export const encodeIpcError = (code: IpcErrorCode, message: string): string => `${WIRE}${code}:${message}`

// Turns whatever invoke rejected with into an IpcError (code INTERNAL when it was not one of ours). contextBridge
// keeps only the message of an Error, so the preload rethrows the encoded message and the renderer decodes it here.
export function decodeIpcError(err: unknown): IpcError {
  const text = err instanceof Error ? err.message : String(err)
  const m = WIRE_RE.exec(text)
  if (m) return new IpcError(m[1] as IpcErrorCode, m[2]!)
  return new IpcError('INTERNAL', text.replace(/^Error invoking remote method '[^']*': (Error: )?/, ''))
}
