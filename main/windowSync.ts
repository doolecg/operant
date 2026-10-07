import type { BrowserWindow } from 'electron'

export interface Size {
  width: number
  height: number
}

// The page fills the window when its layout viewport times the page zoom equals the window's content size.
// Anything clearly smaller is a view that did not follow a maximize or full-screen change.
export function viewportStale(content: Size, inner: Size, zoom: number, tolerance = 4): boolean {
  if (content.width <= 0 || content.height <= 0 || inner.width <= 0 || inner.height <= 0) return false
  const slack = tolerance * Math.max(1, zoom)
  return content.width - inner.width * zoom > slack || content.height - inner.height * zoom > slack
}

// Keeps the page the size of its window. After a maximize, restore or full-screen change (and a display change)
// it re-applies the zoom, repaints, and when the page still reports a smaller viewport than the window it re-enters
// the maximized or full-screen state, which makes Chromium allocate the view again.
export function attachWindowSync(win: BrowserWindow, onDisplayChange: (cb: () => void) => void): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let repairs = 0

  const inner = async (): Promise<Size | null> => {
    try {
      const v = (await win.webContents.executeJavaScript('[window.innerWidth, window.innerHeight]')) as [number, number]
      return { width: v[0], height: v[1] }
    } catch {
      return null
    }
  }

  const check = async (last: boolean): Promise<void> => {
    if (win.isDestroyed() || win.webContents.isLoading()) return
    const wc = win.webContents
    wc.setZoomFactor(wc.getZoomFactor())
    wc.invalidate()
    const size = await inner()
    const [width, height] = win.getContentSize()
    if (!size || !viewportStale({ width: width!, height: height! }, size, wc.getZoomFactor())) {
      repairs = 0
      return
    }
    if (!last || repairs >= 2) return
    // Still short after a moment more (not just a maximize animation in flight): repair.
    await new Promise((r) => setTimeout(r, 600))
    if (win.isDestroyed()) return
    const again = await inner()
    const [cw, ch] = win.getContentSize()
    if (!again || !viewportStale({ width: cw!, height: ch! }, again, wc.getZoomFactor())) return
    repairs++
    if (win.isFullScreen()) {
      win.setFullScreen(false)
      setTimeout(() => !win.isDestroyed() && win.setFullScreen(true), 150)
    } else if (win.isMaximized()) {
      win.unmaximize()
      setTimeout(() => !win.isDestroyed() && win.maximize(), 150)
    } else {
      const [w, h] = win.getContentSize()
      win.setContentSize(w! + 1, h!)
      setTimeout(() => !win.isDestroyed() && win.setContentSize(w!, h!), 50)
    }
  }

  const schedule = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      void check(false)
      timer = setTimeout(() => void check(true), 500)
    }, 120)
  }

  for (const ev of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'resized', 'restore', 'show'] as const) {
    win.on(ev as 'maximize', schedule)
  }
  onDisplayChange(schedule)
  win.on('closed', () => clearTimeout(timer))
}
