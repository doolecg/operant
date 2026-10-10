// Result shapes for the learn, memory, aux, backup, superpowers and preset-file calls. Core builds them; the renderer reads them.
import type { HindsightStatus } from './types'
import type { LearnRunInfo } from './learn'
import type { MemorySettings } from './aux-settings'

export interface AuxUsage {
  calls: number
  tokens: number
  usd: number
}

export interface AuxStatus {
  day: string
  total: AuxUsage
  maxCallsPerDay: number
  maxUsdPerDay: number
  features: Record<string, AuxUsage>
  // Why calls are refused now; null when they are not.
  blocked: string | null
  // 'local limit' when Operant's own budget stopped it, 'provider limit' when the CLI or API reported a rate or quota limit.
  label: 'local limit' | 'provider limit' | null
  lastError: string
}

export interface RecallItem {
  bank: 'soul' | 'project'
  text: string
}

export interface RecallOutput {
  items: RecallItem[]
  text: string
  truncated: boolean
  // Why nothing came back (recall off, or every bank failed); '' when the banks answered.
  error: string
}

export interface MemoryExport {
  filename: string
  text: string
}

export interface ResetResult {
  // One line per thing reset: the Hindsight bank and the Operant lessons of each project.
  steps: Array<{ target: string; ok: boolean; error: string }>
}

export interface MemoryDiagnostics {
  recall: MemorySettings
  hindsight: { state: HindsightStatus['state']; detail: string; banks: string }
  banks: Array<{ bank: string; name: string; lessons: number; hindsightEntries: number | null; hindsightError: string }>
  lastRun: LearnRunInfo | null
  learnMode: string
  spend: AuxStatus
}

export type BackupPartName = 'settings.json' | 'presets.json' | 'teams.json' | 'learn.json'

export interface BackupEntry {
  name: string
  path: string
  bytes: number
  modified: number
  kind: 'manual' | 'pre-update'
}

export interface SuperpowersStatus {
  installed: boolean
  path?: string
  version?: string
}

export interface PresetFileEntry {
  name: string
  agent: string
  model: string
  effort: string
  permissionMode: string
  tools: string
  allow: string[]
  deny: string[]
  cacheTtl: string
  contextCap: number
  mcp: string
  roleText: string | null
}

export interface PresetImportItem {
  name: string
  action: 'add' | 'skip' | 'invalid'
  reason: string
  // The values to create, for an add.
  input: PresetFileEntry | null
}
