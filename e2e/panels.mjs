// App shell e2e: the four view pills (Workspace, Terminal, Seats, Memory), the inbox count on the Workspace pill, the three
// hideable panes (project list, Terminal side panel, Workspace inbox) with their top-bar buttons and keys (Alt+B,
// Alt+Shift+B, Alt+Z), the choice surviving a restart, the notifications.inbox setting, and the screenshots of the
// Workspace board, the Terminal tiles, the task modal and the hidden panes. Runs in the background with throwaway data.
// Usage: node e2e/panels.mjs [outDir]  (default docs/specs/screenshots)
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const outDir = resolve(process.argv[2] ?? 'docs/specs/screenshots')
mkdirSync(outDir, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), 'operant-panels-'))
const project = mkdtempSync(join(tmpdir(), 'operant-panels-proj-'))
const claudeDir = mkdtempSync(join(tmpdir(), 'operant-panels-claude-'))
writeFileSync(join(project, 'app.ts'), 'export const a = 1\n')

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
const inbox = () => page.getByRole('complementary', { name: 'Inbox' })
const sidePanel = () => page.getByRole('region', { name: 'Workspace panels' })

try {
  await launch()
  await page.getByText('Welcome to Operant 3').waitFor()
  const crew = await inv('crews:create', { name: 'shell', folder: project })
  await inv('settings:set', { tiles: { layout: 'dwindle', gaps: 6, closeDoneAfterSec: 0 } })

  // Seed one job per column: a question and a review (both need the owner), a working one and a done one.
  const seed = async (task, patch) => {
    const r = await inv('runs:create', { crewId: crew.id, task, masterCli: 'claude', mode: 'background' })
    await inv('runs:stop', r.id)
    const d = new DatabaseSync(join(dataDir, 'operant.db'))
    d.exec('PRAGMA busy_timeout = 5000')
    d.prepare('UPDATE runs SET mode = ?, status = ?, waiting = ?, question = ?, question_options = ?, review_summary = ?, outcome = ?, finished_at = ? WHERE id = ?').run(
      'master', patch.status, patch.waiting ?? '', patch.question ?? '', JSON.stringify(patch.options ?? []), patch.review ?? '', patch.outcome ?? '', patch.finished ?? null, r.id,
    )
    d.close()
    return r.id
  }
  const q = await seed('Pick a port', { status: 'needs-you', waiting: 'question', question: 'Which port?', options: ['3000', '8080'] })
  const rv = await seed('Add a health check', { status: 'review', review: '## Done\n\n- added `/health`' })
  await seed('Write the docs', { status: 'working' })
  await seed('Tidy the logs', { status: 'done', outcome: 'Logs tidied.', finished: Date.now() })
  await page.reload()
  await page.waitForFunction(() => !!window.operant)
  await page.locator(`[data-crew-row="${crew.id}"]`).getByText('shell', { exact: true }).click({ position: { x: 4, y: 4 } })
  await page.getByRole('heading', { name: 'shell', level: 1 }).waitFor()

  // Four pills, in order; the Workspace pill carries the inbox count.
  await pills().waitFor()
  const labels = await pills().getByRole('button').evaluateAll((els) => els.map((e) => e.getAttribute('data-mode')))
  assert.deepEqual(labels, ['workspace', 'terminal', 'seats', 'memory'])
  await page.locator('[data-mode-badge="workspace"]').getByText('2', { exact: true }).waitFor()
  await mode('Workspace').click()
  await page.locator('[data-workspace-board]').waitFor()
  await inbox().waitFor()
  await sidebar().waitFor()
  await shot('workspace-board')

  // One task modal, opened from a card; it covers whatever view is open.
  await page.locator('[data-run-card]').getByRole('button', { name: `Open JOB#${rv}`, exact: true }).click()
  const modal = page.getByRole('dialog', { name: `JOB#${rv}` })
  await modal.waitFor()
  await shot('task-modal')
  await modal.getByRole('button', { name: 'Close job panel' }).click()
  await modal.waitFor({ state: 'detached' })

  // Terminal view: tiles, with a side panel; the drawer stays out while the tiles show.
  await mode('Terminal').click()
  await page.getByTestId('tile-surface').waitFor()
  await sidePanel().waitFor()
  await page.keyboard.press('Alt+Shift+T')
  await poll('shell tile', async () => (await page.locator('[data-tile]').count()) >= 2)
  assert.equal(await page.getByTestId('terminal-drawer').count(), 0, 'a new shell is a tile, not a drawer tab')
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

  // Alt+Shift+B hides the pane of the open view: the Terminal side panel here, the inbox in the Workspace.
  await page.keyboard.press('Alt+Shift+B')
  await sidePanel().waitFor({ state: 'detached' })
  await poll('panelHidden saved', async () => (await layout()).panelHidden === true)
  assert.equal((await layout()).inboxHidden, false, 'the inbox is a separate pane')
  await mode('Workspace').click()
  await inbox().waitFor()
  await page.keyboard.press('Alt+Shift+B')
  await inbox().waitFor({ state: 'detached' })
  await poll('inboxHidden saved', async () => (await layout()).inboxHidden === true)
  await shot('panels-hidden')

  // The choice survives a restart (project list, side panel and inbox all stay hidden).
  await app.close()
  await launch()
  await page.getByRole('heading', { name: 'shell', level: 1 }).waitFor()
  await page.locator('[data-workspace-board]').waitFor()
  assert.equal(await sidebar().count(), 0, 'the project list stays hidden after a restart')
  assert.equal(await inbox().count(), 0, 'the inbox stays hidden after a restart')
  await mode('Terminal').click()
  await page.getByTestId('tile-surface').waitFor()
  assert.equal(await sidePanel().count(), 0, 'the side panel stays hidden after a restart')

  // Alt+Z restores everything when all are hidden, and hides everything when any is shown.
  await page.keyboard.press('Alt+Z')
  await sidebar().waitFor()
  await sidePanel().waitFor()
  assert.deepEqual(await layout().then((l) => [l.sidebarHidden, l.panelHidden, l.inboxHidden]), [false, false, false])
  await page.keyboard.press('Alt+Z')
  await sidebar().waitFor({ state: 'detached' })
  await sidePanel().waitFor({ state: 'detached' })
  assert.deepEqual(await layout().then((l) => [l.sidebarHidden, l.panelHidden, l.inboxHidden]), [true, true, true])
  await page.keyboard.press('Alt+Z')
  await sidebar().waitFor()

  // The tile keys do not collide with the shell keys: Alt+J / Alt+K move focus between tiles and the panes stay as they are.
  await page.keyboard.press('Alt+J')
  await page.keyboard.press('Alt+K')
  await sidebar().waitFor()
  await sidePanel().waitFor()

  // Settings: the inbox notification switch turns the Workspace badge off, and the hide switches mirror the panes.
  await page.keyboard.press('Control+,')
  await page.getByRole('heading', { name: 'Settings' }).waitFor()
  await page.getByRole('button', { name: 'Top bar', exact: true }).click()
  const notify = page.getByRole('switch', { name: 'Inbox notifications' })
  assert.equal(await notify.getAttribute('aria-checked'), 'true')
  await notify.click()
  await poll('notifications saved', async () => (await inv('settings:get')).notifications.inbox === false)
  await page.getByRole('switch', { name: 'Hide the project list' }).click()
  await poll('sidebar switch saved', async () => (await layout()).sidebarHidden === true)
  await page.getByRole('switch', { name: 'Hide the project list' }).click()
  await poll('sidebar switch cleared', async () => (await layout()).sidebarHidden === false)
  await page.getByRole('button', { name: 'Close settings' }).click()
  await page.locator('[data-mode-badge="workspace"]').waitFor({ state: 'detached' })
  await inv('settings:set', { notifications: { inbox: true } })
  await page.locator('[data-mode-badge="workspace"]').waitFor()
  void q
  console.log('panels e2e ok; screenshots in', outDir)
} finally {
  await app.close()
}
