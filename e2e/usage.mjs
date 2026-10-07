// Usage page e2e (R20 to R22): seeded usage rows, the Usage tab (filters, totals, trend, grouping, a job's page, budgets
// with a held queue and Resume, export buttons), the provider limits with a stubbed Claude endpoint and a fake OpenCode
// database, the header badge, and the Import and Export settings page against a fake Operant 2.8.2 data folder.
// Runs in the background with throwaway data. Usage: node e2e/usage.mjs [outDir]  (default docs/specs/screenshots)
// Set OPERANT_E2E_EXE to a packaged executable to test a build instead of the dev app.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const outDir = resolve(process.argv[2] ?? 'docs/specs/screenshots')
mkdirSync(outDir, { recursive: true })
const root = mkdtempSync(join(tmpdir(), 'operant-usage-'))
const dataDir = join(root, 'data')
const home = join(root, 'home')
const claudeDir = join(root, 'claude')
const legacy = join(root, 'Operant')
const projects = join(root, 'repos')
for (const d of [dataDir, home, claudeDir, join(legacy, 'store'), join(legacy, 'agent-plugin', 'agents'), join(projects, 'Alpha'), join(projects, 'Legacy One')]) mkdirSync(d, { recursive: true })
const shop = join(projects, 'Alpha')
writeFileSync(join(shop, 'app.ts'), 'export const a = 1\n')

// A fake OpenCode database in a throwaway home; the Claude sign-in is written after the endpoint is stubbed in the main process (below), so the startup poll never reaches the network.
mkdirSync(join(home, '.local', 'share', 'opencode'), { recursive: true })
{
  const oc = new DatabaseSync(join(home, '.local', 'share', 'opencode', 'opencode.db'))
  oc.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)')
  const ins = oc.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)')
  const t = Date.now() - 3600_000
  ins.run('m1', 's1', t, JSON.stringify({ role: 'assistant', providerID: 'opencode', modelID: 'big-pickle', cost: 0.12, tokens: { input: 40_000, output: 6_000, cache: { read: 90_000, write: 0 } } }))
  ins.run('m2', 's1', t, JSON.stringify({ role: 'assistant', providerID: 'openrouter', modelID: 'some-model', cost: 0, tokens: { input: 12_000, output: 2_000, cache: { read: 0, write: 0 } } }))
  oc.close()
}

// A fake Operant 2.8.2 data folder: 1 project that exists, 1 that does not, 3 usage events and a bad line.
const NOW = Date.now()
writeFileSync(join(legacy, 'config.json'), JSON.stringify({ projects: [join(projects, 'Legacy One'), join(projects, 'Gone')], tokenBudget: 5_000_000 }))
const tok = (id, t, project, model, input) => JSON.stringify({ id, t, v: 1, project, corr: `${project}:${id}`, model, tier: 'small', input, output: 10, cacheRead: 100, cacheWrite: 20 })
writeFileSync(join(legacy, 'store', 'tokenEvents.jsonl'), [tok('tok-1', NOW - 5 * 86400000, 'Legacy One', 'claude-sonnet-5-5', 1000), tok('tok-2', NOW - 4 * 86400000, 'Legacy One', 'claude-sonnet-5-5', 500), '{broken'].join('\n') + '\n')
writeFileSync(join(legacy, 'store', 'modelRuns.jsonl'), JSON.stringify({ id: 'mod-1', t: NOW - 5 * 86400000, corr: 'Legacy One:tok-1', model: 'claude-sonnet-5-5', agent: 'claude', usd: 0.5 }) + '\n')
writeFileSync(join(legacy, 'agent-plugin', 'agents', 'explore.md'), '---\nname: explore\ndescription: "find things"\nmodel: haiku\ntools: Read, Grep\n---\nYou answer one question.\n')

