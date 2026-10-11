// Colour themes, ported from Operant 2.8.2 (renderer/themes.js) plus Dark, Light and System. Pure data and maths, shared
// by the renderer (which writes the CSS variables), main (the window background before the page loads) and the tests.

export type Scheme = 'dark' | 'light'

export interface ThemeDef {
  id: string
  name: string
  note: string
  scheme: Scheme
  bg: string
  glow: string
  card: string
  surface: string
  text: string
  dim: string
  accent: string
  onAccent: string
  agent: string
  done: string
  danger: string
  warn: string
  info: string
  working: string
  termBlack: string
  ansi: Ansi
  // Optional fixed values for the surfaces the mix formulas get wrong (set on Dark and Light only).
  border?: string
  muted?: string
  input?: string
  sidebar?: string
  hover?: string
}

export type Ansi = Record<
  | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white'
  | 'brightBlack' | 'brightRed' | 'brightGreen' | 'brightYellow' | 'brightBlue' | 'brightMagenta' | 'brightCyan' | 'brightWhite',
  string
>

// The built-in terminal palette themes without their own `ansi` fall back to (2.8.2's).
const ANSI: Ansi = {
  red: '#e06c5a', green: '#9cb88a', yellow: '#e3b27a', blue: '#8fa9c7', magenta: '#c89ab8', cyan: '#8dbab3', white: '#f0eee6',
  brightBlack: '#8a857a', brightRed: '#f08a78', brightGreen: '#b4cfa3', brightYellow: '#f0c995', brightBlue: '#abc2dc',
  brightMagenta: '#dcb4ce', brightCyan: '#a9d0ca', brightWhite: '#faf9f5',
}

// 2.8.2 wrote its surfaces as "r, g, b"; they are kept in that form below and turned into hex here.
const c = (rgb: string): string => '#' + rgb.split(',').map((n) => Number(n).toString(16).padStart(2, '0')).join('')

type Raw = Omit<ThemeDef, 'id' | 'ansi' | 'onAccent' | 'surface' | 'card'> & {
  card: string
  surface: string
  onAccent?: string
  ansi?: Partial<Ansi>
}
const def = (id: string, r: Raw): ThemeDef => ({
  ...r,
  id,
  card: c(r.card),
  surface: c(r.surface),
  onAccent: r.onAccent ?? (r.scheme === 'light' ? '#ffffff' : r.bg),
  ansi: { ...ANSI, ...r.ansi },
})

