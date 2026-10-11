// Clip e2e: no terminal in a Terminal view tile draws a row past its tile's visible body, the last whole row is visible,
// and a Claude tile (the real claude on Haiku, no turn is sent) is measured like any other. The old check that the xterm
// rows equal the PTY rows and that Claude's footer row is visible needed a scripted painter; the real
// claude's screen is not under our control, so those two are not checked.
// Runs over window sizes and UI scales, a split of two tiles, a fullscreen toggle and the master layout, with the Claude
// Mods panel open beside them. Runs in the background with throwaway data.
// Usage: node e2e/clip.mjs [phase] [outDir]  (phase names the screenshots: clip-<phase>-*.png)
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { claudeHome, e2eEnv } from './fixtures/real-claude.mjs'

const phase = process.argv[2] ?? 'after'
const outDir = resolve(process.argv[3] ?? 'docs/specs/screenshots')
mkdirSync(outDir, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), 'operant-clip-'))
const project = mkdtempSync(join(tmpdir(), 'operant-clip-proj-'))
const claudeRoot = mkdtempSync(join(tmpdir(), 'operant-clip-claude-'))
const claudeDir = claudeHome(claudeRoot)
process.on('exit', () => rmSync(claudeRoot, { recursive: true, force: true }))
writeFileSync(join(project, 'app.ts'), 'export const a = 1\n')

const env = e2eEnv({ dataDir, claudeDir })

const SIZES = [
  [1400, 900],
  [1920, 1080],
  [2560, 1440],
]
const SCALES = [1, 1.25, 1.5, 0] // 0 = automatic

