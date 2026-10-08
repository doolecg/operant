// Terminal view tiles e2e: the Master as the fixed main tile, a subagent as a read-only tile (Claude and OpenCode runs),
// a new shell as a second tile side by side, the layout / fullscreen / close keys. Runs in the background with throwaway
// data and a fake claude (FAKE_CLAUDE_SUBAGENT makes the Master's transcript carry a subagent; the job_agents rows are
// also seeded so the tiles do not depend on the reader's timing). Needs the Terminal view mounted by the app shell
// (WP11: view pill "Terminal", TerminalView fed by useTerminals, drawer given hideCrewId).
// Usage: node e2e/terminal.mjs [outDir]  (default docs/specs/screenshots)
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const outDir = resolve(process.argv[2] ?? 'docs/specs/screenshots')
mkdirSync(outDir, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), 'operant-term-'))
const project = mkdtempSync(join(tmpdir(), 'operant-term-proj-'))
const claudeDir = mkdtempSync(join(tmpdir(), 'operant-term-claude-'))
writeFileSync(join(project, 'app.ts'), 'export const a = 1\n')

const env = { ...process.env, OPERANT_BACKGROUND: '1', OPERANT_E2E: '1', OPERANT_DATA_DIR: dataDir, CLAUDE_CONFIG_DIR: claudeDir, FAKE_CLAUDE_SUBAGENT: 'pm' }
const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
env[pathKey] = resolve('e2e/fixtures/bin') + delimiter + env[pathKey]

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
  const tile = (id) => page.locator(`[data-tile="${id}"]`)
  const rect = (id) => tile(id).evaluate((e) => ({ x: e.offsetLeft, y: e.offsetTop, w: e.offsetWidth, h: e.offsetHeight }))

  await page.getByText('Welcome to Operant 3').waitFor()
  const crew = await inv('crews:create', { name: 'tiles', folder: project })
  const claudeRun = await inv('runs:create', { crewId: crew.id, task: 'Claude job', masterCli: 'claude', mode: 'background' })
  const openRun = await inv('runs:create', { crewId: crew.id, task: 'OpenCode job', masterCli: 'opencode', mode: 'background' })
  const db = new DatabaseSync(join(dataDir, 'operant.db'))
  db.exec('PRAGMA busy_timeout = 5000')
  db.prepare("UPDATE runs SET status = 'working' WHERE id IN (?, ?)").run(claudeRun.id, openRun.id)
  const add = db.prepare('INSERT INTO job_agents (run_id, seat, model, status, transcript_ref) VALUES (?, ?, ?, ?, ?)')
  add.run(claudeRun.id, 'pm', 'sonnet', 'working', 'agent-fake1.jsonl')
  add.run(openRun.id, 'builder', '', 'working', 'ses_fake_child')
  db.close()
  await inv('settings:set', { tiles: { layout: 'dwindle', gaps: 6, closeDoneAfterSec: 0 }, layout: { panelHidden: false } })
  // The rows were written behind the app's back: reload so no cached run list is stale.
  await page.reload()
  await page.waitForFunction(() => !!window.operant)
  await page.locator('[data-crew-row]').getByText('tiles', { exact: true }).click({ position: { x: 4, y: 4 } })
  await page.getByRole('heading', { name: 'tiles', level: 1 }).waitFor()
  await page.getByRole('button', { name: 'Terminal', exact: true }).click()

  const surface = page.getByTestId('tile-surface')
  await surface.waitFor()
  // The Master is the fixed main tile: present, no close button.
  await tile('master').waitFor()
  assert.equal(await page.getByRole('button', { name: 'Close Master Terminal' }).count(), 0)
  await shot('terminal-tiles-master')

  // Subagents of working runs open as read-only tiles, on Claude and on OpenCode runs.
  for (const seat of ['pm', 'builder']) {
    const t = page.getByRole('region', { name: seat })
    await t.waitFor()
    await t.getByText('read-only').waitFor()
    await t.getByRole('log').waitFor()
    assert.equal(await t.locator('textarea').count(), 0, 'a subagent tile takes no input')
  }
  await shot('terminal-tiles-subagents')

  // A new shell opens as another tile beside the others, not in the drawer.
  const count = () => page.locator('[data-tile]').count()
  const n = await count()
  await page.keyboard.press('Alt+Shift+T')
  await poll('shell tile', async () => (await count()) === n + 1)
  assert.equal(await page.getByTestId('terminal-drawer').count(), 0, 'the project terminals live in the tiles')
  const shell = page.getByRole('region', { name: /^Shell: / })
  await shell.waitFor()
  const mb = await rect('master')
  const sb = await shell.evaluate((e) => ({ x: e.offsetLeft, w: e.offsetWidth }))
  assert.ok(sb.x !== mb.x || sb.w !== mb.w, 'the shell tile has its own rect')
  await shot('terminal-tiles-shell')

  // Layout key: the master layout puts the Master in a left pane of fixed share.
  const before = await rect('master')
  await page.keyboard.press('Alt+Shift+L')
  await poll('master layout', async () => (await surface.getAttribute('data-layout')) === 'master')
  await page.waitForTimeout(400)
  const after = await rect('master')
  assert.ok(after.h > before.h || after.w !== before.w, 'the layout key changes the tile rects')
  assert.equal(after.x, before.x)
  await shot('terminal-tiles-master-layout')

  // Fullscreen key: the focused tile fills the surface, the others hide; pressing again restores.
  await tile('master').click({ position: { x: 20, y: 12 } })
  await page.keyboard.press('Alt+Shift+F')
  await poll('fullscreen', async () => (await tile('master').getAttribute('data-fullscreen')) === 'true')
  await page.waitForTimeout(300)
  const box = await surface.evaluate((e) => ({ w: e.clientWidth, h: e.clientHeight }))
  const full = await rect('master')
  assert.ok(Math.abs(full.w - box.w) <= 1 && Math.abs(full.h - box.h) <= 1, 'fullscreen fills the surface')
  await page.keyboard.press('Alt+Shift+F')
  await poll('fullscreen off', async () => (await tile('master').getAttribute('data-fullscreen')) === 'false')

  // Close tile: the button and the key remove a tile; the key never closes the Master.
  await page.getByRole('button', { name: 'Close builder' }).click()
  await page.getByRole('region', { name: 'builder' }).waitFor({ state: 'detached' })
  await page.getByRole('region', { name: 'pm' }).click({ position: { x: 20, y: 12 } })
  await page.keyboard.press('Alt+Shift+W')
  await page.getByRole('region', { name: 'pm' }).waitFor({ state: 'detached' })
  await tile('master').click({ position: { x: 20, y: 12 } })
  await page.keyboard.press('Alt+Shift+W')
  await tile('master').waitFor()
  await shot('terminal-tiles-closed')
  console.log('terminal e2e ok')
} finally {
  await app.close()
}
