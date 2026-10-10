import type { DatabaseSync } from 'node:sqlite'
import type { DraftStatus, LearnRunInfo, LearnSkip, LearnStore, Lesson, LessonFilter, LessonKind, LessonPatch, LessonScope, LessonStatus, SkillDraft } from '../shared/learn'

// Appended to MIGRATIONS in store.ts (additive).
export const LESSONS_MIGRATION = `CREATE TABLE lessons (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     crew_id INTEGER NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
     text TEXT NOT NULL,
     kind TEXT NOT NULL,
     scope TEXT NOT NULL DEFAULT 'project',
     files TEXT NOT NULL DEFAULT '[]',
     symbols TEXT NOT NULL DEFAULT '[]',
     source_jobs TEXT NOT NULL DEFAULT '[]',
     stores TEXT NOT NULL DEFAULT '[]',
     status TEXT NOT NULL DEFAULT 'active',
     hits INTEGER NOT NULL DEFAULT 1,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX lessons_crew_status ON lessons (crew_id, status);
   CREATE TABLE skill_drafts (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     crew_id INTEGER NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     body TEXT NOT NULL,
     source_jobs TEXT NOT NULL DEFAULT '[]',
     status TEXT NOT NULL DEFAULT 'pending',
     installed_path TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE learn_runs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     crew_id INTEGER NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
     run_id INTEGER,
     source TEXT NOT NULL,
     at INTEGER NOT NULL,
     extracted INTEGER NOT NULL DEFAULT 0,
     written INTEGER NOT NULL DEFAULT 0,
     merged INTEGER NOT NULL DEFAULT 0,
     staled INTEGER NOT NULL DEFAULT 0,
     queued INTEGER NOT NULL DEFAULT 0,
     skipped TEXT NOT NULL DEFAULT '[]',
     error TEXT NOT NULL DEFAULT ''
   );`

// Which AI each learn run asked (additive).
export const LEARN_AI_MIGRATION = `ALTER TABLE learn_runs ADD COLUMN cli TEXT NOT NULL DEFAULT '';
   ALTER TABLE learn_runs ADD COLUMN model TEXT NOT NULL DEFAULT '';`

// A skill draft can be a fix to an installed skill (where it goes, the text it replaces) and remembers its lesson (additive).
export const SKILL_FIX_MIGRATION = `ALTER TABLE skill_drafts ADD COLUMN target_path TEXT NOT NULL DEFAULT '';
   ALTER TABLE skill_drafts ADD COLUMN previous_body TEXT NOT NULL DEFAULT '';
   ALTER TABLE skill_drafts ADD COLUMN lesson_id INTEGER NOT NULL DEFAULT 0;`

type Row = Record<string, unknown>

const list = (v: unknown): string[] => {
  try {
    const a: unknown = JSON.parse(String(v))
    return Array.isArray(a) ? a.map(String) : []
  } catch {
    return []
  }
}
const nums = (v: unknown): number[] => list(v).map(Number).filter((n) => Number.isFinite(n))

const toLesson = (r: Row): Lesson => ({
  id: Number(r.id),
  crewId: Number(r.crew_id),
  text: String(r.text),
  kind: r.kind as LessonKind,
  scope: r.scope as LessonScope,
  files: list(r.files),
  symbols: list(r.symbols),
  sourceJobs: nums(r.source_jobs),
  stores: list(r.stores) as LearnStore[],
  status: r.status as LessonStatus,
  hits: Number(r.hits),
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
})
const toDraft = (r: Row): SkillDraft => ({
  id: Number(r.id),
  crewId: Number(r.crew_id),
  name: String(r.name),
  body: String(r.body),
  sourceJobs: nums(r.source_jobs),
  status: r.status as DraftStatus,
  installedPath: String(r.installed_path),
  targetPath: String(r.target_path ?? ''),
  previousBody: String(r.previous_body ?? ''),
  lessonId: Number(r.lesson_id ?? 0),
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
})
const toRun = (r: Row): LearnRunInfo => ({
  id: Number(r.id),
  crewId: Number(r.crew_id),
  runId: r.run_id == null ? null : Number(r.run_id),
  source: r.source as 'job' | 'conversation',
  at: Number(r.at),
  extracted: Number(r.extracted),
  written: Number(r.written),
  merged: Number(r.merged),
  staled: Number(r.staled),
  queued: Number(r.queued),
  skipped: JSON.parse(String(r.skipped)) as LearnSkip[],
  error: String(r.error),
  cli: String(r.cli ?? ''),
  model: String(r.model ?? ''),
})

