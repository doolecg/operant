// The tile layout: a split tree of tile ids, saved per crew as opaque JSON through tiles:saveLayout.
// Ids: 'master' for the Master Terminal, `s:<scratchId>` for a scratch terminal. A tile in the tree is open.
export type SplitDir = 'row' | 'col'

export type LayoutNode = { type: 'leaf'; id: string } | { type: 'split'; dir: SplitDir; sizes: number[]; children: LayoutNode[] }

export interface TileLayout {
  version: 1
  root: LayoutNode
  fullscreen: string | null
}

export const MASTER = 'master'
export const scratchTile = (id: number) => `s:${id}`
export const scratchIdOf = (tile: string): number | null => {
  const m = /^s:(\d+)$/.exec(tile)
  return m ? Number(m[1]) : null
}

export const MIN_SIZE = 0.08

const leaf = (id: string): LayoutNode => ({ type: 'leaf', id })

const equalSizes = (n: number) => Array.from({ length: n }, () => 1 / n)

function parseNode(raw: unknown): LayoutNode | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (r.type === 'leaf') return typeof r.id === 'string' ? leaf(r.id) : null
  if (r.type !== 'split' || (r.dir !== 'row' && r.dir !== 'col') || !Array.isArray(r.children)) return null
  const children = r.children.map(parseNode).filter((c): c is LayoutNode => c !== null)
  if (children.length === 0) return null
  if (children.length === 1) return children[0]!
  const given =
    Array.isArray(r.sizes) && r.sizes.length === children.length && r.sizes.every((s) => typeof s === 'number' && s > 0)
      ? (r.sizes as number[])
      : null
  const total = given ? given.reduce((a, b) => a + b, 0) : 0
  return { type: 'split', dir: r.dir, sizes: given ? given.map((s) => s / total) : equalSizes(children.length), children }
}

export function leaves(node: LayoutNode): string[] {
  return node.type === 'leaf' ? [node.id] : node.children.flatMap(leaves)
}

function prune(node: LayoutNode, keep: (id: string) => boolean): LayoutNode | null {
  if (node.type === 'leaf') return keep(node.id) ? node : null
  const kids: LayoutNode[] = []
  const sizes: number[] = []
  node.children.forEach((c, i) => {
    const p = prune(c, keep)
    if (p) {
      kids.push(p)
      sizes.push(node.sizes[i]!)
    }
  })
  if (kids.length === 0) return null
  if (kids.length === 1) return kids[0]!
  const total = sizes.reduce((a, b) => a + b, 0)
  return { ...node, children: kids, sizes: sizes.map((s) => s / total) }
}

// Reads whatever was saved, drops tiles that no longer exist, and makes sure the Master Terminal is present.
export function normalizeLayout(raw: unknown, validScratch: ReadonlySet<number>): TileLayout {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  let root = parseNode(r.root)
  if (root) {
    const seen = new Set<string>()
    root = prune(root, (id) => {
      const sid = scratchIdOf(id)
      const ok = id === MASTER || (sid != null && validScratch.has(sid))
      if (!ok || seen.has(id)) return false
      seen.add(id)
      return true
    })
  }
  if (!root) root = leaf(MASTER)
  else if (!leaves(root).includes(MASTER)) root = { type: 'split', dir: 'row', sizes: [0.7, 0.3], children: [root, leaf(MASTER)] }
  const fullscreen = typeof r.fullscreen === 'string' && leaves(root).includes(r.fullscreen) ? r.fullscreen : null
  return { version: 1, root, fullscreen }
}

function replace(node: LayoutNode, id: string, fn: (l: LayoutNode) => LayoutNode): LayoutNode {
  if (node.type === 'leaf') return node.id === id ? fn(node) : node
  return { ...node, children: node.children.map((c) => replace(c, id, fn)) }
}

// A split inside a split of the same direction is merged into its parent.
function flatten(node: LayoutNode): LayoutNode {
  if (node.type === 'leaf') return node
  const kids: LayoutNode[] = []
  const sizes: number[] = []
  node.children.forEach((raw, i) => {
    const c = flatten(raw)
    if (c.type === 'split' && c.dir === node.dir) {
      c.children.forEach((g, j) => {
        kids.push(g)
        sizes.push(node.sizes[i]! * c.sizes[j]!)
      })
    } else {
      kids.push(c)
      sizes.push(node.sizes[i]!)
    }
  })
  return { ...node, children: kids, sizes }
}

// Puts `newId` beside `targetId` (split in `dir`), or at the end of the root when there is no target.
export function addTile(root: LayoutNode, newId: string, targetId: string | null, dir: SplitDir): LayoutNode {
  if (targetId && leaves(root).includes(targetId)) {
    return flatten(replace(root, targetId, (l) => ({ type: 'split', dir, sizes: [0.5, 0.5], children: [l, leaf(newId)] })))
  }
  if (root.type === 'split' && root.dir === dir) {
    const n = root.children.length
    const scale = n / (n + 1)
    return { ...root, children: [...root.children, leaf(newId)], sizes: [...root.sizes.map((s) => s * scale), 1 / (n + 1)] }
  }
  return { type: 'split', dir, sizes: [0.5, 0.5], children: [root, leaf(newId)] }
}

export function removeTile(root: LayoutNode, id: string): LayoutNode | null {
  const out = prune(root, (x) => x !== id)
  return out ? flatten(out) : null
}

export function swapTiles(root: LayoutNode, a: string, b: string): LayoutNode {
  if (a === b) return root
  const map = (n: LayoutNode): LayoutNode =>
    n.type === 'leaf' ? (n.id === a ? leaf(b) : n.id === b ? leaf(a) : n) : { ...n, children: n.children.map(map) }
  return map(root)
}

// `path` is the child indexes from the root to a split node.
export function setSizes(root: LayoutNode, path: number[], sizes: number[]): LayoutNode {
  if (root.type === 'leaf') return root
  if (path.length === 0) return { ...root, sizes }
  const [head, ...rest] = path
  return { ...root, children: root.children.map((c, i) => (i === head ? setSizes(c, rest, sizes) : c)) }
}

// Moves the handle between child `index` and `index + 1` by `delta` (a fraction of the split), keeping both above the minimum.
export function dragHandle(sizes: number[], index: number, delta: number): number[] {
  const pair = sizes[index]! + sizes[index + 1]!
  const next = Math.min(pair - MIN_SIZE, Math.max(MIN_SIZE, sizes[index]! + delta))
  const out = sizes.slice()
  out[index] = next
  out[index + 1] = pair - next
  return out
}
