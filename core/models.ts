import { CLAUDE_EFFORTS, CLAUDE_MODELS } from '../shared/models'
import { findService } from './opencode'
import { runHidden } from './proc'

export interface ModelList {
  models: string[]
  // Effort choices per model id; a model missing here (or with an empty list) has none.
  efforts: Record<string, string[]>
  error?: string
}

// Runs `file args` and resolves with stdout; rejects when it cannot start or exits non-zero.
export type RunCommand = (file: string, args: string[]) => Promise<string>

const TTL_MS = 5 * 60 * 1000

const realRun: RunCommand = async (file, args) => {
  const r = await runHidden(file, args, { timeoutMs: 20_000, shell: process.platform === 'win32', source: file === 'opencode' ? 'opencode' : 'claude-run' })
  if (r.code !== 0) throw new Error(r.stderr.trim() || `${file} exited with code ${r.code}`)
  return r.stdout
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:+@-]*\/[A-Za-z0-9._:+/@-]+$/

// Claude takes --effort for every model but Haiku.
export function listEfforts(agent: 'claude' | 'opencode', model: string, list?: ModelList): string[] {
  if (agent === 'claude') return model.includes('haiku') ? [] : [...CLAUDE_EFFORTS]
  return list?.efforts[model] ?? []
}

// `opencode models` prints one provider/model id per line (it has no --verbose). ANSI codes, blanks and anything
// else are skipped.
export function parseOpencodeModels(out: string): string[] {
  const models: string[] = []
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.replace(ANSI, '').trim()
    if (ID_RE.test(line) && !models.includes(line)) models.push(line)
  }
  return models
}

// The variants (efforts) per model id from the service's GET /api/model, answered as
// { data: [{ providerID, modelID, variants: [{ id }] }] }.
export function parseServiceVariants(body: unknown): Record<string, string[]> {
  const rows = (body as { data?: unknown } | null)?.data
  const efforts: Record<string, string[]> = {}
  if (!Array.isArray(rows)) return efforts
  for (const r of rows as Array<{ providerID?: unknown; modelID?: unknown; variants?: unknown }>) {
    if (typeof r?.providerID !== 'string' || typeof r.modelID !== 'string' || !Array.isArray(r.variants)) continue
    const names = r.variants
      .map((v) => (v as { id?: unknown } | null)?.id)
      .filter((id): id is string => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(id))
    if (names.length) efforts[`${r.providerID}/${r.modelID}`] = names
  }
  return efforts
}

const realVariants = async (): Promise<Record<string, string[]>> => {
  const cfg = findService()
  if (!cfg) return {}
  const r = await fetch(`${cfg.url}/api/model`, { headers: { Authorization: cfg.auth }, signal: AbortSignal.timeout(5000) })
  return r.ok ? parseServiceVariants(await r.json()) : {}
}

export interface ModelsDeps {
  run?: RunCommand
  // Efforts per model id; the real one asks the OpenCode service. Failing gives no efforts.
  variants?: () => Promise<Record<string, string[]>>
  now?: () => number
}

let cache: { at: number; value: ModelList } | null = null

export function resetModelsCache(): void {
  cache = null
}

const missing = (err: NodeJS.ErrnoException): string =>
  err.code === 'ENOENT' || /not recognized|not found/i.test(err.message)
    ? 'opencode is not installed or not on PATH'
    : `opencode models failed: ${err.message.split('\n')[0]}`

export async function listModels(agent: 'claude' | 'opencode', deps: ModelsDeps = {}): Promise<ModelList> {
  if (agent === 'claude') {
    return { models: [...CLAUDE_MODELS], efforts: Object.fromEntries(CLAUDE_MODELS.map((m) => [m, listEfforts('claude', m)])) }
  }
  const now = (deps.now ?? Date.now)()
  if (cache && now - cache.at < TTL_MS) return cache.value
  const run = deps.run ?? realRun
  let models: string[] = []
  let failure: NodeJS.ErrnoException | null = null
  try {
    models = parseOpencodeModels(await run('opencode', ['models']))
  } catch (e) {
    failure = e as NodeJS.ErrnoException
  }
  if (!models.length) return { models: [], efforts: {}, error: failure ? missing(failure) : 'opencode listed no models' }
  const all = await (deps.variants ?? realVariants)().catch(() => ({}) as Record<string, string[]>)
  const efforts = Object.fromEntries(Object.entries(all).filter(([id]) => models.includes(id)))
  const value: ModelList = { models, efforts }
  cache = { at: now, value }
  return value
}
