import { describe, expect, it } from 'vitest'
import { syncTiles } from './tileSync'
import { tileIds } from './tiling'

const area = { x: 0, y: 0, w: 1000, h: 600 }

describe('syncTiles', () => {
  it('starts with the Master alone', () => {
    expect(tileIds(syncTiles(null, [], area, 6, null))).toEqual(['master'])
  })
  it('adds new tiles after the Master and keeps the tree when nothing changes', () => {
    const a = syncTiles(null, ['scratch:1', 'agent:1:2'], area, 6, null)
    expect(tileIds(a)).toEqual(['master', 'scratch:1', 'agent:1:2'])
    expect(syncTiles(a, ['scratch:1', 'agent:1:2'], area, 6, null)).toBe(a)
  })
  it('removes tiles that are gone but never the Master', () => {
    const a = syncTiles(null, ['scratch:1', 'agent:1:2'], area, 6, null)
    expect(tileIds(syncTiles(a, ['agent:1:2'], area, 6, null))).toEqual(['master', 'agent:1:2'])
    expect(tileIds(syncTiles(a, [], area, 6, null))).toEqual(['master'])
  })
})
