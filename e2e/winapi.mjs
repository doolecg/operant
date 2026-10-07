// The REAL operating-system window of an Electron process, driven through user32 (e2e/winapi.ps1): maximize and
// restore with ShowWindow, and measure what is on the display (the painted, non-black part of the client area).
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const script = resolve('e2e/winapi.ps1')

// `pid` must be the Electron main process (await app.evaluate(() => process.pid)), not Playwright's launcher.
export function realWindow(pid) {
  const run = (action) => {
    const out = JSON.parse(execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', action, '-ProcessId', String(pid)]).toString().trim().split('\n').pop())
    if (out.error) throw new Error(`real window: ${out.error}`)
    return out
  }
  return {
    maximize: () => run('maximize'),
    restore: () => run('restore'),
    // { zoomed, window: [w, h], client: [w, h], paintedBox: [w, h] } in device pixels, from a screen copy.
    measure: () => run('screen'),
  }
}

// The share of the client area the painted bounding box covers (1 = all of it).
export const coverage = (m) => (m.paintedBox[0] * m.paintedBox[1]) / (m.client[0] * m.client[1])
