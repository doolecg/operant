import { memo } from 'react'
import type { Hat, Tint } from './agentView'

// An original 12x12 pixel critter (round body, two eyes, cheeks) with one of eight hats. Drawn as crisp rects.
const BODY = [
  '............',
  '............',
  '............',
  '............',
  '...BBBBBB...',
  '..BBBBBBBB..',
  '..BBeBBeBB..',
  '..BBBBBBBB..',
  '..BcBnnBcB..',
  '..BBBBBBBB..',
  '...BBBBBB...',
  '...f....f...',
]

// Each hat is drawn from row `at` downward over the body; '.' is see-through.
const HATS: Record<Hat, { at: number; rows: string[] }> = {
  cap: { at: 1, rows: ['...rrrrrr...', '..rrrrrrrr..', '..rrrrrrrrr.'] },
  hardhat: { at: 0, rows: ['....yyyy....', '...yyyyyy...', '..yyyyyyyy..', '.yyyyyyyyyy.'] },
  beanie: { at: 0, rows: ['.....ww.....', '...uuuuuu...', '..uuuuuuuu..', '..wwwwwwww..'] },
  chef: { at: 0, rows: ['...ww.ww....', '..wwwwwwww..', '..wwwwwwww..', '...wwwwww...', '...gggggg...'] },
  headphones: { at: 1, rows: ['...kkkkkk...', '..k......k..', '..k......k..', '.kk......kk.', '.kk......kk.'] },
  flag: { at: 0, rows: ['......rr....', '......rrrr..', '......rr....', '......k.....', '......k.....'] },
  bow: { at: 1, rows: ['....pp.pp...', '....ppppp...', '....pp.pp...'] },
  crown: { at: 1, rows: ['..o..oo..o..', '..oooooooo..', '..oooooooo..'] },
}

const BODY_COLORS: Record<Tint, { B: string; f: string; c: string }> = {
  coral: { B: '#f28b78', f: '#d4685a', c: '#ffc2b5' },
  peach: { B: '#f8b896', f: '#dc946f', c: '#ffd9c7' },
  butter: { B: '#f4cf8a', f: '#d5a85a', c: '#ffe3b8' },
}
const FIXED: Record<string, string> = { e: '#3a2a2a', n: '#7a3b3b', r: '#e0463c', y: '#f2c230', u: '#4d8fe0', w: '#fbf7f0', g: '#b9b3a8', k: '#3b3f4a', p: '#f06fa6', o: '#f5b82e' }

function pixels(hat: Hat, tint: Tint): Array<{ x: number; y: number; c: string }> {
  const grid = BODY.map((r) => r.split(''))
  const h = HATS[hat]
  h.rows.forEach((row, i) => {
    row.split('').forEach((ch, x) => {
      if (ch !== '.') grid[h.at + i]![x] = ch
    })
  })
  const colors = { ...FIXED, ...BODY_COLORS[tint] }
  const out: Array<{ x: number; y: number; c: string }> = []
  grid.forEach((row, y) => row.forEach((ch, x) => ch !== '.' && colors[ch as keyof typeof colors] && out.push({ x, y, c: colors[ch as keyof typeof colors] })))
  return out
}

const reduced = (): boolean => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

export const Critter = memo(function Critter({ hat, tint, bob, size = 36 }: { hat: Hat; tint: Tint; bob: boolean; size?: number }) {
  const px = pixels(hat, tint)
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" shapeRendering="crispEdges" aria-hidden className="shrink-0">
      <g>
        {px.map((p) => (
          <rect key={`${p.x},${p.y}`} x={p.x} y={p.y} width={1} height={1} fill={p.c} />
        ))}
        {bob && !reduced() && <animateTransform attributeName="transform" type="translate" values="0 0;0 -0.5;0 0" dur="1.2s" repeatCount="indefinite" calcMode="discrete" />}
      </g>
    </svg>
  )
})
