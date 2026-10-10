import { DEFAULT_LEARN_SETTINGS, LEARN_MODES, type LearnSettings } from './learn'
import { DEFAULT_AUX_MODELS, DEFAULT_AUX_SETTINGS, DEFAULT_MEMORY_SETTINGS, sanitizeAux, sanitizeAuxModels, sanitizeMemory, type AuxModels, type AuxSettings, type MemorySettings } from './aux-settings'
import { IDE_IDS, type IdeId } from './projects'
import type { CacheTtl } from './types'
import type { ClockFormat, MediaSize, TopBarSettings } from './media'
import { DEFAULT_APPEARANCE, sanitizeAppearance, type Appearance } from './themes'
import { MOD_DEFAULT_ENABLED, MOD_IDS, type ModId } from './claude-mods'
import { CLAUDE_EFFORTS } from './models'

export type HindsightMode = 'local' | 'lan' | 'remote'

export type KeyAction =
  | 'newCrew'
  | 'indexCrew'
  | 'openSettings'
  | 'toggleConsole'
  | 'newShell'
  | 'toggleSidebar'
  | 'toggleAllPanels'
  | 'tileLayout'
  | 'tileSplit'
  | 'tileFullscreen'
  | 'tileFocusNext'
  | 'tileFocusPrev'
  | 'tileClose'
  | 'openInIde'
  | 'openPlayground'
  | 'mediaPlayPause'
  | 'mediaNext'
  | 'mediaPrev'
  | 'mediaShuffle'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'

export type TileLayout = 'dwindle' | 'master'
export type MainCli = 'claude' | 'opencode'
export type TileStrip = 'compact' | 'normal' | 'hide'

// Claude Code tiles: `enabled` is the master switch (Operant's status line and the hooks the enabled mods need);
// `mods` switches each mod on or off. Unknown ids are dropped.
export interface ClaudeModsSettings {
  enabled: boolean
  mods: Record<ModId, boolean>
  // /keepwarm in the Chat view (an Operant feature, not a Claude Code mod). It only ever pings after the owner runs /keepwarm.
  keepWarm: boolean
  // The commands menu in the Chat view (the Commands button and / commands that run only on Claude Code's own screen).
  commandMenu: boolean
}

