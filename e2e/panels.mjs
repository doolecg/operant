// App shell e2e: the two view pills (Terminal, Memory), the hideable project list with its top-bar button and keys (Alt+B,
// Alt+Z), the choice surviving a restart, the top-bar Activity menu (items, the unread badge, Clear all), and the Usage and
// Git popouts (opened from the top bar, closed with Esc). Runs in the background with throwaway data.
// Usage: node e2e/panels.mjs [outDir]  (default docs/specs/screenshots)
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const outDir = resolve(process.argv[2] ?? 'docs/specs/screenshots')
mkdirSync(outDir, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), 'operant-panels-'))
const project = mkdtempSync(join(tmpdir(), 'operant-panels-proj-'))
const claudeDir = mkdtempSync(join(tmpdir(), 'operant-panels-claude-'))
writeFileSync(join(project, 'app.ts'), 'export const a = 1\n')
// A git repo, so the top bar shows the branch chip that opens the Git popout.
const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: project, stdio: 'ignore', windowsHide: true })
git('init', '-q')
git('add', '.')
git('commit', '-qm', 'init')
writeFileSync(join(project, 'notes.txt'), 'changed\n')

const env = { ...process.env, OPERANT_BACKGROUND: '1', OPERANT_E2E: '1', OPERANT_DATA_DIR: dataDir, CLAUDE_CONFIG_DIR: claudeDir }
const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
env[pathKey] = resolve('e2e/fixtures/bin') + delimiter + env[pathKey]

let app = null
let page = null
async function launch() {
  app = await electron.launch({ args: ['.'], env })
  page = await app.firstWindow()
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.waitForFunction(() => !!window.operant)
}
const inv = (channel, ...args) => page.evaluate(([c, a]) => window.operant.invoke(c, ...a), [channel, args])
const shot = async (name) => (await page.waitForTimeout(500), page.screenshot({ path: join(outDir, `${name}.png`) }))
const poll = async (label, fn, timeout = 10_000) => {
  for (const end = Date.now() + timeout; Date.now() < end; await page.waitForTimeout(150)) if (await fn()) return
  throw new Error(`timed out waiting for ${label}`)
}
const pills = () => page.getByRole('group', { name: 'Dashboard mode' })
const mode = (label) => pills().getByRole('button', { name: new RegExp(`^${label}`) })
const layout = async () => (await inv('settings:get')).layout
const sidebar = () => page.getByRole('complementary', { name: 'Projects' })
const tilesRegion = () => page.getByRole('region', { name: 'Terminal tiles' })
const activity = () => page.getByRole('button', { name: /^Activity/ })
const activityMenu = () => page.getByRole('menu', { name: 'Activity' })
const usageModal = () => page.getByRole('dialog', { name: 'Usage' })
const gitModal = () => page.getByRole('dialog', { name: 'Git' })

