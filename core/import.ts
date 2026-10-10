import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { ImportCounts, ImportPreview, ImportResult, ImportSource, SkippedRow } from '../shared/types'
import { validateLaunchSettings } from './launch'
import { appDataDir, type PathEnv } from './paths'
import { costUsd, isPriced } from './pricing'
import type { Store } from './store'

// Everything that moves between Operant versions or machines, as one JSON document. Operant 2.8.2's data folder is
// read into the same shape, so both go through one preview and one apply.

export const BUNDLE_FORMAT = 'operant-export'
export const BUNDLE_VERSION = 1
const SKIPPED_MAX = 200

export interface BundleUsage {
  // Stable across runs and machines: importing the same row twice adds it once.
  key: string
  at: number
  model: string
  cli: string
  provider: string
  source: string
  seat: string
  // A folder path (exports from this version) or a project name (2.8.2); matched to a project here.
  project: string
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheWrite: number
  costUsd: number
  legacy: boolean
}

export interface BundlePreset {
  name: string
  agent: string
  model: string
  effort: string
  permissionMode: string
  tools: string
  roleText: string | null
}

export interface Bundle {
  format: typeof BUNDLE_FORMAT
  version: number
  app: string
  // Id of the machine it was exported from; rows exported here and imported here are already present.
  origin: string
  exportedAt: number
  source: ImportPreview['format']
  projects: Array<{ name: string; folder: string }>
  presets: BundlePreset[]
  usage: BundleUsage[]
  // Old settings with no equivalent here, kept so the preview can say so.
  unmappedSettings: string[]
}

export interface Read {
  bundle: Bundle
  skipped: SkippedRow[]
  notes: string[]
  found: boolean
  location: string
}

export interface ImportDeps {
  now?: () => number
  exists?: (path: string) => boolean
  env?: PathEnv
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const normFolder = (p: string): string => resolve(p).replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()

const emptyBundle = (source: Bundle['source'], now: number): Bundle => ({
  format: BUNDLE_FORMAT,
  version: BUNDLE_VERSION,
  app: 'Operant 2',
  origin: '',
  exportedAt: now,
  source,
  projects: [],
  presets: [],
  usage: [],
  unmappedSettings: [],
})

class Skips {
  readonly list: SkippedRow[] = []
  count = 0
  add(kind: SkippedRow['kind'], ref: string, reason: string): void {
    this.count++
    if (this.list.length < SKIPPED_MAX) this.list.push({ kind, ref, reason })
  }
}

// Operant 2.8.2's data folder: OPERANT_USER_DATA when set, else %APPDATA%\Operant (its Electron app name).
export function legacyDataDir(e?: PathEnv): string {
  const env = e ?? { platform: process.platform, home: process.env.USERPROFILE ?? process.env.HOME ?? '', env: process.env }
  return env.env.OPERANT_USER_DATA || appDataDir({ ...env, env: { ...env.env, OPERANT_DATA_DIR: undefined } }, 'Operant')
}

function jsonl(file: string, onBad: (line: number, reason: string) => void): Array<Record<string, unknown>> {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out: Array<Record<string, unknown>> = []
  raw.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return
    try {
      const o = JSON.parse(line) as unknown
      if (o && typeof o === 'object' && !Array.isArray(o)) out.push(o as Record<string, unknown>)
      else onBad(i + 1, 'not an object')
    } catch {
      onBad(i + 1, 'not valid JSON')
    }
  })
  return out
}

const cliOf = (agent: string, model: string): string => (agent === 'opencode' || model.startsWith('opencode/') ? 'opencode' : 'claude')
const providerOf = (cli: string, model: string): string => (cli === 'claude' ? 'anthropic' : model.includes('/') ? model.split('/')[0]! : '')

// Role files of 2.8.2 (agent-plugin/agents/<role>.md): front matter with a description, model and tools, then the text.
export function parseRole(file: string, text: string): BundlePreset | null {
  const raw = text.replace(/\r\n/g, '\n')
  const m = /^---\n([\s\S]*?)\n---[ \t]*(\n|$)/.exec(raw)
  const front = m?.[1] ?? ''
  const body = (m ? raw.slice(m[0].length) : raw).trim()
  if (!body) return null
  const field = (k: string) => (new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(front)?.[1] ?? '').trim().replace(/^"(.*)"$/, '$1')
  const name = field('name') || basename(file, '.md')
  return { name: `${name} (from 2.8.2)`, agent: 'claude', model: field('model') || 'sonnet', effort: '', permissionMode: 'default', tools: field('tools'), roleText: body }
}

