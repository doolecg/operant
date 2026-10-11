import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings, sanitizeSettings } from './settings'
import {
  ACCENT_PRESETS,
  BUILTIN_THEMES,
  addCustomTheme,
  contrast,
  customToDef,
  deleteCustomTheme,
  exportTheme,
  importTheme,
  normalizeHex,
  resolveTheme,
  sanitizeAppearance,
  tokensFor,
  updateCustomTheme,
  windowBackground,
  xtermColors,
  type CustomTheme,
} from './themes'

const AA = 4.5

// Every pair of text and the surface it is drawn on that the app uses for body text.
function pairs(t: Record<string, string>): Array<[string, string, string]> {
  const p: Array<[string, string, string]> = [
    ['--foreground', '--background', 'text on page'],
    ['--foreground', '--card', 'text on card'],
    ['--card-foreground', '--card', 'card text'],
    ['--popover-foreground', '--popover', 'popup text'],
    ['--secondary-foreground', '--secondary', 'secondary'],
    ['--accent-foreground', '--accent', 'hover'],
    ['--muted-foreground', '--background', 'muted on page'],
    ['--muted-foreground', '--card', 'muted on card'],
    ['--muted-foreground', '--muted', 'muted on muted'],
    ['--muted-foreground', '--popover', 'muted on popup'],
    ['--primary-foreground', '--primary', 'text on accent'],
    ['--sidebar-foreground', '--sidebar', 'sidebar'],
    ['--link', '--background', 'link on page'],
    ['--link', '--card', 'link on card'],
    ['--destructive', '--background', 'error on page'],
    ['--destructive', '--card', 'error on card'],
    ['--success', '--card', 'success on card'],
    ['--warning', '--card', 'warning on card'],
    ['--info', '--card', 'notice on card'],
  ]
  return p.filter(([a, b]) => t[a] && t[b])
}

describe('themes: contrast', () => {
  for (const d of BUILTIN_THEMES) {
    it(`${d.name} reaches WCAG AA for body text`, () => {
      const t = tokensFor(d)
      for (const [fg, bg, label] of pairs(t)) expect(contrast(t[fg]!, t[bg]!), `${d.id}: ${label}`).toBeGreaterThanOrEqual(AA)
      for (const n of ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5', '--chart-6', '--chart-other', '--chart-model']) {
        expect(contrast(t[n]!, t['--card']!), `${d.id}: ${n}`).toBeGreaterThanOrEqual(3)
      }
    })
    it(`${d.name} keeps AA with every accent preset`, () => {
      for (const [hex, name] of ACCENT_PRESETS) {
        const t = tokensFor(d, hex)
        expect(contrast(t['--primary-foreground']!, t['--primary']!), `${d.id} + ${name}`).toBeGreaterThanOrEqual(AA)
        expect(contrast(t['--link']!, t['--background']!), `${d.id} link + ${name}`).toBeGreaterThanOrEqual(AA)
      }
    })
    it(`${d.name} uses its own raw text colours when they already pass`, () => {
      const t = tokensFor(d)
      expect(t['--foreground']).toBe(d.text)
      expect(contrast(d.text, d.bg)).toBeGreaterThanOrEqual(AA)
    })
  }

  it('a custom theme with unreadable muted text is nudged to AA', () => {
    const d = customToDef({ id: 'custom-1', name: 'Dim', base: 'dark', colors: { bg: '#222222', dim: '#2a2a2a' } })
    const t = tokensFor(d)
    expect(contrast(t['--muted-foreground']!, t['--muted']!)).toBeGreaterThanOrEqual(AA)
  })

  it('the static fallback in index.css matches the Dark theme', () => {
    const css = readFileSync('renderer/src/index.css', 'utf8')
    const root = /:root\s*\{([^}]*)\}/.exec(css)![1]!
    const t = tokensFor(BUILTIN_THEMES.find((x) => x.id === 'dark')!)
    for (const k of ['--background', '--foreground', '--card', '--primary', '--muted-foreground', '--border', '--success', '--link']) {
      expect(root, k).toContain(`${k}: ${t[k]};`)
    }
  })
})

