import type { Store } from './store'

const DAY_MS = 86_400_000

export interface PurgeSettings {
  purgeRetentionDays: number
  purgeEnabled: boolean
}

export interface PurgeEligibility {
  ok: boolean
  blockers: string[]
}

export interface PurgeEvent {
  kind: 'operator-purged' | 'squad-purged'
  crewId: number | null
  operatorId: number | null
  squadId: number | null
  label: string
}

export interface PurgeResult extends PurgeEligibility {
  operatorId: number
  label: string
  purged: boolean
  squadPurged: boolean
  squadId: number | null
}

export interface PurgeSummary {
  purged: number[]
  squadsPurged: number[]
  skipped: PurgeResult[]
}

export interface PurgeOptions {
  store: Store
  now: () => number
  settings: () => PurgeSettings
  emit?: (event: PurgeEvent) => void
}

interface Row {
  [key: string]: unknown
}

// The purge rule for soft-deleted operators: eligibility, the spend archive fold, the sweep and the
// manual "Purge now". Timer-free; the host calls `sweep()` at startup and on an interval.
export class Purger {
  constructor(private readonly o: PurgeOptions) {}

  private get db() {
    return this.o.store.db
  }

  private count(sql: string, ...args: number[]): number {
    return Number((this.db.prepare(sql).get(...args) as Row).n)
  }

  // `ignoreRetention` is the manual path; the data-safety blockers always apply.
  eligible(operatorId: number, ignoreRetention = false): PurgeEligibility {
    const row = this.db.prepare('SELECT deleted_at FROM operators WHERE id = ?').get(operatorId) as Row | undefined
    if (!row) return { ok: false, blockers: ['operator not found'] }
    if (row.deleted_at == null) return { ok: false, blockers: ['operator is live, not deleted'] }
    const blockers: string[] = []

    const jobs = this.count(
      `SELECT COUNT(*) AS n FROM jobs WHERE state IN ('doing', 'review', 'held') AND (assignee_id = ? OR reviewer_id = ?)`,
      operatorId,
      operatorId,
    )
    if (jobs > 0) blockers.push(`${jobs} job${jobs === 1 ? '' : 's'} in doing, review or held`)

    const unread = this.count(
      'SELECT COUNT(*) AS n FROM messages WHERE read_at IS NULL AND (from_id = ? OR to_id = ?)',
      operatorId,
      operatorId,
    )
    if (unread > 0) blockers.push(`${unread} unread message${unread === 1 ? '' : 's'}`)

    if (!ignoreRetention) {
      const days = Math.max(0, this.o.settings().purgeRetentionDays)
      const newest = Number(
        (this.db.prepare('SELECT MAX(at) AS t FROM usage WHERE operator_id = ?').get(operatorId) as Row).t ?? 0,
      )
      const last = Math.max(Number(row.deleted_at), newest)
      const left = last + days * DAY_MS - this.o.now()
      if (left > 0) blockers.push(`retention: ${Math.ceil(left / DAY_MS)} day(s) left of ${days}`)
    }
    return { ok: blockers.length === 0, blockers }
  }

  // Soft-deleted operators with no blocker at all, for the Settings list.
  eligibleIds(): number[] {
    return this.deletedIds().filter((id) => this.eligible(id).ok)
  }

  private deletedIds(): number[] {
    return (this.db.prepare('SELECT id FROM operators WHERE deleted_at IS NOT NULL ORDER BY id').all() as Row[]).map((r) => Number(r.id))
  }

  private purge(operatorId: number, ignoreRetention: boolean): PurgeResult {
    const label = this.o.store.operatorAddress(operatorId, true) ?? `operator ${operatorId}`
    const check = this.eligible(operatorId, ignoreRetention)
    const result: PurgeResult = { ...check, operatorId, label, purged: false, squadPurged: false, squadId: null }
    if (!check.ok) return result
    const crewId = this.o.store.crewIdOfOperator(operatorId, true)
    const squad = this.db.prepare('SELECT squad_id, (SELECT deleted_at FROM squads WHERE id = squad_id) AS sq FROM operators WHERE id = ?').get(operatorId) as Row
    const squadId = Number(squad.squad_id)
    result.squadId = squadId
    // Folds the spend into spend_archive and removes the row in one transaction.
    this.o.store.purgeOperator(operatorId)
    result.purged = true
    this.announce({ kind: 'operator-purged', crewId, operatorId, squadId: null, label }, `Purged deleted operator ${label}`)
    if (squad.sq != null && this.o.store.purgeSquadIfEmpty(squadId)) {
      result.squadPurged = true
      this.announce({ kind: 'squad-purged', crewId, operatorId: null, squadId, label: `squad ${squadId}` }, `Removed empty deleted squad (id ${squadId})`)
    }
    return result
  }

  private announce(event: PurgeEvent, text: string): void {
    this.o.store.addEvent('purge', text, event.crewId, null)
    this.o.emit?.(event)
  }

  // Auto-purge pass: only soft-deleted operators past retention with no blocker. Safe to repeat.
  sweep(): PurgeSummary {
    const summary: PurgeSummary = { purged: [], squadsPurged: [], skipped: [] }
    if (!this.o.settings().purgeEnabled) return summary
    for (const id of this.deletedIds()) {
      const r = this.purge(id, false)
      if (r.purged) {
        summary.purged.push(id)
        if (r.squadPurged) summary.squadsPurged.push(r.squadId!)
      } else summary.skipped.push(r)
    }
    return summary
  }

  // Manual purge: ignores retention and `purgeEnabled`, never the data-safety blockers (the spec gives
  // the user no override, so `force` does not lift them; it only asks for a re-check ignoring retention).
  purgeNow(target: number | 'all', _opts: { force?: boolean } = {}): PurgeResult[] {
    const ids = target === 'all' ? this.deletedIds() : [target]
    return ids.map((id) => this.purge(id, true))
  }
}
