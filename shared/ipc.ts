import type {
  AgentKind,
  AppInfo,
  CapEvent,
  CapStatus,
  ChangePlan,
  Crew,
  CrewCounts,
  CrewPatch,
  CrewTopology,
  CrewView,
  GraphData,
  GraphWindow,
  IndexStatus,
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
  OperatorFromPreset,
  OperatorPatch,
  OperatorSpend,
  OperatorStatus,
  Preset,
  PresetInput,
  PresetPatch,
  PurgeOutcome,
  PurgeStatus,
  ScratchInput,
  ScratchPatch,
  ScratchSpend,
  ScratchStatus,
  ScratchTerminal,
  Squad,
  SquadDelete,
  UnreadCounts,
  UpdateStatus,
  UsageBreakdownResult,
  UsagePeriod,
} from './types'
import type { Settings, SettingsPatch } from './settings'

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
  // What a delete would remove, for the confirm dialog.
  'crews:counts': (crewId: number) => CrewCounts
  // Stops every session, then removes the crew with its jobs, messages, spend history and tiles.
  'crews:delete': (crewId: number) => CrewCounts

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
  'events:recent': (limit: number) => OperantEvent[]
  'dashboard:summary': () => DashboardSummary
  'settings:get': () => Settings
  'settings:set': (patch: SettingsPatch) => Settings
  // "Reset section to defaults".
  'settings:reset': (section: keyof Settings) => Settings
  // Handled by main (needs Electron), not by core.
  'app:pickFolder': () => string | null
  'app:info': () => AppInfo
  'app:openExternal': (url: string) => void
  'update:status': () => UpdateStatus
  'update:check': () => UpdateStatus
  'update:install': () => boolean
}

export type IpcChannel = keyof IpcApi
export type MainChannel =
  | 'app:pickFolder'
  | 'app:info'
  | 'app:openExternal'
  | 'update:status'
  | 'update:check'
  | 'update:install'
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
  purge: { kind: 'operator-purged' | 'squad-purged'; crewId: number | null; operatorId: number | null; squadId: number | null; label: string }
  settings: Settings
  update: UpdateStatus
}

export type IpcEventName = keyof IpcEvents

export interface OperantBridge {
  invoke<C extends IpcChannel>(channel: C, ...args: Parameters<IpcApi[C]>): Promise<Awaited<ReturnType<IpcApi[C]>>>
  on<E extends IpcEventName>(name: E, listener: (payload: IpcEvents[E]) => void): () => void
  platform: NodeJS.Platform
}

export const CORE_CHANNELS: CoreChannel[] = [
  'crews:list',
  'crews:topology',
  'crews:create',
  'crews:update',
  'crews:counts',
  'crews:delete',
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
  'app:info',
  'app:openExternal',
  'update:status',
  'update:check',
  'update:install',
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
