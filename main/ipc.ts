import { app, dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { ipcErrorOf, type Operant } from '../core/operant'
import { CORE_CHANNELS, encodeIpcError, type IpcApi, type IpcEventName, type IpcEvents, type MainChannel } from '../shared/ipc'
import { isTrustedSender, type AppOrigin } from './guard'
import type { createUpdater } from './updater'

type MainHandlers = { [C in MainChannel]: (...a: Parameters<IpcApi[C]>) => ReturnType<IpcApi[C]> | Promise<ReturnType<IpcApi[C]>> }

export function registerIpc(
  operant: Operant,
  updater: ReturnType<typeof createUpdater>,
  getWindow: () => BrowserWindow | null,
  origin: AppOrigin,
): void {
  // Only the main window showing the app may call; anything else (a dropped file, a navigated page) is refused.
  const trusted = (e: IpcMainInvokeEvent) => isTrustedSender(e, getWindow()?.webContents.id, origin)
  const refuse = () => new Error(encodeIpcError('FORBIDDEN', 'Not allowed from this page'))
  for (const channel of CORE_CHANNELS) {
    const handler = operant.handlers[channel] as (...a: unknown[]) => unknown
    // Electron passes only an error's message to the renderer, so the code travels inside it.
    ipcMain.handle(channel, async (e, ...args: unknown[]) => {
      if (!trusted(e)) throw refuse()
      try {
        return await handler(...args)
      } catch (err) {
        const { code, message } = ipcErrorOf(err)
        throw new Error(encodeIpcError(code, message))
      }
    })
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
    ipcMain.handle(channel, (e, ...args: unknown[]) => {
      if (!trusted(e)) throw refuse()
      return (handler as (...a: unknown[]) => unknown)(...args)
    })
  }

  const forward = <E extends IpcEventName>(name: E) =>
    operant.on(name as Exclude<E, 'update'>, ((payload: IpcEvents[E]) => push(getWindow(), name, payload)) as never)
  forward('event')
  forward('operator:data')
  forward('operator:status')
  forward('operator:config')
  forward('scratch:data')
  forward('scratch:exit')
  forward('index:status')
  forward('usage')
  forward('caps')
  forward('message')
  forward('unread')
  forward('job')
  forward('purge')
  forward('settings')
}

export function push<E extends IpcEventName>(win: BrowserWindow | null, name: E, payload: IpcEvents[E]): void {
  if (win && !win.isDestroyed()) win.webContents.send(`push:${name}`, payload)
}
