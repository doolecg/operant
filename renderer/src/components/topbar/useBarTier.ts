import { useCallback, useEffect, useRef, useState } from 'react'

// How much of the top bar fits, from its width in CSS px (so it follows the UI scale):
// 0 all, 1 full-size media drops volume and shuffle, 2 status labels and date go, 3 status and alerts collapse into one menu,
// 4 no media, 5 no clock, 6 the mode toggle becomes a menu.
export const barTier = (w: number): number => (w >= 1400 ? 0 : w >= 1250 ? 1 : w >= 1100 ? 2 : w >= 900 ? 3 : w >= 760 ? 4 : w >= 620 ? 5 : 6)

export function useBarTier(): [(el: HTMLElement | null) => void, number] {
  const [tier, setTier] = useState(0)
  const obs = useRef<ResizeObserver | null>(null)
  useEffect(() => () => obs.current?.disconnect(), [])
  const ref = useCallback((el: HTMLElement | null) => {
    obs.current?.disconnect()
    if (!el) return
    const o = new ResizeObserver(([e]) => e && setTier(barTier(e.contentRect.width + 28)))
    o.observe(el)
    obs.current = o
  }, [])
  return [ref, tier]
}
