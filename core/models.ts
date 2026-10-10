import { CLAUDE_MODELS, claudeEffortsFor, modelName, providerName, providerOf, type ModelEntry, type ModelList, type ModelProvider } from '../shared/models'
import { findService } from './opencode'
import { runHidden } from './proc'

export type { ModelList } from '../shared/models'

// Runs `file args` and resolves with stdout; rejects when it cannot start or exits non-zero.
export type RunCommand = (file: string, args: string[]) => Promise<string>

const TTL_MS = 5 * 60 * 1000
// A catalogue built from fewer sources than all three is kept only briefly, so the full one replaces it soon.
const DEGRADED_TTL_MS = 30 * 1000

const realRun: RunCommand = async (file, args) => {
  const r = await runHidden(file, args, { timeoutMs: 20_000, shell: process.platform === 'win32', source: file === 'opencode' ? 'opencode' : 'claude-run' })
  if (r.code !== 0) throw new Error(r.stderr.trim() || `${file} exited with code ${r.code}`)
  return r.stdout
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g
// The same characters the launch builders accept for an OpenCode model, so a listed id can always be started.
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:+@-]*\/[A-Za-z0-9][A-Za-z0-9._:+/@-]*$/
const VARIANT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/

export function listEfforts(agent: 'claude' | 'opencode', model: string, list?: ModelList): string[] {
  if (agent === 'claude') return claudeEffortsFor(model)
  return list?.efforts[model] ?? []
}

// `opencode models` prints one provider/model id per line (it has no --verbose). ANSI codes, blanks and anything
// else are skipped.
export function parseOpencodeModels(out: string): string[] {
  const models: string[] = []
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.replace(ANSI, '').trim()
    if (ID_RE.test(line) && line.length <= 128 && !models.includes(line)) models.push(line)
  }
  return models
}

export interface ServiceModel {
  id: string
  name: string
  efforts: string[]
  free: boolean
  context?: number
}

// The service's GET /api/model, answered as { data: [{ providerID, modelID, name, variants: [{ id }], cost: [{ input,
// output }], limit: { context }, enabled }] }, keyed by provider/model id. Rows it cannot read are skipped.
export function parseServiceModels(body: unknown): Record<string, ServiceModel> {
  const rows = (body as { data?: unknown } | null)?.data
  const out: Record<string, ServiceModel> = {}
  if (!Array.isArray(rows)) return out
  for (const r of rows as Array<Record<string, unknown> | null>) {
    if (typeof r?.providerID !== 'string' || typeof r.modelID !== 'string' || r.enabled === false) continue
    const id = `${r.providerID}/${r.modelID}`
    const efforts = (Array.isArray(r.variants) ? r.variants : [])
      .map((v) => (v as { id?: unknown } | null)?.id)
      .filter((v): v is string => typeof v === 'string' && VARIANT_RE.test(v))
    const cost = Array.isArray(r.cost) ? (r.cost as Array<{ input?: unknown; output?: unknown } | null>) : []
    const free = cost.length > 0 && cost.every((c) => c?.input === 0 && c?.output === 0)
    const context = (r.limit as { context?: unknown } | null | undefined)?.context
    out[id] = {
      id,
      name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : modelName(id),
      efforts,
      free,
      ...(typeof context === 'number' && context > 0 ? { context } : {}),
    }
  }
  return out
}

// The variants (efforts) per model id alone.
export function parseServiceVariants(body: unknown): Record<string, string[]> {
  return Object.fromEntries(Object.values(parseServiceModels(body)).filter((m) => m.efforts.length).map((m) => [m.id, m.efforts]))
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '')

// `opencode auth list` prints "<name>  <name>  <kind>" rows (plus headings, box art and maybe an environment section).
// Returns the normalised cells, or null when nothing readable came back (then nobody is judged not connected).
export function parseAuthList(out: string): Set<string> | null {
  const cells = new Set<string>()
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.replace(ANSI, '').replace(/[|│┌└├┐┘─●○◆◇▲]/g, ' ').trim()
    if (!line || /^\d+ credentials?/i.test(line)) continue
    for (const cell of line.split(/\s{2,}/)) if (norm(cell)) cells.add(norm(cell))
  }
  return cells.size ? cells : null
}

// Providers usable without stored credentials: OpenCode's free Zen models and local servers.
const OPEN_PROVIDERS = new Set(['opencode', 'ollama', 'lmstudio'])
const FREE_ID = /(^|[-/])free$|^opencode\/big-pickle$/

