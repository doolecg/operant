// Runs an AI-written Playwright script in a worker thread, connected to the project's browser through the filtering CDP
// proxy. A worker (not the main thread) so an endless loop, a crash or an out-of-memory script can only lose the
// worker: it is terminated at the timeout and the app and the browser carry on. NEVER log the endpoint (it holds
// the proxy secret); results are scrubbed of it before they go anywhere.
import { Worker } from 'node:worker_threads'

export interface ScriptRequest {
  // ws://127.0.0.1:<port>/cdp/<crew>/<secret>, in-process only.
  endpoint: string
  // Absolute path of the playwright-core module the worker loads.
  playwrightPath: string
  code: string
  // The URL of the tab the script's `page` should be (the user's active tab); null = the last tab.
  pageUrl: string | null
  timeoutMs: number
}

export interface ScriptResult {
  ok: boolean
  // JSON (or an inspected string) of what the script returned.
  value?: string
  output: string[]
  error?: string
  timedOut?: boolean
}

export const SCRIPT_DEFAULT_TIMEOUT_MS = 30_000
export const SCRIPT_MAX_TIMEOUT_MS = 120_000
export const SCRIPT_MAX_OUTPUT = 16_000
const STEP_TIMEOUT_MS = 15_000

// Removes the proxy URL, its secret and any long hex token from text that goes to the AI.
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text
  for (const s of secrets) if (s) out = out.split(s).join('[endpoint]')
  return out
    .replace(/wss?:\/\/127\.0\.0\.1:\d+\S*/g, '[endpoint]')
    .replace(/\/cdp\/\d+\/[0-9a-f]{16,}/gi, '/cdp/[redacted]')
    .replace(/\b[0-9a-f]{40,}\b/gi, '[redacted]')
}

export function clampTimeout(ms: unknown): number {
  const n = typeof ms === 'number' && Number.isFinite(ms) ? ms : SCRIPT_DEFAULT_TIMEOUT_MS
  return Math.max(1000, Math.min(Math.round(n), SCRIPT_MAX_TIMEOUT_MS))
}

export function formatScriptResult(r: ScriptResult): string {
  const parts: string[] = []
  if (r.error) parts.push(`Error: ${r.error}`)
  else parts.push(`Result: ${r.value ?? 'null'}`)
  if (r.output.length > 0) parts.push(`Console output:\n${r.output.join('\n')}`)
  return parts.join('\n')
}

// The worker's program (CommonJS). The script is either a function expression, called with (page, context, browser),
// or the body of an async function with page, context, browser, console and sleep in scope.
export const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads')
const util = require('node:util')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const MAX = workerData.maxOutput
const out = []
let size = 0
const fmt = (v) => (typeof v === 'string' ? v : util.inspect(v, { depth: 3, breakLength: 120 }))
const line = (level, args) => {
  if (size >= MAX) return
  let t = args.map(fmt).join(' ')
  if (level !== 'log') t = level + ': ' + t
  if (size + t.length > MAX) t = t.slice(0, MAX - size) + '...'
  size += t.length
  out.push(t)
}
const cons = {}
for (const l of ['log', 'info', 'warn', 'error', 'debug']) cons[l] = (...a) => line(l, a)
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.min(Math.max(Number(ms) || 0, 0), 60000)))
const toText = (v) => {
  if (v === undefined) return 'null'
  let t
  try { t = JSON.stringify(v, null, 2) } catch { t = undefined }
  if (t === undefined) t = fmt(v)
  return t.length > MAX ? t.slice(0, MAX) + '...' : t
}
;(async () => {
  try {
    const { chromium } = require(workerData.playwright)
    const browser = await chromium.connectOverCDP(workerData.endpoint, { timeout: workerData.stepTimeout })
    const context = browser.contexts()[0]
    if (!context) throw new Error('The browser has no open page.')
    const pages = context.pages()
    const page = pages.find((p) => p.url() === workerData.pageUrl) || pages[pages.length - 1]
    if (!page) throw new Error('There is no open tab.')
    page.setDefaultTimeout(workerData.stepTimeout)
    context.setDefaultTimeout(workerData.stepTimeout)
    let value
    let asExpr = null
    try { asExpr = new AsyncFunction('page', 'context', 'browser', 'console', 'sleep', 'return (' + workerData.code + '\n)') } catch { asExpr = null }
    if (asExpr) {
      value = await asExpr(page, context, browser, cons, sleep)
      if (typeof value === 'function') value = await value(page, context, browser)
    } else {
      const body = new AsyncFunction('page', 'context', 'browser', 'console', 'sleep', workerData.code)
      value = await body(page, context, browser, cons, sleep)
    }
    parentPort.postMessage({ ok: true, value: toText(value), output: out })
  } catch (e) {
    parentPort.postMessage({ ok: false, error: String((e && e.message) || e).split('\n').slice(0, 12).join('\n'), output: out })
  }
})()
`

export function runScriptInWorker(req: ScriptRequest, signal?: AbortSignal): Promise<ScriptResult> {
  return new Promise<ScriptResult>((resolve) => {
    let settled = false
    let worker: Worker | null = null
    const secrets = [req.endpoint]
    const finish = (r: ScriptResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      void worker?.terminate()
      resolve({
        ...r,
        output: r.output.map((l) => redactSecrets(l, secrets)),
        ...(r.error !== undefined ? { error: redactSecrets(r.error, secrets) } : {}),
        ...(r.value !== undefined ? { value: redactSecrets(r.value, secrets) } : {}),
      })
    }
    const onAbort = (): void => finish({ ok: false, error: 'The script was cancelled.', output: [] })
    const timer = setTimeout(
      () => finish({ ok: false, timedOut: true, error: `The script timed out after ${Math.round(req.timeoutMs / 1000)} s and was stopped.`, output: [] }),
      req.timeoutMs,
    )
    timer.unref?.()
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: {
          endpoint: req.endpoint,
          playwright: req.playwrightPath,
          code: req.code,
          pageUrl: req.pageUrl,
          stepTimeout: STEP_TIMEOUT_MS,
          maxOutput: SCRIPT_MAX_OUTPUT,
        },
        resourceLimits: { maxOldGenerationSizeMb: 256 },
        stdout: true,
        stderr: true,
      })
    } catch {
      return finish({ ok: false, error: 'The script could not be started.', output: [] })
    }
    worker.on('message', (m: ScriptResult) => finish(m))
    worker.on('error', (err) => finish({ ok: false, error: `The script crashed: ${String((err as Error | undefined)?.message ?? err).split('\n')[0]}`, output: [] }))
    worker.on('exit', () => finish({ ok: false, error: 'The script stopped without a result.', output: [] }))
  })
}
