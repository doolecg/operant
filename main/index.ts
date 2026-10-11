import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn as spawnPty } from '@lydell/node-pty'
import { app, BrowserWindow, dialog, nativeTheme, safeStorage, screen, shell } from 'electron'
import { scrubLogLine } from '../core/agents'
import { CdpProxy } from '../core/browser/cdp-proxy'
import { BrowserHub } from '../core/browser/hub'
import { createExtras, type Extras } from '../core/browser/extras'
import { McpHost } from '../core/browser/mcp-host'
import { assessCall, confirmSummary } from '../core/browser/risk'
import { CliServer, type CliTarget } from '../core/cli-server'
import { CrewIndexes } from '../core/codegraph'
import { consoleLog } from '../core/console'
import { FileSecretStore } from '../core/secrets'
import { Operant } from '../core/operant'
import { appDataDir } from '../core/paths'
import { SessionManager } from '../core/sessions'
import { Store } from '../core/store'
import { DEFAULT_CREW_BROWSER, sanitizeCrewBrowser } from '../shared/browser-compat'
import { DEFAULT_APPEARANCE, windowBackground } from '../shared/themes'
import { BrowserPanels } from './browser'
import { BrowserPopout } from './browser-popout'
import { hideAutomationFlag } from './browser-stealth'
import { loadEnv } from './env'
import { isAppUrl, type AppOrigin } from './guard'
import { attachCloseGuard, type CloseGuard } from './closeGuard'
import { push, registerIpc } from './ipc'
import { watchClaudeTurns, type TurnWatch } from './notify'
import { createUpdater } from './updater'
import { attachWindowSync } from './windowSync'

// A .env file sets variables the real environment lacks: the repo root in dev, the app data folder when installed.
const envDir = app.isPackaged ? appDataDir() : app.getAppPath()
loadEnv({ dir: envDir, log: (line) => console.log(line) })

// Keep data apart from Operant 1, which owns the plain "Operant" folder.
app.setPath('userData', appDataDir())

// The embedded browser is driven over CDP through a filtering proxy. Chromium picks a free port on 127.0.0.1 and writes
// it to <userData>/DevToolsActivePort. A switch that is already there (the e2e harness) is left alone.
if (!app.commandLine.hasSwitch('remote-debugging-port')) app.commandLine.appendSwitch('remote-debugging-port', '0')
// With a debugging port Chromium reports navigator.webdriver = true to every page; the browser panel should look like a normal browser.
hideAutomationFlag(app)

// ws://127.0.0.1:<port><path> of the app's own DevTools endpoint; never logged. Throws while the file is not there yet.
function devToolsUpstream(): string {
  const [port, path] = readFileSync(join(app.getPath('userData'), 'DevToolsActivePort'), 'utf8').split(/\r?\n/)
  if (!port || !path) throw new Error('DevTools port not ready')
  return `ws://127.0.0.1:${port.trim()}${path.trim()}`
}

// Test runs set OPERANT_BACKGROUND=1 so the window opens behind others without taking focus.
const background = process.env.OPERANT_BACKGROUND === '1'
const devUrl = process.env.VITE_DEV_URL

// The Operant plugin (its memory skill) ships next to the app: in the repo during dev, in resources/ when packaged.
const pluginDir = app.isPackaged ? join(process.resourcesPath, 'plugin') : join(app.getAppPath(), 'plugin')

// The `operant` wrappers that tiles run: resources/cli when packaged, cli/bin in the repo (the wrapper
// finds out/cli/operant.cjs from there).
const cliDir = app.isPackaged ? join(process.resourcesPath, 'cli') : join(app.getAppPath(), 'cli', 'bin')

// The window and taskbar icon: resources/icon.png when packaged, build/icon.png in the repo.
const iconFile = app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(app.getAppPath(), 'build', 'icon.png')

const appOrigin: AppOrigin = { devUrl, indexFile: join(__dirname, '../renderer/index.html') }

