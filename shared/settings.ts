import type { CacheTtl } from './types'

export type KeyAction =
  | 'newCrew'
  | 'addSquad'
  | 'indexCrew'
  | 'tabActivity'
  | 'tabJobs'
  | 'tabMessages'
  | 'tabCost'
  | 'viewCards'
  | 'viewList'
  | 'viewGraph'
  | 'viewTiles'
  | 'openSettings'

export interface Settings {
  // Daily spend budget in USD across all crews; 0 turns the budget off.
  dailyBudgetUsd: number
  defaultModels: { claude: string; codex: string }
  // Empty file means the system default shell.
  shell: { file: string; args: string }
  updates: { channel: 'stable' | 'beta'; checkHours: number; installOnQuit: boolean }
  // Accelerators like "Mod+Shift+P"; Mod is Ctrl, or Cmd on macOS. Empty means unbound.
  keybinds: Record<KeyAction, string>
  tokens: {
    // Default per-operator daily cap in USD; 0 turns it off. An operator's own cap wins.
    operatorDailyCapUsd: number
    // Percent of a cap at which the warning fires.
    capWarnPct: number
    // A turn is cold when cache writes exceed this percent of its context.
    coldThresholdPct: number
    // Output share of cost (percent) above which the Cost tab flags waste.
    outputShareWarnPct: number
    // Cache TTL for operators whose own setting is 'auto' ('auto' = Claude Code's default, nothing is set).
    defaultCacheTtl: CacheTtl
    // Cache TTL for sub-agents of every operator.
    subagentCacheTtl: CacheTtl
    // Keeps operators on one Claude Code version (DISABLE_AUTOUPDATER=1) so upgrades don't rebuild caches.
    pinClaudeVersion: boolean
  }
  collab: {
    nudgeIdleSeconds: number
    nudgeBatchSeconds: number
    leaseMinutes: number
    maxRejects: number
    longJobEstimateMinutes: number
    longJobElapsedMinutes: number
    // Soft-deleted operators are purged after this many days; the sweep runs only when purgeEnabled.
    purgeRetentionDays: number
    purgeEnabled: boolean
  }
}

export const KEY_ACTIONS: Array<{ id: KeyAction; label: string }> = [
  { id: 'newCrew', label: 'New crew' },
  { id: 'addSquad', label: 'Add squad' },
  { id: 'indexCrew', label: 'Index crew with CodeGraph' },
  { id: 'tabActivity', label: 'Show activity' },
  { id: 'tabJobs', label: 'Show jobs' },
  { id: 'tabMessages', label: 'Show messages' },
  { id: 'tabCost', label: 'Show cost' },
  { id: 'viewCards', label: 'Cards view' },
  { id: 'viewList', label: 'List view' },
  { id: 'viewGraph', label: 'Graph view' },
  { id: 'viewTiles', label: 'Tiles view' },
  { id: 'openSettings', label: 'Open settings' },
]

export const DEFAULT_SETTINGS: Settings = {
  dailyBudgetUsd: 0,
  defaultModels: { claude: 'sonnet', codex: 'gpt-5' },
  shell: { file: '', args: '' },
  updates: { channel: 'stable', checkHours: 3, installOnQuit: true },
  keybinds: {
    newCrew: 'Mod+N',
    addSquad: 'Mod+Shift+P',
    indexCrew: 'Mod+I',
    tabActivity: 'Mod+1',
    tabJobs: 'Mod+2',
    tabMessages: 'Mod+4',
    tabCost: 'Mod+3',
    viewCards: 'Mod+Shift+1',
    viewList: 'Mod+Shift+2',
    viewGraph: 'Mod+Shift+3',
    viewTiles: 'Mod+Shift+4',
    openSettings: 'Mod+,',
  },
  tokens: {
    operatorDailyCapUsd: 0,
    capWarnPct: 80,
    coldThresholdPct: 50,
    outputShareWarnPct: 30,
    defaultCacheTtl: 'auto',
    subagentCacheTtl: '5m',
    pinClaudeVersion: true,
  },
  collab: {
    nudgeIdleSeconds: 5,
    nudgeBatchSeconds: 15,
    leaseMinutes: 60,
    maxRejects: 1,
    longJobEstimateMinutes: 120,
    longJobElapsedMinutes: 240,
    purgeRetentionDays: 30,
    purgeEnabled: true,
  },
}

