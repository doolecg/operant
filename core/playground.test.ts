import { describe, expect, it } from 'vitest'
import { exportBundle } from './import'
import { findProject, projectLabel } from './discord-frontdesk'
import { PLAYGROUND_ROLE, masterRoleFile } from './master-plugin'
import { MIGRATIONS, PLAYGROUND_KEPT, Store } from './store'

describe('the Playground', () => {
  it('is seeded once, first in the list, with no PRJ number', () => {
    const store = new Store(':memory:')
    const a = store.ensurePlayground('/data/Playground')
    const b = store.ensurePlayground('/elsewhere')
    store.createCrew('shop', '/shop')
    expect(b.id).toBe(a.id)
    expect(store.listCrews().filter((c) => c.kind === 'playground')).toHaveLength(1)
    expect(store.listCrews()[0]).toMatchObject({ name: 'Playground', folder: '/data/Playground', prjNumber: 0, kind: 'playground', groupId: null })
    expect(store.createCrew('next', '/n').prjNumber).toBe(1002)
  })

  it('cannot be deleted and stays first when the list is reordered', () => {
    const store = new Store(':memory:')
    const pg = store.ensurePlayground('/pg')
    const a = store.createCrew('a', '/a')
    const b = store.createCrew('b', '/b')
    expect(() => store.deleteCrew(pg.id)).toThrow(PLAYGROUND_KEPT)
    expect(store.reorderCrews([b.id, a.id]).map((c) => c.name)).toEqual(['Playground', 'b', 'a'])
  })

  it('clears its runs and messages and leaves other projects alone', () => {
    const store = new Store(':memory:')
    const pg = store.ensurePlayground('/pg')
    const other = store.createCrew('other', '/o')
    for (const crewId of [pg.id, other.id]) {
      store.createRun({ crewId, task: 't', masterCli: 'claude' })
      store.createMessage({ crewId, fromKind: 'user', toKind: 'user', body: 'hi' })
    }
    store.clearCrewHistory(pg.id)
    expect([store.listRuns(pg.id).length, store.listMessages(pg.id).length]).toEqual([0, 0])
    expect([store.listRuns(other.id).length, store.listMessages(other.id).length]).toEqual([1, 1])
    expect(store.getCrew(pg.id)).not.toBeNull()
  })

  it('is exported as settings only and named without a PRJ number for Discord', () => {
    const store = new Store(':memory:')
    const pg = store.ensurePlayground('/pg')
    store.createCrew('shop', '/shop')
    expect(exportBundle(store, 1).projects.map((p) => p.name)).toEqual(['shop'])
    expect(projectLabel(pg)).toBe('Playground')
    expect(findProject(store.listCrews(), 'playground')?.id).toBe(pg.id)
  })

  it('gives the Master a general-purpose role and adds a unique migration', () => {
    const role = masterRoleFile('/roles', 'Role text', { name: 'Playground', kind: 'playground' }, 'linux')
    expect(role.content).toContain(PLAYGROUND_ROLE)
    expect(masterRoleFile('/roles', 'Role text', { name: 'shop' }, 'linux').content).toContain('Project: shop.')
    expect(new Set(MIGRATIONS).size).toBe(MIGRATIONS.length)
  })
})
