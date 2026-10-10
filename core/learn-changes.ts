import type { DatabaseSync } from 'node:sqlite'
import type { LearnChange, LearnChangeKind, LearnChangeStatus } from '../shared/learn'

// Every automatic edit the learn step makes (or proposes) with the text it replaced, so a rollback can put it back.
// The table is created here, not in the store's migrations, so the learn step owns its own history.
export const LEARN_CHANGES_SQL = `CREATE TABLE IF NOT EXISTS learn_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  crew_id INTEGER,
  kind TEXT NOT NULL,
  target_id INTEGER NOT NULL DEFAULT 0,
  proposal TEXT NOT NULL DEFAULT '',
  evidence TEXT NOT NULL DEFAULT '',
  files_affected TEXT NOT NULL DEFAULT '[]',
  cli TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  tokens INTEGER NOT NULL DEFAULT 0,
  usd REAL NOT NULL DEFAULT 0,
  validation TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  previous TEXT NOT NULL DEFAULT '',
  next TEXT NOT NULL DEFAULT '',
  rolled_back_at INTEGER
)`

type Row = Record<string, unknown>

const toChange = (r: Row): LearnChange => ({
  id: Number(r.id),
  at: Number(r.at),
  crewId: r.crew_id == null ? null : Number(r.crew_id),
  kind: String(r.kind) as LearnChangeKind,
  targetId: Number(r.target_id),
  proposal: String(r.proposal),
  evidence: String(r.evidence),
  filesAffected: JSON.parse(String(r.files_affected)) as string[],
  cli: String(r.cli),
  model: String(r.model),
  tokens: Number(r.tokens),
  usd: Number(r.usd),
  validation: String(r.validation),
  status: String(r.status) as LearnChangeStatus,
  previous: String(r.previous),
  next: String(r.next),
  rolledBackAt: r.rolled_back_at == null ? null : Number(r.rolled_back_at),
})

export type NewChange = Omit<LearnChange, 'id' | 'at' | 'rolledBackAt'>

export class LearnChangesDb {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(LEARN_CHANGES_SQL)
  }

  add(c: NewChange): LearnChange {
    const row = this.db
      .prepare(
        `INSERT INTO learn_changes (at, crew_id, kind, target_id, proposal, evidence, files_affected, cli, model, tokens, usd, validation, status, previous, next)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        this.now(),
        c.crewId,
        c.kind,
        c.targetId,
        c.proposal,
        c.evidence,
        JSON.stringify(c.filesAffected),
        c.cli,
        c.model,
        c.tokens,
        c.usd,
        c.validation,
        c.status,
        c.previous,
        c.next,
      ) as Row
    return toChange(row)
  }

  get(id: number): LearnChange | null {
    const row = this.db.prepare('SELECT * FROM learn_changes WHERE id = ?').get(id) as Row | undefined
    return row ? toChange(row) : null
  }

  list(filter: { crewId?: number; status?: LearnChangeStatus } = {}): LearnChange[] {
    const where: string[] = []
    const args: Array<string | number> = []
    if (filter.crewId != null) {
      where.push('crew_id = ?')
      args.push(filter.crewId)
    }
    if (filter.status) {
      where.push('status = ?')
      args.push(filter.status)
    }
    const sql = `SELECT * FROM learn_changes${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC`
    return (this.db.prepare(sql).all(...args) as Row[]).map(toChange)
  }

  setStatus(id: number, status: LearnChangeStatus): LearnChange {
    const rolled = status === 'rolledBack' ? this.now() : null
    this.db.prepare('UPDATE learn_changes SET status = ?, rolled_back_at = COALESCE(?, rolled_back_at) WHERE id = ?').run(status, rolled, id)
    return this.get(id)!
  }

  // Restore only: replaces every record with the given ones, keeping their ids.
  replaceAll(changes: LearnChange[]): number {
    this.db.exec('DELETE FROM learn_changes')
    const ins = this.db.prepare(
      `INSERT INTO learn_changes (id, at, crew_id, kind, target_id, proposal, evidence, files_affected, cli, model, tokens, usd, validation, status, previous, next, rolled_back_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const c of changes) {
      ins.run(c.id, c.at, c.crewId, c.kind, c.targetId, c.proposal, c.evidence, JSON.stringify(c.filesAffected), c.cli, c.model, c.tokens, c.usd, c.validation, c.status, c.previous, c.next, c.rolledBackAt)
    }
    return changes.length
  }

  // Clears the records. Applied changes that were never rolled back keep their text in the lessons themselves.
  clear(crewId?: number): number {
    const r = crewId == null ? this.db.prepare('DELETE FROM learn_changes').run() : this.db.prepare('DELETE FROM learn_changes WHERE crew_id = ?').run(crewId)
    return Number(r.changes)
  }
}
