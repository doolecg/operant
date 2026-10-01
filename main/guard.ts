import { pathToFileURL } from 'node:url'

// What loads in the app window: the dev server, or the packaged renderer file. Anything else is refused.
export interface AppOrigin {
  devUrl?: string
  indexFile: string
}

const without = (url: URL): string => `${url.protocol}//${url.host}${url.pathname}`

export function isAppUrl(url: string | undefined | null, origin: AppOrigin): boolean {
  if (!url) return false
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return false
  }
  if (origin.devUrl) {
    try {
      return target.origin === new URL(origin.devUrl).origin
    } catch {
      return false
    }
  }
  return target.protocol === 'file:' && without(target) === without(pathToFileURL(origin.indexFile))
}

interface SenderEvent {
  sender: { id: number }
  senderFrame?: { url: string } | null
}

// True only for a call made by the top page of the main window, showing the app.
export function isTrustedSender(e: SenderEvent, windowContentsId: number | null | undefined, origin: AppOrigin): boolean {
  return windowContentsId != null && e.sender.id === windowContentsId && isAppUrl(e.senderFrame?.url, origin)
}
