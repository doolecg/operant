import type { Lesson } from '../shared/learn'
import type { McpDown, Run } from '../shared/types'
import { describeDown } from './mcp'
import { bankFor, runCommand, type HindsightService, type HindsightDeps } from './hindsight'
import { lessonsSection } from './lessons'
import type { Store } from './store'

export type ExploreResult = { ok: true; text: string } | { ok: false; error: string }

// CodeGraph explore for a project folder. The default shells out to the `codegraph` CLI.
export interface Explorer {
  explore(folder: string, query: string): Promise<ExploreResult>
}

const EXPLORE_CAP = 12_000

export function cliExplorer(run: HindsightDeps['run'] = runCommand): Explorer {
  return {
    async explore(folder, query) {
      const r = await run('codegraph', ['explore', query], { cwd: folder, timeoutMs: 30_000 })
      if (r.code !== 0) {
        const why = `${r.stderr}\n${r.stdout}`.trim().split(/\r?\n/)[0]
        return { ok: false, error: why || `codegraph exited ${r.code ?? 'abnormally'}` }
      }
      const text = r.stdout.trim()
      return text ? { ok: true, text: text.slice(0, EXPLORE_CAP) } : { ok: false, error: 'CodeGraph found nothing for these symbols' }
    },
  }
}

const SYMBOL_CAP = 12
const STOP = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'when', 'should', 'make', 'add', 'fix', 'use', 'new', 'all'])

// Symbols and file names a task mentions: `backticked` words, CamelCase and snake_case names, camelCase
// names with a capital inside, and paths. Only [A-Za-z0-9_./-] survives, so the list is safe to pass to a CLI.
export function extractSymbols(task: string): string[] {
  const found: string[] = []
  const add = (s: string) => {
    const t = s.replace(/^[./-]+|[.,;:/-]+$/g, '')
    if (t.length < 3 || !/^[A-Za-z0-9_./-]+$/.test(t) || STOP.has(t.toLowerCase()) || found.includes(t)) return
    found.push(t)
  }
  for (const m of task.matchAll(/`([^`\s]+)`/g)) add(m[1]!)
  for (const m of task.matchAll(/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+|[A-Za-z0-9_-]+\.[a-z]{1,5}\b/g)) add(m[0])
  for (const m of task.matchAll(/\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b|\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+\b/g)) add(m[0])
  return found.slice(0, SYMBOL_CAP)
}

export const BRIEF_RULES = [
  'Query Hindsight before you act: the memory below is a start, and you can recall more.',
  'Use CodeGraph (`codegraph explore`) before grep, find or reading files to locate and understand code.',
  'A memory is a past record, not the truth: check it against the CodeGraph source. If they disagree, trust the code and write a correction to Hindsight.',
]

export interface BriefDeps {
  store: Store
  hindsight: Pick<HindsightService, 'recall'>
  explorer: Explorer
  // MCP servers the seats picked that are down; the job starts anyway and the brief names them.
  mcpDown?: (run: Run) => Promise<McpDown[]>
  // Active lessons from past jobs that match the task's symbols and files.
  lessons?: (run: Run, symbols: string[]) => Lesson[]
}

export interface Brief {
  text: string
  // What could not be included; empty when both parts are present.
  missing: Array<'codegraph' | 'hindsight'>
}

function seatLines(store: Store, run: Run): string[] {
  return run.seats.map((s) => {
    const p = store.getPreset(s.presetId)
    const name = p?.name ?? `preset ${s.presetId}`
    const extra = [p?.roleText ? `role: ${p.roleText}` : '', p?.skills?.length ? `skills: ${p.skills.join(', ')}` : ''].filter(Boolean)
    return `${s.count} x ${name} on ${s.model}${extra.length ? ` (${extra.join('; ')})` : ''}`
  })
}

// The Master's first prompt: the task, the seats to run as subagents, rules, then the CodeGraph and Hindsight parts.
// A service that is down or empty is named in the brief; the job never waits on it or fails because of it.
export async function buildBrief(deps: BriefDeps, run: Run): Promise<Brief> {
  const crew = deps.store.getCrew(run.crewId)
  const symbols = extractSymbols(run.task)
  const query = symbols.join(' ')
  const missing: Brief['missing'] = []

  const codegraph = async (): Promise<string> => {
    if (!crew) return 'CodeGraph: not available (project not found).'
    if (!symbols.length) return 'CodeGraph: no symbols named in the task, so nothing was explored up front. Explore as you start.'
    try {
      const r = await deps.explorer.explore(crew.folder, query)
      if (r.ok) return `CodeGraph explore for ${query}:\n${r.text}`
      missing.push('codegraph')
      return `CodeGraph: MISSING (${r.error}). Use grep and file reads for now.`
    } catch (err) {
      missing.push('codegraph')
      return `CodeGraph: MISSING (${err instanceof Error ? err.message : String(err)}). Use grep and file reads for now.`
    }
  }
  const hindsight = async (): Promise<string> => {
    if (!crew) return 'Hindsight: not available (project not found).'
    try {
      const r = await deps.hindsight.recall(bankFor(crew.folder), [run.task, ...symbols].join('\n').slice(0, 2000))
      if (r.ok) return r.items.length ? `Hindsight recall:\n${r.items.map((i) => `- ${i}`).join('\n')}` : 'Hindsight recall: nothing stored yet for this task.'
      missing.push('hindsight')
      return `Hindsight: MISSING (${r.error}). Work without past memory and say so in your outcome.`
    } catch (err) {
      missing.push('hindsight')
      return `Hindsight: MISSING (${err instanceof Error ? err.message : String(err)}). Work without past memory and say so in your outcome.`
    }
  }
  const [cg, hs] = await Promise.all([codegraph(), hindsight()])

  const parts = [run.task]
  const seats = seatLines(deps.store, run)
  if (seats.length) parts.push(`Run these seats as your own subagents: ${seats.join('; ')}.`)
  if (run.rules) parts.push(`Team rules: ${run.rules}`)
  parts.push(`Rules:\n${BRIEF_RULES.map((r) => `- ${r}`).join('\n')}`)
  if (missing.length) parts.push(`Brief note: ${missing.map((m) => (m === 'codegraph' ? 'CodeGraph' : 'Hindsight')).join(' and ')} could not be reached, so that part is missing below.`)
  const down = await deps.mcpDown?.(run).catch(() => [] as McpDown[])
  if (down?.length) parts.push(`MCP servers down: ${describeDown(down)}. The job is starting anyway: do without them, and say in your outcome what you could not do.`)
  let learned: Lesson[] = []
  try {
    learned = deps.lessons?.(run, symbols) ?? []
  } catch {
    // lessons are a bonus: the brief goes out without them
  }
  parts.push(hs)
  if (learned.length) parts.push(lessonsSection(learned))
  parts.push(cg)
  return { text: parts.join('\n\n'), missing }
}
