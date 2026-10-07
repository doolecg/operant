// Dashboard jobs e2e: the project list (PRJ# and drag-to-reorder that survives a restart), the Master Terminal with
// the Plus menu, the job card grid, the job panel and the read-only agent view. Runs in the background with
// throwaway data and a fake claude. Usage: node e2e/runs.mjs [outDir]  (default docs/specs/screenshots)
// Set OPERANT_E2E_EXE to a packaged executable to test a build instead of the dev app.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const outDir = resolve(process.argv[2] ?? 'docs/specs/screenshots')
mkdirSync(outDir, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), 'operant-runs-'))
const project = mkdtempSync(join(tmpdir(), 'operant-runs-proj-'))
const claudeDir = mkdtempSync(join(tmpdir(), 'operant-runs-claude-'))
writeFileSync(join(project, 'app.ts'), 'export const a = 1\n')

const env = { ...process.env, OPERANT_BACKGROUND: '1', OPERANT_E2E: '1', OPERANT_DATA_DIR: dataDir, CLAUDE_CONFIG_DIR: claudeDir }
const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
env[pathKey] = resolve('e2e/fixtures/bin') + delimiter + env[pathKey]
const packaged = process.env.OPERANT_E2E_EXE

let app = null
let page = null
async function launch() {
  app = await electron.launch(packaged ? { executablePath: packaged, args: [], env } : { args: ['.'], env })
  page = await app.firstWindow()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForFunction(() => !!window.operant)
}
const inv = (channel, ...args) => page.evaluate(([c, a]) => window.operant.invoke(c, ...a), [channel, args])
const shot = async (name) => {
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(outDir, `${name}.png`) })
}
const order = async () => (await inv('crews:list')).map((c) => c.name)
async function orderIs(expected) {
  const end = Date.now() + 10_000
  while (Date.now() < end) {
    if (JSON.stringify(await order()) === JSON.stringify(expected)) return
    await page.waitForTimeout(200)
  }
  assert.deepEqual(await order(), expected)
}

