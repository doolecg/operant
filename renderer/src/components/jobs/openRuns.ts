// The status pill's "needs you" chip asks the workspace to show its Runs tab filtered to the jobs that need the owner.
// The request is kept until a workspace is mounted, since the chip can be clicked while another page is open.
const EVENT = 'operant:open-runs-needing-you'
let pending = false

export function requestNeedsYouRuns() {
  pending = true
  window.dispatchEvent(new Event(EVENT))
}

export function takeNeedsYouRequest(): boolean {
  const p = pending
  pending = false
  return p
}

export function onNeedsYouRequest(listener: () => void): () => void {
  window.addEventListener(EVENT, listener)
  return () => window.removeEventListener(EVENT, listener)
}
