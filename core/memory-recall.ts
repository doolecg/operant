import type { MemorySettings } from '../shared/aux-settings'
import { SOUL_BANK, bankFor, type RecallResult } from './hindsight'

// Plain retrieval: no model call. The Soul Bank (global user preferences) and the project's bank, cut to the
// settings' topK and token budget (about four characters to a token).
export interface RecallSource {
  recall(bank: string, query: string, limit: number): Promise<RecallResult>
}

import type { RecallItem, RecallOutput } from '../shared/ops'

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

export async function recallMemory(src: RecallSource, folder: string | null, query: string, s: MemorySettings): Promise<RecallOutput> {
  const none = (error: string): RecallOutput => ({ items: [], text: '', truncated: false, error })
  if (s.recallMode === 'off') return none('Memory recall is off (Settings, Memory)')
  const q = query.trim()
  if (!q) return none('Nothing to recall: the query is empty')
  const asks: Array<Promise<{ bank: RecallItem['bank']; r: RecallResult }>> = []
  if (s.includeSoul) asks.push(src.recall(SOUL_BANK, q, s.topK).then((r) => ({ bank: 'soul' as const, r })))
  if (folder) asks.push(src.recall(bankFor(folder), q, s.topK).then((r) => ({ bank: 'project' as const, r })))
  const answers = await Promise.all(asks)
  const failed = answers.filter((a) => !a.r.ok)
  const items: RecallItem[] = []
  let budget = s.maxTokens
  let truncated = false
  for (const a of answers) {
    if (!a.r.ok) continue
    for (const text of a.r.items) {
      if (items.length >= s.topK) {
        truncated = true
        break
      }
      const cost = estimateTokens(text)
      if (cost > budget) {
        truncated = true
        break
      }
      budget -= cost
      items.push({ bank: a.bank, text })
    }
  }
  const error = answers.length > 0 && failed.length === answers.length && !items.length ? (failed[0]!.r as { error: string }).error : ''
  return { items, text: items.map((i) => i.text).join('\n\n'), truncated, error }
}
