// Memory recall policy, the model each learn/memory task uses, and the daily budget every such call goes through.

export type RecallMode = 'off' | 'on-demand' | 'session-start'
export const RECALL_MODES: RecallMode[] = ['off', 'on-demand', 'session-start']

export interface MemorySettings {
  recallMode: RecallMode
  topK: number
  maxTokens: number
  includeSoul: boolean
}

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = { recallMode: 'on-demand', topK: 5, maxTokens: 1500, includeSoul: true }

export const AUX_TASKS = ['extraction', 'consolidation', 'retrieval', 'skillEval', 'skillImprove', 'compression', 'promptEnhance'] as const
export type AuxTask = (typeof AUX_TASKS)[number]

// 'learn' follows the learn settings (the default for every task); the other values pick a CLI of their own.
export type AuxCli = 'learn' | 'claude' | 'opencode' | 'local'
export interface AuxModel {
  cli: AuxCli
  model: string
  effort: string
  localUrl: string
}
export type AuxModels = Record<AuxTask, AuxModel>

export const DEFAULT_AUX_MODEL: AuxModel = { cli: 'learn', model: '', effort: '', localUrl: '' }
// Enhance prompt (Chat view) asks a cheap Claude model of its own unless the owner picks another.
export const PROMPT_ENHANCE_MODEL: AuxModel = { cli: 'claude', model: 'claude-haiku-5-5', effort: '', localUrl: '' }
export const DEFAULT_AUX_MODELS: AuxModels = Object.fromEntries(
  AUX_TASKS.map((t) => [t, { ...(t === 'promptEnhance' ? PROMPT_ENHANCE_MODEL : DEFAULT_AUX_MODEL) }]),
) as AuxModels

export interface AuxSettings {
  // 0 means no limit.
  maxCallsPerDay: number
  // 0 means no limit.
  maxUsdPerDay: number
  retryLimit: number
  backoffMs: number
  onLimit: 'stop' | 'confirm'
}

export const DEFAULT_AUX_SETTINGS: AuxSettings = { maxCallsPerDay: 200, maxUsdPerDay: 0, retryLimit: 2, backoffMs: 1000, onLimit: 'stop' }

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:+@/[\]-]*$/
const EFFORT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const HTTP_URL = /^https?:\/\/[^\s]+$/i

const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {})
const int = (v: unknown, fallback: number, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(max, Math.max(min, v))) : fallback

export function sanitizeMemory(raw: unknown): MemorySettings {
  const r = obj(raw)
  const d = DEFAULT_MEMORY_SETTINGS
  return {
    recallMode: (RECALL_MODES as string[]).includes(r.recallMode) ? (r.recallMode as RecallMode) : d.recallMode,
    topK: int(r.topK, d.topK, 1, 50),
    maxTokens: int(r.maxTokens, d.maxTokens, 100, 20_000),
    includeSoul: typeof r.includeSoul === 'boolean' ? r.includeSoul : d.includeSoul,
  }
}

export function sanitizeAuxModels(raw: unknown): AuxModels {
  const r = obj(raw)
  const out = {} as AuxModels
  for (const t of AUX_TASKS) {
    const m = r[t] === undefined ? DEFAULT_AUX_MODELS[t] : obj(r[t])
    const cli: AuxCli = (['learn', 'claude', 'opencode', 'local'] as string[]).includes(m.cli) ? (m.cli as AuxCli) : 'learn'
    out[t] = {
      cli,
      model: typeof m.model === 'string' && MODEL_ID.test(m.model.trim().slice(0, 200)) ? m.model.trim().slice(0, 200) : '',
      effort: typeof m.effort === 'string' && EFFORT_ID.test(m.effort.trim().slice(0, 40)) ? m.effort.trim().slice(0, 40) : '',
      localUrl: typeof m.localUrl === 'string' && HTTP_URL.test(m.localUrl.trim().slice(0, 300)) ? m.localUrl.trim().slice(0, 300) : '',
    }
  }
  return out
}

export function sanitizeAux(raw: unknown): AuxSettings {
  const r = obj(raw)
  const d = DEFAULT_AUX_SETTINGS
  return {
    maxCallsPerDay: int(r.maxCallsPerDay, d.maxCallsPerDay, 0, 100_000),
    maxUsdPerDay: int(r.maxUsdPerDay, d.maxUsdPerDay, 0, 100_000),
    retryLimit: int(r.retryLimit, d.retryLimit, 0, 5),
    backoffMs: int(r.backoffMs, d.backoffMs, 0, 60_000),
    onLimit: r.onLimit === 'confirm' ? 'confirm' : 'stop',
  }
}
