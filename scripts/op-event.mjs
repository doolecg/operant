// Operant's Claude Code hook and status line writer. It has no dependencies and no model calls: Claude Code runs it
// with the app binary as Node (ELECTRON_RUN_AS_NODE=1) and pipes the event JSON to stdin.
//
//   node op-event.mjs hook <eventsDir>    appends one line {ts, tile, ...payload} to <eventsDir>/<session_id>.jsonl
//   node op-event.mjs status <eventsDir>  writes the latest payload to <eventsDir>/status-<session_id>.json and prints one line
//
// Only tiles Operant launched (OPERANT_SOURCE=operant) write anything. It always exits 0, so a failed write never
// blocks Claude Code.
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/
const MAX_STRING = 2000
const MAX_ITEMS = 200

// Drops prompts (they can hold the user's text) and clips long strings and lists so one event stays small.
function shrink(value, depth = 0) {
  if (typeof value === 'string') return value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value
  if (!value || typeof value !== 'object' || depth > 8) return value
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((item) => shrink(item, depth + 1))
  const out = {}
  for (const [key, item] of Object.entries(value)) if (key !== 'prompt') out[key] = shrink(item, depth + 1)
  return out
}

function readStdin() {
  return new Promise((resolve) => {
    let text = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => (text += chunk))
    process.stdin.on('end', () => resolve(text))
    process.stdin.on('error', () => resolve(text))
  })
}

// One short plain line for the terminal's status bar: model, context used, session cost.
function statusText(payload) {
  const parts = []
  const model = payload.model?.display_name ?? payload.model?.id
  if (typeof model === 'string') parts.push(model)
  const used = payload.context_window?.used_percentage
  if (typeof used === 'number') parts.push(`ctx ${Math.round(used)}%`)
  const cost = payload.cost?.total_cost_usd
  if (typeof cost === 'number') parts.push(`$${cost.toFixed(2)}`)
  return parts.join(' | ')
}

async function main() {
  const [mode, eventsDir] = process.argv.slice(2)
  if (process.env.OPERANT_SOURCE !== 'operant' || !eventsDir || (mode !== 'hook' && mode !== 'status')) return
  let payload
  try {
    payload = JSON.parse(await readStdin())
  } catch {
    return
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return
  const sessionId = payload.session_id
  if (typeof sessionId !== 'string' || !SAFE_ID.test(sessionId)) return
  mkdirSync(eventsDir, { recursive: true })
  const tile = process.env.OPERANT_TILE_ID ?? null
  if (mode === 'hook') {
    appendFileSync(join(eventsDir, `${sessionId}.jsonl`), `${JSON.stringify({ ts: Date.now(), tile, ...shrink(payload) })}\n`)
    return
  }
  const file = join(eventsDir, `status-${sessionId}.json`)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ ts: Date.now(), tile, ...shrink(payload) }))
  renameSync(tmp, file)
  const text = statusText(payload)
  if (text) process.stdout.write(`${text}\n`)
}

main().catch(() => undefined).finally(() => {
  process.exitCode = 0
})