export const BUILTIN_THEMES: ThemeDef[] = [
  // Claude-app neutrals: the page, cards and popovers are three greys; the accent is the coral.
  {
    id: 'dark', name: 'Dark', note: 'Neutral dark', scheme: 'dark',
    bg: '#171717', glow: '#1f1c1a', card: '#1f1f1f', surface: '#262626', text: '#ececec', dim: '#9a9a9a',
    accent: '#d97757', onAccent: '#141414', agent: '#e3b27a', done: '#8fbf7f', danger: '#f06a5f', warn: '#e6b85c',
    info: '#7aa6e3', working: '#f0883e', termBlack: '#262626',
    border: '#2f2f2f', muted: '#262626', input: '#363636', sidebar: '#141414', hover: '#2a2a2a',
    ansi: {
      ...ANSI, blue: '#7aa6e3', cyan: '#5fb3a8', magenta: '#a98bd6', green: '#8fbf7f', yellow: '#e6c15a', red: '#e0704f', brightMagenta: '#d987b0',
    },
  },
  {
    id: 'light', name: 'Light', note: 'Clean white', scheme: 'light',
    bg: '#faf9f7', glow: '#f0ede7', card: '#ffffff', surface: '#ffffff', text: '#1a1a1a', dim: '#6b6862',
    accent: '#c96442', onAccent: '#ffffff', agent: '#8a5600', done: '#2f6f2a', danger: '#c4402c', warn: '#9a6700',
    info: '#2f6aa3', working: '#d9600f', termBlack: '#24292f',
    border: '#e8e6e1', muted: '#f2f0ec', input: '#dedbd4', sidebar: '#f5f4f1', hover: '#efede8',
    ansi: {
      red: '#c4502c', green: '#3f7a2c', yellow: '#a57f00', blue: '#3b6ea8', magenta: '#7a55b5', cyan: '#2f7a72', white: '#6e7781',
      brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#633c01', brightBlue: '#218bff',
      brightMagenta: '#b04a82', brightCyan: '#3192aa', brightWhite: '#8c959f',
    } as Ansi,
  },
  def('obsidian', {
    name: 'Obsidian', note: 'Near-black, warm', scheme: 'dark',
    bg: '#0f0e0d', glow: '#2a1b12', card: '22, 21, 20', surface: '30, 29, 27', text: '#f0eee6', dim: '#948f84',
    accent: '#d97757', agent: '#e3b27a', done: '#9cb88a', termBlack: '#262522',
    danger: '#f85149', warn: '#f0b35a', info: '#7aa6e3', working: '#f0883e',
  }),
  def('void', {
    name: 'Void', note: 'Pure black (OLED)', scheme: 'dark',
    bg: '#000000', glow: '#1f130c', card: '12, 12, 11', surface: '22, 22, 20', text: '#f0eee6', dim: '#8a857b',
    accent: '#d97757', agent: '#e3b27a', done: '#9cb88a', termBlack: '#1e1d1b',
    danger: '#f85149', warn: '#f0b35a', info: '#7aa6e3', working: '#f0883e',
  }),
  def('graphite', {
    name: 'Graphite', note: 'Cool neutral dark', scheme: 'dark',
    bg: '#101113', glow: '#221a17', card: '27, 28, 31', surface: '35, 36, 40', text: '#ececec', dim: '#8e9096',
    accent: '#d97757', agent: '#e3b27a', done: '#9cb88a', termBlack: '#2a2b2f',
    danger: '#f85149', warn: '#f0b35a', info: '#7aa6e3', working: '#f0883e',
  }),
  def('midnight', {
    name: 'Midnight', note: 'Deep navy blue', scheme: 'dark',
    bg: '#0b1020', glow: '#14234a', card: '19, 27, 50', surface: '27, 36, 64', text: '#e6ebf5', dim: '#8391ad',
    accent: '#5b9cff', agent: '#a78bfa', done: '#6fd3a0', termBlack: '#1b2340',
    danger: '#ff6b7f', warn: '#f5c76b', info: '#5fd4e6', working: '#f5a25b',
    ansi: {
      red: '#ff6b7f', green: '#6fd3a0', yellow: '#f5c76b', blue: '#5b9cff', magenta: '#c38bfa', cyan: '#5fd4e6', white: '#c9d2e3',
      brightBlack: '#4a5677', brightRed: '#ff8b9b', brightGreen: '#8fe3b8', brightYellow: '#ffd98c', brightBlue: '#86b6ff',
      brightMagenta: '#d6aaff', brightCyan: '#86e3f0', brightWhite: '#f2f5fb',
    },
  }),
  def('nord', {
    name: 'Nord', note: 'Arctic blue-grey', scheme: 'dark',
    bg: '#2e3440', glow: '#2f4556', card: '56, 62, 77', surface: '63, 70, 87', text: '#eceff4', dim: '#9aa3b5',
    accent: '#88c0d0', agent: '#b48ead', done: '#a3be8c', termBlack: '#3b4252',
    danger: '#bf616a', warn: '#ebcb8b', info: '#81a1c1', working: '#d08770',
    ansi: {
      red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b', blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
      brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b', brightBlue: '#81a1c1',
      brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4',
    },
  }),
  def('dracula', {
    name: 'Dracula', note: 'Purple vampire dark', scheme: 'dark',
    bg: '#282a36', glow: '#3a2f55', card: '49, 51, 66', surface: '58, 60, 77', text: '#f8f8f2', dim: '#8e96bd',
    accent: '#bd93f9', agent: '#ff79c6', done: '#50fa7b', termBlack: '#343746',
    danger: '#ff5555', warn: '#f1fa8c', info: '#8be9fd', working: '#ffb86c',
    ansi: {
      red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
      brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5', brightBlue: '#d6acff',
      brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
    },
  }),
  def('tokyonight', {
    name: 'Tokyo Night', note: 'Neon city night', scheme: 'dark',
    bg: '#1a1b26', glow: '#232a4d', card: '34, 36, 52', surface: '41, 44, 64', text: '#c0caf5', dim: '#7982a9',
    accent: '#7aa2f7', agent: '#bb9af7', done: '#9ece6a', termBlack: '#24283b',
    danger: '#f7768e', warn: '#e0af68', info: '#7dcfff', working: '#ff9e64',
    ansi: {
      red: '#f7768e', green: '#9ece6a', yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
      brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a', brightYellow: '#e0af68', brightBlue: '#7aa2f7',
      brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#c0caf5',
    },
  }),
  def('catppuccin', {
    name: 'Catppuccin Mocha', note: 'Soothing pastel dark', scheme: 'dark',
    bg: '#1e1e2e', glow: '#2e2545', card: '42, 43, 60', surface: '49, 50, 68', text: '#cdd6f4', dim: '#9399b2',
    accent: '#cba6f7', agent: '#fab387', done: '#a6e3a1', termBlack: '#313244',
    danger: '#f38ba8', warn: '#f9e2af', info: '#89b4fa', working: '#fab387',
    ansi: {
      red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af', blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de',
      brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af', brightBlue: '#89b4fa',
      brightMagenta: '#f5c2e7', brightCyan: '#94e2d5', brightWhite: '#a6adc8',
    },
  }),
  def('gruvbox', {
    name: 'Gruvbox Dark', note: 'Retro warm groove', scheme: 'dark',
    bg: '#282828', glow: '#3a2c1c', card: '54, 51, 49', surface: '62, 58, 56', text: '#ebdbb2', dim: '#a89984',
    accent: '#fe8019', agent: '#fabd2f', done: '#b8bb26', termBlack: '#3c3836',
    danger: '#fb4934', warn: '#fabd2f', info: '#83a598', working: '#fe8019',
    ansi: {
      red: '#cc241d', green: '#98971a', yellow: '#d79921', blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
      brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26', brightYellow: '#fabd2f', brightBlue: '#83a598',
      brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#ebdbb2',
    },
  }),
  def('rosepine', {
    name: 'Rosé Pine', note: 'Muted rose and pine', scheme: 'dark',
    bg: '#191724', glow: '#2d2238', card: '34, 32, 52', surface: '42, 39, 62', text: '#e0def4', dim: '#908caa',
    accent: '#ebbcba', agent: '#f6c177', done: '#9ccfd8', termBlack: '#26233a',
    danger: '#eb6f92', warn: '#f6c177', info: '#9ccfd8', working: '#ea9a97',
    ansi: {
      red: '#eb6f92', green: '#31748f', yellow: '#f6c177', blue: '#9ccfd8', magenta: '#c4a7e7', cyan: '#ebbcba', white: '#e0def4',
      brightBlack: '#6e6a86', brightRed: '#eb6f92', brightGreen: '#31748f', brightYellow: '#f6c177', brightBlue: '#9ccfd8',
      brightMagenta: '#c4a7e7', brightCyan: '#ebbcba', brightWhite: '#e0def4',
    },
  }),
  def('paper', {
    name: 'Paper', note: 'Warm off-white', scheme: 'light',
    bg: '#f4f1ea', glow: '#ead8c4', card: '253, 252, 248', surface: '255, 255, 255', text: '#26231f', dim: '#5f5a51',
    accent: '#b85a3a', onAccent: '#ffffff', agent: '#8a5600', done: '#3f6a2c', termBlack: '#3d3a35',
    danger: '#c4402c', warn: '#b4630a', info: '#3b6ea8', working: '#d9731f',
    ansi: {
      red: '#b5402a', green: '#4f7a3a', yellow: '#8a6200', blue: '#3b6ea8', magenta: '#8f4f86', cyan: '#2f7a72', white: '#6f6a60',
      brightBlack: '#8a857a', brightRed: '#c9553d', brightGreen: '#5f8f47', brightYellow: '#a87700', brightBlue: '#4d84c2',
      brightMagenta: '#a6639c', brightCyan: '#3f9087', brightWhite: '#a29d92',
    },
  }),
  def('daylight', {
    name: 'Daylight', note: 'Cool white, blue accent', scheme: 'light',
    bg: '#f3f5f8', glow: '#d7e3f7', card: '255, 255, 255', surface: '255, 255, 255', text: '#171b22', dim: '#535f6e',
    accent: '#2f6fea', onAccent: '#ffffff', agent: '#6e3fd0', done: '#15702f', termBlack: '#24292f',
    danger: '#cf222e', warn: '#9a6700', info: '#1b7c83', working: '#e8590c',
    ansi: {
      red: '#cf222e', green: '#116329', yellow: '#4d2d00', blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
      brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#633c01', brightBlue: '#218bff',
      brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f',
    },
  }),
]

