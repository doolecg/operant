import type { ModelList } from './models'
import type { ConsoleLine, ConsoleProcess, ConsoleSource } from './console'
import type { DraftStatus, LearnAi, LearnChange, LearnChangeStatus, LearnRunInfo, LearnStatus, LearnTestResult, LearnStore, Lesson, LessonFilter, LessonPatch, LessonStatus, MemoryFile, SkillDraft } from './learn'
import type { AuxStatus, BackupEntry, BackupPartName, MemoryDiagnostics, MemoryExport, PresetImportItem, RecallOutput, ResetResult, SuperpowersStatus } from './ops'
import type { EnhanceContext } from './prompt-enhance'
import type {
  AppInfo,
  BudgetConfig,
  BudgetStatus,
  BudgetWindow,
  ExportFormat,
  ExportText,
  OptionalMcpEntry,
  OptionalMcpId,
  OptionalMcpTarget,
  ImportPreview,
  ImportResult,
  ImportSource,
  ProvidersStatus,
  UsageQuery,
  UsageReport,
  UsageSeries,
  UsageSeriesQuery,
  UsageView,
  Crew,
  CrewPatch,
  IndexStatus,
  HindsightAdapter,
  HindsightKeyState,
  HindsightStatus,
  HindsightTestResult,
  IpcErrorCode,
  OperantEvent,
  McpOverview,
  McpServerInput,
  Preset,
  PresetInput,
  PresetPatch,
  ScratchInput,
  ScratchPatch,
  ScratchSpend,
  ScratchStatus,
  ScratchTerminal,
  Team,
  TeamImportPreview,
  TeamInput,
  TeamPatch,
  UpdateStatus,
} from './types'
import type { GitChanges, GitInfo, IdeId, IdeInfo, ProjectGroup } from './projects'
import type { GitBranches, GitCommit, GitCommitDetails, GitCommitResult, GitDiff, GitDiffRequest, GitHunkRef, GitResult, GitStatus } from './git'
import type { Settings, SettingsPatch } from './settings'
import type { MediaState, MediaTimeline } from './media'
import type { CapabilityReport, ClaudeTileState } from './claude-mods'
import type { RunningCounts } from './notify'
import { CHAT_CHANNELS, type ChatApi, type ChatEvents } from './claude-chat'

// Request/response calls: renderer -> main via ipcRenderer.invoke. Every one is validated in core; a
// refusal rejects with an `IpcError` (code + message the dashboard can show).
export interface IpcApi extends ChatApi {
  // Crews
  'crews:list': () => Crew[]
  'crews:create': (input: { name: string; folder: string }) => Crew
  'crews:update': (crewId: number, patch: CrewPatch) => Crew
  'crews:reorder': (crewIds: number[]) => Crew[]
  // Stops every session, then removes the crew with its jobs, messages, spend history and tiles.
  'crews:delete': (crewId: number) => void

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




  // Presets
  'presets:list': () => Preset[]
  'presets:create': (input: PresetInput) => Preset
  // `apply` copies the new values to the operators that were unmodified before this edit (running ones take
  // them on their next restart).
  'presets:update': (presetId: number, patch: PresetPatch) => Preset
  'presets:duplicate': (presetId: number, name?: string) => Preset
  'presets:delete': (presetId: number) => void
  // Built-ins go back to their shipped values and role text.
  'presets:reset': (presetId: number) => Preset
  'presets:restoreBuiltins': () => Preset[]
  // Preset files: export one preset (or all), and read a file before importing it (apply false) or import it (apply true).
  'presets:export': (presetId?: number) => ExportText
  'presets:importPreview': (text: string) => PresetImportItem[]
  'presets:import': (text: string) => PresetImportItem[]

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

