import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawn as spawnPty } from '@lydell/node-pty'
import { app, BrowserWindow, dialog, nativeTheme, safeStorage, screen, shell } from 'electron'
import { scrubLogLine } from '../core/agents'
import { CliServer } from '../core/cli-server'
import { CrewIndexes } from '../core/codegraph'
import { consoleLog } from '../core/console'
import { FileSecretStore } from '../core/secrets'
import { Operant } from '../core/operant'
import { appDataDir } from '../core/paths'
import { SessionManager } from '../core/sessions'
import { Store } from '../core/store'
import { DEFAULT_APPEARANCE, windowBackground } from '../shared/themes'
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
let installing = (): boolean => false

// A notification was clicked: bring the window forward and show its Claude tile.
function openFromNotice(scratchId: number, crewId: number): void {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  push(win, 'notify:open', { scratchId, crewId })
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
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
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
    cliServer: (target) => new CliServer({ target }),
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
  const updater = createUpdater({ send: (s) => push(win, 'update', s), getSettings: () => core.currentSettings, beforeInstall: (v) => core.snapshotBeforeUpdate(v) })
  core.on('settings', () => updater.reschedule())
  installing = () => updater.status.state === 'installing'
  registerIpc(core, updater, () => win, appOrigin, {
    answerClose: (action) => guard?.answer(action),
    turnBusy: (scratchId) => turns?.busy(scratchId) ?? false,
    setVisible: (scratchId) => turns?.setVisible(scratchId),
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
  // Exits arrive after the store is closed, so stop listening before killing the shells.
  sessions?.removeAllListeners()
  sessions?.stopAll()
  store?.close()
})