// The accent presets of 2.8.2.
export const ACCENT_PRESETS: Array<[string, string]> = [
  ['#d97757', 'Terracotta'], ['#c96442', 'Clay'], ['#e3a35a', 'Amber'],
  ['#e0786f', 'Coral'], ['#9cb88a', 'Sage'], ['#9a8fd1', 'Iris'],
  ['#5b9cff', 'Blue'], ['#3fb8a8', 'Teal'], ['#b48ef5', 'Violet'],
  ['#f07ab8', 'Pink'], ['#6fcf7f', 'Green'], ['#e5c07b', 'Gold'],
]

export const SYSTEM_THEME = 'system'
export const DEFAULT_THEME = 'dark'

// ---------------------------------------------------------------- colour maths

const HEX6 = /^#[0-9a-f]{6}$/
const HEX3 = /^#[0-9a-f]{3}$/

// '#abc' / '#AABBCC' / 'aabbcc' to '#aabbcc', or null when it is not a colour.
export function normalizeHex(v: unknown): string | null {
  if (typeof v !== 'string') return null
  let s = v.trim().toLowerCase()
  if (!s.startsWith('#')) s = '#' + s
  if (HEX3.test(s)) s = '#' + [...s.slice(1)].map((ch) => ch + ch).join('')
  return HEX6.test(s) ? s : null
}