export interface Settings {
  // The learning loop: lessons from finished jobs, written to Hindsight, CodeGraph notes and personal memory.
  learn: LearnSettings
  // Memory recall policy (Soul Bank and project banks): off, on demand, or at session start; how many, how many tokens.
  memory: MemorySettings
  // The model each learn or memory task asks; 'learn' follows the learn settings.
  auxModels: AuxModels
  // Daily budget for every learn and memory model call (counts, USD), the retries and what a limit does.
  aux: AuxSettings
  // Daily spend budget in USD across all crews; 0 turns the budget off.
  dailyBudgetUsd: number
  // The same across the last 5 hours and the last 7 days; 0 turns each off.
  fiveHourBudgetUsd: number
  weeklyBudgetUsd: number
  // A Hindsight memory server hosted elsewhere (http/https URL); empty runs the local one through uvx.
  hindsightUrl: string
  // How the Hindsight memory server is hosted: local (127.0.0.1, Operant runs it), lan (Operant runs it bound to
  // bindHost so other machines can connect) or remote (url; Operant never starts or stops it). API keys live in the
  // encrypted secret store, never here. openBind records that the user confirmed a non-loopback bind with no key.
  hindsight: { mode: HindsightMode; bindHost: string; port: number; url: string; openBind: boolean }
  // The Claude Code default model (older key, still read for new presets and terminals).
  defaultModels: { claude: string }
  // The effort new Claude tiles start with, remembered from the last one picked ('' = no effort, one of CLAUDE_EFFORTS otherwise).
  defaultEfforts: { claude: string }
  // The CLI new Terminal-view tiles start with (the top bar's Claude Code | OpenCode choice).
  mainCli: MainCli
  // The thin info bar under each Terminal-view tile (model, context, tokens, cost, folder, branch).
  infoBar: boolean
  // Context-window use at which the info bar's bar turns warn-coloured, and danger-coloured (percent).
  contextWarnPct: number
  contextDangerPct: number
  // The app's main CLI and its default model and effort: new tasks, MCP servers and seats start on it, and so does the Master Terminal.
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
  // The project list width in px that the user dragged; 0 keeps the built-in size. The window clamps it live.
  // sidebarHidden remembers whether the user hid the project list.
  layout: { sidebarWidth: number; sidebarHidden: boolean }
  // Terminal text: copy once on mouseup, font size in px, scrollback lines, Ctrl+click file paths, dropped files type their paths.
  terminal: { copyOnSelect: boolean; fontSize: number; scrollback: number; fileLinks: boolean; dropPaths: boolean }
  // The tiles surface: layout kind, gap in px and the strip's size.
  tiles: { layout: TileLayout; gaps: number; strip: TileStrip }
  // Claude Code tiles: Operant's hooks and status line (sub-agent state, context and cost), and the sub-agent panel.
  claudeMods: ClaudeModsSettings
  // The top bar: Windows media controls and the clock and date pill. All apply live.
  topBar: TopBarSettings
  // Ask before closing a terminal tile or Operant itself (a "Don't ask again" turns the ask off here).
  confirm: { closeTile: boolean; closeApp: boolean }
  // Windows notifications for a Claude turn that finished and for Claude waiting on the owner.
  notify: { finished: boolean; needs: boolean }
  tokens: {
    // Percent of a cap at which the warning fires.
    capWarnPct: number
    // A turn is cold when cache writes exceed this percent of its context.
    coldThresholdPct: number
    // Cache TTL for operators whose own setting is 'auto' ('auto' = Claude Code's default, nothing is set).
    defaultCacheTtl: CacheTtl
    // Cache TTL for sub-agents of every operator.
    subagentCacheTtl: CacheTtl
    // Keeps operators on one Claude Code version (DISABLE_AUTOUPDATER=1) so upgrades don't rebuild caches.
    pinClaudeVersion: boolean
  }
}