try {
  await launch()
  await page.getByText('Welcome to Operant 3').waitFor()

  const ids = await page.evaluate(async (folder) => {
    const o = window.operant
    const alpha = await o.invoke('crews:create', { name: 'alpha', folder })
    const beta = await o.invoke('crews:create', { name: 'beta', folder })
    const gamma = await o.invoke('crews:create', { name: 'gamma', folder })
    const presets = await o.invoke('presets:list')
    const pm = presets.find((p) => p.builtin === 'pm')
    const reviewer = presets.find((p) => p.builtin === 'reviewer')
    const team = await o.invoke('teams:create', {
      name: 'duo',
      seats: [
        { presetId: pm.id, count: 1, model: 'sonnet' },
        { presetId: reviewer.id, count: 2, model: 'haiku' },
      ],
    })
    return { alpha: alpha.id, beta: beta.id, gamma: gamma.id, team: team.id }
  }, project)

  // Project list: PRJ# and a drag handle on every row.
  await page.getByText('PRJ#', { exact: false }).first().waitFor()
  assert.equal(await page.locator('[data-crew-row]').count(), 3)
  for (const name of ['alpha', 'beta', 'gamma']) await page.getByRole('button', { name: `Reorder ${name}` }).waitFor()
  await page.locator(`[data-crew-row="${ids.alpha}"]`).getByText('alpha', { exact: true }).click({ position: { x: 4, y: 4 } })
  await page.getByRole('heading', { name: 'alpha', level: 1 }).waitFor()

  // The workspace: Master Terminal in the centre, jobs on the right.
  await page.getByRole('button', { name: 'Start new task' }).waitFor()
  await page.getByText('No jobs yet.').waitFor()

  // Plus menu: team run with edited seats.
  await page.getByRole('button', { name: 'Start new task' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Send' }).isDisabled().then((d) => assert.ok(d, 'Send must wait for a task'))
  await dialog.getByLabel('Task').fill('Add a health check to app.ts')
  await dialog.getByRole('button', { name: 'Team', exact: true }).click()
  await dialog.getByLabel('Team', { exact: true }).click()
  await page.getByRole('option', { name: 'duo' }).click()
  await dialog.getByLabel('Master model').waitFor()
  await dialog.getByLabel('Seat 2 preset').waitFor()
  assert.equal(await dialog.getByLabel('Seat 2 count').inputValue(), '2')
  await dialog.getByLabel('Seat 2 count').fill('3')
  await dialog.getByLabel('Seat 1 custom model id').fill('opus')
  await dialog.getByRole('button', { name: 'Add seat' }).click()
  await dialog.getByLabel('Seat 3 count').waitFor()
  await dialog.getByRole('button', { name: 'Remove seat 3' }).click()
  assert.equal(await dialog.getByLabel('Seat 3 count').count(), 0)
  await shot('plus-menu')

  await dialog.getByRole('button', { name: 'Send' }).click()
  await dialog.waitFor({ state: 'detached' })
  const card = page.getByRole('button', { name: /Open JOB#\d+/ })
  await card.waitFor()
  const runs = await inv('runs:list', ids.alpha)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].task, 'Add a health check to app.ts')
  assert.equal(runs[0].teamId, ids.team)
  assert.deepEqual(
    runs[0].seats.map((s) => [s.count, s.model]),
    [
      [1, 'opus'],
      [3, 'haiku'],
    ],
  )
  const runId = runs[0].id
  assert.ok(runId >= 20001)
  await card.getByText(/Queued|Working/).waitFor()
  await shot('dashboard-after')

  // Agents are read from the CLI by the backend; seed two rows the way it would.
  const db = new DatabaseSync(join(dataDir, 'operant.db'))
  db.exec('PRAGMA busy_timeout = 5000')
  const add = db.prepare('INSERT INTO job_agents (run_id, seat, model, status, transcript_ref) VALUES (?, ?, ?, ?, ?)')
  add.run(runId, 'pm', 'opus', 'working', 'agent-1.jsonl')
  add.run(runId, 'reviewer', 'haiku', 'done', 'agent-2.jsonl')
  db.close()

  await card.click()
  const panel = page.getByRole('region', { name: `Job panel JOB#${runId}` })
  await panel.waitFor()
  await panel.getByText('Add a health check to app.ts').waitFor()
  await panel.getByRole('button', { name: 'Open agent pm' }).waitFor()
  await panel.getByRole('button', { name: 'Open agent reviewer' }).waitFor()
  await shot('job-panel')
  // The panel leaves the Master header alone: its buttons stay on top and clickable.
  const reachable = await page.evaluate(() => {
    const b = document.querySelector('button[aria-label="Start new task"]')
    const r = b.getBoundingClientRect()
    return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === b || b.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
  })
  assert.ok(reachable, 'the job panel must not cover the Master header buttons')

  // The status pill shows the job counts and Memory (Hindsight and CodeGraph health in one dot); its tooltip lists both.
  const status = page.getByRole('group', { name: 'Status' })
  await status.getByRole('status', { name: /^Jobs:/ }).waitFor()
  const memory = status.getByLabel(/^Memory: Hindsight .*CodeGraph /)
  await memory.waitFor()
  await memory.hover()
  const tip = page.getByRole('tooltip')
  await tip.waitFor()
  assert.match((await tip.first().textContent()) ?? '', /Hindsight .*CodeGraph /)
  await shot('project-header')

  // The agent view is a live view: working indicator, follow toggle, copy; read-only.
  await panel.getByRole('button', { name: 'Open agent pm' }).click()
  await panel.getByText('Read-only').waitFor()
  await panel.getByRole('status', { name: 'Working' }).waitFor()
  assert.equal(await panel.getByRole('button', { name: 'Follow the newest line' }).getAttribute('aria-pressed'), 'true')
  await panel.getByRole('button', { name: 'Follow the newest line' }).click()
  assert.equal(await panel.getByRole('button', { name: 'Follow the newest line' }).getAttribute('aria-pressed'), 'false')
  await panel.getByRole('button', { name: 'Copy the log' }).waitFor()
  await panel.getByText('agent-1.jsonl').waitFor()
  await panel.getByRole('log').waitFor()
  await shot('agent-view')
  await panel.getByRole('button', { name: 'Back to agent list' }).click()

  // A second job waits in the queue: its card edits the task, then stops it (the panel is closed so the cards show).
  await panel.getByRole('button', { name: 'Close job panel' }).click()
  await panel.waitFor({ state: 'detached' })
  const second = await inv('runs:create', { crewId: ids.alpha, task: 'Second task', masterCli: 'claude' })
  const secondCard = page.locator('li', { has: page.getByRole('button', { name: `Open JOB#${second.id}` }) })
  await secondCard.getByText('Second task').waitFor()
  await secondCard.getByRole('button', { name: `Edit task of JOB#${second.id}` }).click()
  await secondCard.getByLabel(`Task of JOB#${second.id}`).fill('Second task, edited')
  await secondCard.getByRole('button', { name: 'Save task' }).click()
  await secondCard.getByText('Second task, edited').waitFor()
  assert.equal((await inv('runs:get', second.id)).task, 'Second task, edited')
  await secondCard.getByRole('button', { name: `Stop JOB#${second.id}` }).click()
  await secondCard.getByText('Failed').waitFor()
  await secondCard.getByRole('button', { name: `Delete JOB#${second.id}` }).click()
  await secondCard.getByRole('button', { name: `Confirm delete JOB#${second.id}` }).click()
  await secondCard.waitFor({ state: 'detached' })
  await shot('job-cards')

  await card.click()
  await panel.waitFor()
  // Actions: stopping ends the job as failed, live, and the card follows.
  await panel.getByRole('button', { name: 'Stop job' }).click()
  await panel.getByText('Failed', { exact: true }).waitFor()
  await card.getByText('Failed').waitFor()
  assert.equal((await inv('runs:get', runId)).status, 'failed')
  await panel.getByRole('button', { name: 'Delete job' }).click()
  await panel.getByRole('button', { name: 'Confirm delete' }).click()
  await panel.waitFor({ state: 'detached' })
  await page.getByText('No jobs yet.').waitFor()
  assert.equal((await inv('runs:list', ids.alpha)).length, 0)

  // Reorder by dragging a row by its handle; the order is saved and survives a restart.
  assert.deepEqual(await order(), ['alpha', 'beta', 'gamma'])
  // An OS-level drag does not run in a window that never takes focus, so the drag events are sent directly.
  const dt = await page.evaluateHandle(() => new DataTransfer())
  const gammaRow = page.locator(`[data-crew-row="${ids.gamma}"]`)
  const alphaRow = page.locator(`[data-crew-row="${ids.alpha}"]`)
  await gammaRow.dispatchEvent('dragstart', { dataTransfer: dt })
  await alphaRow.dispatchEvent('dragover', { dataTransfer: dt })
  await alphaRow.dispatchEvent('drop', { dataTransfer: dt })
  await gammaRow.dispatchEvent('dragend', { dataTransfer: dt })
  await orderIs(['gamma', 'alpha', 'beta'])
  // The keyboard moves a row too.
  await page.getByRole('button', { name: 'Reorder beta' }).press('ArrowUp')
  await orderIs(['gamma', 'beta', 'alpha'])
  await shot('project-reorder')

  // The seat dialog's default model and effort come from the CLI's own list.
  await page.keyboard.press('Control+,')
  await page.getByRole('heading', { name: 'Settings' }).waitFor()
  await page.getByRole('button', { name: 'Presets', exact: true }).click()
  await page.getByRole('button', { name: /^Seat settings for / }).first().click()
  const seat = page.getByRole('dialog')
  await seat.getByLabel('model', { exact: true }).waitFor()
  await seat.getByLabel('effort', { exact: true }).waitFor()
  await shot('settings-seat-dialog')
  await seat.getByRole('button', { name: 'Cancel' }).click()

  const closeStart = Date.now()
  await app.close()
  assert.ok(Date.now() - closeStart < 20_000, `quitting took ${Date.now() - closeStart} ms`)
  await launch()
  await page.getByRole('button', { name: 'Reorder gamma' }).waitFor()
  assert.deepEqual(await order(), ['gamma', 'beta', 'alpha'])
  const rows = await page.locator('[data-crew-row]').evaluateAll((els) => els.map((e) => e.textContent))
  assert.ok(rows[0].includes('gamma') && rows[2].includes('alpha'), rows.join())
  console.log('runs e2e passed; screenshots in', outDir)
} catch (err) {
  await page?.screenshot({ path: join(outDir, 'fail-runs.png') }).catch(() => {})
  throw err
} finally {
  await app?.close().catch(() => {})
  for (const d of [dataDir, project, claudeDir]) rmSync(d, { recursive: true, force: true })
}
