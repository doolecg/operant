// Workspace board + inbox e2e: runs sit in the five columns by status, the inbox lists question / permission / review /
// failed jobs, answering an option from the inbox moves the card, a failure leaves the inbox once opened, and the
// counts match. Runs in the background with throwaway data and a fake claude (the rows are seeded the way the Master
// would leave them). Needs the Workspace view mounted by the app shell (WP11: WorkspaceBoard + TaskModal host).
// Usage: node e2e/workspace.mjs [outDir]  (default docs/specs/screenshots)
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const outDir = resolve(process.argv[2] ?? 'docs/specs/screenshots')
mkdirSync(outDir, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), 'operant-board-'))
const project = mkdtempSync(join(tmpdir(), 'operant-board-proj-'))
const claudeDir = mkdtempSync(join(tmpdir(), 'operant-board-claude-'))
writeFileSync(join(project, 'app.ts'), 'export const a = 1\n')

const env = { ...process.env, OPERANT_BACKGROUND: '1', OPERANT_E2E: '1', OPERANT_DATA_DIR: dataDir, CLAUDE_CONFIG_DIR: claudeDir }
const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
env[pathKey] = resolve('e2e/fixtures/bin') + delimiter + env[pathKey]

const app = await electron.launch({ args: ['.'], env })
try {
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.waitForFunction(() => !!window.operant)
  await page.getByText('Welcome to Operant 3').waitFor()
  const inv = (channel, ...args) => page.evaluate(([c, a]) => window.operant.invoke(c, ...a), [channel, args])
  const shot = async (name) => {
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(outDir, `${name}.png`) })
  }

  const crew = await inv('crews:create', { name: 'alpha', folder: project })
  const seed = async (task, patch) => {
    const r = await inv('runs:create', { crewId: crew.id, task, masterCli: 'claude', mode: 'background' })
    await inv('runs:stop', r.id)
    const d = new DatabaseSync(join(dataDir, 'operant.db'))
    d.exec('PRAGMA busy_timeout = 5000')
    const finished = patch.status === 'done' || patch.status === 'failed' ? Date.now() : null
    d.prepare(
      'UPDATE runs SET mode = ?, status = ?, waiting = ?, question = ?, question_options = ?, review_summary = ?, outcome = ?, started_at = ?, finished_at = ? WHERE id = ?',
    ).run('master', patch.status, patch.waiting ?? '', patch.question ?? '', JSON.stringify(patch.options ?? []), patch.review ?? '', patch.outcome ?? '', Date.now(), finished, r.id)
    d.close()
    return r.id
  }
  const queued = await seed('Add a changelog', { status: 'queued' })
  const working = await seed('Write the health check', { status: 'working' })
  const question = await seed('Pick a port', { status: 'needs-you', waiting: 'question', question: 'Which **port** should the health check use?', options: ['3000', '8080'] })
  const permission = await seed('Install a package', { status: 'needs-you', waiting: 'permission' })
  const review = await seed('Tidy the logs', { status: 'review', review: '## Done\n\n- logs tidied' })
  const done = await seed('Rename the helper', { status: 'done', outcome: 'Renamed and tests pass' })
  const failed = await seed('Migrate the schema', { status: 'failed', outcome: 'The migration step crashed' })

  await page.reload()
  await page.waitForFunction(() => !!window.operant)
  await page.locator(`[data-crew-row="${crew.id}"]`).getByText('alpha', { exact: true }).click({ position: { x: 4, y: 4 } })
  await page.locator('[data-workspace-board]').waitFor()

  // Every run sits in the column of its status; failed shares Done.
  const inColumn = async (col) => (await page.locator(`[data-board-column="${col}"] [data-run-card]`).evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-run-card'))))).sort((a, b) => a - b)
  assert.deepEqual(await inColumn('queued'), [queued])
  assert.deepEqual(await inColumn('working'), [working])
  assert.deepEqual(await inColumn('needs-you'), [question, permission])
  assert.deepEqual(await inColumn('review'), [review])
  assert.deepEqual(await inColumn('done'), [done, failed])
  assert.equal(await page.locator(`[data-run-card="${failed}"]`).getAttribute('data-status'), 'failed')
  await page.locator(`[data-board-column="needs-you"] [data-column-count]`).getByText('2', { exact: true }).waitFor()

  // The inbox lists the question, the permission prompt, the review and the failure, oldest first; badge counts match.
  const inbox = page.getByRole('complementary', { name: 'Inbox' })
  await inbox.waitFor()
  const inboxIds = async () => (await inbox.locator('[data-inbox-item]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-inbox-item')))))
  assert.deepEqual(await inboxIds(), [question, permission, review, failed])
  assert.equal(await inbox.locator('[data-inbox-count]').innerText(), '4')
  assert.deepEqual(await inbox.locator('[data-inbox-item]').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind'))), ['question', 'permission', 'review', 'failed'])
  await shot('workspace-board')

  // A card opens the task modal.
  await page.getByRole('button', { name: `Open JOB#${working}` }).click()
  const modal = page.getByRole('dialog', { name: `JOB#${working}` })
  await modal.waitFor()
  await modal.getByRole('button', { name: 'Close job panel' }).click()
  await modal.waitFor({ state: 'detached' })

  // Answering an option from the inbox records the reply; the card moves once the Master picks it up (`run answer`),
  // which is simulated by the transition the backend makes then.
  await inbox.getByRole('group', { name: `Answer options for JOB#${question}` }).getByRole('button', { name: '8080' }).click()
  await inbox.locator(`[data-inbox-item="${question}"] [data-answer-sent]`).waitFor()
  const replies = (await inv('runs:events', question)).filter((e) => e.kind === 'reply')
  assert.deepEqual(replies.map((e) => e.body), ['8080'])
  {
    const d = new DatabaseSync(join(dataDir, 'operant.db'))
    d.exec('PRAGMA busy_timeout = 5000')
    d.prepare("UPDATE runs SET status = 'working', waiting = '', question = '', question_options = '[]' WHERE id = ?").run(question)
    d.close()
  }
  await page.reload()
  await page.waitForFunction(() => !!window.operant)
  await page.locator(`[data-crew-row="${crew.id}"]`).getByText('alpha', { exact: true }).click({ position: { x: 4, y: 4 } })
  await inbox.waitFor()
  assert.deepEqual(await inColumn('working'), [working, question])
  assert.deepEqual(await inColumn('needs-you'), [permission])
  assert.deepEqual(await inboxIds(), [permission, review, failed])
  assert.equal(await inbox.locator('[data-inbox-count]').innerText(), '3')

  // Opening a failure removes it from the inbox for good (kept locally); the card stays in Done.
  await inbox.getByRole('button', { name: `Open JOB#${failed} from the inbox` }).click()
  const failedModal = page.getByRole('dialog', { name: `JOB#${failed}` })
  await failedModal.waitFor()
  await failedModal.getByRole('button', { name: 'Close job panel' }).click()
  assert.deepEqual(await inboxIds(), [permission, review])
  assert.ok((await inColumn('done')).includes(failed))
  await page.reload()
  await page.waitForFunction(() => !!window.operant)
  await page.locator(`[data-crew-row="${crew.id}"]`).getByText('alpha', { exact: true }).click({ position: { x: 4, y: 4 } })
  await inbox.waitFor()
  assert.deepEqual(await inboxIds(), [permission, review], 'the seen failure stays out after a reload')
  assert.equal(await inbox.locator('[data-inbox-count]').innerText(), '2')

  // The review leaves the inbox when its status changes.
  await inv('runs:approve', review)
  await inbox.locator(`[data-inbox-item="${review}"]`).waitFor({ state: 'detached' })
  assert.ok((await inColumn('done')).includes(review))
  await shot('workspace-board-after')
  console.log('workspace e2e ok')
} finally {
  await app.close()
}