const env = {
  ...process.env,
  OPERANT_BACKGROUND: '1', OPERANT_E2E: '1',
  OPERANT_DATA_DIR: dataDir,
  OPERANT_USER_DATA: legacy,
  CLAUDE_CONFIG_DIR: claudeDir,
  HOME: home,
  USERPROFILE: home,
}
const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
env[pathKey] = resolve('e2e/fixtures/bin') + delimiter + env[pathKey]
const packaged = process.env.OPERANT_E2E_EXE

const consoleNotes = []
const app = await electron.launch(packaged ? { executablePath: packaged, args: [], env } : { args: ['.'], env })
const page = await app.firstWindow()
page.on('console', (m) => m.type() === 'error' && consoleNotes.push(`console.error: ${m.text()}`))
page.on('pageerror', (e) => consoleNotes.push(`pageerror: ${e.message}`))
const inv = (channel, ...args) => page.evaluate(([c, a]) => window.operant.invoke(c, ...a), [channel, args])
const shot = async (name) => {
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(outDir, `${name}.png`) })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(label, fn, timeout = 30_000) {
  for (const end = Date.now() + timeout; Date.now() < end; await sleep(250)) if (await fn()) return
  throw new Error(`timed out waiting for ${label}`)
}

try {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForFunction(() => !!window.operant)
  await page.getByText('Welcome to Operant 3').waitFor()

  // The Claude plan endpoint is answered in the main process: 5-hour window at 86%, weekly at 41%.
  await app.evaluate(() => {
    const realFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith('https://api.anthropic.com/api/oauth/usage')) {
        const iso = (h) => new Date(Date.now() + h * 3600_000).toISOString()
        return new Response(JSON.stringify({ five_hour: { utilization: 86, resets_at: iso(2.2) }, seven_day: { utilization: 41, resets_at: iso(70) } }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return realFetch(url, init)
    }
  })

  writeFileSync(join(claudeDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'e2e-not-a-real-token' } }))

  const crew = await inv('crews:create', { name: 'shop', folder: shop })
  const other = await inv('crews:create', { name: 'docs', folder: join(projects, 'Legacy One') })
  const run = await inv('runs:create', { crewId: crew.id, task: 'Add a health check to app.ts', masterCli: 'claude' })

  // Seed usage the way the backend stores it: rows per message with a model, seat, CLI and optional job and agent.
  const db = new DatabaseSync(join(dataDir, 'operant.db'))
  db.exec('PRAGMA busy_timeout = 5000')
  const agent = db.prepare('INSERT INTO job_agents (run_id, seat, model, status, transcript_ref) VALUES (?, ?, ?, ?, ?)')
  const pm = Number(agent.run(run.id, 'pm', 'claude-opus-5-5', 'done', 'a1.jsonl').lastInsertRowid)
  const builder = Number(agent.run(run.id, 'builder', 'claude-sonnet-5-5', 'working', 'a2.jsonl').lastInsertRowid)
  const reviewer = Number(agent.run(run.id, 'reviewer', 'claude-haiku-4-5', 'done', 'a3.jsonl').lastInsertRowid)
  const add = db.prepare(
    `INSERT INTO usage (at, model, input_tokens, output_tokens, cache_read, cache_w5m, cache_w1h, cost_usd, crew_id, run_id, job_agent_id, cli, provider, source, seat, ext_key, legacy)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
  )
  const DAY = 86400000
  let k = 0
  const row = (daysAgo, model, i, o, cr, cw, cost, crewId, runId, agentId, cli, provider, source, seat) =>
    add.run(NOW - daysAgo * DAY - 600_000, model, i, o, cr, cw, 0, cost, crewId, runId, agentId, cli, provider, source, seat, `e2e-${k++}`)
  for (let d = 0; d < 14; d++) {
    row(d, 'claude-sonnet-5-5', 30_000 + d * 700, 5_000 + d * 120, 180_000, 20_000, 0.55 + (d % 5) * 0.18, crew.id, null, null, 'claude', 'anthropic', 'operator', 'builder')
    if (d % 2 === 0) row(d, 'claude-opus-5-5', 12_000, 2_500, 90_000, 8_000, 0.9 + (d % 3) * 0.3, crew.id, null, null, 'claude', 'anthropic', 'operator', 'lead')
    if (d % 3 === 0) row(d, 'opencode/big-pickle', 20_000, 3_000, 0, 0, 0.12, crew.id, null, null, 'opencode', 'opencode', 'operator', 'builder')
    if (d % 4 === 0) row(d, 'claude-haiku-4-5', 8_000, 900, 40_000, 0, 0.05, other.id, null, null, 'claude', 'anthropic', 'operator', 'docs')
  }
  // The job: Master (no agent row) plus three agents, today.
  row(0, 'claude-opus-5-5', 20_000, 4_000, 120_000, 10_000, 1.35, crew.id, run.id, null, 'claude', 'anthropic', 'master', 'master')
  row(0, 'claude-opus-5-5', 15_000, 3_000, 80_000, 6_000, 0.88, crew.id, run.id, pm, 'claude', 'anthropic', 'agent', 'pm')
  row(0, 'claude-sonnet-5-5', 42_000, 9_000, 260_000, 30_000, 0.74, crew.id, run.id, builder, 'claude', 'anthropic', 'agent', 'builder')
  row(0, 'claude-haiku-4-5', 9_000, 1_200, 50_000, 0, 0.06, crew.id, run.id, reviewer, 'claude', 'anthropic', 'agent', 'reviewer')
  db.close()

  await page.getByRole('heading', { name: 'shop', level: 1 }).waitFor()
  const tabs = page.getByRole('tablist', { name: 'Workspace panels' })
  assert.equal(await tabs.getByRole('tab', { name: 'Cost' }).count(), 0, 'the Cost tab was renamed')
  await tabs.getByRole('tab', { name: 'Usage' }).click()
  await page.getByRole('heading', { name: 'Usage', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Widen the Usage panel' }).click()

  // Totals: the cards show the sum of the rows, and the table's total row says the same.
  const filterFrom = (() => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d.getTime() - 29 * DAY
  })()
  const base = { from: filterFrom, crewId: crew.id }
  const report = await inv('usage:report', { filter: base, groupBy: ['day'], trend: true })
  const rowsSum = report.rows.reduce((a, r) => a + r.costUsd, 0)
  assert.ok(Math.abs(rowsSum - report.totals.costUsd) < 1e-9, 'totals are the sum of the rows')
  const money = (n) => n.toLocaleString(undefined, { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol' })
  const totals = page.getByRole('region', { name: 'Usage totals' })
  await totals.getByText(money(report.totals.costUsd)).first().waitFor()
  const table = page.getByRole('region', { name: 'Usage breakdown' }).getByRole('table')
  await table.locator('tfoot').getByText(money(report.totals.costUsd)).waitFor()
  assert.equal(await table.locator('tbody tr').count(), report.rows.length, 'one table row per day')
  await page.getByRole('region', { name: 'Spend trend' }).getByRole('img').waitFor()
  await shot('usage')

  // Grouping switch and filters.
  const group = page.getByRole('group', { name: 'Group by' })
  await group.getByRole('button', { name: 'Model' }).click()
  await table.getByRole('columnheader', { name: 'Model' }).waitFor()
  const byModel = await inv('usage:report', { filter: base, groupBy: ['model'] })
  assert.equal(await table.locator('tbody tr').count(), byModel.rows.length)
  for (const g of ['Project', 'CLI', 'Seat', 'Day']) {
    await group.getByRole('button', { name: g }).click()
    await table.getByRole('columnheader', { name: g }).waitFor()
  }
  await group.getByRole('button', { name: 'CLI' }).click()
  await page.getByRole('combobox', { name: 'CLI' }).click()
  await page.getByRole('option', { name: 'opencode' }).click()
  const oc = await inv('usage:report', { filter: { ...base, cli: 'opencode' }, groupBy: ['cli'] })
  await table.locator('tfoot').getByText(money(oc.totals.costUsd)).waitFor()
  assert.ok(oc.totals.costUsd > 0 && oc.totals.costUsd < report.totals.costUsd)
  await page.getByRole('combobox', { name: 'CLI' }).click()
  await page.getByRole('option', { name: 'All' }).click()
  await page.getByRole('group', { name: 'Date range' }).getByRole('button', { name: 'Today' }).click()
  const today = await inv('usage:report', { filter: { from: new Date().setHours(0, 0, 0, 0), crewId: crew.id }, groupBy: [] })
  await totals.getByText(money(today.totals.costUsd)).first().waitFor()
  await page.getByRole('group', { name: 'Date range' }).getByRole('button', { name: '30 days' }).click()

  // A job's page: cost per agent, reachable from the Usage tab and from the job panel.
  await group.getByRole('button', { name: 'Job' }).click()
  await page.getByRole('button', { name: `Open JOB#${run.id}` }).click()
  const jobTable = page.getByRole('region', { name: `Cost per agent for JOB#${run.id}` })
  await jobTable.waitFor()
  const ju = await inv('usage:job', run.id)
  assert.equal(ju.agents.length, 4, 'Master and three agents')
  for (const name of ['Master', 'pm', 'builder', 'reviewer']) await jobTable.getByRole('row', { name: new RegExp(`^${name}`) }).waitFor()
  await jobTable.locator('tfoot').getByText(money(ju.totals.costUsd)).waitFor()
  assert.ok(Math.abs(ju.agents.reduce((a, x) => a + x.costUsd, 0) - ju.totals.costUsd) < 1e-9, 'job total is the sum of its agents')
  await shot('usage-job')
  await page.getByRole('button', { name: 'All usage' }).click()
  await tabs.getByRole('tab', { name: /^Runs/ }).click()
  await page.getByRole('button', { name: new RegExp(`Open JOB#${run.id}`) }).click()
  await page.getByRole('region', { name: `Job panel JOB#${run.id}` }).getByRole('button', { name: 'Usage' }).click()
  await jobTable.waitFor()
  await page.getByRole('button', { name: 'All usage' }).click()

  // Export: the buttons are there (the save dialog is native, so the text comes through the same backend call).
  await page.getByRole('button', { name: 'Export CSV' }).first().waitFor()
  await page.getByRole('button', { name: 'Export JSON' }).first().waitFor()
  const csv = await inv('usage:exportText', { kind: 'report', query: { filter: base, groupBy: ['day'] } }, 'csv')
  assert.ok(csv.text.split('\n').length > report.rows.length, 'CSV has a row per day')

  // Providers: Claude windows with reset times, OpenCode per provider, z.ai off, estimates labelled.
  await page.getByRole('button', { name: 'Refresh provider usage' }).click()
  const claude = page.getByRole('region', { name: 'Claude plan usage' })
  await until('claude bars', async () => (await claude.getByRole('progressbar').count()) === 2)
  await claude.getByRole('progressbar', { name: /5-hour/i }).waitFor()
  assert.match((await claude.getByRole('progressbar').first().getAttribute('aria-valuetext')) ?? '', /86% used, resets in/)
  const ocCard = page.getByRole('region', { name: 'OpenCode usage' })
  await ocCard.getByRole('row', { name: /openrouter/ }).getByText('(estimate)').waitFor()
  await ocCard.getByText('Estimate from tokens').waitFor()
  const zai = page.getByRole('region', { name: 'z.ai usage' })
  await zai.getByText(/^No data/).waitFor()
  await page.getByRole('region', { name: 'Provider usage' }).scrollIntoViewIfNeeded()
  await shot('usage-providers')
  assert.equal(await page.getByText('e2e-not-a-real-token').count(), 0, 'keys are never shown')

  // The header badge (at least 80% used) opens the Usage tab from anywhere.
  const badge = page.getByRole('button', { name: /^Provider limits: Claude/ })
  await badge.waitFor()
  await tabs.getByRole('tab', { name: /^Runs/ }).click()
  await badge.click()
  await tabs.getByRole('tab', { name: 'Usage', selected: true }).waitFor()
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click()

  // Budgets in settings: a project cap, the queue held when it is passed, and Resume.
  await page.getByRole('button', { name: 'Budgets', exact: true }).click()
  await page.getByLabel('Project shop cap in USD').fill('0.5')
  await page.getByLabel('Project shop cap in USD').blur()
  await until('project cap saved', async () => (await inv('budgets:get')).config.projectDailyUsd[String(crew.id)] === 0.5)
  await until('project paused', async () => (await inv('budgets:get')).projects.find((p) => p.crewId === crew.id)?.paused === true, 20_000).catch(() => {})
  const second = await inv('runs:create', { crewId: crew.id, task: 'Second job, held by the cap', masterCli: 'claude' })
  await until('queue held', async () => (await inv('budgets:get')).held.length > 0, 20_000)
  await page.getByText('Queued jobs are on hold').waitFor()
  await shot('budgets')
  await page.getByRole('button', { name: 'Resume held project shop' }).click()
  await until('queue resumed', async () => (await inv('budgets:get')).held.length === 0)
  // The job itself starts when the project has a free slot (the first job still holds it); what Resume guarantees is no hold.
  assert.equal((await inv('budgets:get')).held.length, 0)
  assert.ok(['queued', 'working'].includes((await inv('runs:get', second.id)).status))
  await page.getByLabel('Project shop cap in USD').fill('0')
  await page.getByLabel('Project shop cap in USD').blur()
  await until('project cap cleared', async () => ((await inv('budgets:get')).config.projectDailyUsd[String(crew.id)] ?? 0) === 0)

  // Import and export: preview the fake 2.8.2 folder, apply, and a second preview shows nothing new.
  await page.getByRole('button', { name: 'Import and export', exact: true }).click()
  await page.getByRole('button', { name: 'Preview import from Operant 2.8.2' }).click()
  const preview = page.getByRole('region', { name: 'Import preview' })
  await preview.waitFor()
  await preview.getByRole('row', { name: /Usage rows/ }).waitFor()
  const before = await inv('import:preview', { kind: 'legacy' })
  assert.equal(before.usage.add, 2)
  assert.equal(before.projects.existing, 1, 'the project that exists here is not added twice')
  assert.equal(before.projects.skipped, 1)
  await preview.getByRole('region', { name: 'Skipped rows' }).waitFor()
  await preview.getByText(/folder not found/).waitFor()
  await shot('import')
  const usageBefore = (await inv('usage:report', { groupBy: [] })).totals.turns
  await page.getByRole('button', { name: /^Apply: add/ }).click()
  await page.getByRole('region', { name: 'Import result' }).waitFor()
  assert.equal((await inv('usage:report', { groupBy: [] })).totals.turns, usageBefore + 2)
  await page.getByRole('button', { name: 'Check again' }).click()
  await page.getByText('Nothing new to import').waitFor()
  const again = await inv('import:apply', { kind: 'legacy' })
  assert.equal(again.usage.add, 0, 'running the import twice adds nothing')
  await page.getByRole('button', { name: 'Export all data as JSON' }).waitFor()
  const all = await inv('data:export')
  const bundle = JSON.parse(all.text)
  assert.equal(bundle.format, 'operant-export')
  assert.ok(bundle.usage.length >= 30)
  assert.ok(!/e2e-not-a-real-token/.test(all.text), 'the export holds no keys')

  assert.deepEqual(consoleNotes, [], consoleNotes.join('\n'))
  console.log('usage e2e passed')
} catch (e) {
  await page.screenshot({ path: join(outDir, 'usage-failure.png') }).catch(() => {})
  throw e
} finally {
  await app.close()
}
