import { DEFAULT_LEARN_SETTINGS, type LearnSettings } from './learn'
import { IDE_IDS, type IdeId } from './projects'
import type { CacheTtl } from './types'
import type { ClockFormat, MediaSize, TopBarSettings } from './media'
import { DEFAULT_APPEARANCE, sanitizeAppearance, type Appearance } from './themes'

export type HindsightMode = 'local' | 'lan' | 'remote'

export type KeyAction =
  | 'newCrew'
  | 'indexCrew'
  | 'openSettings'
  | 'toggleConsole'
  | 'newShell'
  | 'toggleSidebar'
  | 'openInIde'
  | 'openPlayground'
  | 'mediaPlayPause'
  | 'mediaNext'
  | 'mediaPrev'
  | 'mediaShuffle'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'

export interface Settings {
  // The learning loop: lessons from finished jobs, written to Hindsight, CodeGraph notes and personal memory.
  learn: LearnSettings
  // Daily spend budget in USD across all crews; 0 turns the budget off.
  dailyBudgetUsd: number
  // A Hindsight memory server hosted elsewhere (http/https URL); empty runs the local one through uvx.
  hindsightUrl: string
  // How the Hindsight memory server is hosted: local (127.0.0.1, Operant runs it), lan (Operant runs it bound to
  // bindHost so other machines can connect) or remote (url; Operant never starts or stops it). API keys live in the
  // encrypted secret store, never here. openBind records that the user confirmed a non-loopback bind with no key.
  hindsight: { mode: HindsightMode; bindHost: string; port: number; url: string; openBind: boolean }
  // The Claude Code default model (older key, still read for new presets and terminals).
  defaultModels: { claude: string }
  // The app's main CLI and its default model and effort: new tasks, MCP servers and seats start on it, and so does the Master Terminal.
  mainCli: 'claude' | 'opencode'
  mainModel: string
  mainEffort: string
  // Empty file means the system default shell.
  shell: { file: string; args: string }
  // The IDE "Open in IDE" launches; `custom` is the command used when the default is Custom (the folder is appended).
  ide: { default: IdeId; custom: string }
  updates: { channel: 'stable' | 'beta'; checkHours: number; installOnQuit: boolean }
  // Accelerators like "Mod+Shift+P"; Mod is Ctrl, or Cmd on macOS. Empty means unbound.
  keybinds: Record<KeyAction, string>
  // UI scale: 0 follows the window size (bigger windows get a bigger UI), otherwise a fixed factor from 0.8 to 2.
  uiScale: number
  // Colour theme, accent override, terminal colours and the user's own themes. All apply live.
  appearance: Appearance
  // Side panel widths in px that the user dragged; 0 keeps the built-in size. The window clamps them live.
  layout: { sidebarWidth: number; rightWidth: number }
  // The top bar: Windows media controls, the clock and date pill and the agent counts. All apply live.
  topBar: TopBarSettings
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
  // Run Masters (`claude -p`). useClaudeHooks lets the user's own Claude hooks and plugins run in them; off by default
  // because a hook that starts a console program opens a visible window (the run has no console of its own).
  runs: { useClaudeHooks: boolean }
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
    // A finished job opens an "Update tracker" board job for projects that have a tracker file (each project can opt out too).
    trackerJobs: boolean
  }
}

export const KEY_ACTIONS: Array<{ id: KeyAction; label: string }> = [
  { id: 'newCrew', label: 'New project' },
  { id: 'indexCrew', label: 'Index project with CodeGraph' },
  { id: 'openSettings', label: 'Open settings' },
  { id: 'toggleConsole', label: 'Show or hide the console' },
  { id: 'newShell', label: 'New shell in the project folder' },
  { id: 'toggleSidebar', label: 'Show or hide the project list' },
  { id: 'openInIde', label: 'Open the project in the IDE' },
  { id: 'openPlayground', label: 'Open the Playground terminal' },
  { id: 'mediaPlayPause', label: 'Media: play or pause' },
  { id: 'mediaNext', label: 'Media: next track' },
  { id: 'mediaPrev', label: 'Media: previous track' },
  { id: 'mediaShuffle', label: 'Media: shuffle' },
  { id: 'zoomIn', label: 'Zoom in (UI scale)' },
  { id: 'zoomOut', label: 'Zoom out (UI scale)' },
  { id: 'zoomReset', label: 'Reset the UI scale to automatic' },
]

