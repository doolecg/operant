import { BrowserWindow, type WebContentsView } from 'electron'

export interface BrowserPopoutOptions {
  getMainWindow: () => BrowserWindow | null
  // The crew's views that are shown right now (the active tab's), so they can be moved across.
  views: (crewId: number) => readonly WebContentsView[]
  // Loads the app's renderer in the new window with ?browserPopout=<crewId> (see the wiring notes).
  load: (win: BrowserWindow, crewId: number) => void
  title: (crewId: number) => string
  // Same webPreferences as the main window (preload, sandbox, context isolation).
  webPreferences: Electron.WebPreferences
  icon?: string
  // OPERANT_BACKGROUND=1: windows show without taking focus.
  background: boolean
  // The app window's navigation guard, so the pop-out only ever shows the app.
  isAppUrl: (url: string) => boolean
  // The browser moved to or from its own window: reset the panel's rect and push state.
  onChange: (crewId: number, out: boolean) => void
}

// One pop-out window per project. The crew's native views are moved into it and, on pop-in or close, back. Which
// window a panel's views belong to is answered by windowFor(crewId); BrowserPanels uses it instead of the main window.
export class BrowserPopout {
  private readonly wins = new Map<number, BrowserWindow>()

  constructor(private readonly o: BrowserPopoutOptions) {}

  isOut(crewId: number): boolean {
    return this.wins.has(crewId)
  }

  // The window that hosts the crew's views, or null while they are in the main window.
  windowFor(crewId: number): BrowserWindow | null {
    const w = this.wins.get(crewId)
    return w && !w.isDestroyed() ? w : null
  }

  // webContents ids of the pop-outs: ipc.ts must trust these senders and push events to them as well.
  webContentsIds(): number[] {
    return [...this.wins.values()].filter((w) => !w.isDestroyed()).map((w) => w.webContents.id)
  }

  windows(): BrowserWindow[] {
    return [...this.wins.values()].filter((w) => !w.isDestroyed())
  }

  open(crewId: number): void {
    const existing = this.windowFor(crewId)
    if (existing) {
      if (!this.o.background) existing.focus()
      return
    }
    const main = this.o.getMainWindow()
    const win = new BrowserWindow({
      width: 1100,
      height: 760,
      minWidth: 480,
      minHeight: 360,
      show: false,
      title: this.o.title(crewId),
      icon: this.o.icon,
      autoHideMenuBar: true,
      backgroundColor: main && !main.isDestroyed() ? main.getBackgroundColor() : undefined,
      webPreferences: this.o.webPreferences,
    })
    this.wins.set(crewId, win)

    win.once('ready-to-show', () => (this.o.background ? win.showInactive() : win.show()))
    win.webContents.on('will-navigate', (e, url) => {
      if (!this.o.isAppUrl(url)) e.preventDefault()
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    // Closing the window is popping in: the views leave it first, so they are not torn down with it.
    win.on('close', () => this.moveViews(crewId, win, null))
    win.on('closed', () => {
      this.wins.delete(crewId)
      this.o.onChange(crewId, false)
    })

    this.moveViews(crewId, main, win)
    this.o.load(win, crewId)
    this.o.onChange(crewId, true)
  }

  // Pop back in.
  close(crewId: number): void {
    this.windowFor(crewId)?.close()
  }

  // The main window closed (or the app is quitting).
  closeAll(): void {
    for (const w of this.windows()) w.close()
  }

  // Bounds are kept; the renderer in the new window sends its own rect right after it mounts.
  private moveViews(crewId: number, from: BrowserWindow | null, to: BrowserWindow | null): void {
    for (const view of this.o.views(crewId)) {
      try {
        if (from && !from.isDestroyed()) from.contentView.removeChildView(view)
      } catch {
        /* not attached there */
      }
      if (to && !to.isDestroyed() && to !== from) to.contentView.addChildView(view)
    }
  }
}
