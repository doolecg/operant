import { describe, expect, it } from 'vitest'
import { SETTINGS_CATEGORIES, SETTINGS_PAGES, SETTINGS_SECTION_IDS, resolveSettingsTarget } from './pages'

// The section ids the settings page had before it was grouped. Each must still open a page (deep links).
const OLD_SECTION_IDS = [
  'general', 'appearance', 'projects', 'topbar', 'terminals', 'terminal', 'tiles', 'mods', 'tokens', 'budgets', 'presets', 'teams',
  'learning', 'memory', 'aux', 'hindsight', 'codegraph', 'backups', 'superpowers', 'mcp', 'import', 'shortcuts', 'reset',
]

describe('settings page registry', () => {
  it('maps every old section id to a page', () => {
    for (const id of OLD_SECTION_IDS) expect(resolveSettingsTarget(id), id).toBeDefined()
    expect([...SETTINGS_SECTION_IDS].sort()).toEqual([...OLD_SECTION_IDS].sort())
  })

  it('opens the page that holds an old section and names the section to scroll to', () => {
    expect(resolveSettingsTarget('hindsight')).toMatchObject({ page: { id: 'memory' }, section: { id: 'hindsight' } })
    expect(resolveSettingsTarget('aux')).toMatchObject({ page: { id: 'learning' }, section: { id: 'aux' } })
    expect(resolveSettingsTarget('teams')).toMatchObject({ page: { id: 'presets' }, section: { id: 'teams' } })
    expect(resolveSettingsTarget('import')).toMatchObject({ page: { id: 'data' }, section: { id: 'import' } })
    expect(resolveSettingsTarget('mods')).toMatchObject({ page: { id: 'mods' } })
    expect(resolveSettingsTarget('mods')?.section).toBeUndefined()
  })

  it('resolves a page id to the page itself, and rejects unknown ids', () => {
    expect(resolveSettingsTarget('usage')).toEqual({ page: SETTINGS_PAGES.find((p) => p.id === 'usage') })
    expect(resolveSettingsTarget('general')?.section).toBeUndefined()
    expect(resolveSettingsTarget('no-such-section')).toBeUndefined()
    expect(resolveSettingsTarget(undefined)).toBeUndefined()
  })

  it('has no duplicate page ids, labels or section ids, and every page has at least one section', () => {
    const pageIds = SETTINGS_PAGES.map((p) => p.id)
    expect(new Set(pageIds).size).toBe(pageIds.length)
    expect(new Set(SETTINGS_PAGES.map((p) => p.label)).size).toBe(SETTINGS_PAGES.length)
    const sectionIds = SETTINGS_PAGES.flatMap((p) => p.subsections.map((s) => s.id))
    expect(new Set(sectionIds).size).toBe(sectionIds.length)
    expect(sectionIds.sort()).toEqual([...SETTINGS_SECTION_IDS].sort())
    for (const p of SETTINGS_PAGES) expect(p.subsections.length, p.id).toBeGreaterThan(0)
  })

  it('has unique category labels with at least one page each', () => {
    const labels = SETTINGS_CATEGORIES.map((c) => c.label)
    expect(new Set(labels).size).toBe(labels.length)
    for (const c of SETTINGS_CATEGORIES) expect(c.pages.length, c.label).toBeGreaterThan(0)
  })
})
