// Dashboard smoke test: seed a crew through the real IPC bridge, run a shell operator,
// write to its terminal over IPC, open the seat editor and settings, and save screenshots. Runs in the background with throwaway data.
// Usage: node e2e/dashboard.mjs [outDir]
// Set OPERANT_E2E_EXE to a packaged executable to test a build instead of the dev app.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const outDir = resolve(process.argv[2] ?? 'out/e2e')
mkdirSync(outDir, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), 'operant-e2e-'))
const project = mkdtempSync(join(tmpdir(), 'operant-proj-'))
const claudeDir = mkdtempSync(join(tmpdir(), 'operant-claude-'))
writeFileSync(join(project, 'app.ts'), 'export function main() { return helper() }\nfunction helper() { return 1 }\n')

// Put the fake `claude` first on PATH (the key is "Path" on Windows) and point transcripts at a temp dir.
const env = { ...process.env, OPERANT_BACKGROUND: '1', OPERANT_E2E: '1', OPERANT_DATA_DIR: dataDir, CLAUDE_CONFIG_DIR: claudeDir }
const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
env[pathKey] = resolve('e2e/fixtures/bin') + delimiter + env[pathKey]

const packaged = process.env.OPERANT_E2E_EXE
const app = await electron.launch(packaged ? { executablePath: packaged, args: [], env } : { args: ['.'], env })
try {
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByText('Welcome to Operant 3').waitFor()
  await page.screenshot({ path: join(outDir, '0-welcome.png') })

  const ids = await page.evaluate(async (folder) => {
    const o = window.operant
    const crew = await o.invoke('crews:create', { name: 'shop', folder })
    const dev = await o.invoke('squads:create', { crewId: crew.id, name: 'dev' })
    const review = await o.invoke('squads:create', { crewId: crew.id, name: 'review' })
    const lead = await o.invoke('operators:create', { squadId: dev.id, role: 'lead', agent: 'claude', model: 'opus' })
    await o.invoke('operators:create', { squadId: dev.id, role: 'builder', agent: 'claude', model: 'sonnet' })
    const sh = await o.invoke('operators:create', { squadId: dev.id, role: 'runner', agent: 'shell', model: '-' })
    await o.invoke('operators:create', { squadId: review.id, role: 'reviewer', agent: 'codex', model: 'gpt-5' })
    const t1 = await o.invoke('jobs:create', { crewId: crew.id, title: 'Build the crew dashboard', for: sh.id })
    await o.invoke('jobs:move', t1.id, { state: 'doing' })
    await o.invoke('jobs:create', { crewId: crew.id, title: 'Parse transcript usage', for: lead.id })
    await o.invoke('jobs:create', { crewId: crew.id, title: 'Settings page' })
    await o.invoke('operators:start', sh.id)
    await o.invoke('operators:start', lead.id)
    return { crew: crew.id, shell: sh.id, lead: lead.id }
  }, project)

  // Pushed events should refresh the view without a reload.
  await page.locator(`[data-crew-row="${ids.crew}"]`).getByText('shop', { exact: true }).click({ position: { x: 4, y: 4 } })
  await page.getByRole('heading', { name: 'shop' }).waitFor()
  // The workspace is the default; the crew topology screens are gone, so the operators run without a card.
  const group = page.getByRole('group', { name: 'Dashboard mode' })
  await group.getByRole('button', { name: 'Workspace', exact: true }).waitFor()
  assert.deepEqual(await group.getByRole('button').allInnerTexts(), ['Workspace', 'Terminal', 'Seats', 'Memory'], 'four view pills')
  assert.equal(await group.getByRole('button', { name: 'Crew', exact: true }).count(), 0, 'crew mode is gone')
  await page.locator('[data-workspace-board]').waitFor()
  await group.getByRole('button', { name: 'Terminal', exact: true }).click()
  await page.getByRole('region', { name: 'Master Terminal' }).waitFor()
  await page.getByRole('region', { name: 'Workspace panels' }).waitFor()

  // The fake claude writes two messages: spend $0.462 at Opus 5.5 prices.
  const poll = async (label, fn, timeout = 20_000) => {
    for (const end = Date.now() + timeout; Date.now() < end; await page.waitForTimeout(250)) if (await fn()) return
    throw new Error(`timed out waiting for ${label}`)
  }
  await poll('spend', async () => (await page.evaluate(() => window.operant.invoke('dashboard:summary'))).spendToday > 0.4).catch(async (err) => {
    console.error('lead terminal: ' + (await page.evaluate((id) => window.operant.invoke('operators:buffer', id), ids.lead)))
    throw err
  })
  const spent = await page.evaluate(() => window.operant.invoke('dashboard:summary'))
  assert.ok(Math.abs(spent.spendToday - 0.462) < 1e-9, `spendToday ${spent.spendToday}`)

  // The project block at the top left shows its mini buttons on hover.
  await page.getByRole('heading', { level: 1 }).hover()
  await page.getByRole('button', { name: 'Index with CodeGraph' }).click()
  await poll('index', async () => (await page.evaluate((id) => window.operant.invoke('events:recent', 50), ids.crew)).some((e) => /shop indexed: 1 files/.test(e.message)), 60_000)
  await page.screenshot({ path: join(outDir, '1-dashboard.png') })

  // The side panel's tabs: Board by default, then every other panel is reachable.
  const tabs = page.getByRole('tablist', { name: 'Workspace panels' })
  await tabs.getByRole('tab', { name: /^Board/, selected: true }).waitFor()
  await tabs.getByRole('tab', { name: /^Board/ }).click()
  await page.getByText('Build the crew dashboard').waitFor()
  await tabs.getByRole('tab', { name: /^Messages/ }).click()
  await page.getByRole('navigation', { name: 'Conversations' }).waitFor()
  await tabs.getByRole('tab', { name: 'Activity' }).click()
  await page.getByText(/shop indexed: 1 files/).first().waitFor()
  await tabs.getByRole('tab', { name: 'Usage' }).click()
  await page.getByRole('heading', { name: 'Usage', exact: true }).waitFor()
  await page.screenshot({ path: join(outDir, '1b-workspace-tabs.png') })
  await page.screenshot({ path: resolve('docs/specs/screenshots/workspace-tabs.png') })
  await tabs.getByRole('tab', { name: /^Board/ }).click()

  // Seat editor: the Seats toggle shows seats and teams in the node view and the list view.
  await group.getByRole('button', { name: 'Seats', exact: true }).click()
  const editor = page.getByRole('region', { name: 'Seat editor' })
  await editor.waitFor()
  await page.getByTestId('seat-graph').waitFor()
  await page.locator('.react-flow__node').first().waitFor()
  const inv = (channel, ...args) => page.evaluate(([c, a]) => window.operant.invoke(c, ...a), [channel, args])
  const dialog = page.getByRole('dialog')
  const view = page.getByRole('group', { name: 'Seat editor view' })

  // Nodes view: create a team and a seat, edit both, change the seat's settings.
  await editor.getByRole('button', { name: 'New team' }).click()
  await dialog.getByLabel('Name', { exact: true }).fill('Core')
  await dialog.getByRole('button', { name: 'Add seat' }).click()
  await dialog.getByRole('button', { name: 'Create team' }).click()
  await editor.getByRole('button', { name: 'Edit Core' }).waitFor()
  await editor.getByRole('button', { name: 'New seat' }).click()
  await dialog.getByLabel('Name', { exact: true }).fill('e2e seat')
  await dialog.getByRole('button', { name: 'Create preset' }).click()
  await editor.getByRole('button', { name: 'Edit e2e seat' }).waitFor()
  await editor.getByRole('button', { name: 'Edit Core' }).click()
  await dialog.getByLabel('Name', { exact: true }).fill('Core crew')
  await dialog.getByLabel('Max workers').fill('3')
  await dialog.getByRole('button', { name: 'Save team' }).click()
  await editor.getByRole('button', { name: 'Edit Core crew' }).waitFor()
  const team = (await inv('teams:list')).find((t) => t.name === 'Core crew')
  assert.ok(team && team.seats.length === 1 && team.limits.maxWorkers === 3, 'team saved from the node view')
  const hindsightBefore = (await inv('presets:list')).find((p) => p.name === 'e2e seat').hindsight
  await editor.getByRole('button', { name: 'Seat settings for e2e seat' }).click()
  await dialog.getByRole('switch', { name: 'Hindsight memory' }).click()
  await dialog.getByRole('button', { name: 'Save seat' }).click()
  await dialog.waitFor({ state: 'detached' })
  assert.equal((await inv('presets:list')).find((p) => p.name === 'e2e seat').hindsight, !hindsightBefore, 'seat settings saved from the node view')
  await page.locator('.react-flow__edge').first().waitFor()
  await page.waitForTimeout(600)
  await page.screenshot({ path: join(outDir, '2-seats-nodes.png') })

  // List view: the same data; create, then delete a team and a seat with their confirmations.
  await view.getByRole('button', { name: 'List', exact: true }).click()
  await editor.getByRole('button', { name: 'Edit Core crew' }).waitFor()
  await page.screenshot({ path: join(outDir, '2-seats-list.png') })
  await editor.getByRole('button', { name: 'New team' }).click()
  await dialog.getByLabel('Name', { exact: true }).fill('Extra')
  await dialog.getByRole('button', { name: 'Create team' }).click()
  await editor.getByRole('button', { name: 'Delete Extra' }).click()
  await dialog.getByRole('button', { name: 'Delete team' }).click()
  await poll('team deleted', async () => !(await inv('teams:list')).some((t) => t.name === 'Extra'))
  await editor.getByRole('button', { name: 'Delete e2e seat' }).click()
  await dialog.getByRole('button', { name: 'Delete seat' }).click()
  await poll('seat deleted', async () => !(await inv('presets:list')).some((p) => p.name === 'e2e seat'))
  await view.getByRole('button', { name: 'Nodes', exact: true }).click()
  await page.locator('.react-flow__node').first().waitFor()
  await group.getByRole('button', { name: 'Terminal', exact: true }).click()
  await page.getByRole('region', { name: 'Master Terminal' }).waitFor()

  // The operator's PTY still runs a command over IPC.
  await page.evaluate((id) => window.operant.invoke('operators:write', id, 'echo operant-e2e-ok' + String.fromCharCode(13)), ids.shell)
  await poll('shell output', async () => (await page.evaluate((id) => window.operant.invoke('operators:buffer', id), ids.shell)).includes('operant-e2e-ok'), 15_000)
  await page.evaluate((id) => window.operant.invoke('operators:stop', id), ids.shell)
  await poll('shell stopped', async () => (await page.evaluate(() => window.operant.invoke('dashboard:summary'))).operatorsRunning === 1)
  const summary = await page.evaluate(() => window.operant.invoke('dashboard:summary'))
  assert.equal(summary.operatorsRunning, 1)
  assert.equal(summary.operatorsTotal, 4)
  assert.equal(summary.tasksOpen, 3)

  // Settings: open with the default shortcut, set a budget, rebind a shortcut and use it.
  await page.keyboard.press('Control+,')
  await page.getByRole('heading', { name: 'Settings' }).waitFor()
  if (!packaged) await page.getByText('Updates run in installed builds only').waitFor()
  await page.getByRole('button', { name: 'Tokens', exact: true }).click()
  await page.getByLabel('Daily budget (USD)').fill('0.25')
  await page.getByLabel('Daily budget (USD)').press('Enter')
  await page.getByRole('button', { name: 'Shortcuts', exact: true }).click()
  await page.getByRole('button', { name: 'Ctrl+N' }).click()
  await page.keyboard.press('Control+Shift+K')
  await page.getByRole('button', { name: 'Ctrl+Shift+K' }).waitFor()
  await page.screenshot({ path: join(outDir, '4-settings.png') })
  const saved = await page.evaluate(() => window.operant.invoke('settings:get'))
  assert.equal(saved.dailyBudgetUsd, 0.25)
  assert.equal(saved.keybinds.newCrew, 'Mod+Shift+K')

  console.log('dashboard e2e passed; screenshots in', outDir)
} finally {
  await app.close()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
  rmSync(claudeDir, { recursive: true, force: true })
}
