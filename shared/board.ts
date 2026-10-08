// Pure helpers for the Workspace board: which column a run sits in and what the owner's inbox holds.
import type { Run } from './types'

export type BoardColumn = 'queued' | 'working' | 'needs-you' | 'review' | 'done'

export const BOARD_COLUMNS: BoardColumn[] = ['queued', 'working', 'needs-you', 'review', 'done']

// failed runs sit in the Done column (with a red edge).
export function columnOf(run: Pick<Run, 'status'>): BoardColumn {
  return run.status === 'failed' ? 'done' : run.status
}

export type InboxKind = 'question' | 'permission' | 'master' | 'review' | 'failed'
export interface InboxItem {
  runId: number
  kind: InboxKind
  text: string
  at: number
}

const TEXT_MAX = 160

const oneLine = (s: string, fallback: string): string => {
  const line = s
    .split('\n')
    .map((l) => l.replace(/^[#>*\-\s]+/, '').trim())
    .find((l) => l !== '')
  if (!line) return fallback
  return line.length > TEXT_MAX ? `${line.slice(0, TEXT_MAX - 1)}…` : line
}

// What needs the owner, oldest first: open questions, permission prompts, a stopped Master, review requests and
// failures (a failure leaves once its run id is in `seen`). Derived from runs; nothing is stored.
export function inboxItems(runs: Run[], seen: ReadonlySet<number>): InboxItem[] {
  const out: InboxItem[] = []
  for (const r of runs) {
    const started = r.startedAt ?? r.createdAt
    if (r.status === 'needs-you') {
      if (r.waiting === 'permission') out.push({ runId: r.id, kind: 'permission', text: 'Waiting at a permission prompt', at: started })
      else if (r.waiting === 'master') out.push({ runId: r.id, kind: 'master', text: 'The Master Terminal stopped', at: started })
      else out.push({ runId: r.id, kind: 'question', text: oneLine(r.question, 'Waiting for your answer'), at: started })
    } else if (r.status === 'review') {
      out.push({ runId: r.id, kind: 'review', text: oneLine(r.reviewSummary, 'Ready for your review'), at: r.finishedAt ?? started })
    } else if (r.status === 'failed' && !seen.has(r.id)) {
      out.push({ runId: r.id, kind: 'failed', text: oneLine(r.outcome, 'The run failed'), at: r.finishedAt ?? started })
    }
  }
  return out.sort((a, b) => a.at - b.at || a.runId - b.runId)
}

// The failures the owner already looked at or dismissed, kept locally as a run id list.
export function parseSeen(raw: string | null): number[] {
  if (!raw) return []
  try {
    const v: unknown = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n)) : []
  } catch {
    return []
  }
}

// Drops ids whose run no longer exists.
export const pruneSeen = (seen: Iterable<number>, existing: ReadonlySet<number>): number[] => [...seen].filter((id) => existing.has(id))
