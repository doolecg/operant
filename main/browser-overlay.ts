import type { WebContents } from 'electron'
import { buildCursorScript, buildHighlightScript, parseSnapshotRefs, toTarget, type OverlayRect, type OverlayTarget, type RefHint } from '../shared/browser-overlay'

// Draws the AI's action in the page: a highlight box with a label and an animated cursor dot. Everything runs in a
// fixed Electron isolated world (page scripts cannot see it) and lives in a closed shadow root that is fixed,
// pointer-events none and removed after about 1.5 s, so the page's layout and clicks are never affected.
// Electron reserves world 999 (contextIsolation); anything below 1 << 20 and not 0 is free.
const WORLD_ID = 4242
const SHOW_MS = 1500

async function run(wc: WebContents, code: string): Promise<Record<string, unknown> | null> {
  if (wc.isDestroyed()) return null
  try {
    const out: unknown = await wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code }])
    return typeof out === 'string' ? (JSON.parse(out) as Record<string, unknown>) : null
  } catch {
    // Page navigating, crashed or a frame gone: the overlay is cosmetic, so there is nothing to report.
    return null
  }
}

// Boxes the target and returns its rect in viewport CSS px, or null when the element was not found.
export async function highlight(wc: WebContents, target: OverlayTarget, label = '', ms = SHOW_MS): Promise<OverlayRect | null> {
  const r = await run(wc, buildHighlightScript(target, label, ms))
  if (!r || r.found !== true) return null
  return { x: Number(r.x), y: Number(r.y), w: Number(r.w), h: Number(r.h) }
}

// Glides the cursor dot to (x, y) viewport CSS px and pulses it.
export async function cursor(wc: WebContents, x: number, y: number, ms = SHOW_MS): Promise<void> {
  await run(wc, buildCursorScript(x, y, ms))
}

// The last snapshot's refs per tab, so a later `click e12` can be shown on the right element.
export class RefMemory {
  private readonly byTab = new Map<number, Map<string, RefHint>>()

  // Feed it any tool result text; only aria snapshots (lines with [ref=eN]) change anything.
  learn(tabKey: number, resultText: string): void {
    if (!resultText.includes('[ref=')) return
    const refs = parseSnapshotRefs(resultText)
    if (refs.size > 0) this.byTab.set(tabKey, refs)
  }

  hints(tabKey: number): ReadonlyMap<string, RefHint> | undefined {
    return this.byTab.get(tabKey)
  }

  forget(tabKey: number): void {
    this.byTab.delete(tabKey)
  }
}

// One AI action: box the element (a ref, a selector) and glide the cursor to its centre. Never throws.
export async function showAction(wc: WebContents, raw: string | undefined, label: string, hints?: ReadonlyMap<string, RefHint>): Promise<boolean> {
  const target = toTarget(raw, hints)
  if (!target) return false
  const r = await highlight(wc, target, label)
  if (!r) return false
  await cursor(wc, r.x + r.w / 2, r.y + r.h / 2)
  return true
}