  // Any grouping and filter of the usage rows (day, project, job, seat, agent, model, CLI, provider): totals are the sum of the rows.
  'usage:report': (query: UsageQuery) => UsageReport
  // Cost and tokens per hour or day, optionally split (a line per model, project, ...).
  'usage:timeseries': (query: UsageSeriesQuery) => UsageSeries
  // CSV or JSON text of any view, for the renderer to save.
  'usage:exportText': (view: UsageView, format: ExportFormat) => ExportText
  // The same, written to a file the user picks (null when they cancel).
  'usage:export': (view: UsageView, format: ExportFormat) => { saved: string | null }
  // Budgets: the daily budget lives in settings; project and job caps and what a cap does live here.
  'budgets:get': () => BudgetStatus
  'budgets:set': (patch: Partial<BudgetConfig>) => BudgetStatus
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


  'index:status': (crewId: number) => IndexStatus | null
  'index:run': (crewId: number) => IndexStatus | null
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
  // Runs the learn step on a Claude tile's finished session now; `confirm` lets it pass a budget that asks first.
  'learn:runNow': (tileId: number, confirm?: boolean) => LearnRunInfo | null
  // Automatic changes (and proposals), newest first; rollback puts the replaced text back.
  'learn:records': (filter?: { crewId?: number; status?: LearnChangeStatus }) => LearnChange[]
  'learn:rollback': (changeId: number) => LearnChange
  'learn:clearRecords': (crewId?: number) => number
  // Memory: the lessons (Operant's own, editable), a recall with the policy in settings, export, reset and diagnostics.
  'memory:recall': (query: string, crewId?: number) => RecallOutput
  'memory:edit': (id: number, patch: LessonPatch) => Lesson
  'memory:delete': (id: number) => Lesson
  'memory:export': () => MemoryExport
  'memory:reset': (req: { scope: 'soul' | 'project' | 'all'; crewId?: number; confirm: boolean }) => ResetResult
  'memory:diagnostics': () => MemoryDiagnostics
  // Model calls of the learn and memory work: today's counts, spend and any limit in force.
  'aux:status': () => AuxStatus
  // Rewrites rough composer text with the promptEnhance aux model (counted, capped, retried). `commands` are the chat's own skills.
  // `context` is what 'aux:enhanceContext' returned (memories and code symbols, capped again before use).
  'aux:enhancePrompt': (text: string, commands?: Array<{ name: string; description: string }>, context?: EnhanceContext) => string
  // The small recall and CodeGraph lookups for the tile's project, run in parallel with timeouts (no model call).
  'aux:enhanceContext': (text: string, scratchId: number) => EnhanceContext
  // A full rebuild of a project's CodeGraph index (discards it first); only a project Operant knows.
  'codegraph:rebuild': (folder: string) => IndexStatus
  'codegraph:status': (folder: string) => IndexStatus
  'backup:create': (label?: string) => { name: string; path: string; bytes: number }
  'backup:list': () => BackupEntry[]
  'backup:restore': (name: string, confirm: boolean) => BackupPartName[]
  'backup:delete': (name: string) => void
  'superpowers:status': () => SuperpowersStatus
  // MCP servers for the project's folder (null = user-level only); `refresh` re-runs the status checks.
  'mcp:list': (crewId: number | null, refresh?: boolean) => McpOverview
  'mcp:add': (crewId: number | null, input: McpServerInput) => McpOverview
  'mcp:update': (crewId: number | null, serverId: string, input: McpServerInput) => McpOverview
  'mcp:setEnabled': (crewId: number | null, serverId: string, enabled: boolean) => McpOverview
  'mcp:remove': (crewId: number | null, serverId: string) => McpOverview
  // Optional integrations: their status for the project's folder; `refresh` re-runs the CLI checks and the runtime probe.
  'mcp:optional': (crewId: number | null, refresh?: boolean) => OptionalMcpEntry[]
  // Adds the optional server to the chosen CLIs and scopes (the user clicked Add); removes Operant's own entries.
  'mcp:optionalAdd': (crewId: number | null, id: OptionalMcpId, targets: OptionalMcpTarget[]) => McpOverview
  'mcp:optionalRemove': (crewId: number | null, id: OptionalMcpId) => McpOverview
  'events:recent': (limit: number) => OperantEvent[]
  // Clears the activity feed (every project's events).
  'events:clear': () => void
  // Which Claude Code and OpenCode CLIs are on PATH, their versions, and what each can do. Cached; refresh re-probes.
  'capabilities:get': () => Promise<CapabilityReport>
  'capabilities:refresh': () => Promise<CapabilityReport>
  // A Claude Code tile's sub-agents, status line and events state (null when the tile has none yet).
  'claudeMods:get': (tileId: number) => ClaudeTileState | null
  'settings:get': () => Settings
  'settings:set': (patch: SettingsPatch) => Settings
  // "Reset section to defaults".
  'settings:reset': (section?: keyof Settings) => Settings
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
  // The owner's answer to the close-app dialog: quit, or stay open.
  'app:closeReply': (action: 'shown' | 'quit' | 'stay') => void
  // Whether a tile's Claude is mid-turn (main tracks the turns it sees).
  'turn:busy': (scratchId: number) => boolean
  // The terminal tile on screen and focused (null when none): a finished turn of that tile does not notify while the window has focus.
  'notify:visible': (scratchId: number | null) => void
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
  | 'app:closeReply'
  | 'turn:busy'
  | 'notify:visible'
export type CoreChannel = Exclude<IpcChannel, MainChannel>

// Push messages: main -> renderer.
export interface IpcEvents {
  event: OperantEvent
  'scratch:data': { scratchId: number; data: string }
  // The batched updates of a Chat view tile (see shared/claude-chat.ts).
  'chat:ops': ChatEvents['chat:ops']
  'scratch:exit': { scratchId: number; exitCode: number }
  'index:status': { crewId: number; status: IndexStatus }
  // A project went over its warning share of a daily budget.
  // crewId is null for the all-projects cap.
  budget: { crewId: number | null; window: BudgetWindow; spentUsd: number; capUsd: number; pct: number }
  settings: Settings
  update: UpdateStatus
  'console:line': ConsoleLine
  'media:state': MediaState
  // A Claude Code tile's state after each change (sub-agents, status line).
  'claudeMods:state': ClaudeTileState
  'media:timeline': MediaTimeline | null
  'media:art': string | null
  // The window asks to close while something runs: the renderer shows the dialog and answers app:closeReply.
  'app:closeRequest': RunningCounts
  // A finished or waiting Claude tile was clicked in a notification: show that tile.
  'notify:open': { scratchId: number; crewId: number }
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
  'crews:create',
  'crews:update',
  'crews:reorder',
  'crews:delete',
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
  'presets:list',
  'presets:create',
  'presets:update',
  'presets:duplicate',
  'presets:delete',
  'presets:reset',
  'presets:restoreBuiltins',
  'presets:export',
  'presets:importPreview',
  'presets:import',
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
  'hindsight:status',
  'mcp:list',
  'mcp:add',
  'mcp:update',
  'mcp:setEnabled',
  'mcp:remove',
  'mcp:optional',
  'mcp:optionalAdd',
  'mcp:optionalRemove',
  'hindsight:act',
  'hindsight:adapters',
  'hindsight:test',
  'hindsight:keyState',
  'hindsight:setKey',
  'hindsight:clearKey',
  'hindsight:generateKey',
  'learn:status',
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
  'learn:runNow',
  'learn:records',
  'learn:rollback',
  'learn:clearRecords',
  'memory:recall',
  'memory:edit',
  'memory:delete',
  'memory:export',
  'memory:reset',
  'memory:diagnostics',
  'aux:status',
  'aux:enhancePrompt',
  'aux:enhanceContext',
  'codegraph:rebuild',
  'codegraph:status',
  'backup:create',
  'backup:list',
  'backup:restore',
  'backup:delete',
  'superpowers:status',
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
  'usage:report',
  'usage:timeseries',
  'usage:exportText',
  'usage:export',
  'budgets:get',
  'budgets:set',
  'import:preview',
  'import:apply',
  'import:pickFile',
  'data:export',
  'data:exportFile',
  'providers:status',
  'providers:refresh',
  'index:status',
  'index:run',
  'events:recent',
  'events:clear',
  'capabilities:get',
  'capabilities:refresh',
  'claudeMods:get',
  ...CHAT_CHANNELS,
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
  'app:closeReply',
  'turn:busy',
  'notify:visible',
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