export interface NewLesson {
  crewId: number
  text: string
  kind: LessonKind
  scope: LessonScope
  files: string[]
  symbols: string[]
  sourceJobs: number[]
  status: LessonStatus
}

export type LessonUpdate = LessonPatch & { scope?: LessonScope; sourceJobs?: number[]; stores?: LearnStore[]; status?: LessonStatus; hits?: number }

const defined = (o: object): object => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

// Lessons, skill drafts and learn-run records, over the app's database.
export class LessonsDb {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}

  // Restore only: replaces every lesson and skill draft with the given rows, keeping their ids. Rows of a project
  // the caller does not allow are left out (their count is returned as `dropped`).
  replaceAll(lessons: Lesson[], drafts: SkillDraft[], allowed: (crewId: number) => boolean): { lessons: number; drafts: number; dropped: number } {
    let dropped = 0
    this.db.exec('BEGIN')
    try {
      this.db.exec('DELETE FROM lessons; DELETE FROM skill_drafts')
      const ins = this.db.prepare(
        'INSERT INTO lessons (id, crew_id, text, kind, scope, files, symbols, source_jobs, stores, status, hits, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      let nl = 0
      for (const l of lessons) {
        if (!allowed(l.crewId)) {
          dropped++
          continue
        }
        ins.run(l.id, l.crewId, l.text, l.kind, l.scope, JSON.stringify(l.files), JSON.stringify(l.symbols), JSON.stringify(l.sourceJobs), JSON.stringify(l.stores), l.status, l.hits, l.createdAt, l.updatedAt)
        nl++
      }
      const insD = this.db.prepare(
        'INSERT INTO skill_drafts (id, crew_id, name, body, source_jobs, status, installed_path, target_path, previous_body, lesson_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      let nd = 0
      for (const d of drafts) {
        if (!allowed(d.crewId)) {
          dropped++
          continue
        }
        insD.run(d.id, d.crewId, d.name, d.body, JSON.stringify(d.sourceJobs), d.status, d.installedPath, d.targetPath ?? '', d.previousBody ?? '', d.lessonId ?? 0, d.createdAt, d.updatedAt)
        nd++
      }
      this.db.exec('COMMIT')
      return { lessons: nl, drafts: nd, dropped }
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  addLesson(n: NewLesson): Lesson {
    const t = this.now()
    const r = this.db
      .prepare('INSERT INTO lessons (crew_id, text, kind, scope, files, symbols, source_jobs, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(n.crewId, n.text, n.kind, n.scope, JSON.stringify(n.files), JSON.stringify(n.symbols), JSON.stringify(n.sourceJobs), n.status, t, t)
    return this.getLesson(Number(r.lastInsertRowid))!
  }

  getLesson(id: number): Lesson | null {
    const r = this.db.prepare('SELECT * FROM lessons WHERE id = ?').get(id) as Row | undefined
    return r ? toLesson(r) : null
  }

  listLessons(f: LessonFilter = {}): Lesson[] {
    const where: string[] = []
    const args: Array<string | number> = []
    if (f.crewId != null) (where.push('crew_id = ?'), args.push(f.crewId))
    if (f.kind) (where.push('kind = ?'), args.push(f.kind))
    if (f.status) (where.push('status = ?'), args.push(f.status))
    const rows = this.db.prepare(`SELECT * FROM lessons ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC`).all(...args) as Row[]
    let out = rows.map(toLesson)
    if (f.store) out = out.filter((l) => l.stores.includes(f.store!))
    const q = f.search?.trim().toLowerCase()
    if (q) out = out.filter((l) => [l.text, ...l.files, ...l.symbols].some((s) => s.toLowerCase().includes(q)))
    return out
  }

  updateLesson(id: number, p: LessonUpdate): Lesson {
    const cur = this.getLesson(id)
    if (!cur) throw new Error(`No lesson ${id}`)
    const n = { ...cur, ...defined(p) } as Lesson
    this.db
      .prepare('UPDATE lessons SET text=?, kind=?, scope=?, files=?, symbols=?, source_jobs=?, stores=?, status=?, hits=?, updated_at=? WHERE id=?')
      .run(n.text, n.kind, n.scope, JSON.stringify(n.files), JSON.stringify(n.symbols), JSON.stringify(n.sourceJobs), JSON.stringify(n.stores), n.status, n.hits, this.now(), id)
    return this.getLesson(id)!
  }

  // `targetPath`: the installed skill file a fix rewrites ('' for a new skill). `lessonId`: the lesson the draft came from.
  addDraft(crewId: number, name: string, body: string, sourceJobs: number[], targetPath = '', lessonId = 0): SkillDraft {
    const t = this.now()
    const r = this.db
      .prepare('INSERT INTO skill_drafts (crew_id, name, body, source_jobs, target_path, lesson_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(crewId, name, body, JSON.stringify(sourceJobs), targetPath, lessonId, t, t)
    return this.getDraft(Number(r.lastInsertRowid))!
  }

  getDraft(id: number): SkillDraft | null {
    const r = this.db.prepare('SELECT * FROM skill_drafts WHERE id = ?').get(id) as Row | undefined
    return r ? toDraft(r) : null
  }

  listDrafts(crewId?: number, status?: DraftStatus): SkillDraft[] {
    const rows = this.db.prepare('SELECT * FROM skill_drafts ORDER BY id DESC').all() as Row[]
    return rows.map(toDraft).filter((d) => (crewId == null || d.crewId === crewId) && (!status || d.status === status))
  }

  updateDraft(id: number, p: Partial<Pick<SkillDraft, 'name' | 'body' | 'status' | 'installedPath' | 'sourceJobs' | 'previousBody'>>): SkillDraft {
    const cur = this.getDraft(id)
    if (!cur) throw new Error(`No skill draft ${id}`)
    const n = { ...cur, ...defined(p) } as SkillDraft
    this.db
      .prepare('UPDATE skill_drafts SET name=?, body=?, status=?, installed_path=?, source_jobs=?, previous_body=?, updated_at=? WHERE id=?')
      .run(n.name, n.body, n.status, n.installedPath, JSON.stringify(n.sourceJobs), n.previousBody, this.now(), id)
    return this.getDraft(id)!
  }

  deleteDraft(id: number): void {
    this.db.prepare('DELETE FROM skill_drafts WHERE id = ?').run(id)
  }

  addLearnRun(r: Omit<LearnRunInfo, 'id' | 'at'>): LearnRunInfo {
    const at = this.now()
    const res = this.db
      .prepare('INSERT INTO learn_runs (crew_id, run_id, source, at, extracted, written, merged, staled, queued, skipped, error, cli, model) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(r.crewId, r.runId, r.source, at, r.extracted, r.written, r.merged, r.staled, r.queued, JSON.stringify(r.skipped), r.error, r.cli, r.model)
    return { ...r, id: Number(res.lastInsertRowid), at }
  }

  lastLearnRun(crewId?: number): LearnRunInfo | null {
    const r = (crewId == null
      ? this.db.prepare('SELECT * FROM learn_runs ORDER BY id DESC LIMIT 1').get()
      : this.db.prepare('SELECT * FROM learn_runs WHERE crew_id = ? ORDER BY id DESC LIMIT 1').get(crewId)) as Row | undefined
    return r ? toRun(r) : null
  }
}
