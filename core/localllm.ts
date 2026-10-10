import { scrubLogLine } from './agents'

// A client for a local (or LAN) model server that speaks the OpenAI chat API: LM Studio, llama.cpp's server, vLLM, or
// Ollama's /v1 layer. Shared by the learn step.

export const LOCAL_LLM_DEFAULT_URL = 'http://127.0.0.1:1234'
export const LOCAL_LLM_TIMEOUT_MS = 120_000

export type LocalFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

export interface LocalLlmDeps {
  fetch?: LocalFetch
  // The API key from the encrypted secret store; most local servers need none.
  apiKey?: () => string | null
  timeoutMs?: number
}

export interface LocalMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface LocalChatOptions {
  // Ask for a JSON object; a server that ignores or rejects response_format is retried without it.
  json?: boolean
  maxTokens?: number
  temperature?: number
}

export interface LocalModelList {
  models: string[]
  error?: string
}

const realFetch: LocalFetch = (url, init) => fetch(url, init) as ReturnType<LocalFetch>

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// 127.x, ::1, localhost, *.local and the private ranges 10/8, 172.16/12, 192.168/16 and 169.254/16.
export function isLanHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === 'localhost' || h === '::1' || h.endsWith('.local') || h.endsWith('.localhost')) return true
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h)
  if (!m) return /^f[cd][0-9a-f]{2}:/.test(h)
  const a = Number(m[1])
  const b = Number(m[2])
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)
}

// The server's base URL without a trailing slash or /v1, or an error. Plain http is for this PC and the LAN; any other
// plain-http host needs `confirmed` (the owner said they know it is unencrypted).
export function normalizeLocalUrl(raw: string, confirmed = false): { url: string } | { error: string } {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return { error: `"${raw.trim()}" is not a URL (try ${LOCAL_LLM_DEFAULT_URL})` }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'The endpoint must be an http or https URL' }
  if (u.protocol === 'http:' && !isLanHost(u.hostname) && !confirmed) {
    return { error: `${u.hostname} is not on this PC or your network: plain http would send prompts unencrypted. Use https or confirm it in settings` }
  }
  return { url: `${u.origin}${u.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')}` }
}

function headers(d: LocalLlmDeps, json: boolean): Record<string, string> {
  const key = d.apiKey?.()
  return { ...(json ? { 'Content-Type': 'application/json' } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}) }
}

// One request with its own deadline; the timer aborts the call. The body is read inside the deadline.
async function request(d: LocalLlmDeps, url: string, init: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ ok: boolean; status: number; body: string }> {
  const ctl = new AbortController()
  const ms = d.timeoutMs ?? LOCAL_LLM_TIMEOUT_MS
  const timer = setTimeout(() => ctl.abort(), ms)
  try {
    const r = await (d.fetch ?? realFetch)(url, { ...init, signal: ctl.signal })
    return { ok: r.ok, status: r.status, body: await r.text() }
  } catch (e) {
    if (ctl.signal.aborted) throw new Error(`The local model timed out after ${Math.round(ms / 1000)} s`)
    throw new Error(`Could not reach ${url.replace(/^(https?:\/\/[^/]+).*/, '$1')}: ${errText(e)}`)
  } finally {
    clearTimeout(timer)
  }
}

const parse = (s: string): unknown => {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {})
const names = (v: unknown, key: string): string[] => (Array.isArray(v) ? v.map((m) => obj(m)[key]).filter((s): s is string => typeof s === 'string' && s !== '') : [])

const apiError = (status: number, body: string): string => {
  const e = obj(parse(body)).error
  const msg = typeof e === 'string' ? e : typeof obj(e).message === 'string' ? String(obj(e).message) : body.slice(0, 300)
  return scrubLogLine(`The server answered ${status}${msg ? `: ${msg.trim()}` : ''}`)
}

// The models the server offers: OpenAI's GET /v1/models, then Ollama's GET /api/tags.
export async function listLocalModels(baseUrl: string, d: LocalLlmDeps = {}): Promise<LocalModelList> {
  let first = ''
  for (const [path, key, field] of [
    ['/v1/models', 'data', 'id'],
    ['/api/tags', 'models', 'name'],
  ] as const) {
    try {
      const r = await request(d, baseUrl + path, { headers: headers(d, false) })
      if (!r.ok) {
        first ||= apiError(r.status, r.body)
        continue
      }
      const models = [...new Set(names(obj(parse(r.body))[key], field))]
      if (models.length) return { models }
      first ||= 'The server lists no models: load one first'
    } catch (e) {
      first ||= errText(e)
      if (/timed out|Could not reach/.test(first)) break
    }
  }
  return { models: [], error: first || 'The server lists no models' }
}

// Some models wrap their answer in <think> blocks or a code fence; the caller wants just the answer.
const tidy = (s: string): string =>
  s
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i, '$1')
    .trim()

export async function localChat(baseUrl: string, model: string, messages: LocalMessage[], o: LocalChatOptions = {}, d: LocalLlmDeps = {}): Promise<string> {
  const send = (json: boolean) =>
    request(d, `${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: headers(d, true),
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        ...(o.maxTokens ? { max_tokens: o.maxTokens } : {}),
        ...(o.temperature != null ? { temperature: o.temperature } : {}),
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      }),
    })
  let r = await send(!!o.json)
  // A server that does not know response_format (or wants a json_schema) answers 400: ask again without it.
  if (!r.ok && o.json && r.status === 400) r = await send(false)
  if (!r.ok) throw new Error(apiError(r.status, r.body))
  const choices = obj(parse(r.body)).choices
  const choice = obj(Array.isArray(choices) ? choices[0] : null)
  const content = obj(choice.message).content ?? choice.text
  if (typeof content !== 'string' || !tidy(content)) throw new Error('The local model returned no text')
  return tidy(content)
}

export interface LocalTestResult {
  ok: boolean
  ms: number
  error: string
  models: number
}

// Health check: lists the models, then (when `model` is given) one tiny chat call. Reports the time and an honest error.
export async function testLocal(baseUrl: string, model: string, d: LocalLlmDeps = {}, now: () => number = Date.now): Promise<LocalTestResult> {
  const t = now()
  const list = await listLocalModels(baseUrl, d)
  if (list.error) return { ok: false, ms: now() - t, error: list.error, models: 0 }
  if (model) {
    try {
      await localChat(baseUrl, model, [{ role: 'user', content: 'Reply with the single word ok.' }], { maxTokens: 16 }, d)
    } catch (e) {
      return { ok: false, ms: now() - t, error: scrubLogLine(errText(e)), models: list.models.length }
    }
  }
  return { ok: true, ms: now() - t, error: '', models: list.models.length }
}
