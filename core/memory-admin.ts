import type { MemorySettings } from '../shared/aux-settings'
import type { LearnStatus } from '../shared/learn'
import type { MemoryDiagnostics, MemoryExport, ResetResult } from '../shared/ops'
import type { AuxBudget } from './aux-budget'
import { SOUL_BANK, bankFor, type HindsightService, type RecallResult } from './hindsight'
import type { LearnService } from './learn'

// Memory management: export, reset (with an explicit confirm) and the diagnostics summary.
export type { MemoryDiagnostics, MemoryExport, ResetResult }
export type MemoryHindsight = Pick<HindsightService, 'recall' | 'status' | 'test' | 'deleteBank'>

export interface MemoryAdminDeps {
  learn: LearnService
  hindsight: MemoryHindsight
  crews: () => Array<{ id: number; name: string; folder: string }>
  memory: () => MemorySettings
  learnMode: () => string
  aux: AuxBudget
  now: () => number
}

// What Hindsight gave for one bank: its entries (as far as recall reaches) or why it could not be read.
type BankRead = { bank: string; ok: true; items: string[] } | { bank: string; ok: false; error: string }

const EXPORT_LIMIT = 200
const reading = async (h: MemoryHindsight, bank: string, query: string): Promise<BankRead> => {
  const r: RecallResult = await h.recall(bank, query, EXPORT_LIMIT).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }))
  return r.ok ? { bank, ok: true, items: r.items } : { bank, ok: false, error: r.error }
}

export async function exportMemory(d: MemoryAdminDeps): Promise<MemoryExport> {
  const crews = d.crews()
  const lessons = d.learn.lessons({})
  const soul = await reading(d.hindsight, SOUL_BANK, 'user preferences and facts about the user')
  const projects = await Promise.all(
    crews.map(async (c) => ({ crewId: c.id, name: c.name, folder: c.folder, ...(await reading(d.hindsight, bankFor(c.folder), 'lessons learned in this project')) })),
  )
  const stamp = new Date(d.now()).toISOString()
  const doc = { format: 'operant-memory', version: 1, exportedAt: stamp, lessons, hindsight: { soul, projects } }
  return { filename: `operant-memory-${stamp.slice(0, 10)}.json`, text: JSON.stringify(doc, null, 2) }
}

// Wipes a bank or everything. Refused without `confirm: true`. Each step reports on its own: a Hindsight bank the
// server refuses to delete is named as not wiped, and the Operant side still goes on.
export async function resetMemory(d: MemoryAdminDeps, req: { scope: 'soul' | 'project' | 'all'; crewId?: number; confirm: boolean }): Promise<ResetResult> {
  if (req.confirm !== true) throw new Error('Reset needs confirm: true')
  const steps: ResetResult['steps'] = []
  const crews = d.crews().filter((c) => req.crewId == null || c.id === req.crewId)
  if (req.scope === 'soul' || req.scope === 'all') {
    const r = await d.hindsight.deleteBank(SOUL_BANK)
    steps.push({ target: `Hindsight bank ${SOUL_BANK}`, ok: r.ok, error: r.ok ? '' : r.error })
  }
  if (req.scope === 'project' || req.scope === 'all') {
    for (const c of crews) {
      const r = await d.hindsight.deleteBank(bankFor(c.folder))
      steps.push({ target: `Hindsight bank for ${c.name}`, ok: r.ok, error: r.ok ? '' : r.error })
      let n = 0
      for (const l of d.learn.lessons({ crewId: c.id })) {
        if (l.status === 'deleted') continue
        try {
          await d.learn.setLessonStatus(l.id, 'deleted')
          n++
        } catch (err) {
          steps.push({ target: `Lesson ${l.id} of ${c.name}`, ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      }
      steps.push({ target: `${n} lessons of ${c.name}`, ok: true, error: '' })
    }
  }
  return { steps }
}

// A summary, read-only. Hindsight's entry count is what a recall returns (capped), since no count call is confirmed.
export async function memoryDiagnostics(d: MemoryAdminDeps, learnStatus: LearnStatus): Promise<MemoryDiagnostics> {
  const hs = await d.hindsight.status().catch((e: unknown) => ({ state: 'error' as const, detail: e instanceof Error ? e.message : String(e) }))
  const test = await d.hindsight.test().catch(() => null)
  const soulEntries = await reading(d.hindsight, SOUL_BANK, 'user preferences')
  const banks: MemoryDiagnostics['banks'] = [
    { bank: SOUL_BANK, name: 'Soul Bank', lessons: d.learn.lessons({}).filter((l) => l.scope === 'user' && l.status !== 'deleted').length, hindsightEntries: soulEntries.ok ? soulEntries.items.length : null, hindsightError: soulEntries.ok ? '' : soulEntries.error },
  ]
  for (const c of d.crews()) {
    const r = await reading(d.hindsight, bankFor(c.folder), 'lessons learned in this project')
    banks.push({
      bank: bankFor(c.folder),
      name: c.name,
      lessons: d.learn.lessons({ crewId: c.id }).filter((l) => l.status !== 'deleted').length,
      hindsightEntries: r.ok ? r.items.length : null,
      hindsightError: r.ok ? '' : r.error,
    })
  }
  return {
    recall: d.memory(),
    hindsight: { state: hs.state, detail: hs.detail, banks: test?.info ?? '' },
    banks,
    lastRun: learnStatus.lastRun,
    learnMode: d.learnMode(),
    spend: d.aux.status(),
  }
}