describe('themes: catalogue', () => {
  it('has Dark, Light and all twelve 2.8.2 themes with unique ids', () => {
    const ids = BUILTIN_THEMES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(['dark', 'light', 'obsidian', 'void', 'graphite', 'midnight', 'nord', 'dracula', 'tokyonight', 'catppuccin', 'gruvbox', 'rosepine', 'paper', 'daylight'])
    expect(BUILTIN_THEMES.find((t) => t.id === 'nord')).toMatchObject({ name: 'Nord', bg: '#2e3440', accent: '#88c0d0', card: '#383e4d' })
    expect(BUILTIN_THEMES.filter((t) => t.scheme === 'light').map((t) => t.id)).toEqual(['light', 'paper', 'daylight'])
  })

  it('System follows the OS', () => {
    const a = { theme: 'system', customThemes: [] as CustomTheme[] }
    expect(resolveTheme(a, true).id).toBe('dark')
    expect(resolveTheme(a, false).id).toBe('light')
    expect(windowBackground({ ...DEFAULT_SETTINGS.appearance, theme: 'system' }, false)).toBe('#faf9f7')
    expect(windowBackground({ ...DEFAULT_SETTINGS.appearance, theme: 'dracula' }, true)).toBe('#282a36')
  })

  it('terminal colours follow the theme or stay dark', () => {
    const nord = BUILTIN_THEMES.find((t) => t.id === 'nord')!
    expect(xtermColors(nord, '', true)).toMatchObject({ background: nord.card, foreground: '#eceff4', black: '#3b4252', cursor: '#88c0d0' })
    expect(xtermColors(nord, '#ff0000', true).cursor).toBe('#ff0000')
    expect(xtermColors(nord, '', false)).toMatchObject({ background: '#09090b', foreground: '#e4e4e7' })
  })

  it('every ANSI colour reads on the card background, and Dark keeps its palette', () => {
    for (const d of BUILTIN_THEMES) {
      const c = xtermColors(d, '', true) as unknown as Record<string, string>
      expect(c.background, d.id).toBe(d.card)
      for (const k of Object.keys(d.ansi)) expect(contrast(c[k]!, c.background!), `${d.id}: ${k}`).toBeGreaterThanOrEqual(4.5)
    }
    const dark = BUILTIN_THEMES.find((t) => t.id === 'dark')!
    const c = xtermColors(dark, '', true) as unknown as Record<string, string>
    expect(c.blue).toBe('#7aa6e3')
    expect(c.red).toBe('#e0704f')
    expect(c.green).toBe('#8fbf7f')
    expect(c.background).toBe('#1f1f1f')
    expect(c.selectionBackground).toBe('#573930')
  })
})