try {
  await launch()
  await page.getByText('Welcome to Operant 3').waitFor()
  const crew = await inv('crews:create', { name: 'shell', folder: project })
  await inv('settings:set', { tiles: { layout: 'dwindle', gaps: 6 } })

  await page.locator(`[data-crew-row="${crew.id}"]`).getByText('shell', { exact: true }).click({ position: { x: 4, y: 4 } })
  await page.getByRole('heading', { name: 'shell', level: 1 }).waitFor()

  // Two pills, in order; Terminal is the default view.
  await pills().waitFor()
  const labels = await pills().getByRole('button').evaluateAll((els) => els.map((e) => e.getAttribute('data-mode')))
  assert.deepEqual(labels, ['terminal', 'memory'])
  await sidebar().waitFor()

  // Terminal view: the tiles fill the width; there is no side panel and no Terminal side panel button.
  await mode('Terminal').click()
  await tilesRegion().waitFor()
  await page.keyboard.press('Alt+Shift+T')
  await poll('shell tile', async () => (await page.locator('[data-tile]').count()) >= 1)
  assert.equal(await page.getByTestId('terminal-drawer').count(), 0, 'a new shell is a tile, not a drawer tab')
  assert.equal(await page.getByRole('region', { name: 'Workspace panels' }).count(), 0, 'the side panel is gone')
  assert.equal(await page.getByRole('button', { name: /side panel/i }).count(), 0, 'no side panel button')
  await shot('terminal-tiles')

  // Alt+B hides the project list and remembers it; the top-bar button brings it back.
  await page.keyboard.press('Alt+B')
  await sidebar().waitFor({ state: 'detached' })
  await poll('sidebarHidden saved', async () => (await layout()).sidebarHidden === true)
  await page.getByRole('button', { name: 'Show project list' }).waitFor()
  await page.getByRole('button', { name: 'Show project list' }).click()
  await sidebar().waitFor()
  assert.equal((await layout()).sidebarHidden, false)
  await page.keyboard.press('Alt+B')
  await sidebar().waitFor({ state: 'detached' })
  await shot('panels-hidden')

  // The choice survives a restart (the project list stays hidden).
  await app.close()
  await launch()
  await page.getByRole('heading', { name: 'shell', level: 1 }).waitFor()
  assert.equal(await sidebar().count(), 0, 'the project list stays hidden after a restart')
  await mode('Terminal').click()
  await tilesRegion().waitFor()

  // Alt+Z shows and hides the project list too.
  await page.keyboard.press('Alt+Z')
  await sidebar().waitFor()
  await page.keyboard.press('Alt+Z')
  await sidebar().waitFor({ state: 'detached' })
  await page.keyboard.press('Alt+Z')
  await sidebar().waitFor()

  // The tile keys do not collide with the shell keys: Alt+J / Alt+K move focus between tiles.
  await page.keyboard.press('Alt+J')
  await page.keyboard.press('Alt+K')
  await sidebar().waitFor()

  // Activity: the menu lists the feed (the project was created), a notice bumps the badge, opening the menu reads it,
  // and Clear all empties both the feed and the notices.
  await activity().click()
  await activityMenu().waitFor()
  await activityMenu().getByRole('heading', { name: 'Activity' }).waitFor()
  await activityMenu().getByText('Project shell created').waitFor()
  await page.keyboard.press('Escape')
  await activityMenu().waitFor({ state: 'detached' })
  const copyPath = async () => {
    await page.locator(`[data-crew-row="${crew.id}"]`).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Copy path' }).click()
  }
  await copyPath()
  await copyPath()
  await page.getByRole('button', { name: 'Activity, 2 new' }).waitFor()
  await activity().click()
  await activityMenu().getByText(/^(Path copied|Could not copy the path)$/).first().waitFor()
  assert.equal(await activityMenu().getByText(/^(Path copied|Could not copy the path)$/).count(), 2, 'both notices are listed')
  await page.keyboard.press('Escape')
  await activityMenu().waitFor({ state: 'detached' })
  await page.getByRole('button', { name: 'Activity', exact: true }).waitFor()
  await activity().click()
  await activityMenu().getByRole('button', { name: 'Clear all' }).click()
  await activityMenu().getByText('Nothing has happened yet.').waitFor()
  assert.equal(await activityMenu().locator('li').count(), 0, 'Clear all empties the list')
  assert.deepEqual(await inv('events:recent', 100), [], 'Clear all clears the feed')
  await page.keyboard.press('Escape')
  await activityMenu().waitFor({ state: 'detached' })

  // Usage and Git open as popouts from the sidebar footer; Esc closes each one.
  await page.getByTestId('sidebar-footer').getByRole('button', { name: /^Provider limits: / }).click()
  await usageModal().getByRole('heading', { name: 'Usage', exact: true }).waitFor()
  await page.keyboard.press('Escape')
  await usageModal().waitFor({ state: 'detached' })
  await page.getByRole('button', { name: /^Git: Branch/ }).click()
  await gitModal().getByTestId('git-page').waitFor()
  await page.keyboard.press('Escape')
  await gitModal().waitFor({ state: 'detached' })

  // Settings: the project list switch mirrors the pane; there is no side panel switch.
  await page.keyboard.press('Control+,')
  await page.getByRole('heading', { name: 'Settings' }).waitFor()
  await page.getByRole('button', { name: 'Top bar', exact: true }).click()
  assert.equal(await page.getByRole('switch', { name: /side panel/i }).count(), 0, 'no side panel switch in settings')
  await page.getByRole('switch', { name: 'Hide the project list' }).click()
  await poll('sidebar switch saved', async () => (await layout()).sidebarHidden === true)
  await page.getByRole('switch', { name: 'Hide the project list' }).click()
  await poll('sidebar switch cleared', async () => (await layout()).sidebarHidden === false)
  await page.getByRole('button', { name: 'Close settings' }).click()
  console.log('panels e2e ok; screenshots in', outDir)
} finally {
  await app.close()
}
