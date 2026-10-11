import { describe, expect, it } from 'vitest'
import { ACTIONS_MAX, type BrowserAction } from '../../shared/browser'
import { BrowserHub, type BrowserHost } from './hub'

const host: BrowserHost = {
  ensureOpen: async () => {},
  newTab: async () => ({ tabId: 1, targetId: 't' }),
  closeTab: () => {},
  selectTab: () => {},
}

const begin = (hub: BrowserHub, crewId = 1, tool = 'browser_click') => hub.actionBegin(crewId, { tileId: 5, tool, summary: `${tool} x`, target: 'e1' })

describe('BrowserHub action log', () => {
  it('records running actions, ends them once, and pushes the list', () => {
    let now = 1000
    const hub = new BrowserHub({ host, now: () => now })
    const pushes: BrowserAction[][] = []
    hub.onActions((_c, list) => pushes.push(list))
    const id = begin(hub)
    now = 2000
    hub.actionEnd(1, id, 'done')
    hub.actionEnd(1, id, 'error')
    expect(hub.actions(1)).toEqual([{ id, crewId: 1, at: 1000, tileId: 5, tool: 'browser_click', summary: 'browser_click x', status: 'done', target: 'e1' }])
    expect(pushes.map((l) => l[0]?.status)).toEqual(['running', 'done'])
  })

  it('keeps projects apart and returns copies', () => {
    const hub = new BrowserHub({ host })
    begin(hub, 1)
    begin(hub, 2)
    expect(hub.actions(1)).toHaveLength(1)
    hub.actions(1)[0]!.status = 'error'
    expect(hub.actions(1)[0]?.status).toBe('running')
  })

  it('keeps only the last ACTIONS_MAX (200), oldest dropped first', () => {
    const hub = new BrowserHub({ host })
    const ids: number[] = []
    for (let i = 0; i < ACTIONS_MAX + 5; i++) ids.push(begin(hub))
    const list = hub.actions(1)
    expect(list).toHaveLength(ACTIONS_MAX)
    expect(list[0]?.id).toBe(ids[5])
    expect(list.at(-1)?.id).toBe(ids.at(-1))
    hub.actionEnd(1, ids[0]!, 'done')
    expect(hub.actions(1)).toHaveLength(ACTIONS_MAX)
  })

  it('omits the target fields when the call had none', () => {
    const hub = new BrowserHub({ host })
    hub.actionBegin(1, { tileId: 5, tool: 'browser_snapshot', summary: 'browser_snapshot' })
    expect('target' in hub.actions(1)[0]!).toBe(false)
  })

  it('owns the confirm broker and cancels its approvals on dispose', async () => {
    const hub = new BrowserHub({ host })
    const p = hub.confirms.request({ crewId: 1, tileId: 5, tool: 'x', summary: 's' }, new AbortController().signal)
    hub.dispose()
    await expect(p).resolves.toBe(false)
  })
})