const app = await electron.launch({ args: ['.'], env })
try {
  const page = await app.firstWindow()
  await page.waitForFunction(() => !!window.operant)
  const inv = (channel, ...args) => page.evaluate(([c, a]) => window.operant.invoke(c, ...a), [channel, args])
  const win = (size) => app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setContentSize(s[0], s[1]), size)

  // Every visible terminal: its rows, the rows drawn past its tile's visible body, and where its footer row sits.
  const measure = () =>
    page.evaluate(() => {
      const r = (e) => e.getBoundingClientRect()
      return [...document.querySelectorAll('.xterm')]
        .filter((x) => r(x).width > 20 && r(x).height > 20)
        .map((x) => {
          const tile = x.closest('[data-tile]')
          const host = x.parentElement
          const body = host.parentElement
          const hs = getComputedStyle(host)
          const contentH = r(host).height - (parseFloat(hs.paddingTop) || 0) - (parseFloat(hs.paddingBottom) || 0)
          const rowEls = [...x.querySelectorAll('.xterm-rows > div')]
          const screen = r(x.querySelector('.xterm-screen'))
          const bodyBottom = r(body).bottom
          return {
            tile: tile?.getAttribute('aria-label') ?? '?',
            claude: (tile?.getAttribute('aria-label') ?? '').startsWith('Claude:'),
            rows: rowEls.length,
            cell: rowEls[0] ? r(rowEls[0]).height : 0,
            overflowPx: Math.max(0, screen.bottom - bodyBottom),
            slackPx: contentH - screen.height,
          }
        })
    })

  // The first problem a terminal shows, or null when it is clean.
  const problemOf = (t) => {
    if (t.overflowPx > 0.5) return `rows draw ${t.overflowPx.toFixed(1)}px past the tile body`
    if (t.slackPx >= t.cell + 0.5) return `${t.slackPx.toFixed(1)}px unused, a whole row would fit`
    return null
  }
  const judge = (list) => list.map((t) => ({ t, p: problemOf(t) })).filter((x) => x.p)

  // Waits for the PTY to catch up with the new size (up to 8s), then returns the terminals and their problems.
  const settle = async () => {
    for (let end = Date.now() + 8000; ; await page.waitForTimeout(200)) {
      const list = await measure()
      const problems = judge(list)
      if (problems.length === 0 || Date.now() > end) return { list, problems }
    }
  }

  const shot = (name) => page.screenshot({ path: join(outDir, `clip-${phase}-${name}.png`) })
  const setScale = (s) => inv('settings:set', { uiScale: s })

  await page.getByText('Welcome to Operant 3').waitFor()
  await inv('crews:create', { name: 'clip', folder: project })
  await inv('settings:set', { mainCli: 'claude' })
  await page.locator('[data-crew-row]').getByText('clip', { exact: true }).click({ position: { x: 4, y: 4 } })
  await page.getByRole('heading', { name: 'clip', level: 1 }).waitFor()
  await page.getByRole('group', { name: 'Dashboard mode' }).getByRole('button', { name: 'Terminal', exact: true }).click()
  await page.locator('[data-crew-row]').getByText('clip', { exact: true }).click({ button: 'right', position: { x: 4, y: 4 } })
  await page.getByRole('menuitem', { name: 'New Claude terminal here' }).click()
  await page.getByRole('region', { name: /^Claude: / }).waitFor({ timeout: 20_000 })
  await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Terminal', exact: true }).click() // new Claude tiles open in Chat
  await page.keyboard.press('Alt+Shift+T') // a shell beside it: a split of two tiles
  await page.locator('[data-tile]').nth(1).waitFor({ timeout: 20_000 })
  await page.locator('.xterm').nth(1).waitFor({ timeout: 20_000 })

  const failures = []
  const report = async (label, shotName) => {
    const { list, problems } = await settle()
    const claude = list.filter((t) => t.claude).length
    console.log(`${label}: terminals ${list.length} (claude ${claude}) rows ${list.map((t) => t.rows).join(' ')} problems ${problems.length}`)
    for (const { t, p } of problems) console.log(`  ${t.tile}: ${p} (rows ${t.rows}, overflow ${t.overflowPx.toFixed(1)}px, slack ${t.slackPx.toFixed(1)}px)`)
    failures.push(...problems.map((x) => `${label} ${x.t.tile}: ${x.p}`))
    if (shotName) await shot(shotName)
  }

  for (const scale of SCALES) {
    await setScale(scale)
    for (const [w, h] of SIZES) {
      await win([w, h])
      await page.waitForTimeout(700)
      await report(`${w}x${h} scale ${scale || 'auto'}`, `${w}x${h}-scale-${scale || 'auto'}`)
    }
  }

  // Fullscreen: the Claude tile fills the surface and keeps its rows inside the tile; then it is restored.
  await setScale(1.25)
  await win([1920, 1080])
  await page.waitForTimeout(500)
  await page.getByRole('region', { name: /^Claude: / }).click({ position: { x: 20, y: 12 } })
  await page.keyboard.press('Alt+Shift+F')
  await page.waitForFunction(() => document.querySelector('[data-tile][data-fullscreen="true"]'))
  await report('fullscreen 1920x1080 scale 1.25', 'fullscreen-1920x1080-scale-1.25')
  await page.keyboard.press('Alt+Shift+F')
  await page.waitForFunction(() => !document.querySelector('[data-tile][data-fullscreen="true"]'))

  // Master layout: the first tile takes a left pane, so its size changes with the layout.
  await page.keyboard.press('Alt+Shift+L')
  await page.waitForFunction(() => document.querySelector('[data-testid="tile-surface"]')?.getAttribute('data-layout') === 'master')
  await report('master 1920x1080 scale 1.25', 'master-1920x1080-scale-1.25')

  await page.keyboard.press('Alt+Shift+L')
  await setScale(1.5)
  await win([1400, 900])
  await report('dwindle 1400x900 scale 1.5 after layout toggle', null)

  console.log(`clip e2e ${phase}: ${failures.length} problem(s)`)
  assert.equal(failures.length, 0, `terminal clipping or row mismatch:\n${failures.join('\n')}`)
  console.log('clip e2e ok')
} finally {
  await app.close()
}