const rgbOf = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
const toHex = (r: number, g: number, b: number): string =>
  '#' + [r, g, b].map((x) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, '0')).join('')

// a toward b by t (0 = a, 1 = b).
export function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = rgbOf(a)
  const [br, bg, bb] = rgbOf(b)
  return toHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t)
}

export function luminance(hex: string): number {
  const [r, g, b] = rgbOf(hex).map((x) => {
    const v = x / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

// WCAG 2 contrast ratio, 1 to 21.
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

// Nudges fg toward white (dark themes) or black (light themes) until it has `min` contrast on every background.
export function ensureContrast(fg: string, bgs: string[], min: number, scheme: Scheme): string {
  const target = scheme === 'dark' ? '#ffffff' : '#000000'
  let out = fg
  for (let i = 1; i <= 20 && bgs.some((bg) => contrast(out, bg) < min); i++) out = mix(fg, target, i * 0.05)
  return out
}

// Text on accent fills: white or near-black, whichever contrasts more.
export const onAccentFor = (accent: string): string => (contrast(accent, '#ffffff') >= contrast(accent, '#0f0e0d') ? '#ffffff' : '#0f0e0d')

// ---------------------------------------------------------------- custom themes

// The main colours a custom theme can change; everything else comes from its base theme.
export const COLOR_KEYS = ['bg', 'card', 'surface', 'text', 'dim', 'accent', 'danger', 'warn', 'done', 'info'] as const
export type ColorKey = (typeof COLOR_KEYS)[number]

export const COLOR_LABELS: Record<ColorKey, string> = {
  bg: 'Background', card: 'Cards', surface: 'Menus and popups', text: 'Text', dim: 'Muted text', accent: 'Accent',
  danger: 'Errors', warn: 'Warnings', done: 'Success', info: 'Notices',
}

export interface CustomTheme {
  id: string
  name: string
  base: string
  colors: Partial<Record<ColorKey, string>>
}

export const MAX_CUSTOM_THEMES = 24
const CUSTOM_ID = /^custom-[a-z0-9]{1,24}$/

export const isBuiltinId = (id: string): boolean => BUILTIN_THEMES.some((t) => t.id === id)

export function sanitizeCustomTheme(raw: unknown): CustomTheme | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !CUSTOM_ID.test(r.id)) return null
  const name = typeof r.name === 'string' ? r.name.trim().slice(0, 40) : ''
  const base = typeof r.base === 'string' && isBuiltinId(r.base) ? r.base : DEFAULT_THEME
  const src = r.colors && typeof r.colors === 'object' ? (r.colors as Record<string, unknown>) : {}
  const colors: CustomTheme['colors'] = {}
  for (const k of COLOR_KEYS) {
    const hex = normalizeHex(src[k])
    if (hex) colors[k] = hex
  }
  return { id: r.id, name: name || 'Custom theme', base, colors }
}

export function sanitizeCustomThemes(raw: unknown): CustomTheme[] {
  const out: CustomTheme[] = []
  for (const item of Array.isArray(raw) ? raw : []) {
    const t = sanitizeCustomTheme(item)
    if (t && !out.some((o) => o.id === t.id) && out.length < MAX_CUSTOM_THEMES) out.push(t)
  }
  return out
}

const baseOf = (id: string): ThemeDef => BUILTIN_THEMES.find((t) => t.id === id) ?? BUILTIN_THEMES[0]!

export function customToDef(t: CustomTheme): ThemeDef {
  const base = baseOf(t.base)
  const d: ThemeDef = { ...base, ...t.colors, id: t.id, name: t.name, note: 'Custom' }
  d.scheme = luminance(d.bg) < 0.4 ? 'dark' : 'light'
  if (!t.colors.accent) d.accent = base.accent
  d.onAccent = t.colors.accent ? onAccentFor(d.accent) : base.onAccent
  d.termBlack = d.scheme === base.scheme ? base.termBlack : d.scheme === 'dark' ? mix(d.bg, '#ffffff', 0.12) : mix(d.bg, '#000000', 0.7)
  return d
}

// A new id that no theme in the list uses.
function newCustomId(list: CustomTheme[]): string {
  for (let i = list.length + 1; ; i++) {
    const id = `custom-${i.toString(36)}`
    if (!list.some((t) => t.id === id)) return id
  }
}

export function addCustomTheme(list: CustomTheme[], input: { name: string; base: string; colors: CustomTheme['colors'] }): CustomTheme[] {
  if (list.length >= MAX_CUSTOM_THEMES) throw new Error(`At most ${MAX_CUSTOM_THEMES} custom themes`)
  const t = sanitizeCustomTheme({ id: newCustomId(list), ...input })!
  return [...list, t]
}

export function updateCustomTheme(list: CustomTheme[], id: string, patch: Partial<Pick<CustomTheme, 'name' | 'base' | 'colors'>>): CustomTheme[] {
  return list.map((t) => (t.id === id ? sanitizeCustomTheme({ ...t, ...patch })! : t))
}

export const deleteCustomTheme = (list: CustomTheme[], id: string): CustomTheme[] => list.filter((t) => t.id !== id)

export function exportTheme(t: CustomTheme): string {
  return JSON.stringify({ operantTheme: 1, name: t.name, base: t.base, colors: t.colors }, null, 2)
}

// Parses an exported theme into a new entry of the list (a fresh id); throws a readable message when it is not one.
export function importTheme(json: string, list: CustomTheme[]): CustomTheme[] {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    throw new Error('That is not a theme file (invalid JSON)')
  }
  const r = raw as Record<string, unknown> | null
  if (!r || typeof r !== 'object' || r.operantTheme !== 1 || typeof r.colors !== 'object') throw new Error('That is not an Operant theme file')
  return addCustomTheme(list, { name: String(r.name ?? ''), base: String(r.base ?? DEFAULT_THEME), colors: sanitizeCustomTheme({ id: 'custom-x', colors: r.colors })!.colors })
}

