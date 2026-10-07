// The header's limit badge asks the workspace to show its Usage tab. The request is kept until a workspace is
// mounted, since the badge can be clicked while another page is open.
const EVENT = 'operant:open-usage'
let pending = false

export function requestUsageTab() {
  pending = true
  window.dispatchEvent(new Event(EVENT))
}

export function takeUsageRequest(): boolean {
  const p = pending
  pending = false
  return p
}

export function onUsageRequest(listener: () => void): () => void {
  window.addEventListener(EVENT, listener)
  return () => window.removeEventListener(EVENT, listener)
}
