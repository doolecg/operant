import type { ExportText, Preset, Team, TeamImportEntry, TeamInput, TeamLimits, TeamSeat } from '../shared/types'
import { validateModel } from './launch'
import { RunError, cleanLimits, cleanSeats } from './runs'
import type { Store } from './store'

// Teams that ship with Operant, built from the built-in seat presets (keyed by their `builtin`).
// A seat takes its preset's model and effort unless the team names its own.
interface ShippedSeat {
  preset: string
  count: number
  model?: string
  effort?: string
}

export interface ShippedTeam {
  builtin: string
  name: string
  description: string
  seats: ShippedSeat[]
  limits: TeamLimits
  rules: string
}

export const BUILTIN_TEAMS: ShippedTeam[] = [
  {
    builtin: 'build-review',
    name: 'Build and review',
    description: 'One implementor writes the change and one reviewer checks it.',
    seats: [
      { preset: 'implementor', count: 1 },
      { preset: 'reviewer', count: 1 },
    ],
    limits: { maxWorkers: 2, topTier: 'sonnet', tokenBudget: 600_000 },
    rules: 'The implementor makes the change and hands it over; the reviewer reads the diff and reports problems before the job is called done. Keep the change small and in scope.',
  },
  {
    builtin: 'full-crew',
    name: 'Full team',
    description: 'A project manager, researcher, designer, implementor, tester and reviewer for a larger feature.',
    seats: [
      { preset: 'pm', count: 1 },
      { preset: 'researcher', count: 1 },
      { preset: 'designer', count: 1 },
      { preset: 'implementor', count: 1 },
      { preset: 'tester', count: 1 },
      { preset: 'reviewer', count: 1 },
    ],
    limits: { maxWorkers: 6, topTier: 'sonnet', tokenBudget: 2_000_000 },
    rules: 'The project manager splits the task and keeps the list. Research and design come first, then the implementor builds, the tester proves it works and the reviewer signs off. Each seat stays in its own lane.',
  },
  {
    builtin: 'research',
    name: 'Research',
    description: 'Two researchers look into a question in parallel and a reviewer checks their findings.',
    seats: [
      { preset: 'researcher', count: 2 },
      { preset: 'reviewer', count: 1 },
    ],
    limits: { maxWorkers: 3, topTier: 'sonnet', tokenBudget: 800_000 },
    rules: 'Researchers split the question and cite where each finding came from. They change no code. The reviewer checks the findings against the sources and flags gaps.',
  },
  {
    builtin: 'bug-fix',
    name: 'Bug fix',
    description: 'An implementor fixes the bug and a tester proves it is gone.',
    seats: [
      { preset: 'implementor', count: 1 },
      { preset: 'tester', count: 1 },
    ],
    limits: { maxWorkers: 2, topTier: 'sonnet', tokenBudget: 500_000 },
    rules: 'Reproduce the bug first with a failing test. The implementor makes the smallest fix; the tester confirms the test passes and nothing else broke.',
  },
  {
    builtin: 'design-build',
    name: 'Design to build',
    description: 'A designer shapes the change, an implementor builds it and a reviewer checks it.',
    seats: [
      { preset: 'designer', count: 1 },
      { preset: 'implementor', count: 1 },
      { preset: 'reviewer', count: 1 },
    ],
    limits: { maxWorkers: 3, topTier: 'sonnet', tokenBudget: 900_000 },
    rules: 'The designer settles the approach and the files first. The implementor builds exactly that. The reviewer checks the result against the design.',
  },
  {
    builtin: 'quality-pass',
    name: 'Quality pass',
    description: 'A tester and a reviewer check work that is already written.',
    seats: [
      { preset: 'tester', count: 1 },
      { preset: 'reviewer', count: 1 },
    ],
    limits: { maxWorkers: 2, topTier: 'sonnet', tokenBudget: 500_000 },
    rules: 'Change no code unless a fix is tiny and obvious. The tester runs the tests and tries to break it; the reviewer reads the diff. Report findings, ranked by severity.',
  },
  {
    builtin: 'build-review-opencode',
    name: 'Build and review (OpenCode)',
    description: 'Build and review on OpenCode seats, for a project whose master runs OpenCode.',
    seats: [
      { preset: 'implementor-opencode', count: 1 },
      { preset: 'reviewer-opencode', count: 1 },
    ],
    limits: { maxWorkers: 2, topTier: 'sonnet', tokenBudget: 600_000 },
    rules: 'The implementor makes the change and hands it over; the reviewer reads the diff and reports problems before the job is called done. Keep the change small and in scope.',
  },
]

