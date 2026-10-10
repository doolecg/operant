import type { ExportText, Team, TeamImportEntry, TeamInput } from '../shared/types'
import type { Store } from './store'

// Teams that ship with Operant: plain guidance text (a name, a description and rules), no runner.
export interface ShippedTeam {
  builtin: string
  name: string
  description: string
  rules: string
}

// Built-in teams are guidance only: which presets to run together, who owns which files, how to hand off and where
// the review step sits. Nothing starts when a team is chosen; the user opens the terminals.
export const BUILTIN_TEAMS: ShippedTeam[] = [
  {
    builtin: 'solo',
    name: 'Solo',
    description: 'One Implement terminal for a small, well-specified change.',
    rules: 'Use Implement alone. Give it the goal, the files it owns and how to test it. Read the diff yourself before you accept it.',
  },
  {
    builtin: 'plan-build',
    name: 'Plan then build',
    description: 'Plan writes the steps, Implement builds them, Review checks each one.',
    rules: 'Plan writes a numbered list with a done-check and the owned files for each step. Build the steps in order, one Implement terminal per step; steps that own different files may run side by side. Give each file to one terminal only. Review each step against its done-check before the next one starts.',
  },
  {
    builtin: 'feature-squad',
    name: 'Feature squad',
    description: 'Research, Design, Implement, Test and Review, in that order.',
    rules: 'Research maps the code the feature touches. Design settles the structure and splits the work into parts that do not share a file. Implement builds each part in its own terminal, with its files written in its brief. Test covers each part in test files only. Review reads each part, then the whole change. Stop when Review reports no must-fix findings.',
  },
  {
    builtin: 'release',
    name: 'Release',
    description: 'Review checks the change, Release writes the notes and version, Learn saves the lessons.',
    rules: 'Review reads what will ship and must accept it before Release starts. Release edits only the release files, runs the build and tests, and commits nothing. The user commits, tags and publishes. Learn then saves the lessons from the release.',
  },
]

// Built-in teams of the set before this one that now have a new key (renamed), and those that are retired (hidden
// when still shipped, kept as the user's own team when edited).
export const TEAM_RENAMES: Record<string, string> = { 'full-crew': 'feature-squad', 'bug-fix': 'bug-hunt', 'design-build': 'plan-build', 'build-review': 'review-pair' }
export const RETIRED_TEAMS = ['research', 'quality-pass', 'build-review-opencode', 'bug-hunt', 'review-pair', 'refactor-tests']

// Team files

const FORMAT = 'operant-teams'
const FILE_MAX = 1_000_000
const TEAMS_MAX = 200
const NAME_MAX = 80
const TEXT_MAX = 20_000

export const teamKey = (t: Pick<Team, 'builtin' | 'name'>): string => t.builtin ?? `user:${t.name}`

export function exportTeams(_store: Store, teams: Team[]): ExportText {
  const out = teams.map((t) => ({
    key: teamKey(t),
    name: t.name,
    description: t.description,
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
  if (text.length > FILE_MAX) throw new Error('That file is too large to be a team file')
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    throw new Error('That file is not valid JSON')
  }
  const d = doc as { format?: unknown; teams?: unknown }
  if (!d || d.format !== FORMAT || !Array.isArray(d.teams)) throw new Error('That is not an Operant team file')
  if (d.teams.length > TEAMS_MAX) throw new Error(`A team file holds at most ${TEAMS_MAX} teams`)
  const existing = store.listTeams()
  const seen = new Set<string>()
  return d.teams.map((raw: unknown, i): TeamImportItem => {
    const t = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const name = typeof t.name === 'string' ? t.name.trim() : ''
    const key = typeof t.key === 'string' && t.key.trim() ? t.key.trim() : `user:${name}`
    const entry: TeamImportEntry = { key, name: name || `Team ${i + 1}`, action: 'add', reason: '' }
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
      const input: TeamInput = { name, description, rules }
      seen.add(key)
      return { entry, input }
    } catch (e) {
      return refuse(e instanceof Error ? e.message : String(e))
    }
  })
}
