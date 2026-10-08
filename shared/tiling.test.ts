import { describe, expect, it } from 'vitest'
import { hasTile, insertTile, promoteTile, removeTile, setRatio, tileIds, tileRects, toggleSplit, type Rect, type TileNode } from './tiling'

const A: Rect = { x: 0, y: 0, w: 1000, h: 600 }
const GAP = 10
type SplitNode = Extract<TileNode, { split: 'h' | 'v' }>

const build = (ids: string[], targets: (string | null)[] = []): TileNode | null => {
  let t: TileNode | null = null
  ids.forEach((id, i) => {
    t = insertTile(t, id, targets[i] ?? null, A, GAP)
  })
  return t
}
const rectOf = (t: TileNode | null, id: string, layout: 'dwindle' | 'master' = 'dwindle', mfact = 0.55): Rect =>
  tileRects(t, A, layout, mfact, GAP).get(id)!

describe('insertTile', () => {
  it('the first tile is a leaf filling the area', () => {
    const t = build(['m'])
    expect(t).toEqual({ tile: 'm' })
    expect(rectOf(t, 'm')).toEqual(A)
  })

  it('splits a wide tile side by side', () => {
    const t = build(['m', 'a'])
    expect(t).toEqual({ split: 'h', ratio: 0.5, a: { tile: 'm' }, b: { tile: 'a' } })
    expect(rectOf(t, 'm')).toEqual({ x: 0, y: 0, w: 495, h: 600 })
    expect(rectOf(t, 'a')).toEqual({ x: 505, y: 0, w: 495, h: 600 })
  })

  it('stacks when the target is not wider than 0.9x its height', () => {
    const t = build(['m', 'a', 'b'], [null, null, 'a'])
    expect(t).toEqual({
      split: 'h',
      ratio: 0.5,
      a: { tile: 'm' },
      b: { split: 'v', ratio: 0.5, a: { tile: 'a' }, b: { tile: 'b' } },
    })
    expect(rectOf(t, 'a')).toEqual({ x: 505, y: 0, w: 495, h: 295 })
    expect(rectOf(t, 'b')).toEqual({ x: 505, y: 305, w: 495, h: 295 })
  })

  it('without a target splits the last tile in tree order (dwindle)', () => {
    const t = build(['m', 'a', 'b', 'c', 'd'])
    expect(tileIds(t)).toEqual(['m', 'a', 'b', 'c', 'd'])
    // m | (a / (b | (c / d)))
    expect(rectOf(t, 'b').w).toBeCloseTo((495 - GAP) / 2, 5)
    expect(tileRects(t, A, 'dwindle', 0.55, GAP).size).toBe(5)
  })

  it('an unknown target falls back to the last tile', () => {
    expect(build(['m', 'a', 'b'], [null, null, 'zzz'])).toEqual(build(['m', 'a', 'b']))
  })

  it('threshold: exactly 0.9 wide-to-tall splits side by side', () => {
    const area: Rect = { x: 0, y: 0, w: 900, h: 1000 }
    expect(insertTile({ tile: 'a' }, 'b', 'a', area, 0)).toMatchObject({ split: 'h' })
    expect(insertTile({ tile: 'a' }, 'b', 'a', { ...area, w: 899 }, 0)).toMatchObject({ split: 'v' })
  })

  it('re-inserting a present tile changes nothing', () => {
    const t = build(['m', 'a'])!
    expect(insertTile(t, 'a', null, A, GAP)).toBe(t)
  })

  it('does not mutate the input tree', () => {
    const t = build(['m', 'a'])!
    const copy = JSON.parse(JSON.stringify(t))
    insertTile(t, 'b', 'm', A, GAP)
    expect(t).toEqual(copy)
  })
})

describe('removeTile', () => {
  it('the sibling takes the parent place', () => {
    const t = build(['m', 'a', 'b'], [null, null, 'a'])
    expect(removeTile(t, 'a')).toEqual({ split: 'h', ratio: 0.5, a: { tile: 'm' }, b: { tile: 'b' } })
    expect(removeTile(t, 'm')).toEqual({ split: 'v', ratio: 0.5, a: { tile: 'a' }, b: { tile: 'b' } })
  })

  it('removing the only tile empties the tree', () => {
    expect(removeTile({ tile: 'm' }, 'm')).toBeNull()
    expect(removeTile(null, 'm')).toBeNull()
  })

  it('an unknown tile leaves the tree as it is', () => {
    const t = build(['m', 'a', 'b'])!
    expect(removeTile(t, 'nope')).toEqual(t)
  })

  it('the remaining tiles fill the area again', () => {
    const left = removeTile(removeTile(build(['m', 'a', 'b', 'c']), 'b'), 'c')
    const total = [...tileRects(left, A, 'dwindle', 0.5, GAP).values()].reduce((n, r) => n + r.w * r.h, 0)
    expect(total).toBeCloseTo(990 * 600, 3)
  })
})

