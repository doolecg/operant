import type {
  AgentKind,
  AppInfo,
  IndexStatus,
  OperantEvent,
  Squad,
  Crew,
  CrewTopology,
  Operator,
  OperatorContext,
  OperatorSpend,
  OperatorStatus,
  Task,
  TaskState,
  UpdateStatus,
} from './types'
import type { Settings, SettingsPatch } from './settings'

export interface DashboardSummary {
  operatorsRunning: number
  operatorsTotal: number
  tasksOpen: number
  spendToday: number
  dailyBudgetUsd: number
}

// Request/response calls: renderer -> main via ipcRenderer.invoke.
export interface IpcApi {
  'crews:list': () => Crew[]
  'crews:topology': (crewId: number) => CrewTopology | null
  'crews:create': (input: { name: string; folder: string }) => Crew
  'crews:delete': (crewId: number) => void
  'squads:create': (input: { crewId: number; name: string }) => Squad
  'operators:create': (input: { squadId: number; role: string; agent: AgentKind; model: string }) => Operator
  'operators:start': (operatorId: number) => void
  'operators:stop': (operatorId: number) => void
  'operators:write': (operatorId: number, data: string) => void
  'operators:resize': (operatorId: number, cols: number, rows: number) => void
  'operators:buffer': (operatorId: number) => string
  'operators:context': () => Record<number, OperatorContext>
  'usage:series': (crewId: number) => OperatorSpend[]
  'tasks:list': (crewId: number) => Task[]
  'tasks:create': (input: { crewId: number; title: string; operatorId?: number | null }) => Task
  'tasks:move': (taskId: number, state: TaskState) => void
  'index:status': (crewId: number) => IndexStatus | null
  'index:run': (crewId: number) => IndexStatus | null
  'events:recent': (limit: number) => OperantEvent[]
  'dashboard:summary': () => DashboardSummary
  'settings:get': () => Settings
  'settings:set': (patch: SettingsPatch) => Settings
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
  'index:status': { crewId: number; status: IndexStatus }
  usage: { operatorId: number; context: OperatorContext }
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
  'crews:delete',
  'squads:create',
  'operators:create',
  'operators:start',
  'operators:stop',
  'operators:write',
  'operators:resize',
  'operators:buffer',
  'operators:context',
  'usage:series',
  'tasks:list',
  'tasks:create',
  'tasks:move',
  'index:status',
  'index:run',
  'events:recent',
  'dashboard:summary',
  'settings:get',
  'settings:set',
]

export const MAIN_CHANNELS: MainChannel[] = [
  'app:pickFolder',
  'app:info',
  'app:openExternal',
  'update:status',
  'update:check',
  'update:install',
]
