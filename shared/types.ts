export type AgentKind = 'claude' | 'codex' | 'shell'
export type OperatorStatus = 'stopped' | 'starting' | 'running' | 'idle' | 'error'
export type TaskState = 'todo' | 'doing' | 'review' | 'done'

export interface Crew {
  id: number
  name: string
  folder: string
  createdAt: number
}

export interface Squad {
  id: number
  crewId: number
  name: string
}

export interface Operator {
  id: number
  squadId: number
  role: string
  agent: AgentKind
  model: string
  status: OperatorStatus
}

export interface Task {
  id: number
  crewId: number
  operatorId: number | null
  title: string
  state: TaskState
  createdAt: number
  updatedAt: number
}

export interface Usage {
  id: number
  operatorId: number
  at: number
  inputTokens: number
  outputTokens: number
  cacheTokens: number
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
