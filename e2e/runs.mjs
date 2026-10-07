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
  // Master mode is the default; the switch opts into the headless runner, which this flow drives.
  assert.equal(await dialog.getByRole('switch', { name: 'Run in background' }).getAttribute('aria-checked'), 'false')
  await dialog.getByText('Runs without the Master Terminal, no review step.').waitFor()
  await dialog.getByRole('switch', { name: 'Run in background' }).click()
  await dialog.getByRole('button', { name: 'Team', exact: true }).click()
  await dialog.getByLabel('Team', { exact: true }).click()
  // Built-in teams come first in their own group, the user's after.
  await page.getByText('Built-in', { exact: true }).waitFor()
  await page.getByText('Yours', { exact: true }).waitFor()
  await page.getByRole('option', { name: 'Build and review' }).waitFor()
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
  // Save the chosen seats as a team of the user's own; it is picked straight away.
  await dialog.getByRole('button', { name: 'Save as team' }).click()
  await dialog.getByLabel('Team name').fill('duo plus')
  await dialog.getByRole('button', { name: 'Save team' }).click()
  await dialog.getByLabel('Team name').waitFor({ state: 'detached' })
  const savedTeam = (await inv('teams:list')).find((t) => t.name === 'duo plus')
  assert.ok(savedTeam && savedTeam.builtin === null, 'Save as team makes a user team')
  assert.deepEqual(savedTeam.seats.map((s) => [s.count, s.model]), [[1, 'opus'], [3, 'haiku']])
  await shot('plus-menu')

  await dialog.getByRole('button', { name: 'Send' }).click()
  await dialog.waitFor({ state: 'detached' })
  const card = page.getByRole('button', { name: /Open JOB#\d+/ })
  await card.waitFor()
  const runs = await inv('runs:list', ids.alpha)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].task, 'Add a health check to app.ts')
  assert.equal(runs[0].teamId, savedTeam.id)
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
  const second = await inv('runs:create', { crewId: ids.alpha, task: 'Second task', masterCli: 'claude', mode: 'background' })
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

  // A finished job's outcome is Markdown: structure is rendered, nothing in it executes or navigates the window.
  const outcome = [
    '# Health check added',
    '',
    'It **works**, ~~mostly~~ fully, see [the docs](https://example.com/docs) or [bad](javascript:window.__pwned=1).',
    '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>',
    '',
    '- first item',
    '  - nested item',
    '- [x] ticked task',
    '',
    '| File | Lines |',
    '|:--|--:|',
    '| app.ts | 12 |',
    '| core.ts | 340 |',
    '',
    '```ts',
    'export const ok = () => true',
    '```',
  ].join('\n')
  const third = await inv('runs:create', { crewId: ids.alpha, task: 'Third task', masterCli: 'claude', mode: 'background' })
  await inv('runs:stop', third.id)
  const mdDb = new DatabaseSync(join(dataDir, 'operant.db'))
  mdDb.exec('PRAGMA busy_timeout = 5000')
  mdDb.prepare("UPDATE runs SET status = 'done', outcome = ?, finished_at = ? WHERE id = ?").run(outcome, Date.now(), third.id)
  mdDb.close()
  await page.reload()
  await page.waitForFunction(() => !!window.operant)
  await page.locator(`[data-crew-row="${ids.alpha}"]`).getByText('alpha', { exact: true }).click({ position: { x: 4, y: 4 } })
  await page.evaluate(() => {
    window.__pwned = false
  })
  const mdCard = page.locator('li', { has: page.getByRole('button', { name: `Open JOB#${third.id}` }) })
  await mdCard.getByText('Health check added').waitFor()
  assert.ok(!(await mdCard.textContent()).replace(/JOB#\d+/g, '').includes('#'), 'the card preview is plain text')
  await mdCard.getByRole('button', { name: `Open JOB#${third.id}` }).click()
  const mdPanel = page.getByRole('region', { name: `Job panel JOB#${third.id}` })
  const md = mdPanel.locator('[data-outcome] [data-markdown]')
  await md.waitFor()
  await md.getByRole('heading', { name: 'Health check added' }).waitFor()
  assert.equal(await md.locator('li').count(), 3)
  assert.equal(await md.locator('ul ul li').count(), 1)
  assert.equal(await md.locator('input[type=checkbox][disabled]').count(), 1)
  assert.equal(await md.locator('table th').count(), 2)
  assert.equal(await md.locator('table tbody tr').count(), 2)
  assert.equal(await md.locator('strong').innerText(), 'works')
  assert.equal(await md.locator('del').count(), 1)
  assert.ok((await md.locator('pre').innerText()).includes('export const ok'))
  await md.getByRole('button', { name: 'Copy code' }).waitFor()
  assert.equal(await md.locator('script, img, iframe').count(), 0)
  const hrefs = await md.locator('a').evaluateAll((els) => els.map((a) => a.getAttribute('href')))
  assert.deepEqual(hrefs, ['https://example.com/docs'])
  assert.ok((await md.textContent()).includes('<script>window.__pwned=1</script>'), 'html is shown as text')
  const url = page.url()
  await md.getByText('the docs').click()
  await md.getByText('bad').click().catch(() => {})
  await page.waitForTimeout(300)
  assert.equal(page.url(), url, 'a link must not navigate the app window')
  assert.equal(await page.evaluate(() => window.__pwned), false, 'nothing in an outcome executes')
  await shot('run-outcome-markdown')
  await mdPanel.getByRole('button', { name: 'Close job panel' }).click()
  await mdPanel.waitFor({ state: 'detached' })
  await inv('runs:delete', third.id)

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

  // Master-mode jobs: the question, the review and the stopped Master are answered from the job panel. The rows are
  // seeded the way the Master would leave them (the Master Terminal itself is not driven here).
  const seedRun = async (task, patch) => {
    const r = await inv('runs:create', { crewId: ids.alpha, task, masterCli: 'claude', mode: 'background' })
    await inv('runs:stop', r.id)
    const d = new DatabaseSync(join(dataDir, 'operant.db'))
    d.exec('PRAGMA busy_timeout = 5000')
    d.prepare(
      'UPDATE runs SET mode = ?, status = ?, waiting = ?, question = ?, question_options = ?, review_summary = ?, finished_at = NULL WHERE id = ?',
    ).run('master', patch.status, patch.waiting ?? '', patch.question ?? '', JSON.stringify(patch.options ?? []), patch.review ?? '', r.id)
    d.prepare("INSERT INTO run_events (run_id, at, kind, source, body, options) VALUES (?, ?, 'progress', 'master', ?, '[]')").run(r.id, Date.now(), 'Reading the health check code')
    d.close()
    return r.id
  }
  const qId = await seedRun('Pick a port', { status: 'needs-you', waiting: 'question', question: 'Which **port** should the health check use?', options: ['3000', '8080'] })
  const rvId = await seedRun('Add a health check', { status: 'review', review: '## Done\n\n- added `/health`\n- tests pass' })
  const sbId = await seedRun('Tidy the logs', { status: 'review', review: 'Logs tidied.' })
  const mId = await seedRun('Long migration', { status: 'needs-you', waiting: 'master' })
  await page.reload()
  await page.waitForFunction(() => !!window.operant)
  await page.locator(`[data-crew-row="${ids.alpha}"]`).getByText('alpha', { exact: true }).click({ position: { x: 4, y: 4 } })
  const cardOf = (id) => page.locator('li', { has: page.getByRole('button', { name: `Open JOB#${id}` }) })
  await cardOf(qId).getByText('Needs you: question').waitFor()
  await cardOf(qId).getByText('Reading the health check code').waitFor()
  await cardOf(rvId).getByText('Review', { exact: true }).waitFor()
  await cardOf(mId).getByText('Needs you: Master stopped').waitFor()
  await page.getByRole('tab', { name: /^Runs/ }).getByText('4', { exact: true }).waitFor()
  // The status pill chip opens the Runs tab filtered to the jobs that need the owner.
  await page.getByRole('button', { name: /jobs need you/ }).click()
  assert.equal(await page.getByRole('checkbox', { name: 'Only jobs that need you' }).isChecked(), true)

  // Question: option buttons and a free text answer.
  await page.getByRole('button', { name: `Open JOB#${qId}` }).click()
  const qPanel = page.getByRole('region', { name: `Job panel JOB#${qId}` })
  await qPanel.getByRole('heading', { name: 'Question' }).waitFor()
  await qPanel.getByText('Reading the health check code').waitFor()
  await shot('run-question')
  await qPanel.getByRole('button', { name: '8080' }).click()
  await qPanel.getByText('Answered by you, in Operant').waitFor()
  assert.ok((await inv('runs:events', qId)).some((e) => e.kind === 'reply' && e.body === '8080'))
  await qPanel.getByLabel('Your answer').fill('Use 9000')
  await qPanel.getByRole('button', { name: 'Send answer' }).click()
  await qPanel.getByText('Use 9000').waitFor()
  await qPanel.getByRole('button', { name: 'Close job panel' }).click()

  // Review: the summary is Markdown; Approve moves to done and shows the close-out.
  await page.getByRole('button', { name: `Open JOB#${rvId}` }).click()
  const rPanel = page.getByRole('region', { name: `Job panel JOB#${rvId}` })
  await rPanel.locator('[data-review] [data-markdown]').getByRole('heading', { name: 'Done' }).waitFor()
  await shot('run-review')
  await rPanel.getByRole('button', { name: 'Approve' }).click()
  await rPanel.getByRole('heading', { name: 'Close-out' }).waitFor()
  assert.equal((await inv('runs:get', rvId)).status, 'done')
  await rPanel.getByText('Approved by you, in Operant').waitFor()
  await rPanel.getByRole('button', { name: 'Close job panel' }).click()

  // Send back needs a note and queues the job again.
  await page.getByRole('button', { name: `Open JOB#${sbId}` }).click()
  const sPanel = page.getByRole('region', { name: `Job panel JOB#${sbId}` })
  await sPanel.getByRole('button', { name: 'Send back' }).click()
  const sbDialog = page.getByRole('dialog')
  assert.ok(await sbDialog.getByRole('button', { name: 'Send back' }).isDisabled(), 'Send back needs a note')
  await sbDialog.locator('textarea').fill('Also remove the debug lines')
  await sbDialog.getByRole('button', { name: 'Send back' }).click()
  await sbDialog.waitFor({ state: 'detached' })
  const sent = await inv('runs:get', sbId)
  assert.equal(sent.sentBackNote, 'Also remove the debug lines')
  assert.notEqual(sent.status, 'review')
  await sPanel.getByRole('button', { name: 'Close job panel' }).click()

  // A stopped Master: Resume Master asks the backend to start it again (the fake claude sends no ready signal, so the
  // job itself stays put here); the click must not fail.
  await page.getByRole('button', { name: `Open JOB#${mId}` }).click()
  const mPanel = page.getByRole('region', { name: `Job panel JOB#${mId}` })
  await mPanel.getByRole('button', { name: 'Resume Master' }).click()
  await page.waitForTimeout(1500)
  assert.equal(await mPanel.getByRole('alert').count(), 0, 'Resume Master must not fail')
  await mPanel.getByRole('button', { name: 'Close job panel' }).click()

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

  // Built-in teams: badge, description and seat chips; duplicate, hide, edit and reset; never deleted.
  await page.getByRole('button', { name: 'Teams', exact: true }).click()
  const teamRow = (name) => page.locator(`[data-team="${name}"]`)
  await teamRow('Build and review').getByText('Built-in', { exact: true }).waitFor()
  await teamRow('Build and review').getByText('One implementor writes the change').waitFor()
  await teamRow('Full team').getByText('6 × ', { exact: false }).count()
  assert.equal(await teamRow('Build and review').getByRole('button', { name: /^Delete / }).count(), 0)
  const teamNames = await page.locator('[data-team]').evaluateAll((els) => els.map((e) => e.getAttribute('data-team')))
  assert.deepEqual(teamNames.slice(0, 6), ['Build and review', 'Full team', 'Research', 'Bug fix', 'Design to build', 'Quality pass'])
  assert.deepEqual(teamNames.slice(6).sort(), ['duo', 'duo plus'])
  await page.getByText('Full team').first().scrollIntoViewIfNeeded()
  await shot('team-presets')
  await page.getByRole('button', { name: 'Duplicate Research' }).click()
  await teamRow('Research copy').waitFor()
  await page.getByRole('button', { name: 'Delete Research copy' }).click()
  await page.getByRole('button', { name: 'Delete team' }).click()
  await teamRow('Research copy').waitFor({ state: 'detached' })
  await page.getByRole('button', { name: 'Hide Quality pass' }).click()
  await teamRow('Quality pass').waitFor({ state: 'detached' })
  await page.getByRole('button', { name: 'Show hidden (1)' }).click()
  await teamRow('Quality pass').getByText('Hidden', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Show Quality pass' }).click()
  await teamRow('Quality pass').getByText('Hidden', { exact: true }).waitFor({ state: 'detached' })
  await page.getByRole('button', { name: 'Edit Bug fix' }).click()
  await page.getByLabel('Description').fill('Changed by me')
  await page.getByRole('button', { name: 'Save team' }).click()
  await teamRow('Bug fix').getByText('Modified', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Reset Bug fix' }).click()
  await teamRow('Bug fix').getByText('An implementor fixes the bug').waitFor()
  await teamRow('Bug fix').getByText('Modified', { exact: true }).waitFor({ state: 'detached' })
  await inv('teams:delete', (await inv('teams:list')).find((t) => t.name === 'Full team').id).then(
    () => assert.fail('a built-in team must not be deleted'),
    () => {},
  )

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
