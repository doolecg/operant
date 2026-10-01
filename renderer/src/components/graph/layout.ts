import type { GraphEdge, GraphNode, GraphNodeType } from '@shared/types'

export const NODE_SIZE: Record<GraphNodeType, { width: number; height: number }> = {
  crew: { width: 180, height: 48 },
  squad: { width: 160, height: 44 },
  operator: { width: 220, height: 92 },
  master: { width: 200, height: 56 },
  user: { width: 120, height: 44 },
}

export interface XY {
  x: number
  y: number
}

// Top-left positions for every node. The crew sits on top, its squads side by side below it and each squad's
// operators stacked in a column, so a crew stays compact however many operators it has. The user and the Master
// sit beside the crew.
export function autoLayout(nodes: GraphNode[], edges: GraphEdge[]): Map<string, XY> {
  const GAP_X = 90
  const GAP_Y = 36
  const children = new Map<string, GraphNode[]>()
  const byKey = new Map(nodes.map((n) => [n.key, n]))
  for (const e of edges) {
    if (e.kind !== 'member') continue
    const child = byKey.get(e.to)
    if (!child || !byKey.has(e.from)) continue
    children.set(e.from, [...(children.get(e.from) ?? []), child])
  }
  const out = new Map<string, XY>()
  const colWidth = Math.max(NODE_SIZE.operator.width, NODE_SIZE.squad.width)
  const squads = (children.get('crew') ?? []).filter((n) => n.type === 'squad')
  const side = (children.get('crew') ?? []).filter((n) => n.type !== 'squad')
  const rowY = NODE_SIZE.crew.height + GAP_Y
  const totalWidth = Math.max(1, squads.length) * colWidth + Math.max(0, squads.length - 1) * GAP_X
  squads.forEach((sq, i) => {
    const x = i * (colWidth + GAP_X)
    out.set(sq.key, { x: x + (colWidth - NODE_SIZE.squad.width) / 2, y: rowY })
    let y = rowY + NODE_SIZE.squad.height + GAP_Y
    for (const op of children.get(sq.key) ?? []) {
      out.set(op.key, { x: x + (colWidth - NODE_SIZE.operator.width) / 2, y })
      y += NODE_SIZE.operator.height + GAP_Y
    }
  })
  out.set('crew', { x: Math.round((totalWidth - NODE_SIZE.crew.width) / 2), y: 0 })
  let sideX = Math.round((totalWidth + NODE_SIZE.crew.width) / 2) + GAP_X
  for (const n of [...side, ...nodes.filter((n) => n.type === 'user')]) {
    out.set(n.key, { x: sideX, y: Math.round((NODE_SIZE.crew.height - NODE_SIZE[n.type].height) / 2) })
    sideX += NODE_SIZE[n.type].width + GAP_X
  }
  for (const n of nodes) if (!out.has(n.key)) out.set(n.key, { x: totalWidth + GAP_X, y: rowY })
  for (const [k, p] of out) out.set(k, { x: Math.round(p.x), y: Math.round(p.y) })
  return out
}
