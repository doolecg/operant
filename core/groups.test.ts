import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectGroups } from './groups'
import { MIGRATIONS, Store } from './store'

describe('ProjectGroups', () => {
  let store: Store
  let groups: ProjectGroups

  beforeEach(() => {
    store = new Store(':memory:')
    groups = new ProjectGroups(store.db)
  })
  afterEach(() => store.close())

  const crews = (n: number) => Array.from({ length: n }, (_, i) => store.createCrew(`p${i + 1}`, `/code/p${i + 1}`))

  it('adds the tables as the last migration step and leaves existing projects ungrouped', () => {
    expect(store.schemaVersion).toBe(MIGRATIONS.length)
    const [a] = crews(1)
    expect(a!.groupId).toBeNull()
    expect(a!.prjNumber).toBe(1001)
  })

  it('names new groups New group, New group 2, ... and reuses a freed name', () => {
    expect(groups.create().name).toBe('New group')
    const second = groups.create()
    expect(second.name).toBe('New group 2')
    expect(groups.create('  ').name).toBe('New group 3')
    groups.delete(second.id)
    expect(groups.create().name).toBe('New group 2')
  })

  it('renames, and refuses an empty or duplicate name (case does not matter)', () => {
    const a = groups.create('Work')
    const b = groups.create('Play')
    expect(groups.rename(a.id, ' Client work ').name).toBe('Client work')
    expect(() => groups.rename(a.id, '')).toThrow(/cannot be empty/)
    expect(() => groups.rename(b.id, 'client WORK')).toThrow(/already exists/)
    expect(groups.rename(b.id, 'PLAY').name).toBe('PLAY')
    expect(() => groups.create('play')).toThrow(/already exists/)
    expect(() => groups.rename(999, 'x')).toThrow(/not found/)
  })

  it('moves projects in and out of groups and keeps the saved order', () => {
    const [a, b, c] = crews(3)
    const g = groups.create('Work')
    groups.move(c!.id, g.id, a!.id)
    expect(store.listCrews().map((x) => [x.name, x.groupId])).toEqual([
      ['p3', g.id],
      ['p1', null],
      ['p2', null],
    ])
    groups.move(a!.id, g.id)
    expect(store.getCrew(a!.id)!.groupId).toBe(g.id)
    groups.move(a!.id, null, b!.id)
    expect(store.listCrews().map((x) => x.name)).toEqual(['p3', 'p1', 'p2'])
    expect(store.getCrew(a!.id)!.groupId).toBeNull()
    groups.move(a!.id, g.id, b!.id)
    groups.move(b!.id, g.id)
    expect(store.listCrews().map((x) => [x.name, x.groupId])).toEqual([
      ['p3', g.id],
      ['p1', g.id],
      ['p2', g.id],
    ])
    // Nothing else is ungrouped, so it stays where it is; with another ungrouped project it goes after it.
    groups.move(a!.id, null)
    expect(store.listCrews().map((x) => [x.name, x.groupId])).toEqual([
      ['p3', g.id],
      ['p1', null],
      ['p2', g.id],
    ])
    groups.move(b!.id, null)
    expect(store.listCrews().map((x) => [x.name, x.groupId])).toEqual([
      ['p3', g.id],
      ['p1', null],
      ['p2', null],
    ])
    expect(() => groups.move(a!.id, 999)).toThrow(/not found/)
    expect(() => groups.move(999, g.id)).toThrow(/not found/)
  })

  it('deleting a group puts its projects back in the list and removes nothing else', () => {
    const [a, b] = crews(2)
    const g = groups.create('Work')
    groups.move(a!.id, g.id)
    groups.move(b!.id, g.id)
    groups.delete(g.id)
    expect(groups.list()).toEqual([])
    expect(store.listCrews().map((c) => [c.name, c.groupId])).toEqual([
      ['p1', null],
      ['p2', null],
    ])
  })

  it('saves group order and the collapsed flag', () => {
    const a = groups.create('A')
    const b = groups.create('B')
    const c = groups.create('C')
    expect(groups.reorder([c.id, a.id]).map((g) => g.name)).toEqual(['C', 'A', 'B'])
    expect(groups.reorder([b.id, b.id, 999]).map((g) => g.name)).toEqual(['B', 'C', 'A'])
    expect(groups.setCollapsed(a.id, true).collapsed).toBe(true)
    expect(groups.list().find((g) => g.id === a.id)!.collapsed).toBe(true)
    expect(groups.setCollapsed(a.id, false).collapsed).toBe(false)
  })

  it('deleting a project leaves its group in place', () => {
    const [a] = crews(1)
    const g = groups.create('Work')
    groups.move(a!.id, g.id)
    store.deleteCrew(a!.id)
    expect(groups.list().map((x) => x.name)).toEqual(['Work'])
  })
})
