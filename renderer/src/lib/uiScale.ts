import { useEffect, useState } from 'react'
import { bridge } from './bridge'

export const SCALE_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]

// Automatic scale: the UI is laid out for about 1600x900, so a bigger window (a maximized 1080p or 1440p screen)
// grows it in step.
export function autoScale(width: number, height: number): number {
  const f = Math.min(width / 1600, height / 900)
  return Math.round(Math.min(1.75, Math.max(1, f)) * 20) / 20
}

// The zoom the page was last set to. The page's viewport is the window's content size divided by it.
let appliedZoom = 1

// The window's content size in CSS pixels. Taken from the page's own viewport, not the window's outer size: the outer
// size includes the frame and lags a maximize, restore or full-screen change, which left the scale a step behind.
export function contentSize(): { width: number; height: number } {
  return { width: window.innerWidth * appliedZoom, height: window.innerHeight * appliedZoom }
}

export const effectiveScale = (setting: number) => {
  if (setting > 0) return setting
  const { width, height } = contentSize()
  return autoScale(width, height)
}

// The next fixed scale above or below the one in use.
export function stepScale(current: number, dir: 1 | -1): number {
  const next = dir > 0 ? SCALE_STEPS.find((s) => s > current + 0.001) : [...SCALE_STEPS].reverse().find((s) => s < current - 0.001)
  return next ?? (dir > 0 ? SCALE_STEPS[SCALE_STEPS.length - 1]! : SCALE_STEPS[0]!)
}

// Applies the UI scale setting to the window, live, and follows the window size while it is automatic. The page's
// root element is watched rather than the window's resize event: its size changes whenever the viewport does (a
// maximize, a restore, a full-screen change, a zoom change), after the layout has caught up with it.
export function useUiScale(setting: number | undefined): number {
  const [scale, setScale] = useState(1)
  useEffect(() => {
    if (setting === undefined) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const apply = () => {
      const f = effectiveScale(setting)
      appliedZoom = f
      bridge().setZoom(f)
      setScale(f)
    }
    apply()
    if (setting > 0) return
    const ro = new ResizeObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(apply, 120)
    })
    ro.observe(document.documentElement)
    return () => {
      clearTimeout(timer)
      ro.disconnect()
    }
  }, [setting])
  return scale
}