export const KEY_ACTIONS: Array<{ id: KeyAction; label: string }> = [
  { id: 'newCrew', label: 'New project' },
  { id: 'indexCrew', label: 'Index project with CodeGraph' },
  { id: 'openSettings', label: 'Open settings' },
  { id: 'toggleConsole', label: 'Show or hide the console' },
  { id: 'newShell', label: 'New shell in the project folder' },
  { id: 'toggleSidebar', label: 'Show or hide the project list' },
  { id: 'toggleAllPanels', label: 'Show or hide the project list (all panels)' },
  { id: 'tileLayout', label: 'Tiles: switch between dwindle and master layout' },
  { id: 'tileSplit', label: 'Tiles: toggle split direction' },
  { id: 'tileFullscreen', label: 'Tiles: fullscreen the focused tile' },
  { id: 'tileFocusNext', label: 'Tiles: focus the next tile' },
  { id: 'tileFocusPrev', label: 'Tiles: focus the previous tile' },
  { id: 'tileClose', label: 'Tiles: close the focused tile' },
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
  memory: DEFAULT_MEMORY_SETTINGS,
  auxModels: DEFAULT_AUX_MODELS,
  aux: DEFAULT_AUX_SETTINGS,
  dailyBudgetUsd: 0,
  fiveHourBudgetUsd: 0,
  weeklyBudgetUsd: 0,
  defaultModels: { claude: 'sonnet' },
  defaultEfforts: { claude: '' },
  mainCli: 'claude',
  infoBar: true,
  contextWarnPct: 60,
  contextDangerPct: 85,
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
    toggleAllPanels: 'Alt+Z',
    tileLayout: 'Alt+Shift+L',
    tileSplit: 'Alt+Shift+S',
    tileFullscreen: 'Alt+Shift+F',
    tileFocusNext: 'Alt+J',
    tileFocusPrev: 'Alt+K',
    tileClose: 'Alt+Shift+W',
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
  layout: { sidebarWidth: 0, sidebarHidden: false },
  terminal: { copyOnSelect: false, fontSize: 13, scrollback: 5000, fileLinks: true, dropPaths: true },
  tiles: { layout: 'dwindle', gaps: 6, strip: 'normal' },
  claudeMods: { enabled: true, mods: { ...MOD_DEFAULT_ENABLED }, keepWarm: true, commandMenu: true },
  confirm: { closeTile: true, closeApp: true },
  notify: { finished: true, needs: true },
  topBar: {
    mediaControls: typeof process !== 'undefined' && process.platform === 'win32',
    mediaSize: 'full',
    clockFormat: 'auto',
    clockSeconds: false,
    clockDate: true,
  },
  tokens: {
    capWarnPct: 80,
    coldThresholdPct: 50,
    defaultCacheTtl: 'auto',
    subagentCacheTtl: '5m',
    pinClaudeVersion: true,
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

// Settings from before the mod registry had one `subagentPanel` switch: it becomes mods.subagents when mods has no value for it.
export function sanitizeClaudeMods(raw: unknown): ClaudeModsSettings {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const stored = r.mods && typeof r.mods === 'object' && !Array.isArray(r.mods) ? (r.mods as Record<string, unknown>) : {}
  const mods = { ...MOD_DEFAULT_ENABLED } as Record<ModId, boolean>
  for (const id of MOD_IDS) {
    const v = stored[id] ?? (id === 'subagents' && typeof r.subagentPanel === 'boolean' ? r.subagentPanel : undefined)
    if (typeof v === 'boolean') mods[id] = v
  }
  return { enabled: typeof r.enabled === 'boolean' ? r.enabled : true, mods, keepWarm: typeof r.keepWarm === 'boolean' ? r.keepWarm : true, commandMenu: typeof r.commandMenu === 'boolean' ? r.commandMenu : true }
}

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
  const efforts = r.defaultEfforts ?? {}
  const shell = r.shell ?? {}
  const ide = r.ide ?? {}
  const updates = r.updates ?? {}
  const keys = r.keybinds ?? {}
  const tokens = r.tokens ?? {}
  const top = r.topBar ?? {}
  const confirm = r.confirm ?? {}
  const notify = r.notify ?? {}
  const learn = r.learn ?? {}
  const layout = r.layout ?? {}
  const term = r.terminal ?? {}
  const tiles = r.tiles ?? {}
  const mods = r.claudeMods ?? {}
  const flag = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback)
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
      mode: (LEARN_MODES as string[]).includes(learn.mode) ? (learn.mode as LearnSettings['mode']) : d.learn.mode,
      maxCallsPerReview: Math.round(num(learn.maxCallsPerReview, d.learn.maxCallsPerReview, 0, 50)),
      maxTokensPerReview: Math.round(num(learn.maxTokensPerReview, d.learn.maxTokensPerReview, 0, 10_000_000)),
      maxChangesPerReview: Math.round(num(learn.maxChangesPerReview, d.learn.maxChangesPerReview, 0, 100)),
      validationRetries: Math.round(num(learn.validationRetries, d.learn.validationRetries, 0, 3)),
      dailyUsdBudget: num(learn.dailyUsdBudget, d.learn.dailyUsdBudget, 0, 100_000),
      onLimit: learn.onLimit === 'confirm' ? 'confirm' : 'stop',
      minUserTurns: Math.round(num(learn.minUserTurns, d.learn.minUserTurns, 0, 100)),
      minTokens: Math.round(num(learn.minTokens, d.learn.minTokens, 0, 10_000_000)),
    },
    memory: sanitizeMemory(r.memory),
    auxModels: sanitizeAuxModels(r.auxModels),
    aux: sanitizeAux(r.aux),
    dailyBudgetUsd: num(r.dailyBudgetUsd, d.dailyBudgetUsd, 0, 100_000),
    fiveHourBudgetUsd: num(r.fiveHourBudgetUsd, d.fiveHourBudgetUsd, 0, 100_000),
    weeklyBudgetUsd: num(r.weeklyBudgetUsd, d.weeklyBudgetUsd, 0, 100_000),
    ...hindsightSettings(r),
    defaultModels: { claude: str(models.claude, d.defaultModels.claude) || d.defaultModels.claude },
    defaultEfforts: { claude: CLAUDE_EFFORTS.includes(str(efforts.claude, '', 40)) ? str(efforts.claude, '', 40) : '' },
    mainCli: r.mainCli === 'opencode' || r.mainCli === 'claude' ? r.mainCli : d.mainCli,
    infoBar: flag(r.infoBar, d.infoBar),
    contextWarnPct: Math.round(num(r.contextWarnPct, d.contextWarnPct, 1, 100)),
    contextDangerPct: Math.round(num(r.contextDangerPct, d.contextDangerPct, 1, 100)),
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
      sidebarHidden: flag(layout.sidebarHidden, d.layout.sidebarHidden),
    },
    terminal: {
      copyOnSelect: flag(term.copyOnSelect, d.terminal.copyOnSelect),
      fontSize: Math.round(num(term.fontSize, d.terminal.fontSize, 8, 32)),
      scrollback: Math.round(num(term.scrollback, d.terminal.scrollback, 500, 100_000)),
      fileLinks: flag(term.fileLinks, d.terminal.fileLinks),
      dropPaths: flag(term.dropPaths, d.terminal.dropPaths),
    },
    tiles: {
      layout: tiles.layout === 'master' || tiles.layout === 'dwindle' ? tiles.layout : d.tiles.layout,
      gaps: Math.round(num(tiles.gaps, d.tiles.gaps, 0, 40)),
      strip: tiles.strip === 'compact' || tiles.strip === 'normal' || tiles.strip === 'hide' ? tiles.strip : d.tiles.strip,
    },
    claudeMods: sanitizeClaudeMods(mods),
    topBar: {
      mediaControls: flag(top.mediaControls, d.topBar.mediaControls),
      mediaSize: (['compact', 'full'] as const).includes(top.mediaSize) ? (top.mediaSize as MediaSize) : d.topBar.mediaSize,
      clockFormat: (['auto', '24', '12'] as const).includes(top.clockFormat) ? (top.clockFormat as ClockFormat) : d.topBar.clockFormat,
      clockSeconds: flag(top.clockSeconds, d.topBar.clockSeconds),
      clockDate: flag(top.clockDate, d.topBar.clockDate),
    },
    confirm: {
      closeTile: flag(confirm.closeTile, d.confirm.closeTile),
      closeApp: flag(confirm.closeApp, d.confirm.closeApp),
    },
    notify: {
      finished: flag(notify.finished, d.notify.finished),
      needs: flag(notify.needs, d.notify.needs),
    },
    tokens: {
      capWarnPct: num(tokens.capWarnPct, d.tokens.capWarnPct, 1, 100),
      coldThresholdPct: num(tokens.coldThresholdPct, d.tokens.coldThresholdPct, 1, 100),
      defaultCacheTtl: ttl(tokens.defaultCacheTtl, d.tokens.defaultCacheTtl),
      subagentCacheTtl: ttl(tokens.subagentCacheTtl, d.tokens.subagentCacheTtl),
      pinClaudeVersion: typeof tokens.pinClaudeVersion === 'boolean' ? tokens.pinClaudeVersion : d.tokens.pinClaudeVersion,
    },
  }
}

export const SETTINGS_SECTIONS = Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>

// Puts one top-level section (or every section, when none is named) back to its defaults. Other sections are kept.
export function resetSettings(current: Settings, section?: string): Settings {
  if (section === undefined) return sanitizeSettings(structuredClone(DEFAULT_SETTINGS))
  if (!(SETTINGS_SECTIONS as string[]).includes(section)) throw new Error(`No settings section named ${section}`)
  const k = section as keyof Settings
  return sanitizeSettings({ ...current, [k]: structuredClone(DEFAULT_SETTINGS[k]) })
}

export function mergeSettings(current: Settings, patch: SettingsPatch): Settings {
  const next: Record<string, unknown> = { ...current }
  for (const [k, v] of Object.entries(patch)) {
    const cur = (current as unknown as Record<string, unknown>)[k]
    next[k] = v && typeof v === 'object' && cur && typeof cur === 'object' ? { ...cur, ...v } : v
  }
  return sanitizeSettings(next)
}
