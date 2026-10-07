import { useEffect, useState } from 'react'
import { bridge } from './bridge'

export const SCALE_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]

// Automatic scale: the UI is laid out for about 1600x900, so a bigger window (a maximized 1080p or 1440p screen)
// grows it in step. The window's outer size is not affected by the page zoom, so this does not feed back on itself.
export function autoScale(width: number, height: number): number {
  const f = Math.min(width / 1600, height / 900)
  return Math.round(Math.min(1.75, Math.max(1, f)) * 20) / 20
}

export const effectiveScale = (setting: number) => (setting > 0 ? setting : autoScale(window.outerWidth, window.outerHeight))

// The next fixed scale above or below the one in use.
export function stepScale(current: number, dir: 1 | -1): number {
  const next = dir > 0 ? SCALE_STEPS.find((s) => s > current + 0.001) : [...SCALE_STEPS].reverse().find((s) => s < current - 0.001)
  return next ?? (dir > 0 ? SCALE_STEPS[SCALE_STEPS.length - 1]! : SCALE_STEPS[0]!)
}

// Applies the UI scale setting to the window, live, and follows the window size while it is automatic.
export function useUiScale(setting: number | undefined): number {
  const [scale, setScale] = useState(1)
  useEffect(() => {
    if (setting === undefined) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const apply = () => {
      const f = effectiveScale(setting)
      bridge().setZoom(f)
      setScale(f)
    }
    apply()
    if (setting > 0) return
    const onResize = () => {
      clearTimeout(timer)
      timer = setTimeout(apply, 120)
    }
    window.addEventListener('resize', onResize)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('resize', onResize)
    }
  }, [setting])
  return scale
}
