// Dashboard smoke test: seed a crew through the real IPC bridge, run a shell operator,
// type into its terminal, and save screenshots. Runs in the background with throwaway data.
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
const env = { ...process.env, OPERANT_BACKGROUND: '1', OPERANT_DATA_DIR: dataDir, CLAUDE_CONFIG_DIR: claudeDir }
const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
env[pathKey] = resolve('e2e/fixtures/bin') + delimiter + env[pathKey]

const packaged = process.env.OPERANT_E2E_EXE
const app = await electron.launch(packaged ? { executablePath: packaged, args: [], env } : { args: ['.'], env })
try {
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByText('Welcome to Operant 2').waitFor()
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
    const t1 = await o.invoke('tasks:create', { crewId: crew.id, title: 'Build the crew dashboard', operatorId: sh.id })
    await o.invoke('tasks:move', t1.id, 'doing')
    await o.invoke('tasks:create', { crewId: crew.id, title: 'Parse transcript usage', operatorId: lead.id })
    await o.invoke('tasks:create', { crewId: crew.id, title: 'Settings page' })
    await o.invoke('operators:start', sh.id)
    await o.invoke('operators:start', lead.id)
    return { crew: crew.id, shell: sh.id, lead: lead.id }
  }, project)

  // Pushed events should refresh the view without a reload.
  await page.getByRole('heading', { name: 'shop' }).waitFor()
  await page.getByText('runner@shop', { exact: true }).waitFor()
  await page.getByText('runner@shop started').waitFor()
  await page.getByText('Working on:').waitFor()
  assert.equal(await page.getByText('Running', { exact: true }).count(), 2)

  // The fake claude writes two messages: context 155k after msg_2, spend $0.462 at Opus 5.5 prices.
  await page
    .getByText('155K')
    .waitFor({ timeout: 20_000 })
    .catch(async (err) => {
      console.error('lead terminal:\n' + (await page.evaluate((id) => window.operant.invoke('operators:buffer', id), ids.lead)))
      throw err
    })
  const spent = await page.evaluate(() => window.operant.invoke('dashboard:summary'))
  assert.ok(Math.abs(spent.spendToday - 0.462) < 1e-9, `spendToday ${spent.spendToday}`)

  await page.getByRole('button', { name: 'Index with CodeGraph' }).click()
  await page.getByText(/shop indexed: 1 files/).waitFor({ timeout: 60_000 })
  await page.screenshot({ path: join(outDir, '1-dashboard.png') })

  await page.getByRole('tab', { name: /Tasks/ }).click()
  await page.getByText('Parse transcript usage').waitFor()
  await page.screenshot({ path: join(outDir, '2-tasks.png') })

  await page.getByRole('tab', { name: 'Cost' }).click()
  await page.getByText('$0.46').first().waitFor()
  await page.screenshot({ path: join(outDir, '2-cost.png') })

  // Open the running operator's terminal and run a command through the PTY.
  await page.getByText('runner@shop', { exact: true }).locator('xpath=../../..').getByRole('button', { name: 'Terminal' }).click()
  await page.locator('.xterm').waitFor()
  await page.waitForTimeout(1500)
  await page.keyboard.type('echo operant-e2e-ok')
  await page.keyboard.press('Enter')
  await page.waitForFunction(
    async (id) => (await window.operant.invoke('operators:buffer', id)).includes('operant-e2e-ok'),
    ids.shell,
    { timeout: 15_000, polling: 250 },
  )
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(outDir, '3-terminal.png') })

  await page.getByRole('button', { name: 'Stop operator' }).click()
  await page.getByText('This operator is not running.').waitFor()
  const summary = await page.evaluate(() => window.operant.invoke('dashboard:summary'))
  assert.equal(summary.operatorsRunning, 1)
  assert.equal(summary.operatorsTotal, 4)
  assert.equal(summary.tasksOpen, 3)

  // Settings: open with the default shortcut, set a budget, rebind a shortcut and use it.
  await page.keyboard.press('Escape')
  await page.getByText('This operator is not running.').waitFor({ state: 'detached' })
  await page.keyboard.press('Control+,')
  await page.getByRole('heading', { name: 'Settings' }).waitFor()
  if (!packaged) await page.getByText('Updates run in installed builds only').waitFor()
  await page.getByLabel('Daily budget (USD)').fill('0.25')
  await page.getByLabel('Daily budget (USD)').press('Enter')
  await page.getByRole('button', { name: 'Ctrl+3' }).click()
  await page.keyboard.press('Control+Shift+K')
  await page.getByRole('button', { name: 'Ctrl+Shift+K' }).waitFor()
  await page.screenshot({ path: join(outDir, '4-settings.png') })
  const saved = await page.evaluate(() => window.operant.invoke('settings:get'))
  assert.equal(saved.dailyBudgetUsd, 0.25)
  assert.equal(saved.keybinds.tabCost, 'Mod+Shift+K')

  await page.getByText('shop', { exact: true }).first().click()
  await page.getByText('of $0.25 daily budget').waitFor()
  await page.getByRole('tab', { name: 'Activity' }).click()
  await page.keyboard.press('Control+Shift+K')
  await page.getByText('Last 24 hours, this crew').waitFor()
  console.log('dashboard e2e passed; screenshots in', outDir)
} finally {
  await app.close()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
  rmSync(claudeDir, { recursive: true, force: true })
}