// ---------------------------------------------------------------- appearance settings

export interface Appearance {
  // 'system', a built-in id or a custom theme's id.
  theme: string
  // '' keeps the theme's own accent; otherwise a #rrggbb colour.
  accent: string
  // Terminals take the theme's colours; off keeps the fixed dark terminal.
  terminalFollowsTheme: boolean
  // A fine grain laid over the whole window, 0 (off) to 100.
  noise: number
  customThemes: CustomTheme[]
}

export const DEFAULT_APPEARANCE: Appearance = { theme: DEFAULT_THEME, accent: '', terminalFollowsTheme: true, noise: 25, customThemes: [] }

export function sanitizeAppearance(raw: unknown): Appearance {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const customThemes = sanitizeCustomThemes(r.customThemes)
  const known = (id: unknown): id is string => typeof id === 'string' && (id === SYSTEM_THEME || isBuiltinId(id) || customThemes.some((t) => t.id === id))
  return {
    theme: known(r.theme) ? r.theme : DEFAULT_APPEARANCE.theme,
    accent: normalizeHex(r.accent) ?? '',
    terminalFollowsTheme: typeof r.terminalFollowsTheme === 'boolean' ? r.terminalFollowsTheme : DEFAULT_APPEARANCE.terminalFollowsTheme,
    noise: typeof r.noise === 'number' && Number.isFinite(r.noise) ? Math.round(Math.min(100, Math.max(0, r.noise))) : DEFAULT_APPEARANCE.noise,
    customThemes,
  }
}

