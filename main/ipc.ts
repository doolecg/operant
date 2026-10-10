import { app, clipboard, dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { consoleLog, isConsoleSource } from '../core/console'
import { stopOwnProcess } from '../core/proc'
import { ipcErrorOf, type Operant } from '../core/operant'
import { CORE_CHANNELS, encodeIpcError, type IpcApi, type IpcEventName, type IpcEvents, type MainChannel } from '../shared/ipc'
import { isTrustedSender, type AppOrigin } from './guard'
import { createMedia } from './media'
import { isRunnable, resolveAllowedPath } from './openpath'
import type { createUpdater } from './updater'

type MainHandlers = { [C in MainChannel]: (...a: Parameters<IpcApi[C]>) => ReturnType<IpcApi[C]> | Promise<ReturnType<IpcApi[C]>> }

export function registerIpc(
  operant: Operant,
  updater: ReturnType<typeof createUpdater>,
  getWindow: () => BrowserWindow | null,
  origin: AppOrigin,
  hooks: { answerClose: (action: 'shown' | 'quit' | 'stay') => void; turnBusy: (scratchId: number) => boolean; setVisible: (scratchId: number | null) => void },
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

  const media = createMedia(operant)
  const mainHandlers: MainHandlers = {
    'app:pickFolder': async () => {
      const win = getWindow()
      const opts = { properties: ['openDirectory' as const, 'createDirectory' as const] }
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      return res.canceled ? null : (res.filePaths[0] ?? null)
    },
    'shell:openFolder': async (crewId) => {
      const crew = (await operant.handlers['crews:list']()).find((c) => c.id === crewId)
      if (!crew) throw new Error(encodeIpcError('NOT_FOUND', `Project ${String(crewId)} not found`))
      const failure = await shell.openPath(crew.folder)
      if (failure) throw new Error(encodeIpcError('BAD_ARGS', failure))
    },
    'shell:openPath': async (crewId, path) => {
      const crew = (await operant.handlers['crews:list']()).find((c) => c.id === crewId)
      if (!crew) throw new Error(encodeIpcError('NOT_FOUND', `Project ${String(crewId)} not found`))
      const target = typeof path === 'string' ? resolveAllowedPath(crew.folder, path) : null
      if (!target) throw new Error(encodeIpcError('FORBIDDEN', 'That path is outside the project folder, or missing'))
      if (isRunnable(target)) return shell.showItemInFolder(target)
      const failure = await shell.openPath(target)
      if (failure) throw new Error(encodeIpcError('BAD_ARGS', failure))
    },
    'clipboard:hasImage': async () => {
      try {
        for (const item of await clipboard.read()) {
          if (!item.types.includes('image/png')) continue
          if ((await item.getType('image/png')).size > 0) return true
        }
      } catch {
        /* nothing readable */
      }
      return false
    },
    'app:info': () => ({ version: app.getVersion(), platform: process.platform }),
    'app:openExternal': (url) => {
      if (/^(https?:\/\/|mailto:)/i.test(url)) void shell.openExternal(url)
    },
    'update:status': () => updater.status,
    'update:check': async () => {
      await updater.check()
      return updater.status
    },
    'update:install': () => updater.installNow(),
    'console:list': (source) => consoleLog.list({ source: isConsoleSource(source) ? source : undefined }),
    'console:clear': (source) => consoleLog.clear(isConsoleSource(source) ? source : undefined),
    'console:processes': () => consoleLog.processes(),
    'console:stop': (pid) => Number.isInteger(pid) && stopOwnProcess(pid),
    'media:state': () => media.state,
    'media:command': (cmd) => media.command(cmd),
    'app:closeReply': (action) => hooks.answerClose(action),
    'turn:busy': (scratchId) => hooks.turnBusy(scratchId),
    'notify:visible': (scratchId) => hooks.setVisible(Number.isInteger(scratchId) ? scratchId : null),
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
  forward('scratch:data')
  forward('scratch:exit')
  forward('chat:ops')
  forward('index:status')
  forward('budget')
  forward('settings')
  forward('claudeMods:state')
  media.on('media:state', (s) => push(getWindow(), 'media:state', s))
  media.on('media:timeline', (t) => push(getWindow(), 'media:timeline', t))
  media.on('media:art', (a) => push(getWindow(), 'media:art', a))
  consoleLog.onLine((line) => push(getWindow(), 'console:line', line))
}

export function push<E extends IpcEventName>(win: BrowserWindow | null, name: E, payload: IpcEvents[E]): void {
  if (win && !win.isDestroyed()) win.webContents.send(`push:${name}`, payload)
}
