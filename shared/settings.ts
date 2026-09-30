export type KeyAction = 'newCrew' | 'addSquad' | 'indexCrew' | 'tabActivity' | 'tabTasks' | 'tabCost' | 'openSettings'

export interface Settings {
  // Daily spend budget in USD across all crews; 0 turns the budget off.
  dailyBudgetUsd: number
  defaultModels: { claude: string; codex: string }
  // Empty file means the system default shell.
  shell: { file: string; args: string }
  updates: { channel: 'stable' | 'beta'; checkHours: number; installOnQuit: boolean }
  // Accelerators like "Mod+Shift+P"; Mod is Ctrl, or Cmd on macOS. Empty means unbound.
  keybinds: Record<KeyAction, string>
}

export const KEY_ACTIONS: Array<{ id: KeyAction; label: string }> = [
  { id: 'newCrew', label: 'New crew' },
  { id: 'addSquad', label: 'Add squad' },
  { id: 'indexCrew', label: 'Index crew with CodeGraph' },
  { id: 'tabActivity', label: 'Show activity' },
  { id: 'tabTasks', label: 'Show tasks' },
  { id: 'tabCost', label: 'Show cost' },
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
    tabTasks: 'Mod+2',
    tabCost: 'Mod+3',
    openSettings: 'Mod+,',
  },
}

export type SettingsPatch = {
  [K in keyof Settings]?: Settings[K] extends object ? Partial<Settings[K]> : Settings[K]
}

const str = (v: unknown, fallback: string, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : fallback)
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