// The theme in use: System picks Dark or Light from the OS.
export function resolveTheme(a: Pick<Appearance, 'theme' | 'customThemes'>, systemDark: boolean): ThemeDef {
  if (a.theme === SYSTEM_THEME) return baseOf(systemDark ? 'dark' : 'light')
  const custom = a.customThemes.find((t) => t.id === a.theme)
  return custom ? customToDef(custom) : baseOf(a.theme)
}

export const windowBackground = (a: Appearance, systemDark: boolean): string => resolveTheme(a, systemDark).bg

// ---------------------------------------------------------------- tokens

// Every CSS variable a theme sets: the shadcn tokens plus the app's own. Text colours are nudged until they reach
// WCAG AA (4.5:1) on the surfaces they sit on, so a theme's exact palette is kept whenever it already does.
export function tokensFor(d: ThemeDef, accentOverride = ''): Record<string, string> {
  const s = d.scheme
  const accent = accentOverride || d.accent
  const onAccentTry = accentOverride ? onAccentFor(accent) : d.onAccent
  const onAccent = contrast(onAccentTry, accent) >= 4.5 ? onAccentTry : onAccentFor(accent)
  const muted = d.muted ?? mix(d.bg, d.text, 0.08)
  const surfaces = [d.bg, d.card, d.surface, muted]
  const text = (hex: string) => ensureContrast(hex, [d.bg, d.card], 4.5, s)
  const graphic = (hex: string) => ensureContrast(hex, [d.bg, d.card], 3, s)
  const accentTint = mix(d.bg, d.text, 0.12)
  const border = d.border ?? mix(d.bg, d.text, 0.16)
  const a = d.ansi
  return {
    '--background': d.bg,
    '--foreground': d.text,
    '--card': d.card,
    '--card-foreground': d.text,
    '--popover': d.surface,
    '--popover-foreground': d.text,
    '--primary': accent,
    '--primary-foreground': onAccent,
    '--secondary': mix(d.bg, d.text, 0.06),
    '--secondary-foreground': d.text,
    '--muted': muted,
    '--muted-foreground': ensureContrast(d.dim, surfaces, 4.5, s),
    '--accent': d.hover ?? accentTint,
    '--accent-foreground': d.text,
    '--destructive': text(d.danger),
    '--border': border,
    '--input': d.input ?? mix(d.bg, d.text, 0.2),
    '--ring': accent,
    '--chart-1': graphic(a.blue),
    '--chart-2': graphic(a.yellow),
    '--chart-3': graphic(a.green),
    '--chart-4': graphic(a.magenta),
    '--chart-5': graphic(a.cyan),
    '--chart-6': graphic(d.working),
    '--chart-other': graphic(mix(d.dim, d.bg, 0.2)),
    '--chart-model': graphic(d.info),
    '--sidebar': d.sidebar ?? d.card,
    '--sidebar-foreground': d.text,
    '--sidebar-primary': accent,
    '--sidebar-primary-foreground': onAccent,
    '--sidebar-accent': mix(d.card, d.text, 0.1),
    '--sidebar-accent-foreground': d.text,
    '--sidebar-border': border,
    '--sidebar-ring': accent,
    '--success': text(d.done),
    '--warning': text(d.warn),
    '--info': text(d.info),
    '--working': d.working,
    '--agent': text(d.agent),
    '--link': text(accent),
    '--glow': d.glow,
    '--overlay': s === 'dark' ? 'rgb(0 0 0 / 0.6)' : 'rgb(0 0 0 / 0.35)',
    '--xy-minimap-mask': s === 'dark' ? 'rgb(0 0 0 / 0.45)' : 'rgb(0 0 0 / 0.12)',
    '--syn-k': a.magenta,
    '--syn-s': a.green,
    '--syn-n': a.yellow,
    '--syn-f': a.blue,
    '--syn-t': a.cyan,
    '--bubble': mix(d.card, d.text, 0.06),
    '--code': s === 'dark' ? mix(d.bg, d.card, 0.5) : mix(d.bg, d.text, 0.015),
    '--ctx-system': graphic(a.blue),
    '--ctx-tools': graphic(a.cyan),
    '--ctx-mcp': graphic(a.magenta),
    '--ctx-agents': graphic(a.green),
    '--ctx-memory': graphic(a.yellow),
    '--ctx-skills': graphic(a.brightMagenta),
    '--ctx-messages': graphic(a.red),
    '--ctx-free': mix(d.bg, d.text, 0.14),
    '--ctx-tick': text(d.warn),
  }
}

