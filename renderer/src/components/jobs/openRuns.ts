// Any view can ask for a job's task modal; the request is kept until a modal host is mounted.
const OPEN_EVENT = 'operant:open-run'
let pendingRun: number | null = null

export function requestOpenRun(runId: number) {
  pendingRun = runId
  window.dispatchEvent(new CustomEvent<number>(OPEN_EVENT, { detail: runId }))
}

export function takeOpenRunRequest(): number | null {
  const r = pendingRun
  pendingRun = null
  return r
}

export function onOpenRunRequest(listener: (runId: number) => void): () => void {
  const handler = (e: Event) => {
    pendingRun = null
    listener((e as CustomEvent<number>).detail)
  }
  window.addEventListener(OPEN_EVENT, handler)
  return () => window.removeEventListener(OPEN_EVENT, handler)
}