let win: BrowserWindow | null = null
let store: Store | null = null
let sessions: SessionManager | null = null
let operant: Operant | null = null
let quitting = false
// The OS is shutting down or logging off: the window closes without a question.
let ending = false
let turns: TurnWatch | null = null
let guard: CloseGuard | null = null
let cliServer: CliServer | null = null
let cliTarget: CliTarget | null = null
let browserHub: BrowserHub | null = null
let browserPanels: BrowserPanels | null = null
let browserPopout: BrowserPopout | null = null
let browserProxy: CdpProxy | null = null
let browserMcp: McpHost | null = null
let browserExtras: Extras | null = null
let browserMcpUrl: string | null = null
const browserOut = join(tmpdir(), `operant-browser-${process.pid}`)
let installing = (): boolean => false

// A notification was clicked: bring the window forward and show its Claude tile.
function openFromNotice(scratchId: number, crewId: number): void {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  push(win, 'notify:open', { scratchId, crewId })
}

// The browser panels, the hub, the CDP proxy and the MCP host. Panels and hub exist at once; the two servers listen
// a moment later, and tiles launched before that simply get no browser.
function startBrowser(core: Operant): void {
  const hub: BrowserHub = new BrowserHub({
    host: {
      ensureOpen: (id) => panels.ensureOpen(id),
      newTab: (id, url) => panels.newTab(id, url),
      closeTab: (id, tab) => panels.closeTab(id, tab),
      selectTab: (id, tab) => panels.selectTab(id, tab),
    },
    aiAllowed: () => core.currentSettings.browser.aiControl,
  })
  // The panel can move into its own window; its views are carried across by the panels, the window only hosts them.
  const popout = new BrowserPopout({
    getMainWindow: () => win,
    views: (id) => panels.shownViews(id),
    load: (w, id) => {
      if (devUrl) void w.loadURL(`${devUrl}?browserPopout=${String(id)}`)
      else void w.loadFile(appOrigin.indexFile, { query: { browserPopout: String(id) } })
    },
    title: () => 'Browser',
    webPreferences: windowWebPreferences(),
    icon: iconFile,
    background,
    isAppUrl: (u) => isAppUrl(u, appOrigin),
    onChange: (id) => {
      panels.hostChanged(id)
      hub.refresh(id)
    },
  })
  browserPopout = popout
  const panels: BrowserPanels = new BrowserPanels({
    getWindow: () => win,
    popout,
    dataDir: app.getPath('userData'),
    getHub: () => hub,
    homeUrl: () => core.currentSettings.browser.homeUrl,
    searchUrl: () => core.currentSettings.browser.searchUrl,
    crewOptions: (id) => core.currentSettings.browser.perCrew[String(id)] ?? DEFAULT_CREW_BROWSER,
  })
  browserHub = hub
  browserPanels = panels
  if (!cliServer || !cliTarget) return
  const target = cliTarget
  const proxy = new CdpProxy({ hub, host: panels, upstreamUrl: devToolsUpstream })
  const extras = createExtras({ hub, cdpEndpoint: (crewId) => proxy.endpointFor(crewId), autonomy: () => core.currentSettings.browser.autonomy,
    permissions: { grant: (id, origin, perms) => panels.prompts.grantPermissions(id, origin, perms), reset: (id) => panels.prompts.resetGrants(id) },
    compat: {
      get: (id) => {
        const o = core.currentSettings.browser.perCrew[String(id)] ?? DEFAULT_CREW_BROWSER
        return { relaxCors: o.relaxCors, ignoreCertErrors: o.ignoreCertErrors }
      },
      // The same settings write the Settings page uses, so it persists, shows in the toolbar warning and reapplies the sessions.
      set: async (id, patch) => {
        const { perCrew } = core.currentSettings.browser
        const cur = perCrew[String(id)] ?? DEFAULT_CREW_BROWSER
        await core.handlers['settings:set']({ browser: { perCrew: { ...perCrew, [String(id)]: sanitizeCrewBrowser({ ...cur, ...patch }) } } })
      },
    },
    downloads: { list: (id) => panels.prompts.listDownloads(id), read: (id, dlId, max) => panels.prompts.readDownload(id, dlId, max) },
  })
  browserExtras = extras
  const mcp = new McpHost({
    hub,
    auth: cliServer,
    crewOf: (tileId) => target.identify(tileId)?.crewId ?? null,
    aiAllowed: () => core.currentSettings.browser.aiControl,
    cdpEndpoint: (crewId) => proxy.endpointFor(crewId),
    outputDir: (crewId) => join(browserOut, String(crewId)),
    // Snapshots tell the overlay which element an AI ref points at; the text goes nowhere else.
    onResult: (crewId, _tool, text) => panels.learnRefs(crewId, text),
    extras: extras.tools,
    // 'full' lets the AI act freely; 'confirm' (default) asks first for risky calls, see core/browser/risk.ts.
    policy: (call) => (core.currentSettings.browser.autonomy === 'full' ? 'allow' : assessCall(call).risk),
    confirm: (call, signal) => hub.confirms.request({ crewId: call.crewId, tileId: call.tileId, tool: call.name, summary: confirmSummary(call) }, signal),
  })
  browserProxy = proxy
  browserMcp = mcp
  void proxy
    .start()
    .then(() => mcp.listen())
    .then((url) => {
      browserMcpUrl = url
    })
    .catch(() => {
      console.log('browser: could not start the AI browser endpoint')
    })
  // "Allow all" ends with the AI tile's session, when the user takes control, and when the settings change.
  cliServer.onRevoke((tileId) => hub.confirms.revokeTile(tileId))
  hub.onControl((crewId, paused) => {
    if (paused) hub.confirms.revokeCrew(crewId)
  })
  let lastAutonomy = core.currentSettings.browser.autonomy
  // Turning AI control off takes effect at once.
  core.on('settings', () => {
    const { aiControl, autonomy } = core.currentSettings.browser
    if (!aiControl || autonomy !== lastAutonomy) hub.confirms.revokeAll()
    lastAutonomy = autonomy
    panels.reapplySessions()
    if (!core.currentSettings.browser.aiControl) {
      mcp.closeAllSessions()
      proxy.dropClients()
    }
    for (const id of panels.crewIds()) hub.refresh(id)
  })
}

