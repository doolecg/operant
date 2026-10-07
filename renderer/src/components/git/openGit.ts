// The branch chip (and the project menu's "Show changes") asks the workspace to show its Git tab. The request is kept
// until a workspace is mounted, since the chip can be clicked while another page is open.
const EVENT = 'operant:open-git'
let pending = false

export function requestGitTab() {
  pending = true
  window.dispatchEvent(new Event(EVENT))
}

export function takeGitRequest(): boolean {
  const p = pending
  pending = false
  return p
}

export function onGitRequest(listener: () => void): () => void {
  window.addEventListener(EVENT, listener)
  return () => window.removeEventListener(EVENT, listener)
}
