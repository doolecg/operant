import { app, clipboard, dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { consoleLog, isConsoleSource } from '../core/console'
import { stopOwnProcess } from '../core/proc'
import { ipcErrorOf, type Operant } from '../core/operant'
import { CORE_CHANNELS, encodeIpcError, type IpcApi, type IpcEventName, type IpcEvents, type MainChannel } from '../shared/ipc'
import type { BrowserHub } from '../core/browser/hub'
import type { BrowserPanels } from './browser'
import type { BrowserPopout } from './browser-popout'
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
  hooks: { answerClose: (action: 'shown' | 'quit' | 'stay') => void; turnBusy: (scratchId: number) => boolean; setVisible: (scratchId: number | null) => void; browser: { panels: BrowserPanels; hub: BrowserHub; popout: BrowserPopout } },
): void {
  // Only the main window showing the app may call; anything else (a dropped file, a navigated page) is refused.
  // The browser pop-out windows show the same app, so they may call too.
  const { panels, hub, popout } = hooks.browser
  const trusted = (e: IpcMainInvokeEvent) =>
    isTrustedSender(e, getWindow()?.webContents.id, origin) || popout.webContentsIds().some((id) => isTrustedSender(e, id, origin))
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
    'browser:state': (crewId) => panels.state(crewId),
    'browser:open': (crewId, url) => panels.open(crewId, url),
    'browser:close': (crewId) => panels.close(crewId),
    // Applied only from the window that hosts the views (see below); the entry keeps the contract complete.
    'browser:layout': (crewId, rect) => panels.layout(crewId, rect),
    'browser:navigate': (crewId, tabId, input) => panels.navigate(crewId, tabId, input),
    'browser:nav': (crewId, tabId, action) => panels.nav(crewId, tabId, action),
    'browser:tabNew': (crewId, url) => panels.tabNew(crewId, url),
    'browser:tabClose': (crewId, tabId) => panels.closeTab(crewId, tabId),
    'browser:tabSelect': (crewId, tabId) => panels.selectTab(crewId, tabId),
    'browser:control': (crewId, who) => hub.setControl(crewId, who === 'ai' ? 'ai' : 'user'),
    'browser:clearData': (crewId) => panels.clearData(crewId),
    'browser:tabMove': (crewId, tabId, to) => panels.tabMove(crewId, tabId, to),
    'browser:tabDuplicate': (crewId, tabId) => panels.tabDuplicate(crewId, tabId),
    'browser:history': (crewId) => panels.history(crewId),
    'browser:devtools': (crewId, tabId, mode) => panels.devtools(crewId, tabId, mode),
    'browser:zoom': (crewId, tabId, action) => panels.zoom(crewId, tabId, action),
    'browser:find': (crewId, tabId, text, forward, next) => panels.find(crewId, tabId, String(text), forward !== false, next === true),
    'browser:findStop': (crewId, tabId) => panels.findStop(crewId, tabId),
    'browser:viewSource': (crewId, tabId) => panels.viewSource(crewId, tabId),
    'browser:print': (crewId, tabId) => panels.print(crewId, tabId),
    'browser:savePdf': (crewId, tabId) => panels.savePdf(crewId, tabId),
    'browser:capture': (crewId, tabId, opts) => panels.capture(crewId, tabId, opts),
    'browser:actions': (crewId) => hub.actions(crewId),
    'browser:confirms': (crewId) => hub.confirms.pending(crewId),
    'browser:confirmAnswer': (id, allow, all) => hub.confirms.answer(String(id), allow === true, all === true),
    'browser:allowAll': (crewId) => hub.confirms.allowAllActive(crewId),
    'browser:allowAllStop': (crewId) => hub.confirms.revokeCrew(crewId),
    'browser:promptsState': (crewId) => panels.prompts.state(crewId),
    'browser:promptAnswer': (id, answer) => panels.prompts.answer(String(id), answer),
    'browser:downloadCancel': (id) => panels.prompts.cancelDownload(String(id)),
    'browser:downloadOpen': (id) => panels.prompts.openDownload(String(id)),
    'browser:downloadShow': (id) => panels.prompts.showDownloadInFolder(String(id)),
    'browser:inspectLogs': (crewId, tabId) => panels.inspect.logs(crewId, tabId),
    'browser:inspectClear': (crewId, tabId, which) => panels.inspect.clearLogs(crewId, tabId, which === 'console' || which === 'net' ? which : 'both'),
    'browser:emulationGet': (crewId, tabId) => panels.inspect.emulation(crewId, tabId),
    'browser:emulationSet': (crewId, tabId, e) => panels.inspect.setEmulation(crewId, tabId, e),
    'browser:cookies': (crewId, url) => panels.inspect.cookies(crewId, typeof url === 'string' && url ? url : undefined),
    'browser:cookieSet': (crewId, draft, replacing) => panels.inspect.setCookie(crewId, draft, replacing),
    'browser:cookieRemove': (crewId, key) => panels.inspect.removeCookie(crewId, key),
    'browser:clearSite': (crewId, origin) => panels.inspect.clearSite(crewId, String(origin)),
    'browser:clearAll': (crewId) => panels.inspect.clearAll(crewId),
    'browser:bookmarks': (crewId) => panels.inspect.bookmarks(crewId),
    'browser:bookmarkAdd': (crewId, url, title) => panels.inspect.addBookmark(crewId, String(url), String(title ?? '')),
    'browser:bookmarkEdit': (crewId, id, patch) => panels.inspect.editBookmark(crewId, String(id), patch ?? {}),
    'browser:bookmarkRemove': (crewId, id) => panels.inspect.removeBookmark(crewId, String(id)),
    'browser:historyClear': (crewId) => hub.clearHistory(crewId),
    'browser:popOut': (crewId) => panels.popOut(crewId),
    'browser:popIn': (crewId) => panels.popIn(crewId),
  }
  for (const [channel, handler] of Object.entries(mainHandlers)) {
    ipcMain.handle(channel, (e, ...args: unknown[]) => {
      if (!trusted(e)) throw refuse()
      // Both windows of a popped-out panel run the same tile and send their own rect (or null while hidden); only
      // the window that holds the views may move them, or the other one's null would blank the page.
      if (channel === 'browser:layout' && e.sender.id !== panels.hostContentsId(Number(args[0]))) return
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
  // The browser panel's events reach the main window and any pop-out window.
  const pushBrowser = <E extends IpcEventName>(name: E, payload: IpcEvents[E]) => {
    push(getWindow(), name, payload)
    for (const w of popout.windows()) push(w, name, payload)
  }
  hub.on('browser:state', (s) => pushBrowser('browser:state', { ...s, poppedOut: popout.isOut(s.crewId) }))
  hub.onHistory((crewId, entries) => pushBrowser('browser:history', { crewId, entries }))
  hub.onFound((f) => pushBrowser('browser:found', f))
  hub.onActions((crewId, actions) => pushBrowser('browser:actions', { crewId, actions }))
  hub.confirms.onRequest((c) => pushBrowser('browser:confirm', c))
  hub.confirms.onEnd((e) => pushBrowser('browser:confirmEnd', e))
  hub.confirms.onGrants((crewId, active) => pushBrowser('browser:allowAllChanged', { crewId, active }))
  panels.prompts.onChange((s) => pushBrowser('browser:prompts', s))
  panels.inspect.onLogs((crewId, tabId) => pushBrowser('browser:inspectLogs', { crewId, tabId }))
  panels.inspect.onBookmarks((crewId, entries) => pushBrowser('browser:bookmarks', { crewId, entries }))
  consoleLog.onLine((line) => push(getWindow(), 'console:line', line))
}

export function push<E extends IpcEventName>(win: BrowserWindow | null, name: E, payload: IpcEvents[E]): void {
  if (win && !win.isDestroyed()) win.webContents.send(`push:${name}`, payload)
}
