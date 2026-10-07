import type { DatabaseSync } from 'node:sqlite'
import type { ProjectGroup } from '../shared/projects'

type Row = Record<string, unknown>

const NAME_MAX = 60
const toGroup = (r: Row): ProjectGroup => ({
  id: Number(r.id),
  name: String(r.name),
  sortOrder: Number(r.sort_order),
  collapsed: Number(r.collapsed) === 1,
})

// Named groups of projects and which one each project sits in. Groups only organise the list: removing one
// returns its projects to the plain list and touches nothing else. Refusals throw plain errors; core maps them to codes.
export class ProjectGroups {
  constructor(private readonly db: DatabaseSync) {}

  list(): ProjectGroup[] {
    return (this.db.prepare('SELECT * FROM project_groups ORDER BY sort_order, id').all() as Row[]).map(toGroup)
  }

  get(id: number): ProjectGroup {
    const row = this.db.prepare('SELECT * FROM project_groups WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new Error(`Group ${String(id)} not found`)
    return toGroup(row)
  }

  // "New group", "New group 2", ... the first one not taken.
  freeName(): string {
    const taken = new Set(this.list().map((g) => g.name.toLowerCase()))
    for (let n = 1; ; n++) {
      const name = n === 1 ? 'New group' : `New group ${n}`
      if (!taken.has(name.toLowerCase())) return name
    }
  }

  private clean(name: unknown, exceptId?: number): string {
    if (typeof name !== 'string' || !name.trim()) throw new Error('The group name cannot be empty')
    const t = name.trim()
    if (t.length > NAME_MAX) throw new Error(`The group name is longer than ${NAME_MAX} characters`)
    if (this.list().some((g) => g.id !== exceptId && g.name.toLowerCase() === t.toLowerCase())) throw new Error(`A group named "${t}" already exists`)
    return t
  }

  create(name?: string): ProjectGroup {
    const clean = name === undefined || (typeof name === 'string' && !name.trim()) ? this.freeName() : this.clean(name)
    const order = Number((this.db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM project_groups').get() as Row).n)
    return toGroup(this.db.prepare('INSERT INTO project_groups (name, sort_order) VALUES (?, ?) RETURNING *').get(clean, order) as Row)
  }

  rename(id: number, name: unknown): ProjectGroup {
    this.get(id)
    return toGroup(this.db.prepare('UPDATE project_groups SET name = ? WHERE id = ? RETURNING *').get(this.clean(name, id), id) as Row)
  }

  // Its projects become ungrouped (the column is set to NULL by the foreign key).
  delete(id: number): void {
    this.get(id)
    this.db.prepare('DELETE FROM project_groups WHERE id = ?').run(id)
  }

  setCollapsed(id: number, collapsed: boolean): ProjectGroup {
    this.get(id)
    return toGroup(this.db.prepare('UPDATE project_groups SET collapsed = ? WHERE id = ? RETURNING *').get(collapsed ? 1 : 0, id) as Row)
  }

  // The given groups take positions 1..n, any other group follows.
  reorder(ids: number[]): ProjectGroup[] {
    const current = this.list().map((g) => g.id)
    const first = ids.filter((id, i) => current.includes(id) && ids.indexOf(id) === i)
    const order = [...first, ...current.filter((id) => !first.includes(id))]
    const set = this.db.prepare('UPDATE project_groups SET sort_order = ? WHERE id = ?')
    order.forEach((id, i) => set.run(i + 1, id))
    return this.list()
  }

  // Puts a project in a group (null = ungrouped). With `beforeCrewId` it also takes that project's place in the
  // saved order, so a drop between two rows lands there; without it, it goes to the end of the group it joins.
  move(crewId: number, groupId: number | null, beforeCrewId?: number): void {
    if (!this.db.prepare('SELECT 1 FROM crews WHERE id = ?').get(crewId)) throw new Error(`Project ${String(crewId)} not found`)
    if (this.db.prepare("SELECT 1 FROM crews WHERE id = ? AND kind = 'playground'").get(crewId)) throw new Error('The Playground stays above the project list and cannot be grouped')
    if (groupId !== null) this.get(groupId)
    const before = (this.db.prepare('SELECT group_id FROM crews WHERE id = ?').get(crewId) as Row).group_id
    this.db.prepare('UPDATE crews SET group_id = ? WHERE id = ?').run(groupId, crewId)
    if (beforeCrewId === crewId || (beforeCrewId === undefined && before === groupId)) return
    const rows = (this.db.prepare('SELECT id, group_id FROM crews ORDER BY sort_order, id').all() as Row[]).filter((r) => Number(r.id) !== crewId)
    const ids = rows.map((r) => Number(r.id))
    // Without a place given, the project goes to the end of the group it joins.
    const at =
      beforeCrewId === undefined
        ? rows.findLastIndex((r) => (r.group_id == null ? null : Number(r.group_id)) === groupId) + 1
        : ids.indexOf(beforeCrewId)
    if (at <= 0 && beforeCrewId === undefined) return
    if (at < 0) return
    ids.splice(at, 0, crewId)
    const set = this.db.prepare('UPDATE crews SET sort_order = ? WHERE id = ?')
    ids.forEach((id, i) => set.run(i + 1, id))
  }
}
