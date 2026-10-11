// Terminal view tiles e2e: a project with no terminals shows an empty note, new shells open as tiles side by side, and
// the layout / fullscreen / close keys work. Runs in the background with throwaway data. Needs the Terminal view mounted
// by the app shell (TerminalView fed by useTerminals, drawer given hideCrewId).
// Usage: node e2e/terminal.mjs [outDir]  (default docs/specs/screenshots)
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { claudeHome, e2eEnv } from './fixtures/real-claude.mjs'

const outDir = resolve(process.argv[2] ?? 'docs/specs/screenshots')
mkdirSync(outDir, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), 'operant-term-'))
const project = mkdtempSync(join(tmpdir(), 'operant-term-proj-'))
const claudeRoot = mkdtempSync(join(tmpdir(), 'operant-term-claude-'))
const claudeDir = claudeHome(claudeRoot)
process.on('exit', () => rmSync(claudeRoot, { recursive: true, force: true }))
writeFileSync(join(project, 'app.ts'), 'export const a = 1\n')

const env = e2eEnv({ dataDir, claudeDir })

const app = await electron.launch({ args: ['.'], env })
try {
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.waitForFunction(() => !!window.operant)
  const inv = (channel, ...args) => page.evaluate(([c, a]) => window.operant.invoke(c, ...a), [channel, args])
  const poll = async (label, fn, timeout = 15_000) => {
    for (const end = Date.now() + timeout; Date.now() < end; await page.waitForTimeout(200)) if (await fn()) return
    throw new Error(`timed out waiting for ${label}`)
  }
  const shot = async (name) => (await page.waitForTimeout(400), page.screenshot({ path: join(outDir, `${name}.png`) }))
  const tiles = () => page.locator('[data-tile]')
  const rectOf = (loc) => loc.evaluate((e) => ({ x: e.offsetLeft, y: e.offsetTop, w: e.offsetWidth, h: e.offsetHeight }))

  await page.getByText('Welcome to Operant 3').waitFor()
  await inv('crews:create', { name: 'tiles', folder: project })
  await inv('settings:set', { tiles: { layout: 'dwindle', gaps: 6 } })
  await page.locator('[data-crew-row]').getByText('tiles', { exact: true }).click({ position: { x: 4, y: 4 } })
  await page.getByRole('heading', { name: 'tiles', level: 1 }).waitFor()
  await page.getByRole('group', { name: 'Dashboard mode' }).getByRole('button', { name: 'Terminal', exact: true }).click()

  // No terminals yet: an empty note, no tile surface.
  await page.getByText('No terminals open').waitFor()
  assert.equal(await tiles().count(), 0)
  await shot('terminal-tiles-empty')

  // The project row's agent button opens the main CLI (Claude) as a tile, and that tile takes the focus.
  await inv('settings:set', { mainCli: 'claude' })
  const row = page.locator('[data-crew-row]')
  await row.getByText('tiles', { exact: true }).hover()
  await row.getByRole('button', { name: 'New Claude terminal in tiles' }).click()
  await poll('Claude tile', async () => (await tiles().count()) === 1)
  const claude = page.getByRole('region', { name: /^Claude: tiles/ })
  assert.equal(await claude.count(), 1, 'the agent tile title starts with Claude')
  assert.equal(await claude.getAttribute('data-focused'), 'true', 'the new agent tile is focused')
  await page.getByRole('button', { name: /^Close Claude: / }).click()
  await poll('Claude tile closed', async () => (await tiles().count()) === 0)

  // A new shell opens as a tile, not in the drawer; a second one sits beside it.
  await page.keyboard.press('Alt+Shift+T')
  await poll('first shell tile', async () => (await tiles().count()) === 1)
  await page.keyboard.press('Alt+Shift+T')
  await poll('second shell tile', async () => (await tiles().count()) === 2)
  assert.equal(await page.getByTestId('terminal-drawer').count(), 0, 'the project terminals live in the tiles')
  const surface = page.getByTestId('tile-surface')
  await surface.waitFor()
  const shells = page.getByRole('region', { name: /^Shell: / })
  const a = tiles().nth(0)
  const b = tiles().nth(1)
  const ra = await rectOf(a)
  const rb = await rectOf(b)
  assert.ok(ra.x !== rb.x || ra.y !== rb.y, 'the shell tiles have their own rects')
  await shot('terminal-tiles-shells')

  // Layout key: the master layout puts the first tile in a left pane of fixed share.
  await page.keyboard.press('Alt+Shift+L')
  await poll('master layout', async () => (await surface.getAttribute('data-layout')) === 'master')
  await page.waitForTimeout(400)
  const after = await rectOf(a)
  assert.ok(after.h !== ra.h || after.w !== ra.w, 'the layout key changes the tile rects')
  await shot('terminal-tiles-master-layout')

  // Fullscreen key: the focused tile fills the surface, the others hide; pressing again restores.
  await a.click({ position: { x: 20, y: 12 } })
  await page.keyboard.press('Alt+Shift+F')
  await poll('fullscreen', async () => (await a.getAttribute('data-fullscreen')) === 'true')
  await page.waitForTimeout(300)
  const box = await surface.evaluate((e) => ({ w: e.clientWidth, h: e.clientHeight }))
  const full = await rectOf(a)
  assert.ok(Math.abs(full.w - box.w) <= 1 && Math.abs(full.h - box.h) <= 1, 'fullscreen fills the surface')
  await page.keyboard.press('Alt+Shift+F')
  await poll('fullscreen off', async () => (await a.getAttribute('data-fullscreen')) === 'false')

  // Close tile: the button and the key each remove a tile.
  await page.getByRole('button', { name: /^Close Shell: / }).first().click()
  await poll('one tile closed', async () => (await tiles().count()) === 1)
  await tiles().first().click({ position: { x: 20, y: 12 } })
  await page.keyboard.press('Alt+Shift+W')
  await poll('last tile closed', async () => (await tiles().count()) === 0)
  assert.equal(await shells.count(), 0)
  await shot('terminal-tiles-closed')
  console.log('terminal e2e ok')
} finally {
  await app.close()
}