function windowWebPreferences(): Electron.WebPreferences {
  return { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    backgroundColor: windowBackground(operant?.currentSettings.appearance ?? DEFAULT_APPEARANCE, nativeTheme.shouldUseDarkColors),
    title: 'Operant 3',
    icon: iconFile,
    autoHideMenuBar: true,
    webPreferences: windowWebPreferences(),
  })

  win.once('ready-to-show', () => (background ? win?.showInactive() : win?.show()))

  // The window only ever shows the app: a dropped file or a link navigating it is refused.
  win.webContents.on('will-navigate', (e, url) => {
    if (!isAppUrl(url, appOrigin)) e.preventDefault()
  })
  win.webContents.on('will-frame-navigate', (e) => {
    if (!isAppUrl(e.url, appOrigin)) e.preventDefault()
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(appOrigin.indexFile)

  attachWindowSync(win, (cb) => {
    screen.on('display-metrics-changed', cb)
    screen.on('display-added', cb)
    screen.on('display-removed', cb)
  })

  // Windows is shutting down or logging off: the window closes without a question.
  win.on('query-session-end', () => {
    ending = true
  })

  if (operant && turns) {
    const core = operant
    const tw = turns
    guard = attachCloseGuard(win, { operant: core, turns: tw, skip: () => quitting || ending || installing() })
  }

  win.on('closed', () => {
    // The pop-out windows go with the app window.
    browserPopout?.closeAll()
    guard = null
    win = null
  })
}

app.whenReady().then(() => {
  store = new Store(join(app.getPath('userData'), 'operant.db'), undefined, join(app.getPath('userData'), 'backups'))
  const playground = store.ensurePlayground(join(app.getPath('userData'), 'Playground'))
  mkdirSync(playground.folder, { recursive: true })
  consoleLog.setScrubber(scrubLogLine)
  sessions = new SessionManager((file, args, opts) => spawnPty(file, args, { name: 'xterm-256color', ...opts }))
  const indexes = new CrewIndexes(
    app.isPackaged ? join(process.resourcesPath, 'codegraph', 'lib', 'dist', 'index.js') : undefined,
  )
  const core = new Operant({
    store,
    sessions,
    indexes,
    pluginDir,
    // The native Claude mods (plugin/mods/<id>), dev and packaged alike.
    modPluginsDir: join(pluginDir, 'mods'),
    backupDir: join(app.getPath('userData'), 'backups'),
    launch: {
      launchDir: join(app.getPath('userData'), 'launch'),
      rolesDir: join(app.getPath('userData'), 'roles'),
      cliDir,
      // The wrapper runs the CLI with the app binary as Node (ELECTRON_RUN_AS_NODE is set by the wrapper only).
      operantNode: process.execPath,
    },
    // Claude Code tiles get Operant's hooks and status line from this script (run as Node by the app binary).
    claudeMods: {
      node: process.execPath,
      script: app.isPackaged ? join(process.resourcesPath, 'claude-mods', 'op-event.mjs') : join(app.getAppPath(), 'scripts', 'op-event.mjs'),
      eventsDir: join(app.getPath('userData'), 'events'),
    },
    cliServer: (target) => {
      cliTarget = target
      cliServer = new CliServer({ target })
      return cliServer
    },
    // Claude tiles get the browser's MCP endpoint once it is listening (null until then, or when it failed).
    browserMcp: () => browserMcpUrl,
    onCrewDeleted: (crewId) => {
      browserMcp?.closeCrew(crewId)
      browserExtras?.dropCrew(crewId)
      browserHub?.confirms.cancelCrew(crewId)
      browserProxy?.dropCrew(crewId)
      void browserPanels?.destroyCrew(crewId)
    },
    // Where usage exports are saved and import files are picked.
    fileDialogs: {
      save: async (defaultPath, filter) => {
        const opts = { defaultPath, filters: [filter] }
        const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
        return res.canceled ? null : (res.filePath ?? null)
      },
      open: async (filter) => {
        const opts = { properties: ['openFile' as const], filters: [filter] }
        const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
        return res.canceled ? null : (res.filePaths[0] ?? null)
      },
    },
    // API keys: encrypted with the OS keychain (DPAPI on Windows), one file each, outside the database.
    secrets: new FileSecretStore(join(app.getPath('userData'), 'secrets'), {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plain) => safeStorage.encryptString(plain),
      decrypt: (blob) => safeStorage.decryptString(blob),
    }),
  })
  operant = core
  turns = watchClaudeTurns(core, {
    isWindowFocused: () => !!win && !win.isDestroyed() && win.isFocused(),
    open: openFromNotice,
  })
  core.seedFromEnv(process.env)
  void core.start()
  // First plan-limit and provider reading now; the core asks again when each is due.
  void core.providers.refresh().catch(() => undefined)
  startBrowser(core)
  const updater = createUpdater({ send: (s) => push(win, 'update', s), getSettings: () => core.currentSettings, beforeInstall: (v) => core.snapshotBeforeUpdate(v) })
  core.on('settings', () => updater.reschedule())
  installing = () => updater.status.state === 'installing'
  registerIpc(core, updater, () => win, appOrigin, {
    answerClose: (action) => guard?.answer(action),
    turnBusy: (scratchId) => turns?.busy(scratchId) ?? false,
    setVisible: (scratchId) => turns?.setVisible(scratchId),
    browser: { panels: browserPanels!, hub: browserHub!, popout: browserPopout! },
  })
  updater.start()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Revoke every token and close the CLI socket before the app exits.
app.on('before-quit', (e) => {
  if (quitting || !operant) return
  e.preventDefault()
  quitting = true
  operant
    .shutdown()
    .catch(() => {})
    .finally(() => app.quit())
})

app.on('will-quit', () => {
  browserPopout?.closeAll()
  browserExtras?.dispose()
  void browserMcp?.close().catch(() => undefined)
  void browserProxy?.close().catch(() => undefined)
  browserPanels?.dispose()
  browserHub?.dispose()
  try {
    rmSync(browserOut, { recursive: true, force: true })
  } catch {
    /* already gone */
  }
  // Exits arrive after the store is closed, so stop listening before killing the shells.
  sessions?.removeAllListeners()
  sessions?.stopAll()
  store?.close()
})