describe('themes: Claude neutrals', () => {
  it('Dark and Light use the neutral page, card and popover values and keep their ids', () => {
    const dark = BUILTIN_THEMES.find((t) => t.id === 'dark')!
    const light = BUILTIN_THEMES.find((t) => t.id === 'light')!
    expect(dark).toMatchObject({ name: 'Dark', bg: '#171717', card: '#1f1f1f', surface: '#262626', text: '#ececec', accent: '#d97757' })
    expect(light).toMatchObject({ name: 'Light', bg: '#faf9f7', card: '#ffffff', text: '#1a1a1a', accent: '#c96442' })
    expect(resolveTheme({ theme: 'light', customThemes: [] }, true).id).toBe('light')
  })

  it('derives the new surface and context tokens for every theme', () => {
    for (const d of BUILTIN_THEMES) {
      const t = tokensFor(d)
      for (const k of ['--bubble', '--code', '--ctx-system', '--ctx-tools', '--ctx-mcp', '--ctx-agents', '--ctx-memory', '--ctx-skills', '--ctx-messages', '--ctx-free', '--ctx-tick']) {
        expect(t[k], `${d.id}: ${k}`).toMatch(/^#[0-9a-f]{6}$/)
      }
    }
    expect(tokensFor(BUILTIN_THEMES.find((t) => t.id === 'dark')!)).toMatchObject({ '--border': '#2f2f2f', '--sidebar': '#141414', '--accent': '#2a2a2a', '--bubble': '#2b2b2b' })
  })
})

describe('themes: sanitising', () => {
  it('fills defaults and drops anything malformed', () => {
    expect(sanitizeAppearance(undefined)).toEqual({ theme: 'dark', accent: '', terminalFollowsTheme: true, noise: 25, customThemes: [] })
    const a = sanitizeAppearance({ theme: 'nope', accent: 'red', terminalFollowsTheme: 'x', customThemes: 'x' })
    expect(a).toEqual({ theme: 'dark', accent: '', terminalFollowsTheme: true, noise: 25, customThemes: [] })
    expect(sanitizeAppearance({ theme: 'system', accent: '#ABC' })).toMatchObject({ theme: 'system', accent: '#aabbcc' })
    expect(sanitizeAppearance({ theme: 'nord', accent: 'D97757' }).accent).toBe('#d97757')
    expect(sanitizeAppearance({ noise: 400 }).noise).toBe(100)
    expect(sanitizeAppearance({ noise: -3 }).noise).toBe(0)
    expect(sanitizeAppearance({ noise: 'x' }).noise).toBe(25)
  })

  it('keeps a custom theme id only while that theme exists', () => {
    const t = { id: 'custom-a', name: ' Mine ', base: 'nord', colors: { bg: '#101010', text: 'nothex', accent: '#FFF' } }
    const a = sanitizeAppearance({ theme: 'custom-a', customThemes: [t, t, { id: '../x' }, null, { id: 'custom-b', base: 'zzz', colors: 5 }] })
    expect(a.theme).toBe('custom-a')
    expect(a.customThemes).toEqual([
      { id: 'custom-a', name: 'Mine', base: 'nord', colors: { bg: '#101010', accent: '#ffffff' } },
      { id: 'custom-b', name: 'Custom theme', base: 'dark', colors: {} },
    ])
    expect(sanitizeAppearance({ theme: 'custom-a', customThemes: [] }).theme).toBe('dark')
  })

  it('is part of the settings and merges live', () => {
    expect(sanitizeSettings(undefined).appearance).toEqual(DEFAULT_SETTINGS.appearance)
    const s = mergeSettings(DEFAULT_SETTINGS, { appearance: { theme: 'dracula' } })
    expect(s.appearance).toMatchObject({ theme: 'dracula', terminalFollowsTheme: true })
    expect(mergeSettings(s, { appearance: { accent: '#5b9cff' } }).appearance).toMatchObject({ theme: 'dracula', accent: '#5b9cff' })
  })

  it('normalizeHex', () => {
    expect(normalizeHex('#FFF')).toBe('#ffffff')
    expect(normalizeHex('12')).toBeNull()
    expect(normalizeHex(5)).toBeNull()
  })
})

describe('themes: custom theme CRUD', () => {
  it('adds, edits, deletes, exports and imports', () => {
    let list: CustomTheme[] = []
    list = addCustomTheme(list, { name: 'Night shift', base: 'nord', colors: { bg: '#111111', accent: '#ff8800' } })
    list = addCustomTheme(list, { name: 'Second', base: 'paper', colors: {} })
    expect(list.map((t) => t.id)).toEqual(['custom-1', 'custom-2'])
    expect(customToDef(list[0]!)).toMatchObject({ name: 'Night shift', bg: '#111111', accent: '#ff8800', text: '#eceff4', scheme: 'dark' })
    expect(customToDef({ ...list[0]!, colors: { bg: '#ffffff', text: '#000000' } }).scheme).toBe('light')

    list = updateCustomTheme(list, 'custom-1', { name: 'Renamed', colors: { bg: '#222222' } })
    expect(list[0]).toEqual({ id: 'custom-1', name: 'Renamed', base: 'nord', colors: { bg: '#222222' } })
    expect(list[1]!.name).toBe('Second')

    const file = exportTheme(list[0]!)
    expect(JSON.parse(file)).toEqual({ operantTheme: 1, name: 'Renamed', base: 'nord', colors: { bg: '#222222' } })
    const imported = importTheme(file, list)
    expect(imported).toHaveLength(3)
    expect(imported[2]).toMatchObject({ name: 'Renamed', base: 'nord', colors: { bg: '#222222' } })
    expect(new Set(imported.map((t) => t.id)).size).toBe(3)
    expect(() => importTheme('{', list)).toThrow(/invalid JSON/)
    expect(() => importTheme('{"a":1}', list)).toThrow(/not an Operant theme/)

    list = deleteCustomTheme(list, 'custom-1')
    expect(list.map((t) => t.id)).toEqual(['custom-2'])
    expect(sanitizeAppearance({ theme: 'custom-1', customThemes: list }).theme).toBe('dark')
  })

  it('does not reuse an id after a delete and caps the list', () => {
    let list = addCustomTheme([], { name: 'a', base: 'dark', colors: {} })
    list = addCustomTheme(list, { name: 'b', base: 'dark', colors: {} })
    list = deleteCustomTheme(list, 'custom-1')
    list = addCustomTheme(list, { name: 'c', base: 'dark', colors: {} })
    expect(new Set(list.map((t) => t.id)).size).toBe(2)
    for (let i = 0; i < 40; i++) {
      try {
        list = addCustomTheme(list, { name: 'x', base: 'dark', colors: {} })
      } catch {
        break
      }
    }
    expect(list).toHaveLength(24)
  })
})
