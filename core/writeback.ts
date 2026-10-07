import type { Run } from '../shared/types'
import { bankFor, runCommand, type HindsightService } from './hindsight'

export type Git = (folder: string, args: string[]) => Promise<string>

export const realGit: Git = async (folder, args) => {
  const r = await runCommand('git', args, { cwd: folder, timeoutMs: 20_000 })
  if (r.code !== 0) throw new Error(r.stderr.trim().split(/\r?\n/)[0] || `git exited ${r.code ?? 'abnormally'}`)
  return r.stdout
}

const FILE_CAP = 30
const SYMBOL_CAP = 40

export interface DiffInfo {
  files: string[]
  symbols: string[]
}

const DECL =
  /^\+\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|class|interface|type|enum|def|fn|func|struct|trait|const|let)\s+([A-Za-z_$][\w$]*)/

// Files and symbols a job touched: tracked changes against HEAD, untracked files, and, from the diff,
// declarations added on a line and the function named in each hunk header. Never throws.
export async function diffInfo(git: Git, folder: string): Promise<DiffInfo> {
  const files = new Set<string>()
  const symbols = new Set<string>()
  const safe = async (args: string[]) => {
    try {
      return await git(folder, args)
    } catch {
      return ''
    }
  }
  for (const f of (await safe(['diff', '--name-only', 'HEAD'])).split(/\r?\n/)) if (f.trim()) files.add(f.trim())
  for (const f of (await safe(['ls-files', '--others', '--exclude-standard'])).split(/\r?\n/)) if (f.trim()) files.add(f.trim())
  for (const line of (await safe(['diff', '-U0', 'HEAD'])).split(/\r?\n/)) {
    const hunk = /^@@ [^@]*@@\s*(.*)$/.exec(line)
    const decl = hunk ? DECL.exec('+' + hunk[1]) : DECL.exec(line)
    if (decl?.[1] && decl[1].length >= 3) symbols.add(decl[1])
  }
  return { files: [...files].slice(0, FILE_CAP), symbols: [...symbols].slice(0, SYMBOL_CAP) }
}

export function writebackTags(run: Run, d: DiffInfo): string[] {
  return ['operant', `job:${run.id}`, `status:${run.status}`, ...d.files.map((f) => `file:${f}`), ...d.symbols.map((s) => `symbol:${s}`)]
}

export interface WritebackDeps {
  hindsight: Pick<HindsightService, 'retain'>
  git: Git
  // Re-syncs the project's CodeGraph index.
  reindex: (folder: string) => Promise<unknown>
}

export interface WritebackResult {
  hindsight: 'written' | string
  codegraph: 'synced' | string
  tags: string[]
}

// On finish: the outcome goes to the project's Hindsight bank tagged with the diff's files and symbols,
// then CodeGraph re-syncs. Each store is tried on its own; a skipped one is reported, never thrown.
export async function writeBack(deps: WritebackDeps, run: Run, folder: string): Promise<WritebackResult> {
  const diff = await diffInfo(deps.git, folder)
  const tags = writebackTags(run, diff)
  const lines = [
    `JOB#${run.id} ${run.status}: ${run.task}`,
    `Outcome: ${run.outcome || '(none)'}`,
    diff.files.length ? `Files changed: ${diff.files.join(', ')}` : 'No files changed.',
    diff.symbols.length ? `Symbols touched: ${diff.symbols.join(', ')}` : '',
  ].filter(Boolean)
  const result: WritebackResult = { hindsight: 'written', codegraph: 'synced', tags }
  try {
    const r = await deps.hindsight.retain(bankFor(folder), lines.join('\n'), tags)
    if (!r.ok) result.hindsight = `skipped: ${r.error}`
  } catch (err) {
    result.hindsight = `skipped: ${err instanceof Error ? err.message : String(err)}`
  }
  try {
    await deps.reindex(folder)
  } catch (err) {
    result.codegraph = `skipped: ${err instanceof Error ? err.message : String(err)}`
  }
  return result
}
