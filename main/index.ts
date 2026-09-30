import { join } from 'node:path'
import { spawn as spawnPty } from '@lydell/node-pty'
import { app, BrowserWindow, shell } from 'electron'
import { CrewIndexes } from '../core/codegraph'
import { Operant } from '../core/operant'
import { appDataDir } from '../core/paths'
import { SessionManager } from '../core/sessions'
import { Store } from '../core/store'
import { push, registerIpc } from './ipc'
import { createUpdater } from './updater'

// Keep data apart from Operant 1, which owns the plain "Operant" folder.
app.setPath('userData', appDataDir())

// Test runs set OPERANT_BACKGROUND=1 so the window opens behind others without taking focus.
const background = process.env.OPERANT_BACKGROUND === '1'
const devUrl = process.env.VITE_DEV_URL

// The operator plugin ships next to the app: in the repo during dev, in resources/ when packaged.
const pluginDir = app.isPackaged ? join(process.resourcesPath, 'plugin') : join(app.getAppPath(), 'plugin')

// Transcripts are polled rather than watched: fs.watch is unreliable across platforms for appends.
const USAGE_POLL_MS = 2_000

let win: BrowserWindow | null = null
let store: Store | null = null
let sessions: SessionManager | null = null

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0a0a0b',
    title: 'Operant',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.once('ready-to-show', () => (background ? win?.showInactive() : win?.show()))

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))

  win.on('closed', () => (win = null))
}

app.whenReady().then(() => {
  store = new Store(join(app.getPath('userData'), 'operant.db'))
  sessions = new SessionManager((file, args, opts) => spawnPty(file, args, { name: 'xterm-256color', ...opts }))
  const indexes = new CrewIndexes(
    app.isPackaged ? join(process.resourcesPath, 'codegraph', 'lib', 'dist', 'index.js') : undefined,
  )
  const operant = new Operant({ store, sessions, indexes, pluginDir })
  operant.resetStaleOperators()
  setInterval(() => operant.pollUsage(), USAGE_POLL_MS)
  const updater = createUpdater({ send: (s) => push(win, 'update', s), getSettings: () => operant.currentSettings })
  operant.on('settings', () => updater.reschedule())
  registerIpc(operant, updater, () => win)
  updater.start()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  // Exits arrive after the store is closed, so stop listening before killing the shells.
  sessions?.removeAllListeners()
  sessions?.stopAll()
  store?.close()
})