export function buildProviders(ids: string[], service: Record<string, ServiceModel>, auth: Set<string> | null): ModelProvider[] {
  const groups = new Map<string, ModelEntry[]>()
  const known = new Set<string>()
  for (const id of ids) {
    const sm = service[id]
    const pid = providerOf(id)
    if (sm) known.add(pid)
    const entry: ModelEntry = {
      id,
      name: sm?.name ?? modelName(id),
      free: pid !== 'ollama' && ((sm?.free ?? false) || FREE_ID.test(id)),
      efforts: sm?.efforts ?? [],
      ...(sm?.context ? { context: sm.context } : {}),
    }
    const g = groups.get(pid)
    if (g) g.push(entry)
    else groups.set(pid, [entry])
  }
  const providers: ModelProvider[] = [...groups].map(([pid, models]) => {
    const name = providerName(pid)
    const connected =
      OPEN_PROVIDERS.has(pid) ||
      known.has(pid) ||
      auth === null ||
      auth.has(norm(pid)) ||
      auth.has(norm(name)) ||
      [...auth].some((c) => c.length > 3 && (c.includes(norm(pid)) || norm(name).includes(c)))
    return { providerId: pid, providerName: name, connected, models }
  })
  const rank = (p: ModelProvider): number => (p.providerId === 'opencode' ? 0 : p.connected ? 1 : 2)
  return providers.sort((a, b) => rank(a) - rank(b) || a.providerName.localeCompare(b.providerName))
}

const realService = async (): Promise<Record<string, ServiceModel>> => {
  // e2e and unit runs use the fake opencode only; the machine's real service would add its own models.
  if (process.env.OPERANT_E2E || process.env.VITEST) return {}
  const cfg = findService()
  if (!cfg) return {}
  const r = await fetch(`${cfg.url}/api/model`, { headers: { Authorization: cfg.auth }, signal: AbortSignal.timeout(5000) })
  return r.ok ? parseServiceModels(await r.json()) : {}
}

export interface ModelsDeps {
  run?: RunCommand
  // The service's models by provider/model id; the real one asks the OpenCode service. Failing gives none.
  service?: () => Promise<Record<string, ServiceModel>>
  now?: () => number
  // Skip the cache (the Refresh button).
  refresh?: boolean
}

let cache: { at: number; ttl: number; value: ModelList } | null = null

export function resetModelsCache(): void {
  cache = null
}

const missing = (err: NodeJS.ErrnoException): string =>
  err.code === 'ENOENT' || /not recognized|not found/i.test(err.message)
    ? 'opencode is not installed or not on PATH'
    : `opencode models failed: ${err.message.split('\n')[0]}`

export async function listModels(agent: 'claude' | 'opencode', deps: ModelsDeps = {}): Promise<ModelList> {
  if (agent === 'claude') {
    const entries: ModelEntry[] = CLAUDE_MODELS.map((id) => ({ id, name: id, free: false, efforts: listEfforts('claude', id) }))
    return {
      models: [...CLAUDE_MODELS],
      efforts: Object.fromEntries(entries.map((m) => [m.id, m.efforts])),
      providers: [{ providerId: 'claude', providerName: 'Claude', connected: true, models: entries }],
    }
  }
  const now = (deps.now ?? Date.now)()
  if (!deps.refresh && cache && now - cache.at < cache.ttl) return cache.value
  const run = deps.run ?? realRun
  const [cli, auth, svc] = await Promise.allSettled([run('opencode', ['models']), run('opencode', ['auth', 'list']), (deps.service ?? realService)()])
  const service = svc.status === 'fulfilled' ? svc.value : {}
  const ids = cli.status === 'fulfilled' ? parseOpencodeModels(cli.value) : []
  for (const id of Object.keys(service)) if (ID_RE.test(id) && id.length <= 128 && !ids.includes(id)) ids.push(id)
  if (!ids.length) {
    const failure = cli.status === 'rejected' ? (cli.reason as NodeJS.ErrnoException) : null
    return { models: [], efforts: {}, providers: [], error: failure ? missing(failure) : 'opencode listed no models' }
  }
  const providers = buildProviders(ids, service, auth.status === 'fulfilled' ? parseAuthList(auth.value) : null)
  const flat = providers.flatMap((p) => p.models)
  const value: ModelList = {
    models: flat.map((m) => m.id),
    efforts: Object.fromEntries(flat.filter((m) => m.efforts.length).map((m) => [m.id, m.efforts])),
    providers,
  }
  const degraded = cli.status !== 'fulfilled' || auth.status !== 'fulfilled' || svc.status !== 'fulfilled' || Object.keys(service).length === 0
  cache = { at: now, ttl: degraded ? DEGRADED_TTL_MS : TTL_MS, value }
  return value
}
