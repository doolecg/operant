// Fill e2e: the page fills the window at the automatic UI scale at 1920x1080 and 2560x1440, and after a maximize and a
// restore. Each time the root is the size of the viewport (within 1px) and each open terminal fills its tile to within
// one character cell. Runs in the background with throwaway data. Usage: node e2e/fill.mjs [outDir]  (default docs/specs/screenshots)
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const outDir = resolve(process.argv[2] ?? 'docs/specs/screenshots')
mkdirSync(outDir, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), 'operant-fill-'))
const project = mkdtempSync(join(tmpdir(), 'operant-fill-proj-'))
const claudeDir = mkdtempSync(join(tmpdir(), 'operant-fill-claude-'))
writeFileSync(join(project, 'app.ts'), 'export const a = 1\n')

const env = { ...process.env, OPERANT_BACKGROUND: '1', OPERANT_E2E: '1', OPERANT_DATA_DIR: dataDir, CLAUDE_CONFIG_DIR: claudeDir }
const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
env[pathKey] = resolve('e2e/fixtures/bin') + delimiter + env[pathKey]

// The automatic scale for a window content size, as renderer/src/lib/uiScale.ts computes it.
const autoScale = (w, h) => Math.round(Math.min(1.75, Math.max(1, Math.min(w / 1600, h / 900))) * 20) / 20

const app = await electron.launch({ args: ['.'], env })
try {
  const page = await app.firstWindow()
  await page.waitForFunction(() => !!window.operant)
  const inv = (channel, ...args) => page.evaluate(([c, a]) => window.operant.invoke(c, ...a), [channel, args])
  const win = (op, size) =>
    app.evaluate(({ BrowserWindow }, [o, s]) => {
      const w = BrowserWindow.getAllWindows()[0]
      if (o === 'size') w.setContentSize(s[0], s[1])
      else if (o === 'maximize') w.maximize()
      else w.unmaximize()
    }, [op, size ?? null])
  const state = () =>
    app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      return { content: w.getContentSize(), zoom: w.webContents.getZoomFactor(), max: w.isMaximized(), full: w.isFullScreen() }
    })

  // What the page shows: the root against the viewport, and each visible terminal against its tile.
  const measure = () =>
    page.evaluate(() => {
      const r = (el) => el.getBoundingClientRect()
      const root = document.getElementById('root').firstElementChild
      const rr = r(root)
      const terms = [...document.querySelectorAll('.xterm')]
        .filter((x) => r(x).width > 20 && r(x).height > 20)
        .map((x) => {
          const wrap = x.parentElement
          const tile = x.closest('section')
          const cs = getComputedStyle(wrap)
          const pad = [cs.paddingLeft, cs.paddingRight, cs.paddingTop, cs.paddingBottom].map((v) => parseFloat(v) || 0)
          const font = getComputedStyle(x.querySelector('.xterm-rows'))
          const ctx = document.createElement('canvas').getContext('2d')
          ctx.font = `${font.fontSize} ${font.fontFamily}`
          return {
            wrapW: r(wrap).width - pad[0] - pad[1],
            wrapH: r(wrap).height - pad[2] - pad[3],
            termW: r(x).width,
            termH: r(x).height,
            rowH: r(x.querySelector('.xterm-rows > div')).height,
            cellW: ctx.measureText('W').width,
            tileRight: r(tile).right - 1,
            tileBottom: r(tile).bottom - 1,
            termRight: r(x).right,
            termBottom: r(x).bottom,
          }
        })
      return { inner: [innerWidth, innerHeight], root: [rr.width, rr.height], terms }
    })

  // Each check returns the first problem it finds, or null when the page fills the window.
  const problem = (m, zoom, expectedZoom) => {
    if (Math.abs(m.root[0] - m.inner[0]) > 1 || Math.abs(m.root[1] - m.inner[1]) > 1) return `root ${m.root} vs viewport ${m.inner}`
    if (Math.abs(zoom - expectedZoom) > 0.011) return `zoom ${zoom} vs automatic ${expectedZoom}`
    if (m.terms.length === 0) return 'no terminal is open'
    for (const t of m.terms) {
      const cell = Math.max(t.cellW, 6)
      if (t.wrapW - t.termW > cell) return `terminal ${t.termW.toFixed(1)} wide in a ${t.wrapW.toFixed(1)} wide tile`
      if (t.wrapH - t.termH > t.rowH) return `terminal ${t.termH.toFixed(1)} high in a ${t.wrapH.toFixed(1)} high tile`
      if (t.tileRight - t.termRight > 12 + 2 + cell) return `terminal stops ${(t.tileRight - t.termRight).toFixed(1)}px short of its tile's right edge`
      if (t.tileBottom - t.termBottom > 8 + 2 + t.rowH) return `terminal stops ${(t.tileBottom - t.termBottom).toFixed(1)}px short of its tile's bottom edge`
    }
    return null
  }

  // Waits until the page has settled on the window's state, or fails with the last problem seen.
  const settle = async (label, shot) => {
    let last = 'not measured'
    for (let end = Date.now() + 10_000; Date.now() < end; await page.waitForTimeout(150)) {
      const s = await state()
      const expected = autoScale(s.content[0], s.content[1])
      last = problem(await measure(), s.zoom, expected) ?? ''
      if (last === '') {
        const m = await measure()
        console.log(`${label}: content ${s.content.join('x')} zoom ${s.zoom} viewport ${m.inner.join('x')} root ${m.root.join('x')} terminals ${m.terms.length} ok`)
        if (shot) await page.screenshot({ path: join(outDir, `${shot}.png`) })
        return
      }
    }
    throw new Error(`${label}: ${last}`)
  }

  await page.getByText('Welcome to Operant 3').waitFor()
  await inv('crews:create', { name: 'fill', folder: project })
  await inv('settings:set', { mainCli: 'claude' })
  await page.locator('[data-crew-row]').getByText('fill', { exact: true }).click({ position: { x: 4, y: 4 } })
  await page.getByRole('group', { name: 'Dashboard mode' }).getByRole('button', { name: 'Terminal', exact: true }).click()
  await page.locator('[data-crew-row]').getByText('fill', { exact: true }).click({ button: 'right', position: { x: 4, y: 4 } })
  await page.getByRole('menuitem', { name: 'New shell here' }).click()
  await page.locator('.xterm').first().waitFor({ timeout: 20_000 })

  await win('size', [1920, 1080])
  await settle('1920x1080', null)
  await win('size', [2560, 1440])
  await settle('2560x1440', null)
  await win('maximize')
  await settle('maximized', 'fill-maximized')
  await win('unmaximize')
  await settle('restored', null)
  console.log('fill e2e ok')
} finally {
  await app.close()
}
