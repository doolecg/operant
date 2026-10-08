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
    expect(s).toMatchObject({ mainCli: 'claude', mainModel: '', mainEffort: '' })
    expect(s.updates).toEqual({ channel: 'stable', checkHours: 24, installOnQuit: true })
    expect(s.keybinds.newCrew).toBe('Mod+Shift+N')
    expect(Object.keys(s.keybinds).sort()).toEqual(['indexCrew', 'mediaNext', 'mediaPlayPause', 'mediaPrev', 'mediaShuffle', 'newCrew', 'newShell', 'openInIde', 'openPlayground', 'openSettings', 'tileClose', 'tileFocusNext', 'tileFocusPrev', 'tileFullscreen', 'tileLayout', 'tileSplit', 'toggleAllPanels', 'toggleConsole', 'toggleSidePanel', 'toggleSidebar', 'zoomIn', 'zoomOut', 'zoomReset'])
    expect('defaultReview' in s).toBe(false)
  })

  it('sanitises the learning AI choice', () => {
    expect(sanitizeSettings({}).learn).toMatchObject({ cli: 'claude', model: '', effort: '' })
    expect(sanitizeSettings({ learn: { cli: 'opencode', model: 'openai/gpt-5-mini', effort: 'low' } }).learn).toMatchObject({ cli: 'opencode', model: 'openai/gpt-5-mini', effort: 'low' })
    expect(sanitizeSettings({ learn: { cli: 'codex', model: '--evil flag', effort: '-x' } }).learn).toMatchObject({ cli: 'claude', model: '', effort: '' })
  })

  it('sanitises the main CLI choice', () => {
    expect(sanitizeSettings({ mainCli: 'opencode' })).toMatchObject({ mainCli: 'opencode', mainModel: '', mainEffort: '' })
    expect(sanitizeSettings({ mainCli: 'opencode', mainModel: 'openai/gpt-5', mainEffort: 'high' })).toMatchObject({ mainModel: 'openai/gpt-5', mainEffort: 'high' })
    expect(sanitizeSettings({ mainCli: 'codex', mainModel: '--x', mainEffort: '-y' })).toMatchObject({ mainCli: 'claude', mainModel: '', mainEffort: '' })
  })

  it('sanitises the dragged panel widths', () => {
    expect(sanitizeSettings({ layout: { sidebarWidth: 301.4, rightWidth: 'wide' } }).layout).toMatchObject({ sidebarWidth: 301, rightWidth: 0 })
    expect(sanitizeSettings({ layout: { sidebarWidth: -9, rightWidth: 99999 } }).layout).toMatchObject({ sidebarWidth: 0, rightWidth: 4000 })
    expect(mergeSettings(DEFAULT_SETTINGS, { layout: { rightWidth: 500 } }).layout).toMatchObject({ sidebarWidth: 0, rightWidth: 500 })
  })

  it('clamps and defaults the tokens and collaboration groups', () => {
    const s = sanitizeSettings({
      tokens: { operatorDailyCapUsd: -3, capWarnPct: 500, coldThresholdPct: 'x', outputShareWarnPct: 0, defaultCacheTtl: '2h', subagentCacheTtl: '1h', pinClaudeVersion: 'no' },
      collab: { nudgeIdleSeconds: 0, leaseMinutes: 90.6, maxRejects: -1, purgeRetentionDays: 7.2, purgeEnabled: 'no', longJobElapsedMinutes: NaN },
    })
    expect(s.tokens).toEqual({
      operatorDailyCapUsd: 0,
      capWarnPct: 100,
      coldThresholdPct: 50,
      outputShareWarnPct: 1,
      defaultCacheTtl: 'auto',
      subagentCacheTtl: '1h',
      pinClaudeVersion: true,
    })
    expect(s.collab).toEqual({
      ...DEFAULT_SETTINGS.collab,
      nudgeIdleSeconds: 1,
      leaseMinutes: 91,
      maxRejects: 0,
      purgeRetentionDays: 7,
    })
    expect(DEFAULT_SETTINGS.collab.purgeRetentionDays).toBe(30)
    expect(DEFAULT_SETTINGS.collab.purgeEnabled).toBe(true)
    expect(DEFAULT_SETTINGS.tokens.capWarnPct).toBe(80)
    expect(DEFAULT_SETTINGS.tokens).toMatchObject({ defaultCacheTtl: 'auto', subagentCacheTtl: '5m', pinClaudeVersion: true })
  })

  it('keeps the Claude hooks in runs off by default and sanitises it', () => {
    expect(DEFAULT_SETTINGS.runs.useClaudeHooks).toBe(false)
    expect(sanitizeSettings({ runs: { useClaudeHooks: 'yes' } }).runs.useClaudeHooks).toBe(false)
    expect(mergeSettings(DEFAULT_SETTINGS, { runs: { useClaudeHooks: true } }).runs.useClaudeHooks).toBe(true)
  })

  it('merges nested patches without dropping sibling values', () => {
    const s = mergeSettings(DEFAULT_SETTINGS, { updates: { channel: 'beta' }, keybinds: { indexCrew: '' }, dailyBudgetUsd: 25 })
    expect(s.updates).toEqual({ channel: 'beta', checkHours: 3, installOnQuit: true })
    expect(s.keybinds.indexCrew).toBe('')
    expect(s.keybinds.newCrew).toBe('Mod+N')
    expect(s.dailyBudgetUsd).toBe(25)
  })

  it('merges collaboration and token patches field by field', () => {
    const s = mergeSettings(DEFAULT_SETTINGS, { collab: { leaseMinutes: 10, purgeEnabled: false }, tokens: { operatorDailyCapUsd: 5 } })
    expect(s.collab).toEqual({ ...DEFAULT_SETTINGS.collab, leaseMinutes: 10, purgeEnabled: false })
    expect(s.tokens).toEqual({ ...DEFAULT_SETTINGS.tokens, operatorDailyCapUsd: 5 })
    expect(s.keybinds.openSettings).toBe('Mod+,')
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

  it('sanitises the hide flags, terminal, tiles and notification settings', () => {
    const d = sanitizeSettings({})
    expect(d.layout).toMatchObject({ sidebarHidden: false, panelHidden: false, inboxHidden: false })
    expect(d.terminal).toEqual({ copyOnSelect: false, fontSize: 13, scrollback: 5000, fileLinks: true, dropPaths: true })
    expect(d.tiles).toEqual({ layout: 'dwindle', gaps: 6, autoOpenSubagents: true, closeDoneAfterSec: 30, strip: 'normal', runawayMinutes: 0 })
    expect(d.notifications).toEqual({ inbox: true })
    const bad = sanitizeSettings({
      layout: { sidebarHidden: 'yes', panelHidden: true },
      terminal: { copyOnSelect: 1, fontSize: 99, scrollback: 10, fileLinks: false, dropPaths: 'no' },
      tiles: { layout: 'grid', gaps: -4, autoOpenSubagents: false, closeDoneAfterSec: 99999, strip: 'big', runawayMinutes: 2.6 },
      notifications: { inbox: 'off' },
    })
    expect(bad.layout).toMatchObject({ sidebarHidden: false, panelHidden: true, inboxHidden: false })
    expect(bad.terminal).toEqual({ copyOnSelect: false, fontSize: 32, scrollback: 500, fileLinks: false, dropPaths: true })
    expect(bad.tiles).toEqual({ layout: 'dwindle', gaps: 0, autoOpenSubagents: false, closeDoneAfterSec: 3600, strip: 'normal', runawayMinutes: 3 })
    expect(bad.notifications.inbox).toBe(true)
  })

  it('merges partial layout, terminal and tiles patches and labels every key action', () => {
    const m = mergeSettings(DEFAULT_SETTINGS, { layout: { sidebarHidden: true }, terminal: { fontSize: 16 }, tiles: { layout: 'master' }, notifications: { inbox: false } })
    expect(m.layout).toMatchObject({ sidebarHidden: true, panelHidden: false, sidebarWidth: 0 })
    expect(m.terminal).toMatchObject({ fontSize: 16, scrollback: 5000 })
    expect(m.tiles).toMatchObject({ layout: 'master', gaps: 6 })
    expect(m.notifications.inbox).toBe(false)
    expect(KEY_ACTIONS.map((a) => a.id).sort()).toEqual(Object.keys(DEFAULT_SETTINGS.keybinds).sort())
    expect(KEY_ACTIONS.every((a) => a.label.length > 0)).toBe(true)
    expect(DEFAULT_SETTINGS.keybinds).toMatchObject({ toggleSidePanel: 'Alt+Shift+B', toggleAllPanels: 'Alt+Z' })
  })

  it('sanitises the top bar settings and leaves media keys unbound', () => {
    expect(DEFAULT_SETTINGS.keybinds).toMatchObject({ mediaPlayPause: '', mediaNext: '', mediaPrev: '', mediaShuffle: '' })
    const t = sanitizeSettings({ topBar: { mediaSize: 'huge', clockFormat: '13', clockSeconds: 'yes', clockDate: false, agentPill: 0 } }).topBar
    expect(t).toMatchObject({ mediaSize: 'full', clockFormat: 'auto', clockSeconds: false, clockDate: false, agentPill: true })
    const m = mergeSettings(DEFAULT_SETTINGS, { topBar: { mediaSize: 'compact', clockFormat: '12', clockSeconds: true } }).topBar
    expect(m).toMatchObject({ mediaSize: 'compact', clockFormat: '12', clockSeconds: true, clockDate: true })
  })
})