export const DEFAULT_SETTINGS: Settings = {
  learn: DEFAULT_LEARN_SETTINGS,
  dailyBudgetUsd: 0,
  defaultModels: { claude: 'sonnet' },
  mainCli: 'claude',
  mainModel: '',
  mainEffort: '',
  hindsightUrl: '',
  hindsight: { mode: 'local', bindHost: '127.0.0.1', port: 9077, url: '', openBind: false },
  shell: { file: '', args: '' },
  ide: { default: 'code', custom: '' },
  updates: { channel: 'stable', checkHours: 3, installOnQuit: true },
  keybinds: {
    newCrew: 'Mod+N',
    indexCrew: 'Mod+I',
    openSettings: 'Mod+,',
    toggleConsole: 'Mod+J',
    newShell: 'Alt+Shift+T',
    toggleSidebar: 'Alt+B',
    openInIde: 'Alt+Shift+O',
    openPlayground: 'Mod+Shift+P',
    mediaPlayPause: '',
    mediaNext: '',
    mediaPrev: '',
    mediaShuffle: '',
    zoomIn: 'Mod+=',
    zoomOut: 'Mod+-',
    zoomReset: 'Mod+0',
  },
  uiScale: 0,
  appearance: DEFAULT_APPEARANCE,
  layout: { sidebarWidth: 0, rightWidth: 0 },
  topBar: {
    mediaControls: typeof process !== 'undefined' && process.platform === 'win32',
    mediaSize: 'full',
    clockFormat: 'auto',
    clockSeconds: false,
    clockDate: true,
    agentPill: true,
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
  runs: { useClaudeHooks: false },
  collab: {
    nudgeIdleSeconds: 5,
    nudgeBatchSeconds: 15,
    leaseMinutes: 60,
    maxRejects: 1,
    longJobEstimateMinutes: 120,
    longJobElapsedMinutes: 240,
    purgeRetentionDays: 30,
    purgeEnabled: true,
    trackerJobs: true,
  },
}

export type SettingsPatch = {
  [K in keyof Settings]?: Settings[K] extends object ? Partial<Settings[K]> : Settings[K]
}

const str = (v: unknown, fallback: string, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : fallback)
const ttl = (v: unknown, fallback: CacheTtl): CacheTtl => (v === 'auto' || v === '5m' || v === '1h' ? v : fallback)
const num = (v: unknown, fallback: number, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback

// A model id for either CLI (provider/model:tag, claude-haiku-4-5, sonnet[1m]) and an effort name; neither can start with a dash.
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:+@/[\]-]*$/
const EFFORT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const HTTP_URL = /^https?:\/\/[^\s]+$/i
const HOST_RE = /^[A-Za-z0-9.:_-]{1,100}$/

// The legacy hindsightUrl (non-empty means remote) migrates into hindsight.url and mode; hindsightUrl mirrors the
// remote URL afterwards so older readers keep working.
function hindsightSettings(r: Record<string, any>): Pick<Settings, 'hindsight' | 'hindsightUrl'> {
  const h = r.hindsight && typeof r.hindsight === 'object' ? r.hindsight : {}
  const d = DEFAULT_SETTINGS.hindsight
  const legacy = HTTP_URL.test(str(r.hindsightUrl, '', 300)) ? str(r.hindsightUrl, '', 300) : ''
  const own = HTTP_URL.test(str(h.url, '', 300)) ? str(h.url, '', 300) : ''
  const url = own || legacy
  let mode: HindsightMode = h.mode === 'lan' || h.mode === 'remote' || h.mode === 'local' ? h.mode : d.mode
  if (!own && legacy && mode === 'local') mode = 'remote'
  const bindHost = str(h.bindHost, d.bindHost, 100)
  const out = {
    mode,
    bindHost: HOST_RE.test(bindHost) ? bindHost : d.bindHost,
    port: Math.round(num(h.port, d.port, 1, 65535)),
    url,
    openBind: h.openBind === true,
  }
  return { hindsight: out, hindsightUrl: mode === 'remote' ? url : '' }
}

// Fills in defaults and drops anything malformed, so stored or incoming values can't break the app.
export function sanitizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>
  const d = DEFAULT_SETTINGS
  const models = r.defaultModels ?? {}
  const shell = r.shell ?? {}
  const ide = r.ide ?? {}
  const updates = r.updates ?? {}
  const keys = r.keybinds ?? {}
  const tokens = r.tokens ?? {}
  const collab = r.collab ?? {}
  const top = r.topBar ?? {}
  const learn = r.learn ?? {}
  const runs = r.runs ?? {}
  const layout = r.layout ?? {}
  const flag = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback)
  const mainCli = r.mainCli === 'opencode' ? 'opencode' : 'claude'
  return {
    learn: {
      enabled: flag(learn.enabled, d.learn.enabled),
      hindsight: flag(learn.hindsight, d.learn.hindsight),
      codegraph: flag(learn.codegraph, d.learn.codegraph),
      memory: flag(learn.memory, d.learn.memory),
      review: learn.review === 'auto' || learn.review === 'queue' ? learn.review : d.learn.review,
      cli: learn.cli === 'claude' || learn.cli === 'opencode' || learn.cli === 'local' ? learn.cli : d.learn.cli,
      model: MODEL_ID.test(str(learn.model, '', 200)) ? str(learn.model, '', 200) : '',
      effort: EFFORT_ID.test(str(learn.effort, '', 40)) ? str(learn.effort, '', 40) : '',
      localUrl: HTTP_URL.test(str(learn.localUrl, '', 300)) ? str(learn.localUrl, '', 300) : d.learn.localUrl,
      localInsecureOk: flag(learn.localInsecureOk, d.learn.localInsecureOk),
    },
    dailyBudgetUsd: num(r.dailyBudgetUsd, d.dailyBudgetUsd, 0, 100_000),
    ...hindsightSettings(r),
    defaultModels: { claude: str(models.claude, d.defaultModels.claude) || d.defaultModels.claude },
    mainCli,
    mainModel: MODEL_ID.test(str(r.mainModel, '', 200)) ? str(r.mainModel, '', 200) : '',
    mainEffort: EFFORT_ID.test(str(r.mainEffort, '', 40)) ? str(r.mainEffort, '', 40) : '',
    shell: { file: str(shell.file, d.shell.file, 500), args: str(shell.args, d.shell.args, 500) },
    ide: {
      default: (IDE_IDS as readonly string[]).includes(ide.default) ? (ide.default as IdeId) : d.ide.default,
      custom: str(ide.custom, d.ide.custom, 500),
    },
    updates: {
      channel: updates.channel === 'beta' ? 'beta' : 'stable',
      checkHours: Math.round(num(updates.checkHours, d.updates.checkHours, 0, 24)),
      installOnQuit: typeof updates.installOnQuit === 'boolean' ? updates.installOnQuit : d.updates.installOnQuit,
    },
    keybinds: Object.fromEntries(
      KEY_ACTIONS.map(({ id }) => [id, str(keys[id], d.keybinds[id], 40)]),
    ) as Record<KeyAction, string>,
    appearance: sanitizeAppearance(r.appearance),
    uiScale: r.uiScale === 0 ? 0 : num(r.uiScale, d.uiScale, 0.8, 2),
    layout: {
      sidebarWidth: Math.round(num(layout.sidebarWidth, d.layout.sidebarWidth, 0, 4000)),
      rightWidth: Math.round(num(layout.rightWidth, d.layout.rightWidth, 0, 4000)),
    },
    topBar: {
      mediaControls: flag(top.mediaControls, d.topBar.mediaControls),
      mediaSize: (['compact', 'full'] as const).includes(top.mediaSize) ? (top.mediaSize as MediaSize) : d.topBar.mediaSize,
      clockFormat: (['auto', '24', '12'] as const).includes(top.clockFormat) ? (top.clockFormat as ClockFormat) : d.topBar.clockFormat,
      clockSeconds: flag(top.clockSeconds, d.topBar.clockSeconds),
      clockDate: flag(top.clockDate, d.topBar.clockDate),
      agentPill: flag(top.agentPill, d.topBar.agentPill),
    },
    tokens: {
      operatorDailyCapUsd: num(tokens.operatorDailyCapUsd, d.tokens.operatorDailyCapUsd, 0, 100_000),
      capWarnPct: num(tokens.capWarnPct, d.tokens.capWarnPct, 1, 100),
      coldThresholdPct: num(tokens.coldThresholdPct, d.tokens.coldThresholdPct, 1, 100),
      outputShareWarnPct: num(tokens.outputShareWarnPct, d.tokens.outputShareWarnPct, 1, 100),
      defaultCacheTtl: ttl(tokens.defaultCacheTtl, d.tokens.defaultCacheTtl),
      subagentCacheTtl: ttl(tokens.subagentCacheTtl, d.tokens.subagentCacheTtl),
      pinClaudeVersion: typeof tokens.pinClaudeVersion === 'boolean' ? tokens.pinClaudeVersion : d.tokens.pinClaudeVersion,
    },
    runs: { useClaudeHooks: flag(runs.useClaudeHooks, d.runs.useClaudeHooks) },
    collab: {
      nudgeIdleSeconds: num(collab.nudgeIdleSeconds, d.collab.nudgeIdleSeconds, 1, 3600),
      nudgeBatchSeconds: num(collab.nudgeBatchSeconds, d.collab.nudgeBatchSeconds, 0, 3600),
      leaseMinutes: Math.round(num(collab.leaseMinutes, d.collab.leaseMinutes, 1, 1440)),
      maxRejects: Math.round(num(collab.maxRejects, d.collab.maxRejects, 0, 20)),
      longJobEstimateMinutes: Math.round(num(collab.longJobEstimateMinutes, d.collab.longJobEstimateMinutes, 1, 10_000)),
      longJobElapsedMinutes: Math.round(num(collab.longJobElapsedMinutes, d.collab.longJobElapsedMinutes, 1, 10_000)),
      purgeRetentionDays: Math.round(num(collab.purgeRetentionDays, d.collab.purgeRetentionDays, 0, 3650)),
      purgeEnabled: typeof collab.purgeEnabled === 'boolean' ? collab.purgeEnabled : d.collab.purgeEnabled,
      trackerJobs: typeof collab.trackerJobs === 'boolean' ? collab.trackerJobs : d.collab.trackerJobs,
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
