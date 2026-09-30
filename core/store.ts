import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  AgentKind,
  OperantEvent,
  Squad,
  Crew,
  CrewTopology,
  Operator,
  OperatorStatus,
  Task,
  TaskState,
  Usage,
} from '../shared/types'

// Append-only: each entry runs once, in order, tracked by PRAGMA user_version.
const MIGRATIONS: string[] = [
  `CREATE TABLE crews (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     folder TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE squads (
     id INTEGER PRIMARY KEY,
     crew_id INTEGER NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     UNIQUE (crew_id, name)
   );
   CREATE TABLE operators (
     id INTEGER PRIMARY KEY,
     squad_id INTEGER NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
     role TEXT NOT NULL,
     agent TEXT NOT NULL,
     model TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'stopped'
   );
   CREATE TABLE tasks (
     id INTEGER PRIMARY KEY,
     crew_id INTEGER NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
     operator_id INTEGER REFERENCES operators(id) ON DELETE SET NULL,
     title TEXT NOT NULL,
     state TEXT NOT NULL DEFAULT 'todo',
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE usage (
     id INTEGER PRIMARY KEY,
     operator_id INTEGER NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
     at INTEGER NOT NULL,
     input_tokens INTEGER NOT NULL DEFAULT 0,
     output_tokens INTEGER NOT NULL DEFAULT 0,
     cache_tokens INTEGER NOT NULL DEFAULT 0,
     cost_usd REAL NOT NULL DEFAULT 0
   );
   CREATE INDEX usage_operator_at ON usage (operator_id, at);
   CREATE TABLE events (
     id INTEGER PRIMARY KEY,
     crew_id INTEGER REFERENCES crews(id) ON DELETE CASCADE,
     operator_id INTEGER REFERENCES operators(id) ON DELETE SET NULL,
     kind TEXT NOT NULL,
     message TEXT NOT NULL,
     at INTEGER NOT NULL
   );
   CREATE INDEX events_at ON events (at);`,
  // Usage is recorded per API message so re-reading a transcript never double counts.
  `ALTER TABLE usage ADD COLUMN message_id TEXT;
   CREATE UNIQUE INDEX usage_operator_message ON usage (operator_id, message_id);`,
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
]

type Row = Record<string, unknown>

const toCrew = (r: Row): Crew => ({
  id: Number(r.id),
  name: String(r.name),
  folder: String(r.folder),
  createdAt: Number(r.created_at),
})
const toSquad = (r: Row): Squad => ({ id: Number(r.id), crewId: Number(r.crew_id), name: String(r.name) })
const toOperator = (r: Row): Operator => ({
  id: Number(r.id),
  squadId: Number(r.squad_id),
  role: String(r.role),
  agent: r.agent as AgentKind,
  model: String(r.model),
  status: r.status as OperatorStatus,
})
const toTask = (r: Row): Task => ({
  id: Number(r.id),
  crewId: Number(r.crew_id),
  operatorId: r.operator_id == null ? null : Number(r.operator_id),
  title: String(r.title),
  state: r.state as TaskState,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
})
const toUsage = (r: Row): Usage => ({
  id: Number(r.id),
  operatorId: Number(r.operator_id),
  at: Number(r.at),
  inputTokens: Number(r.input_tokens),
  outputTokens: Number(r.output_tokens),
  cacheTokens: Number(r.cache_tokens),
  costUsd: Number(r.cost_usd),
})
const toEvent = (r: Row): OperantEvent => ({
  id: Number(r.id),
  crewId: r.crew_id == null ? null : Number(r.crew_id),
  operatorId: r.operator_id == null ? null : Number(r.operator_id),
  kind: String(r.kind),
  message: String(r.message),
  at: Number(r.at),
})

export class Store {
  readonly db: DatabaseSync

  constructor(file: string, private readonly now: () => number = Date.now) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA foreign_keys = ON')
    if (file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL')
    this.migrate()
  }