const SETTINGS_NOTED = ['tokenBudget', 'defaultAgent', 'team', 'planLimits', 'notifications']

// Reads Operant 2.8.2's data folder without changing it.
export function readLegacy(dir: string, opts: { rolesDir?: string }, deps: ImportDeps = {}): Read {
  const now = (deps.now ?? Date.now)()
  const exists = deps.exists ?? existsSync
  const bundle = emptyBundle('operant-2.8.2', now)
  const skips = new Skips()
  const notes: string[] = []
  const found = exists(join(dir, 'config.json')) || exists(join(dir, 'store'))
  if (!found) {
    notes.push(`No Operant 2.8.2 data found in ${dir}`)
    return { bundle, skipped: [], notes, found, location: dir }
  }

  // Projects and settings: config.json.
  let config: Record<string, unknown> = {}
  try {
    config = obj(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')))
  } catch {
    notes.push('config.json could not be read: no projects or settings were imported')
  }
  const folders: string[] = []
  const take = (v: unknown) => {
    const p = typeof v === 'string' ? v : str(obj(v).path) || str(obj(v).folder)
    if (p.trim()) folders.push(p.trim())
  }
  if (Array.isArray(config.projects)) config.projects.forEach(take)
  if (Array.isArray(config.projectGroups)) for (const g of config.projectGroups) if (Array.isArray(obj(g).projects)) (obj(g).projects as unknown[]).forEach(take)
  const seen = new Set<string>()
  for (const f of folders) {
    const k = normFolder(f)
    if (seen.has(k)) continue
    seen.add(k)
    if (!exists(f)) {
      skips.add('project', f, 'folder not found on this computer')
      continue
    }
    bundle.projects.push({ name: basename(f) || f, folder: f })
  }
  bundle.unmappedSettings = SETTINGS_NOTED.filter((k) => config[k] !== undefined)
  for (const k of bundle.unmappedSettings) skips.add('setting', k, 'no equivalent setting in this version')

  // Usage history: tokenEvents with the cost of the matching modelRuns row (same corr and time).
  const storeDir = join(dir, 'store')
  const bad = (file: string) => (line: number, reason: string) => skips.add('usage', `${file} line ${line}`, reason)
  const runs = jsonl(join(storeDir, 'modelRuns.jsonl'), bad('modelRuns.jsonl'))
  const events = jsonl(join(storeDir, 'tokenEvents.jsonl'), bad('tokenEvents.jsonl'))
  const usdByKey = new Map<string, Record<string, unknown>>()
  for (const r of runs) usdByKey.set(`${str(r.corr)}|${num(r.t)}`, r)
  const matched = new Set<string>()
  const project = (r: Record<string, unknown>) => str(r.project)
  for (const e of events) {
    const id = str(e.id)
    const t = num(e.t)
    if (!id || t == null) {
      skips.add('usage', id || '(no id)', 'a token event needs an id and a time')
      continue
    }
    const nums = [e.input, e.output, e.cacheRead, e.cacheWrite].map((v) => (v === undefined || v === null ? 0 : num(v)))
    if (nums.some((n) => n == null || n < 0)) {
      skips.add('usage', id, 'token counts are not numbers')
      continue
    }
    const [input, output, cacheRead, cacheWrite] = nums as number[]
    const model = str(e.model)
    const run = usdByKey.get(`${str(e.corr)}|${t}`)
    if (run) matched.add(str(run.id))
    const usd = num(run?.usd)
    const cli = cliOf(str(run?.agent), model)
    // 2.8.2 did not always store a cost: it is figured from the price table when the model has a row.
    const cost = usd ?? (isPriced(model) ? costUsd(model, { inputTokens: input!, outputTokens: output!, cacheReadTokens: cacheRead!, cacheWrite5mTokens: cacheWrite!, cacheWrite1hTokens: 0 }) : 0)
    bundle.usage.push({
      key: `legacy:tok:${id}`,
      at: t,
      model,
      cli,
      provider: providerOf(cli, model),
      source: 'import',
      seat: str(e.tier),
      project: project(e),
      inputTokens: input!,
      outputTokens: output!,
      cacheRead: cacheRead!,
      cacheWrite: cacheWrite!,
      costUsd: cost,
      legacy: true,
    })
  }
  // Model runs with no token event: kept for their cost when they have one.
  for (const r of runs) {
    const id = str(r.id)
    if (!id || matched.has(id)) continue
    const t = num(r.t)
    const usd = num(r.usd)
    if (t == null || usd == null || usd <= 0) {
      skips.add('usage', id || '(no id)', 'a model run with no tokens and no cost')
      continue
    }
    const model = str(r.model)
    const cli = cliOf(str(r.agent), model)
    bundle.usage.push({ key: `legacy:run:${id}`, at: t, model, cli, provider: providerOf(cli, model), source: 'import', seat: str(r.tier), project: project(r), inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, costUsd: usd, legacy: true })
  }

  // Role presets from the plugin's agent files.
  const rolesDirs = [opts.rolesDir, join(dir, 'agent-plugin', 'agents'), join(dir, 'agents')].filter((d): d is string => !!d)
  const rolesDir = rolesDirs.find((d) => exists(d))
  if (!rolesDir) notes.push('Role files were not found: pass the agent-plugin/agents folder of Operant 2.8.2 to import its roles as presets')
  else {
    let files: string[] = []
    try {
      files = readdirSync(rolesDir).filter((f) => f.endsWith('.md'))
    } catch {
      skips.add('preset', rolesDir, 'the roles folder could not be read')
    }
    for (const f of files) {
      let text = ''
      try {
        text = readFileSync(join(rolesDir, f), 'utf8')
      } catch {
        skips.add('preset', f, 'unreadable')
        continue
      }
      const p = parseRole(f, text)
      if (p) bundle.presets.push(p)
      else skips.add('preset', f, 'no role text')
    }
  }
  return { bundle, skipped: skips.list, notes: skips.count > skips.list.length ? [...notes, `${skips.count - skips.list.length} more skipped rows are not listed`] : notes, found, location: dir }
}

// A bundle written by exportBundle (possibly on another machine).
export function readBundleText(text: string, location: string): Read {
  const skips = new Skips()
  const notes: string[] = []
  let o: Record<string, unknown>
  try {
    o = obj(JSON.parse(text))
  } catch {
    return { bundle: emptyBundle('operant-export', 0), skipped: [], notes: ['That file is not valid JSON'], found: false, location }
  }
  if (o.format !== BUNDLE_FORMAT || typeof o.version !== 'number') {
    return { bundle: emptyBundle('operant-export', 0), skipped: [], notes: ['That file is not an Operant export'], found: false, location }
  }
  if (o.version > BUNDLE_VERSION) notes.push(`The export is version ${o.version}, newer than this Operant understands (${BUNDLE_VERSION}); unknown parts are ignored`)
  const bundle = emptyBundle('operant-export', num(o.exportedAt) ?? 0)
  bundle.origin = str(o.origin)
  bundle.app = str(o.app) || 'Operant'
  for (const p of Array.isArray(o.projects) ? o.projects : []) {
    const r = obj(p)
    if (str(r.name).trim() && str(r.folder).trim()) bundle.projects.push({ name: str(r.name).trim(), folder: str(r.folder).trim() })
    else skips.add('project', str(r.folder) || str(r.name) || '(empty)', 'a project needs a name and a folder')
  }
  for (const p of Array.isArray(o.presets) ? o.presets : []) {
    const r = obj(p)
    if (str(r.name).trim() && str(r.agent) && str(r.model)) {
      const permissionMode = str(r.permissionMode) || 'default'
      try {
        if (str(r.agent) !== 'claude' && str(r.agent) !== 'opencode') throw new Error('the agent must be claude or opencode')
        validateLaunchSettings({ agent: str(r.agent) as 'claude', model: str(r.model), effort: str(r.effort), tools: str(r.tools), permissionMode: permissionMode === 'default' ? '' : permissionMode })
      } catch (err) {
        skips.add('preset', str(r.name).trim(), err instanceof Error ? err.message : 'invalid launch settings')
        continue
      }
      if (permissionMode === 'bypassPermissions') notes.push(`Warning: preset "${str(r.name).trim()}" would run with bypassPermissions, so its agent acts without asking. Import it only if you trust this file`)
      bundle.presets.push({ name: str(r.name).trim(), agent: str(r.agent), model: str(r.model), effort: str(r.effort), permissionMode, tools: str(r.tools), roleText: typeof r.roleText === 'string' ? r.roleText : null })
    } else skips.add('preset', str(r.name) || '(no name)', 'a preset needs a name, agent and model')
  }
  for (const u of Array.isArray(o.usage) ? o.usage : []) {
    const r = obj(u)
    const key = str(r.key)
    const nums = [r.at, r.inputTokens, r.outputTokens, r.cacheRead, r.cacheWrite, r.costUsd].map(num)
    if (!key || nums.some((n) => n == null || n < 0)) {
      skips.add('usage', key || '(no key)', 'a usage row needs a key and non-negative numbers')
      continue
    }
    bundle.usage.push({
      key,
      at: nums[0]!,
      model: str(r.model),
      cli: str(r.cli) || 'claude',
      provider: str(r.provider),
      source: 'import',
      seat: str(r.seat),
      project: str(r.project),
      inputTokens: nums[1]!,
      outputTokens: nums[2]!,
      cacheRead: nums[3]!,
      cacheWrite: nums[4]!,
      costUsd: nums[5]!,
      legacy: r.legacy === true,
    })
  }
  return { bundle, skipped: skips.list, notes, found: true, location }
}

export function machineId(store: Store): string {
  const have = store.getJson('machine.id')
  if (typeof have === 'string' && have) return have
  const id = randomUUID()
  store.setJson('machine.id', id)
  return id
}

// This version's data in the bundle format, to move to another machine (or back into 2.8.2-style tools).
export function exportBundle(store: Store, now: number): Bundle {
  const bundle = emptyBundle('operant-export', now)
  bundle.origin = machineId(store)
  const crews = store.listCrews()
  bundle.projects = crews.filter((c) => c.kind !== 'playground').map((c) => ({ name: c.name, folder: c.folder }))
  bundle.presets = store
    .listPresets()
    .filter((p) => p.builtin == null)
    .map((p) => ({ name: p.name, agent: p.agent, model: p.model, effort: p.effort, permissionMode: p.permissionMode, tools: p.tools, roleText: p.roleText }))
  const rows = store.db
    .prepare(
      `SELECT u.id, u.ext_key, u.at, u.model, u.cli, u.provider, u.source, u.legacy, u.input_tokens, u.output_tokens, u.cache_read, u.cache_w5m + u.cache_w1h AS cache_write, u.cost_usd,
              u.project_label, COALESCE(u.crew_id, sc.crew_id) AS crew,
              CASE WHEN sc.id IS NOT NULL THEN 'scratch' ELSE u.seat END AS seat
       FROM usage u LEFT JOIN scratch sc ON sc.id = u.scratch_id ORDER BY u.at, u.id`,
    )
    .all() as Array<Record<string, unknown>>
  const folderOf = new Map(crews.map((c) => [c.id, c.folder]))
  for (const r of rows) {
    bundle.usage.push({
      key: r.ext_key != null ? String(r.ext_key) : `export:${bundle.origin}:${r.id}`,
      at: Number(r.at),
      model: String(r.model),
      cli: String(r.cli),
      provider: String(r.provider),
      source: String(r.source),
      seat: String(r.seat),
      project: r.crew != null ? (folderOf.get(Number(r.crew)) ?? '') : String(r.project_label),
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      cacheRead: Number(r.cache_read),
      cacheWrite: Number(r.cache_write),
      costUsd: Number(r.cost_usd),
      legacy: Number(r.legacy) === 1,
    })
  }
  return bundle
}

interface Plan {
  projects: { add: Array<{ name: string; folder: string }>; existing: number }
  presets: { add: BundlePreset[]; existing: number }
  usage: { add: Array<BundleUsage & { crewId: number | null; label: string }>; existing: number }
}

const counts = (add: number, existing: number, skipped: number): ImportCounts => ({ add, existing, skipped })

function plan(store: Store, bundle: Bundle, pendingProjects: Map<string, number>): Plan {
  const crews = store.listCrews()
  const byFolder = new Map(crews.map((c) => [normFolder(c.folder), c]))
  const names = new Set(crews.map((c) => c.name))
  const pAdd: Plan['projects']['add'] = []
  let pExisting = 0
  for (const p of bundle.projects) {
    if (byFolder.has(normFolder(p.folder))) {
      pExisting++
      continue
    }
    let name = p.name
    for (let n = 2; names.has(name); n++) name = `${p.name} (${n})`
    names.add(name)
    pAdd.push({ name, folder: p.folder })
  }
  const presetNames = new Set(store.listPresets().map((p) => p.name))
  const prAdd: BundlePreset[] = []
  let prExisting = 0
  for (const p of bundle.presets) {
    if (presetNames.has(p.name)) prExisting++
    else {
      presetNames.add(p.name)
      prAdd.push(p)
    }
  }
  // Rows this machine exported itself are already here.
  const sameMachine = bundle.origin !== '' && bundle.origin === store.getJson('machine.id')
  const have = new Set((store.db.prepare('SELECT ext_key FROM usage WHERE ext_key IS NOT NULL').all() as Array<{ ext_key: string }>).map((r) => r.ext_key))
  const byBase = new Map<string, number | null>()
  for (const c of crews) {
    for (const k of [c.name.toLowerCase(), basename(c.folder).toLowerCase()]) byBase.set(k, byBase.has(k) && byBase.get(k) !== c.id ? null : c.id)
  }
  const crewFor = (project: string): number | null => {
    if (!project) return null
    const f = byFolder.get(normFolder(project))
    if (f) return f.id
    const pending = pendingProjects.get(normFolder(project))
    if (pending != null) return pending
    return byBase.get(project.toLowerCase()) ?? byBase.get(basename(project).toLowerCase()) ?? null
  }
  const uAdd: Plan['usage']['add'] = []
  let uExisting = 0
  const keys = new Set<string>()
  for (const u of bundle.usage) {
    if (sameMachine || have.has(u.key) || keys.has(u.key)) {
      uExisting++
      continue
    }
    keys.add(u.key)
    uAdd.push({ ...u, crewId: crewFor(u.project), label: crewFor(u.project) == null ? basename(u.project) : '' })
  }
  return { projects: { add: pAdd, existing: pExisting }, presets: { add: prAdd, existing: prExisting }, usage: { add: uAdd, existing: uExisting } }
}

function summary(read: Read, p: Plan, skippedBy: (k: SkippedRow['kind']) => number): ImportPreview {
  const at = p.usage.add.map((u) => u.at)
  return {
    format: read.bundle.source,
    found: read.found,
    location: read.location,
    projects: counts(p.projects.add.length, p.projects.existing, skippedBy('project')),
    usage: counts(p.usage.add.length, p.usage.existing, skippedBy('usage')),
    presets: counts(p.presets.add.length, p.presets.existing, skippedBy('preset')),
    settings: counts(0, 0, skippedBy('setting')),
    usageCostUsd: p.usage.add.reduce((a, u) => a + u.costUsd, 0),
    usageFrom: at.length ? Math.min(...at) : null,
    usageTo: at.length ? Math.max(...at) : null,
    skipped: read.skipped,
    notes: read.notes,
  }
}

// How many rows were skipped per kind (the listed ones; the notes say when the list is capped).
const skippedCounter = (read: Read) => (k: SkippedRow['kind']) => read.skipped.filter((s) => s.kind === k).length

export function previewRead(store: Store, read: Read): ImportPreview {
  return summary(read, plan(store, read.bundle, new Map()), skippedCounter(read))
}

// Adds what the preview counted, in one transaction; running it again finds everything present and adds nothing.
export function applyRead(store: Store, read: Read): ImportResult {
  if (!read.found) return { ...previewRead(store, read), applied: false }
  return store.transaction(() => {
    const created = new Map<string, number>()
    const first = plan(store, read.bundle, created)
    for (const p of first.projects.add) created.set(normFolder(p.folder), store.createCrew(p.name, p.folder).id)
    // Planned again so usage rows find the projects just made.
    const p = plan(store, read.bundle, created)
    for (const pr of first.presets.add) {
      store.createPreset({ name: pr.name, agent: pr.agent as 'claude', model: pr.model, permissionMode: pr.permissionMode, effort: pr.effort, tools: pr.tools, roleText: pr.roleText })
    }
    for (const u of p.usage.add) {
      store.upsertKeyedUsage(
        {
          extKey: u.key,
          at: u.at,
          model: u.model,
          cli: u.cli,
          provider: u.provider,
          source: 'import',
          crewId: u.crewId,
          projectLabel: u.label,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheRead: u.cacheRead,
          cacheW5m: u.cacheWrite,
          cacheW1h: 0,
          costUsd: u.costUsd,
          legacy: u.legacy,
        },
        false,
      )
    }
    return { ...summary(read, { projects: first.projects, presets: first.presets, usage: p.usage }, skippedCounter(read)), applied: true }
  })
}

export function readSource(source: ImportSource, deps: ImportDeps = {}): Read {
  if (source.kind === 'legacy') return readLegacy(source.dir || legacyDataDir(deps.env), { rolesDir: source.rolesDir }, deps)
  let text: string
  try {
    text = readFileSync(source.path, 'utf8')
  } catch {
    return { bundle: emptyBundle('operant-export', 0), skipped: [], notes: ['That file could not be read'], found: false, location: source.path }
  }
  return readBundleText(text, source.path)
}