describe('toggleSplit and setRatio', () => {
  it('toggleSplit flips the parent split and the rect axis', () => {
    const t = build(['m', 'a'])!
    const f = toggleSplit(t, 'a')
    expect(f).toMatchObject({ split: 'v' })
    expect(rectOf(f, 'm')).toEqual({ x: 0, y: 0, w: 1000, h: 295 })
    expect(toggleSplit(f, 'a')).toEqual(t)
  })

  it('toggleSplit only changes the tile own parent', () => {
    const t = build(['m', 'a', 'b'], [null, null, 'a'])!
    const f = toggleSplit(t, 'b') as SplitNode
    expect(f.split).toBe('h')
    expect((f.b as SplitNode).split).toBe('h')
  })

  it('a lone tile or unknown tile is unchanged', () => {
    expect(toggleSplit({ tile: 'm' }, 'm')).toEqual({ tile: 'm' })
    const t = build(['m', 'a'])!
    expect(toggleSplit(t, 'x')).toEqual(t)
  })

  it('setRatio resizes and clamps', () => {
    const t = build(['m', 'a'])!
    expect(rectOf(setRatio(t, 'a', 0.25), 'm').w).toBeCloseTo(247.5, 5)
    expect((setRatio(t, 'm', 5) as SplitNode).ratio).toBe(0.9)
    expect((setRatio(t, 'm', -1) as SplitNode).ratio).toBe(0.1)
    expect((setRatio(t, 'm', NaN) as SplitNode).ratio).toBe(0.5)
  })
})

describe('tileRects', () => {
  it('null tree has no rects', () => {
    expect(tileRects(null, A, 'dwindle', 0.5, GAP).size).toBe(0)
    expect(tileRects(null, A, 'master', 0.5, GAP).size).toBe(0)
  })

  it('dwindle: 1 to 5 tiles stay inside the area and never overlap', () => {
    for (let n = 1; n <= 5; n++) {
      const ids = ['m', 'a', 'b', 'c', 'd'].slice(0, n)
      const rs = tileRects(build(ids), A, 'dwindle', 0.55, GAP)
      expect([...rs.keys()]).toEqual(ids)
      const list = [...rs.values()]
      list.forEach((r) => {
        expect(r.x).toBeGreaterThanOrEqual(0)
        expect(r.y).toBeGreaterThanOrEqual(0)
        expect(r.x + r.w).toBeLessThanOrEqual(1000.0001)
        expect(r.y + r.h).toBeLessThanOrEqual(600.0001)
      })
      for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length; j++) {
          const p = list[i]!
          const q = list[j]!
          const overlap = p.x < q.x + q.w - 1e-6 && q.x < p.x + p.w - 1e-6 && p.y < q.y + q.h - 1e-6 && q.y < p.y + p.h - 1e-6
          expect(overlap).toBe(false)
        }
    }
  })

  it('master: one tile fills the area', () => {
    expect(rectOf(build(['m']), 'm', 'master')).toEqual(A)
  })

  it('master: first tile left at mfact, the rest stacked right (2 to 5 tiles)', () => {
    for (let n = 2; n <= 5; n++) {
      const ids = ['m', 'a', 'b', 'c', 'd'].slice(0, n)
      const t = build(ids)
      const mw = 990 * 0.55
      expect(rectOf(t, 'm', 'master')).toEqual({ x: 0, y: 0, w: mw, h: 600 })
      const h = (600 - GAP * (n - 2)) / (n - 1)
      ids.slice(1).forEach((id, k) => {
        const r = rectOf(t, id, 'master')
        expect(r.x).toBeCloseTo(mw + GAP, 5)
        expect(r.w).toBeCloseTo(990 - mw, 5)
        expect(r.h).toBeCloseTo(h, 5)
        expect(r.y).toBeCloseTo(k * (h + GAP), 5)
      })
    }
  })

  it('master uses tree order, not the tree shape', () => {
    const t = build(['m', 'a', 'b'], [null, null, 'a'])
    expect(rectOf(t, 'a', 'master').y).toBeLessThan(rectOf(t, 'b', 'master').y)
  })

  it('honours the area offset', () => {
    const off: Rect = { x: 12, y: 8, w: 500, h: 300 }
    const t = insertTile({ tile: 'm' }, 'a', null, off, 0)
    const rs = tileRects(t, off, 'dwindle', 0.5, 0)
    expect(rs.get('m')).toEqual({ x: 12, y: 8, w: 250, h: 300 })
    expect(rs.get('a')).toEqual({ x: 262, y: 8, w: 250, h: 300 })
  })
})

describe('promoteTile and helpers', () => {
  it('swaps the tile with the first one', () => {
    const t = build(['m', 'a', 'b'])!
    expect(tileIds(promoteTile(t, 'b'))).toEqual(['b', 'a', 'm'])
    expect(promoteTile(t, 'm')).toBe(t)
    expect(promoteTile(t, 'x')).toBe(t)
  })

  it('hasTile', () => {
    const t = build(['m', 'a'])
    expect(hasTile(t, 'a')).toBe(true)
    expect(hasTile(t, 'z')).toBe(false)
    expect(hasTile(null, 'a')).toBe(false)
  })
})
