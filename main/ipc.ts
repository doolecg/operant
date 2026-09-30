import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import type { Operant } from '../core/operant'
import { CORE_CHANNELS, type IpcApi, type IpcEventName, type IpcEvents, type MainChannel } from '../shared/ipc'
import type { createUpdater } from './updater'

type MainHandlers = { [C in MainChannel]: (...a: Parameters<IpcApi[C]>) => ReturnType<IpcApi[C]> | Promise<ReturnType<IpcApi[C]>> }

export function registerIpc(
  operant: Operant,
  updater: ReturnType<typeof createUpdater>,
  getWindow: () => BrowserWindow | null,
): void {
  for (const channel of CORE_CHANNELS) {
    const handler = operant.handlers[channel] as (...a: unknown[]) => unknown
    ipcMain.handle(channel, (_e, ...args: unknown[]) => handler(...args))
  }

  const mainHandlers: MainHandlers = {
    'app:pickFolder': async () => {
      const win = getWindow()
      const opts = { properties: ['openDirectory' as const, 'createDirectory' as const] }
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      return res.canceled ? null : (res.filePaths[0] ?? null)
    },
    'app:info': () => ({ version: app.getVersion(), platform: process.platform }),
    'app:openExternal': (url) => {
      if (/^https:\/\//.test(url)) void shell.openExternal(url)
    },
    'update:status': () => updater.status,
    'update:check': async () => {
      await updater.check()
      return updater.status
    },
    'update:install': () => updater.installNow(),
  }
  for (const [channel, handler] of Object.entries(mainHandlers)) {
    ipcMain.handle(channel, (_e, ...args: unknown[]) => (handler as (...a: unknown[]) => unknown)(...args))
  }

  const forward = <E extends IpcEventName>(name: E) =>
    operant.on(name as Exclude<E, 'update'>, ((payload: IpcEvents[E]) => push(getWindow(), name, payload)) as never)
  forward('event')
  forward('operator:data')
  forward('operator:status')
  forward('index:status')
  forward('usage')
  forward('settings')
}

export function push<E extends IpcEventName>(win: BrowserWindow | null, name: E, payload: IpcEvents[E]): void {
  if (win && !win.isDestroyed()) win.webContents.send(`push:${name}`, payload)
}