// The colours xterm.js takes. Followed off, terminals keep the fixed dark palette they always had.
export interface XtermColors {
  background: string
  foreground: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  selectionInactiveBackground: string
  scrollbarSliderBackground: string
  scrollbarSliderHoverBackground: string
  scrollbarSliderActiveBackground: string
  black: string
  red: string; green: string; yellow: string; blue: string; magenta: string; cyan: string; white: string
  brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string; brightBlue: string
  brightMagenta: string; brightCyan: string; brightWhite: string
}

export function xtermColors(d: ThemeDef, accentOverride: string, follows: boolean): XtermColors {
  if (!follows) {
    const k = baseOf('dark')
    return { ...k.ansi, black: k.termBlack, background: '#09090b', foreground: '#e4e4e7', cursor: '#e4e4e7', cursorAccent: '#09090b', selectionBackground: '#3f3f46', selectionInactiveBackground: '#27272a', scrollbarSliderBackground: '#e4e4e733', scrollbarSliderHoverBackground: '#e4e4e759', scrollbarSliderActiveBackground: '#d9775799' }
  }
  const accent = accentOverride || d.accent
  const bg = d.card
  const dark = d.scheme === 'dark'
  const ansi = { ...d.ansi } as Record<string, string>
  for (const k of Object.keys(ansi)) ansi[k] = ensureContrast(ansi[k]!, [bg], 4.5, d.scheme)
  return {
    ...(ansi as unknown as Ansi),
    black: d.termBlack,
    background: bg,
    foreground: d.text,
    cursor: accent,
    cursorAccent: bg,
    selectionBackground: mix(bg, accent, dark ? 0.3 : 0.22),
    selectionInactiveBackground: mix(bg, d.text, dark ? 0.14 : 0.1),
    scrollbarSliderBackground: d.text + '33',
    scrollbarSliderHoverBackground: d.text + '59',
    scrollbarSliderActiveBackground: accent + '99',
  }
}