  get schemaVersion(): number {
    return Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version)
  }

  private migrate(): void {
    for (let v = this.schemaVersion; v < MIGRATIONS.length; v++) {
      this.db.exec('BEGIN')
      try {
        this.db.exec(MIGRATIONS[v]!)
        this.db.exec(`PRAGMA user_version = ${v + 1}`)
        this.db.exec('COMMIT')
      } catch (err) {
        this.db.exec('ROLLBACK')
        throw err
      }
    }
  }

  close(): void {
    this.db.close()
  }

  // Crews

  createCrew(name: string, folder: string): Crew {
    const row = this.db
      .prepare('INSERT INTO crews (name, folder, created_at) VALUES (?, ?, ?) RETURNING *')
      .get(name, folder, this.now()) as Row
    return toCrew(row)
  }

  listCrews(): Crew[] {
    return (this.db.prepare('SELECT * FROM crews ORDER BY name').all() as Row[]).map(toCrew)
  }

  getCrew(id: number): Crew | null {
    const row = this.db.prepare('SELECT * FROM crews WHERE id = ?').get(id) as Row | undefined
    return row ? toCrew(row) : null
  }

  deleteCrew(id: number): void {
    this.db.prepare('DELETE FROM crews WHERE id = ?').run(id)
  }

  topology(crewId: number): CrewTopology | null {
    const crew = this.getCrew(crewId)
    if (!crew) return null
    const squads = (this.db.prepare('SELECT * FROM squads WHERE crew_id = ? ORDER BY id').all(crewId) as Row[]).map(toSquad)
    const operators = (
      this.db
        .prepare('SELECT s.* FROM operators s JOIN squads p ON p.id = s.squad_id WHERE p.crew_id = ? ORDER BY s.id')
        .all(crewId) as Row[]
    ).map(toOperator)
    return { ...crew, squads: squads.map((p) => ({ ...p, operators: operators.filter((s) => s.squadId === p.id) })) }
  }

  // Squads and operators

  createSquad(crewId: number, name: string): Squad {
    return toSquad(this.db.prepare('INSERT INTO squads (crew_id, name) VALUES (?, ?) RETURNING *').get(crewId, name) as Row)
  }

  createOperator(squadId: number, role: string, agent: AgentKind, model: string): Operator {
    const row = this.db
      .prepare('INSERT INTO operators (squad_id, role, agent, model) VALUES (?, ?, ?, ?) RETURNING *')
      .get(squadId, role, agent, model) as Row
    return toOperator(row)
  }

  getOperator(id: number): Operator | null {
    const row = this.db.prepare('SELECT * FROM operators WHERE id = ?').get(id) as Row | undefined
    return row ? toOperator(row) : null
  }

  setOperatorStatus(id: number, status: OperatorStatus): void {
    this.db.prepare('UPDATE operators SET status = ? WHERE id = ?').run(status, id)
  }

  crewIdOfOperator(operatorId: number): number | null {
    const row = this.db
      .prepare('SELECT p.crew_id FROM operators s JOIN squads p ON p.id = s.squad_id WHERE s.id = ?')
      .get(operatorId) as Row | undefined
    return row ? Number(row.crew_id) : null
  }

  // Stable address in the form role@crew, as OpenCrew uses.
  operatorAddress(operatorId: number): string | null {
    const row = this.db
      .prepare(
        'SELECT s.role, r.name FROM operators s JOIN squads p ON p.id = s.squad_id JOIN crews r ON r.id = p.crew_id WHERE s.id = ?',
      )
      .get(operatorId) as Row | undefined
    return row ? `${row.role}@${row.name}` : null
  }

  // Tasks

  createTask(crewId: number, title: string, operatorId: number | null = null): Task {
    const t = this.now()
    const row = this.db
      .prepare('INSERT INTO tasks (crew_id, operator_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING *')
      .get(crewId, operatorId, title, t, t) as Row
    return toTask(row)
  }

  listTasks(crewId: number): Task[] {
    return (this.db.prepare('SELECT * FROM tasks WHERE crew_id = ? ORDER BY id').all(crewId) as Row[]).map(toTask)
  }

  moveTask(id: number, state: TaskState): void {
    this.db.prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?').run(state, this.now(), id)
  }

  // Usage

  addUsage(u: Omit<Usage, 'id'>): Usage {
    const row = this.db
      .prepare(
        'INSERT INTO usage (operator_id, at, input_tokens, output_tokens, cache_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?) RETURNING *',
      )
      .get(u.operatorId, u.at, u.inputTokens, u.outputTokens, u.cacheTokens, u.costUsd) as Row
    return toUsage(row)
  }

  upsertMessageUsage(messageId: string, u: Omit<Usage, 'id'>): void {
    this.db
      .prepare(
        `INSERT INTO usage (operator_id, message_id, at, input_tokens, output_tokens, cache_tokens, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (operator_id, message_id) DO UPDATE SET
           input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
           cache_tokens = excluded.cache_tokens, cost_usd = excluded.cost_usd`,
      )
      .run(u.operatorId, messageId, u.at, u.inputTokens, u.outputTokens, u.cacheTokens, u.costUsd)
  }

  // Spend per operator of a crew in fixed-width time buckets from `since`, for sparklines.
  spendSeries(crewId: number, since: number, bucketMs: number, buckets: number): Array<{ operatorId: number; buckets: number[]; total: number }> {
    const rows = this.db
      .prepare(
        `SELECT u.operator_id, CAST((u.at - ?) / ? AS INTEGER) AS b, SUM(u.cost_usd) AS cost
         FROM usage u JOIN operators s ON s.id = u.operator_id JOIN squads p ON p.id = s.squad_id
         WHERE p.crew_id = ? AND u.at >= ?
         GROUP BY u.operator_id, b`,
      )
      .all(since, bucketMs, crewId, since) as Row[]
    const byOperator = new Map<number, number[]>()
    for (const r of rows) {
      const operatorId = Number(r.operator_id)
      const b = Number(r.b)
      if (b < 0 || b >= buckets) continue
      const arr = byOperator.get(operatorId) ?? Array<number>(buckets).fill(0)
      arr[b] = (arr[b] ?? 0) + Number(r.cost)
      byOperator.set(operatorId, arr)
    }
    return [...byOperator].map(([operatorId, arr]) => ({ operatorId, buckets: arr, total: arr.reduce((a, c) => a + c, 0) }))
  }

  spendSince(since: number, crewId?: number): number {
    const row = (
      crewId == null
        ? this.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage WHERE at >= ?').get(since)
        : this.db
            .prepare(
              `SELECT COALESCE(SUM(u.cost_usd), 0) AS total FROM usage u
               JOIN operators s ON s.id = u.operator_id JOIN squads p ON p.id = s.squad_id
               WHERE u.at >= ? AND p.crew_id = ?`,
            )
            .get(since, crewId)
    ) as Row
    return Number(row.total)
  }

  // Settings: one JSON document under a key.

  getJson(key: string): unknown {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined
    if (!row) return undefined
    try {
      return JSON.parse(String(row.value))
    } catch {
      return undefined
    }
  }

  setJson(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value))
  }

  // Events

  addEvent(kind: string, message: string, crewId: number | null = null, operatorId: number | null = null): OperantEvent {
    const row = this.db
      .prepare('INSERT INTO events (crew_id, operator_id, kind, message, at) VALUES (?, ?, ?, ?, ?) RETURNING *')
      .get(crewId, operatorId, kind, message, this.now()) as Row
    return toEvent(row)
  }

  recentEvents(limit: number): OperantEvent[] {
    return (this.db.prepare('SELECT * FROM events ORDER BY at DESC, id DESC LIMIT ?').all(limit) as Row[]).map(
      toEvent,
    )
  }
}