export type SettingsPatch = {
  [K in keyof Settings]?: Settings[K] extends object ? Partial<Settings[K]> : Settings[K]
}

const str = (v: unknown, fallback: string, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : fallback)
const ttl = (v: unknown, fallback: CacheTtl): CacheTtl => (v === 'auto' || v === '5m' || v === '1h' ? v : fallback)
const num = (v: unknown, fallback: number, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback

// Fills in defaults and drops anything malformed, so stored or incoming values can't break the app.
export function sanitizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>
  const d = DEFAULT_SETTINGS
  const models = r.defaultModels ?? {}
  const shell = r.shell ?? {}
  const updates = r.updates ?? {}
  const keys = r.keybinds ?? {}
  const tokens = r.tokens ?? {}
  const collab = r.collab ?? {}
  return {
    dailyBudgetUsd: num(r.dailyBudgetUsd, d.dailyBudgetUsd, 0, 100_000),
    defaultModels: {
      claude: str(models.claude, d.defaultModels.claude) || d.defaultModels.claude,
      codex: str(models.codex, d.defaultModels.codex) || d.defaultModels.codex,
    },
    shell: { file: str(shell.file, d.shell.file, 500), args: str(shell.args, d.shell.args, 500) },
    updates: {
      channel: updates.channel === 'beta' ? 'beta' : 'stable',
      checkHours: Math.round(num(updates.checkHours, d.updates.checkHours, 0, 24)),
      installOnQuit: typeof updates.installOnQuit === 'boolean' ? updates.installOnQuit : d.updates.installOnQuit,
    },
    keybinds: Object.fromEntries(
      KEY_ACTIONS.map(({ id }) => [id, str(keys[id], d.keybinds[id], 40)]),
    ) as Record<KeyAction, string>,
    tokens: {
      operatorDailyCapUsd: num(tokens.operatorDailyCapUsd, d.tokens.operatorDailyCapUsd, 0, 100_000),
      capWarnPct: num(tokens.capWarnPct, d.tokens.capWarnPct, 1, 100),
      coldThresholdPct: num(tokens.coldThresholdPct, d.tokens.coldThresholdPct, 1, 100),
      outputShareWarnPct: num(tokens.outputShareWarnPct, d.tokens.outputShareWarnPct, 1, 100),
      defaultCacheTtl: ttl(tokens.defaultCacheTtl, d.tokens.defaultCacheTtl),
      subagentCacheTtl: ttl(tokens.subagentCacheTtl, d.tokens.subagentCacheTtl),
      pinClaudeVersion: typeof tokens.pinClaudeVersion === 'boolean' ? tokens.pinClaudeVersion : d.tokens.pinClaudeVersion,
    },
    collab: {
      nudgeIdleSeconds: num(collab.nudgeIdleSeconds, d.collab.nudgeIdleSeconds, 1, 3600),
      nudgeBatchSeconds: num(collab.nudgeBatchSeconds, d.collab.nudgeBatchSeconds, 0, 3600),
      leaseMinutes: Math.round(num(collab.leaseMinutes, d.collab.leaseMinutes, 1, 1440)),
      maxRejects: Math.round(num(collab.maxRejects, d.collab.maxRejects, 0, 20)),
      longJobEstimateMinutes: Math.round(num(collab.longJobEstimateMinutes, d.collab.longJobEstimateMinutes, 1, 10_000)),
      longJobElapsedMinutes: Math.round(num(collab.longJobElapsedMinutes, d.collab.longJobElapsedMinutes, 1, 10_000)),
      purgeRetentionDays: Math.round(num(collab.purgeRetentionDays, d.collab.purgeRetentionDays, 0, 3650)),
      purgeEnabled: typeof collab.purgeEnabled === 'boolean' ? collab.purgeEnabled : d.collab.purgeEnabled,
    },
  }
}

export function mergeSettings(current: Settings, patch: SettingsPatch): Settings {
  const next: Record<string, unknown> = { ...current }
  for (const [k, v] of Object.entries(patch)) {
    const cur = (current as unknown as Record<string, unknown>)[k]
    next[k] = v && typeof v === 'object' && cur && typeof cur === 'object' ? { ...cur, ...v } : v
  }
  return sanitizeSettings(next)
}
