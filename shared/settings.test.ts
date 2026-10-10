import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, KEY_ACTIONS, mergeSettings, sanitizeSettings } from './settings'

describe('settings', () => {
  it('fills defaults for missing or malformed values', () => {
    expect(sanitizeSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    const s = sanitizeSettings({
      dailyBudgetUsd: -5,
      defaultModels: { claude: '  opus ', codex: 42 },
      updates: { channel: 'nightly', checkHours: 99.4, installOnQuit: 'yes' },
      keybinds: { newCrew: 'Mod+Shift+N', addSquad: 'Mod+Shift+P', tabCost: 'Mod+3', bogus: 'X' },
    })
    expect(s.dailyBudgetUsd).toBe(0)
    expect(s.defaultModels).toEqual({ claude: 'opus' })
    expect(s.updates).toEqual({ channel: 'stable', checkHours: 24, installOnQuit: true })
    expect(s.keybinds.newCrew).toBe('Mod+Shift+N')
    expect(Object.keys(s.keybinds).sort()).toEqual(['indexCrew', 'mediaNext', 'mediaPlayPause', 'mediaPrev', 'mediaShuffle', 'newCrew', 'newShell', 'openInIde', 'openPlayground', 'openSettings', 'tileClose', 'tileFocusNext', 'tileFocusPrev', 'tileFullscreen', 'tileLayout', 'tileSplit', 'toggleAllPanels', 'toggleConsole', 'toggleSidebar', 'zoomIn', 'zoomOut', 'zoomReset'])
    expect('defaultReview' in s).toBe(false)
  })

  it('remembers the Claude effort only as a real level', () => {
    expect(DEFAULT_SETTINGS.defaultEfforts).toEqual({ claude: '' })
    expect(sanitizeSettings({ defaultEfforts: { claude: ' xhigh ' } }).defaultEfforts).toEqual({ claude: 'xhigh' })
    expect(sanitizeSettings({ defaultEfforts: { claude: 'turbo' } }).defaultEfforts).toEqual({ claude: '' })
    expect(sanitizeSettings({ defaultEfforts: 'max' }).defaultEfforts).toEqual({ claude: '' })
    expect(mergeSettings(DEFAULT_SETTINGS, { defaultEfforts: { claude: 'max' } }).defaultEfforts).toEqual({ claude: 'max' })
    expect(mergeSettings(DEFAULT_SETTINGS, { defaultModels: { claude: 'opus' } }).defaultEfforts).toEqual({ claude: '' })
  })

  it('sanitises the learning AI choice', () => {
    expect(sanitizeSettings({}).learn).toMatchObject({ cli: 'claude', model: '', effort: '' })
    expect(sanitizeSettings({ learn: { cli: 'opencode', model: 'openai/gpt-5-mini', effort: 'low' } }).learn).toMatchObject({ cli: 'opencode', model: 'openai/gpt-5-mini', effort: 'low' })
    expect(sanitizeSettings({ learn: { cli: 'codex', model: '--evil flag', effort: '-x' } }).learn).toMatchObject({ cli: 'claude', model: '', effort: '' })
  })


  it('sanitises the dragged panel widths', () => {
    expect(sanitizeSettings({ layout: { sidebarWidth: 301.4 } }).layout).toMatchObject({ sidebarWidth: 301 })
    expect(sanitizeSettings({ layout: { sidebarWidth: -9 } }).layout).toMatchObject({ sidebarWidth: 0 })
    expect(sanitizeSettings({ layout: { sidebarWidth: 99999 } }).layout).toMatchObject({ sidebarWidth: 4000 })
  })

  it('clamps and defaults the tokens and collaboration groups', () => {
    const s = sanitizeSettings({
      tokens: { operatorDailyCapUsd: -3, capWarnPct: 500, coldThresholdPct: 'x', outputShareWarnPct: 0, defaultCacheTtl: '2h', subagentCacheTtl: '1h', pinClaudeVersion: 'no' },
      collab: { nudgeIdleSeconds: 0, leaseMinutes: 90.6, maxRejects: -1, purgeRetentionDays: 7.2, purgeEnabled: 'no', longJobElapsedMinutes: NaN },
    })
    expect(s.tokens).toEqual({
      capWarnPct: 100,
      coldThresholdPct: 50,
      defaultCacheTtl: 'auto',
      subagentCacheTtl: '1h',
      pinClaudeVersion: true,
    })
    expect(DEFAULT_SETTINGS.tokens.capWarnPct).toBe(80)
    expect(DEFAULT_SETTINGS.tokens).toMatchObject({ defaultCacheTtl: 'auto', subagentCacheTtl: '5m', pinClaudeVersion: true })
  })


  it('merges nested patches without dropping sibling values', () => {
    const s = mergeSettings(DEFAULT_SETTINGS, { updates: { channel: 'beta' }, keybinds: { indexCrew: '' }, dailyBudgetUsd: 25 })
    expect(s.updates).toEqual({ channel: 'beta', checkHours: 3, installOnQuit: true })
    expect(s.keybinds.indexCrew).toBe('')
    expect(s.keybinds.newCrew).toBe('Mod+N')
    expect(s.dailyBudgetUsd).toBe(25)
  })


  it('keeps only an http(s) Hindsight URL', () => {
    expect(sanitizeSettings({ hindsightUrl: ' http://nas:9077 ' }).hindsightUrl).toBe('http://nas:9077')
    expect(sanitizeSettings({ hindsightUrl: 'file:///x' }).hindsightUrl).toBe('')
    expect(DEFAULT_SETTINGS.hindsightUrl).toBe('')
  })

  it('migrates the legacy hindsightUrl into the hosting settings and keeps it mirrored', () => {
    const m = sanitizeSettings({ hindsightUrl: 'http://nas:9077' })
    expect(m.hindsight).toMatchObject({ mode: 'remote', url: 'http://nas:9077' })
    expect(m.hindsightUrl).toBe('http://nas:9077')
    expect(DEFAULT_SETTINGS.hindsight).toMatchObject({ mode: 'local', url: '', port: 9077, bindHost: '127.0.0.1', openBind: false })
    expect(sanitizeSettings({}).hindsight.mode).toBe('local')
    // switching away from remote keeps the URL for later but stops mirroring it
    const lan = mergeSettings(m, { hindsight: { mode: 'lan' } })
    expect(lan.hindsight).toMatchObject({ mode: 'lan', url: 'http://nas:9077' })
    expect(lan.hindsightUrl).toBe('')
    expect(mergeSettings(lan, { hindsight: { mode: 'local' } }).hindsight.mode).toBe('local')
  })

  it('sanitises the hosting settings', () => {
    const h = sanitizeSettings({ hindsight: { mode: 'weird', bindHost: 'bad host!', port: 99999, url: 'ftp://x', openBind: 'yes' } }).hindsight
    expect(h).toEqual({ mode: 'local', bindHost: '127.0.0.1', port: 65535, url: '', openBind: false })
    const ok = sanitizeSettings({ hindsight: { mode: 'lan', bindHost: '100.101.102.103', port: 9100, openBind: true } }).hindsight
    expect(ok).toMatchObject({ mode: 'lan', bindHost: '100.101.102.103', port: 9100, openBind: true })
  })

  it('sanitises the hide flag, terminal and tiles settings', () => {
    const d = sanitizeSettings({})
    expect(d.layout).toEqual({ sidebarWidth: 0, sidebarHidden: false })
    expect(d.terminal).toEqual({ copyOnSelect: false, fontSize: 13, scrollback: 5000, fileLinks: true, dropPaths: true })
    expect(d.tiles).toEqual({ layout: 'dwindle', gaps: 6, strip: 'normal' })
    const bad = sanitizeSettings({
      layout: { sidebarHidden: 'yes' },
      terminal: { copyOnSelect: 1, fontSize: 99, scrollback: 10, fileLinks: false, dropPaths: 'no' },
      tiles: { layout: 'grid', gaps: -4, strip: 'big' },
    })
    expect(bad.layout).toEqual({ sidebarWidth: 0, sidebarHidden: false })
    expect(bad.terminal).toEqual({ copyOnSelect: false, fontSize: 32, scrollback: 500, fileLinks: false, dropPaths: true })
    // A saved chat composer switch from before the Chat view is dropped on load.
    expect(sanitizeSettings({ terminal: { chatComposer: true } }).terminal).toEqual({ copyOnSelect: false, fontSize: 13, scrollback: 5000, fileLinks: true, dropPaths: true })
    expect(bad.tiles).toEqual({ layout: 'dwindle', gaps: 0, strip: 'normal' })
    // A saved layout from before the side panel was removed keeps the project list and drops the rest.
    const old = sanitizeSettings({ layout: { sidebarHidden: true, panelHidden: true, rightWidth: 300 }, keybinds: { toggleSidePanel: 'Alt+X' } })
    expect(old.layout).toEqual({ sidebarWidth: 0, sidebarHidden: true })
    expect(old.keybinds).not.toHaveProperty('toggleSidePanel')
  })

  it('sanitises the main CLI, the info bar and the context thresholds', () => {
    const d = sanitizeSettings({})
    expect(d).toMatchObject({ mainCli: 'claude', infoBar: true, contextWarnPct: 60, contextDangerPct: 85 })
    expect(sanitizeSettings({ mainCli: 'codex', infoBar: 'no', contextWarnPct: 0, contextDangerPct: 500 })).toMatchObject({ mainCli: 'claude', infoBar: true, contextWarnPct: 1, contextDangerPct: 100 })
    expect(sanitizeSettings({ mainCli: 'opencode', infoBar: false, contextWarnPct: 40.6 })).toMatchObject({ mainCli: 'opencode', infoBar: false, contextWarnPct: 41 })
    expect(mergeSettings(DEFAULT_SETTINGS, { mainCli: 'opencode' }).mainCli).toBe('opencode')
  })

  it('merges partial layout, terminal and tiles patches and labels every key action', () => {
    const m = mergeSettings(DEFAULT_SETTINGS, { layout: { sidebarHidden: true }, terminal: { fontSize: 16 }, tiles: { layout: 'master' } })
    expect(m.layout).toEqual({ sidebarHidden: true, sidebarWidth: 0 })
    expect(m.terminal).toMatchObject({ fontSize: 16, scrollback: 5000 })
    expect(m.tiles).toMatchObject({ layout: 'master', gaps: 6 })
    expect(KEY_ACTIONS.map((a) => a.id).sort()).toEqual(Object.keys(DEFAULT_SETTINGS.keybinds).sort())
    expect(KEY_ACTIONS.every((a) => a.label.length > 0)).toBe(true)
    expect(DEFAULT_SETTINGS.keybinds).toMatchObject({ toggleAllPanels: 'Alt+Z' })
  })

  it('sanitises the top bar settings and leaves media keys unbound', () => {
    expect(DEFAULT_SETTINGS.keybinds).toMatchObject({ mediaPlayPause: '', mediaNext: '', mediaPrev: '', mediaShuffle: '' })
    const t = sanitizeSettings({ topBar: { mediaSize: 'huge', clockFormat: '13', clockSeconds: 'yes', clockDate: false } }).topBar
    expect(t).toMatchObject({ mediaSize: 'full', clockFormat: 'auto', clockSeconds: false, clockDate: false })
    const m = mergeSettings(DEFAULT_SETTINGS, { topBar: { mediaSize: 'compact', clockFormat: '12', clockSeconds: true } }).topBar
    expect(m).toMatchObject({ mediaSize: 'compact', clockFormat: '12', clockSeconds: true, clockDate: true })
  })
})

describe('claudeMods settings', () => {
  const allOff = { subagents: false, promptEnhancer: false, designPicker: false, ideaShelf: false, folderTracker: false, plainEnglish: false }

  it('defaults the master switch on, the sub-agent mod on and the rest off', () => {
    expect(DEFAULT_SETTINGS.claudeMods).toEqual({ enabled: true, mods: { ...allOff, subagents: true }, keepWarm: true, commandMenu: true })
    const off = sanitizeSettings({ claudeMods: { enabled: false, mods: { ...allOff, subagents: false, ideaShelf: true } } }).claudeMods
    expect(off).toEqual({ enabled: false, mods: { ...allOff, ideaShelf: true }, keepWarm: true, commandMenu: true })
  })

  it('migrates the old subagentPanel switch into mods.subagents', () => {
    expect(sanitizeSettings({ claudeMods: { enabled: true, subagentPanel: false } }).claudeMods.mods.subagents).toBe(false)
    expect(sanitizeSettings({ claudeMods: { enabled: true, subagentPanel: true } }).claudeMods.mods.subagents).toBe(true)
    // A stored mods value wins over the old flag.
    expect(sanitizeSettings({ claudeMods: { subagentPanel: false, mods: { subagents: true } } }).claudeMods.mods.subagents).toBe(true)
  })

  it('loads a saved chatLook switch from before the Chat view without error', () => {
    const s = sanitizeSettings({ claudeMods: { enabled: true, mods: { chatLook: true, subagents: true } } }).claudeMods
    expect(s).toEqual({ enabled: true, mods: { ...allOff, subagents: true }, keepWarm: true, commandMenu: true })
    expect(Object.keys(s.mods)).not.toContain('chatLook')
  })

  it('drops unknown mod ids and non-boolean values back to the defaults', () => {
    const s = sanitizeSettings({ claudeMods: { enabled: 'no', mods: { subagents: 0, ideaShelf: true, nope: true } } }).claudeMods
    expect(s).toEqual({ enabled: true, mods: { ...allOff, subagents: true, ideaShelf: true }, keepWarm: true, commandMenu: true })
    const gone = sanitizeSettings({ claudeMods: { enabled: true, keepWarm: false, mods: { sessionMonitor: true, assumptionCheck: true } } }).claudeMods
    expect(Object.keys(gone.mods)).not.toContain('sessionMonitor')
    expect(Object.keys(gone.mods)).not.toContain('assumptionCheck')
    expect(gone.keepWarm).toBe(false)
    expect(sanitizeSettings({ claudeMods: 'yes' }).claudeMods).toEqual({ enabled: true, mods: { ...allOff, subagents: true }, keepWarm: true, commandMenu: true })
    expect(sanitizeSettings({ claudeMods: null }).claudeMods).toEqual({ enabled: true, mods: { ...allOff, subagents: true }, keepWarm: true, commandMenu: true })
  })

  it('merges a partial patch without losing the other switches', () => {
    const off = mergeSettings(DEFAULT_SETTINGS, { claudeMods: { enabled: false, mods: { ...allOff, subagents: true } } })
    expect(off.claudeMods).toEqual({ enabled: false, mods: { ...allOff, subagents: true }, keepWarm: true, commandMenu: true })
  })
})