// The seats a shipped team starts with, or null when a preset it needs has been deleted.
// A model the preset's CLI cannot run falls back to the CLI's own default (empty).
export function shippedSeats(def: ShippedTeam, byBuiltin: (key: string) => Preset | null): TeamSeat[] | null {
  const seats: TeamSeat[] = []
  for (const s of def.seats) {
    const preset = byBuiltin(s.preset)
    if (!preset) return null
    let model = s.model ?? preset.model
    try {
      if (model) validateModel(model, preset.agent)
    } catch {
      model = ''
    }
    const effort = s.effort ?? preset.effort
    seats.push({ presetId: preset.id, count: s.count, model, ...(effort ? { effort } : {}) })
  }
  return seats
}

// Team files

const FORMAT = 'operant-teams'
const FILE_MAX = 1_000_000
const TEAMS_MAX = 200
const NAME_MAX = 80
const TEXT_MAX = 20_000

export const teamKey = (t: Pick<Team, 'builtin' | 'name'>): string => t.builtin ?? `user:${t.name}`

export function exportTeams(store: Store, teams: Team[]): ExportText {
  const ref = (id: number) => {
    const p = store.getPreset(id)
    return p ? (p.builtin ?? p.name) : null
  }
  const out = teams.map((t) => ({
    key: teamKey(t),
    name: t.name,
    description: t.description,
    seats: t.seats.flatMap((s) => {
      const preset = ref(s.presetId)
      return preset ? [{ preset, count: s.count, model: s.model, effort: s.effort ?? '' }] : []
    }),
    limits: t.limits,
    rules: t.rules,
  }))
  const one = teams.length === 1 ? teams[0]!.name.replace(/[^\w-]+/g, '-').toLowerCase() : 'teams'
  return { filename: `operant-${one}.json`, mime: 'application/json', text: JSON.stringify({ format: FORMAT, version: 1, teams: out }, null, 2) }
}

export interface TeamImportItem {
  entry: TeamImportEntry
  input: TeamInput | null
}

// Reads a team file and says, per team, whether importing adds it, skips it (already there, by stable key
// or name) or refuses it (and why). Nothing is written.
export function parseTeamFile(store: Store, text: string): TeamImportItem[] {
  if (text.length > FILE_MAX) throw new RunError('BAD_ARGS', 'That file is too large to be a team file')
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    throw new RunError('BAD_ARGS', 'That file is not valid JSON')
  }
  const d = doc as { format?: unknown; teams?: unknown }
  if (!d || d.format !== FORMAT || !Array.isArray(d.teams)) throw new RunError('BAD_ARGS', 'That is not an Operant team file')
  if (d.teams.length > TEAMS_MAX) throw new RunError('BAD_ARGS', `A team file holds at most ${TEAMS_MAX} teams`)
  const existing = store.listTeams()
  const presets = store.listPresets()
  const seen = new Set<string>()
  return d.teams.map((raw: unknown, i): TeamImportItem => {
    const t = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const name = typeof t.name === 'string' ? t.name.trim() : ''
    const key = typeof t.key === 'string' && t.key.trim() ? t.key.trim() : `user:${name}`
    const entry: TeamImportEntry = { key, name: name || `Team ${i + 1}`, seats: Array.isArray(t.seats) ? t.seats.length : 0, action: 'add', reason: '' }
    const refuse = (reason: string): TeamImportItem => ({ entry: { ...entry, action: 'invalid', reason }, input: null })
    try {
      if (!name) return refuse('It has no name')
      if (name.length > NAME_MAX) return refuse(`The name is longer than ${NAME_MAX} characters`)
      const lower = name.toLowerCase()
      if (seen.has(key) || existing.some((e) => teamKey(e) === key || e.name.toLowerCase() === lower)) {
        return { entry: { ...entry, action: 'skip', reason: 'Already here' }, input: null }
      }
      const description = typeof t.description === 'string' ? t.description : ''
      const rules = typeof t.rules === 'string' ? t.rules : ''
      if (description.length > 500) return refuse('The description is longer than 500 characters')
      if (rules.length > TEXT_MAX) return refuse(`The rules are longer than ${TEXT_MAX} characters`)
      if (!Array.isArray(t.seats)) return refuse('It has no seat list')
      const seats = t.seats.map((s: Record<string, unknown>) => {
        const ref = typeof s?.preset === 'string' ? s.preset : ''
        const preset = presets.find((p) => p.builtin === ref) ?? presets.find((p) => p.name === ref)
        if (!preset) throw new RunError('NOT_FOUND', `The seat preset "${ref}" does not exist here`)
        return { presetId: preset.id, count: s.count as number, model: typeof s.model === 'string' ? s.model : '', effort: typeof s.effort === 'string' ? s.effort : '' }
      })
      const input: TeamInput = {
        name,
        description,
        rules,
        seats: cleanSeats(store, seats),
        limits: cleanLimits(t.limits ?? {}) as TeamLimits,
      }
      seen.add(key)
      return { entry, input }
    } catch (e) {
      return refuse(e instanceof Error ? e.message : String(e))
    }
  })
}
