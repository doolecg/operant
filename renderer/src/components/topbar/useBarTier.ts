import { useCallback, useEffect, useRef, useState } from 'react'

// How much of the top bar fits, from its width in CSS px (so it follows the UI scale). Each step takes one more thing away:
// 1 the media controls (cover and title stay), 2 the clock date, 3 the brand text, 4 the status labels, 5 the media block,
// 6 the clock, 7 the view switcher and the terminal CLI pick become menus.
export const barTier = (w: number): number => (w >= 1540 ? 0 : w >= 1440 ? 1 : w >= 1340 ? 2 : w >= 1220 ? 3 : w >= 1100 ? 4 : w >= 1000 ? 5 : w >= 860 ? 6 : 7)

export function useBarTier(): [(el: HTMLElement | null) => void, number] {
  const [tier, setTier] = useState(0)
  const obs = useRef<ResizeObserver | null>(null)
  useEffect(() => () => obs.current?.disconnect(), [])
  const ref = useCallback((el: HTMLElement | null) => {
    obs.current?.disconnect()
    if (!el) return
    const o = new ResizeObserver(([e]) => e && setTier(barTier(e.contentRect.width + 24)))
    o.observe(el)
    obs.current = o
  }, [])
  return [ref, tier]
}
