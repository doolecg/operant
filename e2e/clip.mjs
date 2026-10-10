// Clip e2e: no terminal in a Terminal view tile draws a row past its tile's visible body, the last whole row is visible,
// and a Claude terminal shows as many rows as its PTY. A Claude tile paints a footer on its last row (fixtures/bin/
// fake-claude.mjs with FAKE_CLAUDE_PAINT), and the fixture logs the size it painted, which is the PTY's size.
// Runs over window sizes and UI scales, a split of two tiles, a fullscreen toggle and the master layout, with the Claude
// Mods panel open beside them. Runs in the background with throwaway data.
// Usage: node e2e/clip.mjs [phase] [outDir]  (phase names the screenshots: clip-<phase>-*.png)
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const phase = process.argv[2] ?? 'after'
const outDir = resolve(process.argv[3] ?? 'docs/specs/screenshots')
mkdirSync(outDir, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), 'operant-clip-'))
const project = mkdtempSync(join(tmpdir(), 'operant-clip-proj-'))
const claudeDir = mkdtempSync(join(tmpdir(), 'operant-clip-claude-'))
writeFileSync(join(project, 'app.ts'), 'export const a = 1\n')
const paintLog = join(claudeDir, 'fake-claude-paint.log')
// The PTY's rows as the Claude fixture last painted them (one "rows cols" line per size it drew).
const ptyRows = () => (existsSync(paintLog) ? Number(readFileSync(paintLog, 'utf8').trim().split('\n').pop().split(' ')[0]) : null)

const env = { ...process.env, OPERANT_BACKGROUND: '1', OPERANT_E2E: '1', OPERANT_DATA_DIR: dataDir, CLAUDE_CONFIG_DIR: claudeDir, FAKE_CLAUDE_PAINT: '1' }
const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
env[pathKey] = resolve('e2e/fixtures/bin') + delimiter + env[pathKey]

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
          const footer = rowEls.findIndex((e) => e.textContent.includes('auto mode on'))
          return {
            tile: tile?.getAttribute('aria-label') ?? '?',
            claude: footer >= 0,
            rows: rowEls.length,
            cell: rowEls[0] ? r(rowEls[0]).height : 0,
            overflowPx: Math.max(0, screen.bottom - bodyBottom),
            slackPx: contentH - screen.height,
            footerRow: footer,
            footerClipPx: footer >= 0 ? Math.max(0, r(rowEls[footer]).bottom - bodyBottom) : 0,
          }
        })
    })

  // The first problem a terminal shows, or null when it is clean.
  const problemOf = (t, pty) => {
    if (t.overflowPx > 0.5) return `rows draw ${t.overflowPx.toFixed(1)}px past the tile body`
    if (t.footerClipPx > 0.5) return `footer clipped by ${t.footerClipPx.toFixed(1)}px`
    if (t.claude && pty !== t.rows) return `xterm ${t.rows} rows vs PTY ${pty}`
    if (t.slackPx >= t.cell + 0.5) return `${t.slackPx.toFixed(1)}px unused, a whole row would fit`
    return null
  }
  const judge = (list) => list.map((t) => ({ t, p: problemOf(t, t.claude ? ptyRows() : null) })).filter((x) => x.p)

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
  await page.keyboard.press('Alt+Shift+T') // a shell beside it: a split of two tiles
  await page.locator('[data-tile]').nth(1).waitFor({ timeout: 20_000 })
  await page.locator('.xterm').nth(1).waitFor({ timeout: 20_000 })

  const failures = []
  const report = async (label, shotName) => {
    const { list, problems } = await settle()
    const claude = list.filter((t) => t.claude).length
    console.log(`${label}: terminals ${list.length} (claude ${claude}) rows ${list.map((t) => t.rows).join(' ')} problems ${problems.length}`)
    for (const { t, p } of problems) console.log(`  ${t.tile}: ${p} (rows ${t.rows}, PTY ${ptyRows() ?? '-'}, overflow ${t.overflowPx.toFixed(1)}px, slack ${t.slackPx.toFixed(1)}px)`)
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

  // Fullscreen: the Claude tile fills the surface and keeps its last row inside the tile; then it is restored.
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
