import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawn as spawnPty } from '@lydell/node-pty'
import { app, BrowserWindow, dialog, nativeTheme, safeStorage, screen, shell } from 'electron'
import { scrubLogLine } from '../core/agents'
import { CliServer } from '../core/cli-server'
import { CrewIndexes } from '../core/codegraph'
import { consoleLog } from '../core/console'
import type { GatewayFactory } from '../core/discord-gateway'
import { FileSecretStore } from '../core/discord-secrets'
import { Operant } from '../core/operant'
import { appDataDir } from '../core/paths'
import { SessionManager } from '../core/sessions'
import { Store } from '../core/store'
import { DEFAULT_APPEARANCE, windowBackground } from '../shared/themes'
import { loadEnv } from './env'
import { isAppUrl, type AppOrigin } from './guard'
import { push, registerIpc } from './ipc'
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

// The operator plugin ships next to the app: in the repo during dev, in resources/ when packaged.
const pluginDir = app.isPackaged ? join(process.resourcesPath, 'plugin') : join(app.getAppPath(), 'plugin')

// The `operant` wrappers that operators run: resources/cli when packaged, cli/bin in the repo (the wrapper
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

  win.on('closed', () => (win = null))
}

app.whenReady().then(() => {
  store = new Store(join(app.getPath('userData'), 'operant.db'))
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
    launch: {
      launchDir: join(app.getPath('userData'), 'launch'),
      rolesDir: join(app.getPath('userData'), 'roles'),
      cliDir,
      // The wrapper runs the CLI with the app binary as Node (ELECTRON_RUN_AS_NODE is set by the wrapper only).
      operantNode: process.execPath,
    },
    cliServer: (collab) => new CliServer({ collab }),
    // A bot added without a token re-checks .env once, through the same loader.
    reloadEnv: () => {
      loadEnv({ dir: envDir, log: (line) => console.log(line) })
      return process.env
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
    // Bot tokens: encrypted with the OS keychain (DPAPI on Windows), one file each, outside the database.
    discord: {
      secrets: new FileSecretStore(join(app.getPath('userData'), 'secrets'), {
        isAvailable: () => safeStorage.isEncryptionAvailable(),
        encrypt: (plain) => safeStorage.encryptString(plain),
        decrypt: (blob) => safeStorage.decryptString(blob),
      }),
      // The e2e runs swap in a fake gateway so no test touches the network (unpackaged runs only).
      ...(process.env.OPERANT_E2E_DISCORD_GATEWAY && !app.isPackaged
        ? { gateway: require(process.env.OPERANT_E2E_DISCORD_GATEWAY).createGateway as GatewayFactory }
        : {}),
    },
  })
  operant = core
  core.seedFromEnv(process.env)
  core.resetStaleOperators()
  void core.start()
  // First plan-limit and provider reading now; the core asks again when each is due.
  void core.providers.refresh().catch(() => undefined)
  const updater = createUpdater({ send: (s) => push(win, 'update', s), getSettings: () => core.currentSettings })
  core.on('settings', () => updater.reschedule())
  registerIpc(core, updater, () => win, appOrigin)
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
